import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, open, readFile, readdir, realpath, rename, rmdir, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ChangeMasterPasswordResponse, DeleteProfileResponse, FolderSelectionResponse, ProfilesResponse, RestorePreview, SessionResponse, StorageLocationResponse, VaultResponse, VaultSnapshot, VaultStatus } from '../shared/types.js';
import { listProfileIds } from './profile-store.js';
import { decrypt, deriveKey, encrypt, MAX_VAULT_BYTES, parseEnvelope } from './crypto.js';
import { VaultError } from './errors.js';
import { StorageLocation, storageDirectory } from './storage-location.js';
import { pickFolder, type FolderPicker } from './folder-picker.js';
import { MAX_PROFILES, profileName, profileNameKey } from './profile-name.js';
import { readDefaultProfileName, writeDefaultProfileName } from './profile-config.js';
import * as validate from './validation.js';

interface Session {
  token: string;
  profileId: string | null;
  key: Buffer;
  salt: Buffer;
  vault: VaultSnapshot;
  fingerprint: string;
  expiresAt: number;
}

interface PendingRestore {
  token: string;
  profileId: string | null;
  key: Buffer;
  salt: Buffer;
  vault: VaultSnapshot;
  source: string;
  expectedFingerprint: string | null;
  expiresAt: number;
}

function fingerprint(source: string): string {
  return createHash('sha256').update(source).digest('hex');
}

function matches(provided: string | undefined, expected: string): boolean {
  if (!provided || !/^[A-Za-z0-9_-]{43}$/.test(provided)) return false;
  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

// The session, not the caller, decides which profile a mutation touches.
function rejectProfileSelector(input: Record<string, unknown>): void {
  if (input.profile !== undefined || input.profiles !== undefined) {
    throw new VaultError(400, 'INVALID_INPUT', '身份档由当前会话决定，请求不能指定要操作哪个档。');
  }
}

export class VaultService {
  // Storage root, as opposed to the current profile's directory (equal until profiles exist).
  get rootDirectory(): string { return this.location.directory; }
  get profileDirectory(): string {
    return this.activeProfileId === null ? this.rootDirectory : join(this.rootDirectory, this.activeProfileId);
  }
  // Storage location and folder picking are root-level concerns: the whole profile tree moves together.
  get rootStoragePath(): string { return join(this.rootDirectory, 'vault.pvlt'); }
  get storagePath(): string { return join(this.profileDirectory, 'vault.pvlt'); }
  private session?: Session;
  private activeProfileId: string | null = null;
  private pending?: PendingRestore;
  private tail: Promise<unknown> = Promise.resolve();
  private queued = 0;
  private readonly attemptSlots = new Map<string, number>();
  private activePicker?: AbortController;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(private readonly location: StorageLocation, private readonly now = Date.now, private readonly folderPicker: FolderPicker = pickFolder) {
    this.timer = setInterval(() => this.expire(), 1000);
    this.timer.unref();
  }

  async run<T>(operation: () => Promise<T> | T): Promise<T> {
    if (this.queued >= 20) throw new VaultError(429, 'BUSY', '请求较多，请稍后重试。');
    this.queued++;
    const result = this.tail.then(async () => {
      try {
        await this.location.assertCurrent();
        if (this.session) {
          const source = await this.readSource();
          if (source === null || (fingerprint(source) !== this.session.fingerprint
            && parseEnvelope(source).salt !== this.session.salt.toString('base64'))) {
            this.clearSession();
            this.clearPending();
          }
        }
      } catch (error) {
        this.clearSession();
        this.clearPending();
        throw error;
      }
      return operation();
    });
    this.tail = result.catch(() => undefined);
    try {
      return await result;
    } finally {
      this.queued--;
    }
  }

  dispose(): void {
    clearInterval(this.timer);
    this.clearSession();
    this.clearPending();
  }

  private clearSession(): void {
    this.session?.key.fill(0);
    this.session = undefined;
    this.activeProfileId = null;
    this.activePicker?.abort();
  }

  private clearPending(): void {
    this.pending?.key.fill(0);
    this.pending = undefined;
  }

  private expire(): void {
    if (this.session && this.now() >= this.session.expiresAt) this.clearSession();
    if (this.pending && this.now() >= this.pending.expiresAt) this.clearPending();
  }

  private requireSession(token: string | undefined): Session {
    this.expire();
    if (!this.session || !matches(token, this.session.token)) {
      throw new VaultError(401, 'LOCKED', '密码库已锁定，请重新输入主密码。');
    }
    return this.session;
  }

  // One budget per profile: failing on 工作 must not freeze 默认, and vice versa.
  private throttle(slot: string): void {
    const next = this.attemptSlots.get(slot) ?? 0;
    if (this.now() < next) {
      throw new VaultError(429, 'TRY_LATER', '请稍候一秒再尝试。');
    }
    this.attemptSlots.set(slot, this.now() + 1000);
  }

  private profileSlot(): string {
    return `profile:${this.activeProfileId ?? ''}`;
  }

  private async readSource(): Promise<string | null> {
    let info;
    try {
      info = await stat(this.storagePath);
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
    if (!info.isFile() || info.size > MAX_VAULT_BYTES) {
      throw new VaultError(400, 'INVALID_VAULT', '密码库文件异常或过大，请从有效备份恢复。');
    }
    return readFile(this.storagePath, 'utf8');
  }

  private async atomicWrite(source: string, expected: string | null, safetyBackup = false, beforeReplace?: () => void): Promise<string | undefined> {
    await mkdir(this.profileDirectory, { recursive: true, mode: 0o700 });
    const guardPath = join(this.profileDirectory, 'vault.write-lock');
    let guard;
    try {
      guard = await open(guardPath, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new VaultError(409, 'FILE_BUSY', '密码库正在被写入，或上次写入异常中断。请确认没有其他实例后检查 vault.write-lock 文件。');
      }
      throw error;
    }
    const temporaryPath = join(this.profileDirectory, `.vault-${randomUUID()}.tmp`);
    try {
      await this.location.assertCurrent();
      const current = await this.readSource();
      if ((current === null ? null : fingerprint(current)) !== expected) {
        throw new VaultError(409, 'FILE_CHANGED', '磁盘中的密码库已变化。请锁定后重新解锁，不要覆盖其他修改。');
      }
      let backupPath: string | undefined;
      if (safetyBackup && current !== null) {
        backupPath = join(this.profileDirectory, `before-restore-${this.now()}-${randomUUID()}.pvlt`);
        const backup = await open(backupPath, 'wx', 0o600);
        try {
          await backup.writeFile(await readFile(this.storagePath));
          await backup.sync();
        } finally {
          await backup.close();
        }
      }
      const temporary = await open(temporaryPath, 'wx', 0o600);
      try {
        await temporary.writeFile(source, 'utf8');
        await temporary.sync();
      } finally {
        await temporary.close();
      }
      beforeReplace?.();
      await rename(temporaryPath, this.storagePath);
      return backupPath;
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
      await guard.close().catch(() => undefined);
      await unlink(guardPath).catch(() => undefined);
    }
  }

  private beginSession(key: Buffer, salt: Buffer, vault: VaultSnapshot, source: string, profileId = this.activeProfileId): SessionResponse {
    this.clearSession();
    this.activeProfileId = profileId;
    this.session = {
      token: randomBytes(32).toString('base64url'), profileId, key, salt, vault,
      fingerprint: fingerprint(source), expiresAt: this.now() + vault.settings.autoLockMinutes * 60000,
    };
    return { token: this.session.token, ...this.response(this.session) };
  }

  private response(session: Session): VaultResponse {
    return { vault: structuredClone(session.vault), expiresAt: session.expiresAt };
  }

  async status(token?: string): Promise<VaultStatus> {
    this.expire();
    let exists = false;
    try {
      await stat(this.storagePath);
      exists = true;
    } catch (error) {
      if (!missing(error)) throw error;
    }
    const session = this.session && matches(token, this.session.token) ? this.session : undefined;
    return {
      exists, unlocked: !!session, storagePath: this.storagePath,
      autoLockMinutes: session?.vault.settings.autoLockMinutes ?? 5,
      expiresAt: session?.expiresAt ?? null, revision: session?.vault.revision ?? null,
    };
  }

  private get profileConfigPath(): string { return join(this.location.profileDirectory, 'profiles.json'); }

  async profiles(): Promise<ProfilesResponse> {
    const defaultName = await readDefaultProfileName(this.profileConfigPath);
    return { profiles: (await listProfileIds(this.rootDirectory)).map(id => ({
      id: id === '' ? null : id,
      name: id === '' ? defaultName : id,
      isDefault: id === '',
    })) };
  }

  async deleteProfile(token: string | undefined, body: unknown): Promise<DeleteProfileResponse> {
    const session = this.requireSession(token);
    const input = validate.record(body);
    rejectProfileSelector(input);
    if (session.profileId === null) throw new VaultError(400, 'DEFAULT_PROFILE_UNDELETABLE', '默认身份档不能删除。');
    if (input.confirmed !== true || input.name !== session.profileId) {
      throw new VaultError(400, 'INVALID_INPUT', '请输入该身份档的名称以确认删除。');
    }
    this.checkRevision(session, input.revision);
    const directory = this.profileDirectory;
    const guardPath = join(directory, 'vault.write-lock');
    const guard = await open(guardPath, 'wx', 0o600).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'EEXIST') throw new VaultError(409, 'FILE_BUSY', '这个身份档正在被写入，请稍后再试。');
      throw error;
    });
    let safetyBackupPath = '';
    try {
      const source = await this.readSource();
      if (source === null || fingerprint(source) !== session.fingerprint) {
        throw new VaultError(409, 'FILE_CHANGED', '磁盘中的密码库已变化，请重新解锁后再删除。');
      }
      // The copy is written before anything is removed: an interrupted delete must leave a decryptable file.
      safetyBackupPath = join(this.rootDirectory, `before-delete-${this.now()}-${randomUUID()}.pvlt`);
      const backup = await open(safetyBackupPath, 'wx', 0o600);
      try {
        await backup.writeFile(source, 'utf8');
        await backup.sync();
      } finally {
        await backup.close();
      }
      await unlink(this.storagePath);
      for (const name of await readdir(directory)) {
        if (name === 'vault.write-lock' || (name.startsWith('.vault-') && name.endsWith('.tmp'))) {
          await unlink(join(directory, name)).catch(() => undefined);
        }
      }
    } catch (error) {
      if (safetyBackupPath) await unlink(safetyBackupPath).catch(() => undefined);
      throw error;
    } finally {
      await guard.close().catch(() => undefined);
      await unlink(guardPath).catch(() => undefined);
    }
    this.clearSession();
    this.clearPending();
    return { status: await this.status(), safetyBackupPath };
  }

  async renameDefaultProfile(token: string | undefined, body: unknown): Promise<ProfilesResponse> {
    const session = this.requireSession(token);
    if (session.profileId !== null) {
      throw new VaultError(400, 'NOT_DEFAULT_PROFILE', '只有默认身份档可以改显示名，其他身份档的名字就是它的目录名。');
    }
    const input = validate.record(body);
    await writeDefaultProfileName(this.profileConfigPath, input.name);
    return this.profiles();
  }

  async create(rawPassword: unknown): Promise<SessionResponse> {
    const password = validate.password(rawPassword, true);
    this.throttle(this.profileSlot());
    if (await this.readSource() !== null) throw new VaultError(409, 'EXISTS', '密码库已存在，请解锁，不要重复创建。');
    const salt = randomBytes(16);
    const key = await deriveKey(password, salt);
    try {
      const vault: VaultSnapshot = { entries: [], settings: { autoLockMinutes: 5 }, revision: 1 };
      const source = encrypt(vault, key, salt);
      await this.atomicWrite(source, null);
      this.clearPending();
      return this.beginSession(key, salt, vault, source);
    } catch (error) {
      key.fill(0);
      throw error;
    }
  }

  // A new profile is created and entered in one step; switching into an existing profile lands in 004.
  async createProfile(body: unknown): Promise<SessionResponse> {
    const input = validate.record(body);
    const name = profileName(input.name);
    const { profiles } = await this.profiles();
    if (profiles.some(profile => profile.id !== null && profileNameKey(profile.id) === profileNameKey(name))) {
      throw new VaultError(409, 'PROFILE_EXISTS', '已有同名身份档，请换一个名字。');
    }
    if (profiles.length >= MAX_PROFILES) {
      throw new VaultError(400, 'PROFILE_LIMIT', `身份档数量已达上限（${MAX_PROFILES} 个）。`);
    }
    this.activeProfileId = name;
    try {
      return await this.create(input.password);
    } catch (error) {
      this.activeProfileId = null;
      throw error;
    }
  }

  async unlock(rawBody: unknown): Promise<SessionResponse> {
    const input = validate.record(rawBody);
    const password = validate.password(input.password);
    const profile = input.profile === undefined || input.profile === null ? null : profileName(input.profile);
    if (profile !== null && !(await listProfileIds(this.rootDirectory)).includes(profile)) {
      throw new VaultError(404, 'PROFILE_NOT_FOUND', '没有找到这个身份档，请重新选择。');
    }
    this.activeProfileId = profile;
    try {
      this.throttle(this.profileSlot());
      const source = await this.readSource();
      if (source === null) throw new VaultError(404, 'NOT_FOUND', '还没有密码库，请先创建。');
      const envelope = parseEnvelope(source);
      const salt = Buffer.from(envelope.salt, 'base64');
      const key = await deriveKey(password, salt);
      try {
        const vault = decrypt(envelope, key);
        this.clearPending();
        return this.beginSession(key, salt, vault, source);
      } catch (error) {
        key.fill(0);
        throw error;
      }
    } catch (error) {
      this.activeProfileId = null;
      throw error;
    }
  }

  async changeMasterPassword(token: string | undefined, body: unknown): Promise<ChangeMasterPasswordResponse> {
    const session = this.requireSession(token);
    const input = validate.record(body);
    rejectProfileSelector(input);
    this.checkRevision(session, input.revision);
    const currentPassword = validate.password(input.currentPassword);
    const newPassword = validate.password(input.newPassword, true);
    const confirmPassword = validate.password(input.confirmPassword, true);
    if (newPassword !== confirmPassword) {
      throw new VaultError(400, 'PASSWORD_MISMATCH', '两次输入的新主密码不一致。');
    }
    if (newPassword === currentPassword) {
      throw new VaultError(400, 'NEW_PASSWORD_UNCHANGED', '新主密码不能与当前主密码相同。');
    }
    this.throttle(this.profileSlot());
    await this.backup(token);
    let currentKey: Buffer | undefined;
    let newKey: Buffer | undefined;
    try {
      currentKey = await deriveKey(currentPassword, session.salt);
      this.requireSession(token);
      if (!timingSafeEqual(currentKey, session.key)) {
        throw new VaultError(400, 'WRONG_MASTER_PASSWORD', '当前主密码不正确，请重新输入。');
      }
      const salt = randomBytes(16);
      newKey = await deriveKey(newPassword, salt);
      this.requireSession(token);
      const vault = structuredClone(session.vault);
      vault.revision++;
      const source = encrypt(vault, newKey, salt);
      await this.atomicWrite(source, session.fingerprint, false, () => { this.requireSession(token); });
      this.clearSession();
      this.clearPending();
      return {
        status: { exists: true, unlocked: false, storagePath: this.storagePath, autoLockMinutes: 5, expiresAt: null, revision: null },
      };
    } finally {
      currentKey?.fill(0);
      newKey?.fill(0);
    }
  }

  lock(token?: string): { ok: true } {
    this.requireSession(token);
    this.clearSession();
    this.clearPending();
    return { ok: true };
  }

  activity(token?: string): { expiresAt: number } {
    const session = this.requireSession(token);
    session.expiresAt = this.now() + session.vault.settings.autoLockMinutes * 60000;
    return { expiresAt: session.expiresAt };
  }

  getVault(token?: string): VaultResponse {
    return this.response(this.requireSession(token));
  }

  private async persist(session: Session, vault: VaultSnapshot): Promise<VaultResponse> {
    const source = encrypt(vault, session.key, session.salt);
    await this.atomicWrite(source, session.fingerprint);
    // A timer can expire the session while the filesystem write is in flight.
    if (this.session !== session || this.now() >= session.expiresAt) {
      this.clearSession();
      throw new VaultError(401, 'LOCKED', '数据已保存，但会话已到期，请重新解锁。');
    }
    session.vault = vault;
    session.fingerprint = fingerprint(source);
    session.expiresAt = this.now() + vault.settings.autoLockMinutes * 60000;
    return this.response(session);
  }

  async saveEntry(token: string | undefined, body: unknown, id?: string): Promise<VaultResponse> {
    const session = this.requireSession(token);
    const input = validate.record(body);
    rejectProfileSelector(input);
    this.checkRevision(session, input.revision);
    const entry = validate.entryInput(input.entry);
    const next = structuredClone(session.vault);
    const timestamp = new Date(this.now()).toISOString();
    if (id !== undefined) {
      const index = next.entries.findIndex(item => item.id === id);
      if (index < 0) throw new VaultError(404, 'NOT_FOUND', '条目不存在，请重新载入。');
      next.entries[index] = { ...entry, id, createdAt: next.entries[index].createdAt, updatedAt: timestamp };
    } else {
      if (next.entries.length >= 10000) throw new VaultError(400, 'LIMIT', '密码库最多保存 10000 条凭据。');
      next.entries.push({ ...entry, id: randomUUID(), createdAt: timestamp, updatedAt: timestamp });
    }
    next.revision++;
    return this.persist(session, next);
  }

  async deleteEntry(token: string | undefined, body: unknown, id: string): Promise<VaultResponse> {
    const session = this.requireSession(token);
    const input = validate.record(body);
    rejectProfileSelector(input);
    this.checkRevision(session, input.revision);
    if (!session.vault.entries.some(item => item.id === id)) throw new VaultError(404, 'NOT_FOUND', '条目不存在。');
    const next = structuredClone(session.vault);
    next.entries = next.entries.filter(item => item.id !== id);
    next.revision++;
    return this.persist(session, next);
  }

  async settings(token: string | undefined, body: unknown): Promise<VaultResponse> {
    const session = this.requireSession(token);
    const input = validate.record(body);
    rejectProfileSelector(input);
    this.checkRevision(session, input.revision);
    const next = structuredClone(session.vault);
    next.settings.autoLockMinutes = validate.autoLockMinutes(input.autoLockMinutes);
    next.revision++;
    return this.persist(session, next);
  }

  private checkRevision(session: Session, rawRevision: unknown): void {
    if (validate.revision(rawRevision) !== session.vault.revision) {
      throw new VaultError(409, 'REVISION_CONFLICT', '数据已被其他操作修改，请重新载入最新数据再保存。');
    }
  }

  async selectStorageFolder(token: string | undefined, signal: AbortSignal): Promise<FolderSelectionResponse> {
    const controller = new AbortController();
    await this.run(() => {
      this.requireSession(token);
      if (signal.aborted) throw new VaultError(409, 'PICKER_CANCELLED', '文件夹选择已取消。');
      if (this.activePicker) throw new VaultError(409, 'PICKER_BUSY', '已有文件夹选择窗口打开，请先完成或取消选择。');
      this.activePicker = controller;
    });
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) controller.abort();
    try {
      // Native dialogs must not hold the write queue: lock and status still need to run.
      const selected = await this.folderPicker(this.rootDirectory, controller.signal);
      return await this.run(async () => {
        this.requireSession(token);
        if (controller.signal.aborted) throw new VaultError(409, 'PICKER_CANCELLED', '文件夹选择已取消。');
        if (selected === null) return { directory: null };
        const directory = storageDirectory(await realpath(storageDirectory(selected)));
        if (!(await stat(directory)).isDirectory()) throw new VaultError(400, 'INVALID_DIRECTORY', '请选择一个本机文件夹。');
        return { directory };
      });
    } catch (error) {
      await this.run(() => this.requireSession(token));
      if (error instanceof VaultError) throw error;
      throw new VaultError(503, 'PICKER_FAILED', '无法读取所选文件夹，请确认文件夹可访问后重试。');
    } finally {
      signal.removeEventListener('abort', abort);
      if (this.activePicker === controller) this.activePicker = undefined;
    }
  }

  async changeStorageLocation(token: string | undefined, body: unknown): Promise<StorageLocationResponse> {
    const session = this.requireSession(token);
    const input = validate.record(body);
    rejectProfileSelector(input);
    this.checkRevision(session, input.revision);
    // The client echoes whatever status() published for this session, which is the current profile's
    // file rather than the root one; both identify the same store and both are server-published.
    if (input.confirmed !== true || (input.storagePath !== this.rootStoragePath && input.storagePath !== this.storagePath)) {
      throw new VaultError(400, 'INVALID_INPUT', '请核对当前存储位置并确认迁移。');
    }
    const requestedDirectory = storageDirectory(input.directory);
    const previousStoragePath = this.rootStoragePath;
    const guards: { path: string; handle: Awaited<ReturnType<typeof open>> }[] = [];
    const createdFiles: string[] = [];
    const createdDirectories: string[] = [];
    let committed = false;
    try {
      await mkdir(requestedDirectory, { recursive: true, mode: 0o700 });
      const targetDirectory = storageDirectory(await realpath(requestedDirectory));
      const currentDirectory = await realpath(this.rootDirectory);
      if (process.platform === 'win32'
        ? targetDirectory.toLowerCase() === currentDirectory.toLowerCase()
        : targetDirectory === currentDirectory) {
        throw new VaultError(400, 'SAME_DIRECTORY', '新目录与当前目录相同，无需迁移。');
      }
      // Every profile travels together: guard the root plus each source profile directory, and refuse
      // to write anything until every destination is known to be free.
      const ids = await listProfileIds(currentDirectory);
      // A target that already holds a vault.pvlt also shows up as a source profile, so the same
      // directory can arrive twice; guarding it twice would report a bogus FILE_BUSY.
      const guardPaths: string[] = [];
      const guarded = new Set<string>();
      for (const path of [currentDirectory, targetDirectory, ...ids.filter(id => id !== '').map(id => join(currentDirectory, id))]) {
        const key = process.platform === 'win32' ? path.toLowerCase() : path;
        if (guarded.has(key)) continue;
        guarded.add(key);
        guardPaths.push(path);
      }
      for (const directory of guardPaths) {
        const path = join(directory, 'vault.write-lock');
        try {
          const handle = await open(path, 'wx', 0o600);
          guards.push({ path, handle });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
            throw new VaultError(409, 'FILE_BUSY', '当前目录或新目录正在使用中，请确认没有其他写入操作后重试。');
          }
          throw error;
        }
      }
      await this.location.assertCurrent();
      // Verifies the live session still matches its own file on disk; each file below is then read
      // from its own path, because backup() returns the *current* profile's bytes.
      await this.backup(token);
      const copies = ids.map(id => ({
        from: id === '' ? join(currentDirectory, 'vault.pvlt') : join(currentDirectory, id, 'vault.pvlt'),
        to: id === '' ? join(targetDirectory, 'vault.pvlt') : join(targetDirectory, id, 'vault.pvlt'),
      }));
      for (const copy of copies) {
        try {
          await stat(copy.to);
          throw new VaultError(409, 'TARGET_EXISTS', '新目录已存在同名密码库，不能覆盖。请使用其他目录。');
        } catch (error) {
          if (error instanceof VaultError) throw error;
          if (!missing(error)) throw error;
        }
      }
      for (const copy of copies) {
        const bytes = await readFile(copy.from, 'utf8');
        const expected = fingerprint(bytes);
        const directory = dirname(copy.to);
        if (directory !== targetDirectory) {
          await mkdir(directory, { recursive: true, mode: 0o700 });
          createdDirectories.push(directory);
        }
        const target = await open(copy.to, 'wx', 0o600);
        createdFiles.push(copy.to);
        try {
          await target.writeFile(bytes, 'utf8');
          await target.sync();
        } finally {
          await target.close();
        }
        if (fingerprint(await readFile(copy.to, 'utf8')) !== expected) {
          throw new VaultError(500, 'MIGRATION_FAILED', '新文件校验失败，仍使用原目录。');
        }
      }
      this.requireSession(token);
      // Commit the location only after a complete, verified encrypted copy exists.
      await this.location.save(targetDirectory);
      committed = true;
      this.clearSession();
      this.clearPending();
      return {
        previousStoragePath,
        status: { exists: true, unlocked: false, storagePath: this.rootStoragePath, autoLockMinutes: 5, expiresAt: null, revision: null },
      };
    } catch (error) {
      if (!committed) {
        for (const path of createdFiles.reverse()) await unlink(path).catch(() => undefined);
        for (const directory of createdDirectories.reverse()) await rmdir(directory).catch(() => undefined);
      }
      if (error instanceof VaultError) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
        throw new VaultError(403, 'DIRECTORY_UNWRITABLE', '目录或配置不可写，请选择有写入权限的本机目录；原密码库未改动。');
      }
      if (code === 'ENOTDIR' || code === 'EINVAL' || code === 'EEXIST') {
        throw new VaultError(400, 'INVALID_DIRECTORY', '路径不是有效目录，请检查路径及其父目录。');
      }
      throw new VaultError(500, 'MIGRATION_FAILED', '迁移未完成，仍使用原目录。请检查磁盘空间和目录权限后重试。');
    } finally {
      for (const guard of guards.reverse()) {
        await guard.handle.close().catch(() => undefined);
        await unlink(guard.path).catch(() => undefined);
      }
    }
  }

  backupProfileId(token?: string): string | null {
    return this.requireSession(token).profileId;
  }

  async backup(token?: string): Promise<string> {
    const session = this.requireSession(token);
    const source = await this.readSource();
    if (source === null || fingerprint(source) !== session.fingerprint) {
      throw new VaultError(409, 'FILE_CHANGED', '磁盘中的密码库已变化，请重新解锁后备份。');
    }
    return source;
  }

  async previewRestore(body: unknown): Promise<RestorePreview> {
    const input = validate.record(body);
    const password = validate.password(input.password);
    const source = validate.text(input.backup, '备份文件', MAX_VAULT_BYTES, 1);
    const envelope = parseEnvelope(source);
    this.throttle('restore');
    this.clearPending();
    const current = await this.readSource();
    const salt = Buffer.from(envelope.salt, 'base64');
    const key = await deriveKey(password, salt);
    try {
      const vault = decrypt(envelope, key);
      this.pending = {
        token: randomBytes(32).toString('base64url'), profileId: this.activeProfileId, key, salt, vault, source,
        expectedFingerprint: current === null ? null : fingerprint(current), expiresAt: this.now() + 60000,
      };
      return {
        restoreToken: this.pending.token, entryCount: vault.entries.length,
        willReplace: current !== null, expiresAt: this.pending.expiresAt,
      };
    } catch (error) {
      key.fill(0);
      throw error;
    }
  }

  cancelRestore(body: unknown): { ok: true } {
    const input = validate.record(body);
    if (this.pending && matches(typeof input.restoreToken === 'string' ? input.restoreToken : undefined, this.pending.token)) {
      this.clearPending();
    }
    return { ok: true };
  }

  async confirmRestore(body: unknown): Promise<SessionResponse> {
    const input = validate.record(body);
    this.expire();
    const pending = this.pending;
    if (!pending || !matches(typeof input.restoreToken === 'string' ? input.restoreToken : undefined, pending.token)) {
      throw new VaultError(400, 'RESTORE_EXPIRED', '恢复预览已失效，请重新选择备份并验证。');
    }
    this.pending = undefined;
    // The preview was taken against one profile's file; a session change in between must not let the
    // write land on a different profile's vault.
    if (pending.profileId !== this.activeProfileId) {
      pending.key.fill(0);
      throw new VaultError(409, 'RESTORE_STALE', '当前身份档已变化，请重新解锁后再恢复。');
    }
    try {
      const safetyBackupPath = await this.atomicWrite(pending.source, pending.expectedFingerprint, true);
      return { ...this.beginSession(pending.key, pending.salt, pending.vault, pending.source), safetyBackupPath };
    } catch (error) {
      pending.key.fill(0);
      throw error;
    }
  }
}
