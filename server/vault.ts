import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, open, readFile, readdir, realpath, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChangeMasterPasswordResponse, FolderSelectionResponse, ProfileSummary, ProfilesResponse, RestorePreview, SessionResponse, StorageLocationResponse, VaultResponse, VaultSnapshot, VaultStatus } from '../shared/types.js';
import { decrypt, deriveKey, encrypt, MAX_VAULT_BYTES, parseEnvelope } from './crypto.js';
import { VaultError } from './errors.js';
import { StorageLocation, storageDirectory } from './storage-location.js';
import { pickFolder, type FolderPicker } from './folder-picker.js';
import { MAX_PROFILES, profileName, profileNameKey } from './profile-name.js';
import * as validate from './validation.js';

const DEFAULT_PROFILE_NAME = '默认';

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
  private nextAttemptAt = 0;
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

  private throttle(): void {
    if (this.now() < this.nextAttemptAt) {
      throw new VaultError(429, 'TRY_LATER', '请稍候一秒再尝试。');
    }
    this.nextAttemptAt = this.now() + 1000;
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

  // A profile exists iff its vault.pvlt is a readable regular file; unreadable candidates are skipped
  // so that one broken directory cannot take the whole list down.
  private async isProfileVault(path: string): Promise<boolean> {
    try {
      return (await stat(path)).isFile();
    } catch {
      return false;
    }
  }

  async profiles(): Promise<ProfilesResponse> {
    const profiles: ProfileSummary[] = [];
    if (await this.isProfileVault(this.rootStoragePath)) {
      profiles.push({ id: null, name: DEFAULT_PROFILE_NAME, isDefault: true });
    }
    const additional: ProfileSummary[] = [];
    try {
      for (const entry of await readdir(this.rootDirectory, { withFileTypes: true })) {
        // withFileTypes reports symlinks as neither file nor directory: a linked folder is not a profile.
        if (!entry.isDirectory()) continue;
        if (await this.isProfileVault(join(this.rootDirectory, entry.name, 'vault.pvlt'))) {
          additional.push({ id: entry.name, name: entry.name, isDefault: false });
        }
      }
    } catch (error) {
      if (!missing(error)) throw error;
    }
    additional.sort((left, right) => left.name.localeCompare(right.name, 'zh'));
    return { profiles: [...profiles, ...additional] };
  }

  async create(rawPassword: unknown): Promise<SessionResponse> {
    const password = validate.password(rawPassword, true);
    this.throttle();
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

  async unlock(rawPassword: unknown): Promise<SessionResponse> {
    const password = validate.password(rawPassword);
    this.throttle();
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
  }

  async changeMasterPassword(token: string | undefined, body: unknown): Promise<ChangeMasterPasswordResponse> {
    const session = this.requireSession(token);
    const input = validate.record(body);
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
    this.throttle();
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
    this.checkRevision(session, validate.record(body).revision);
    if (!session.vault.entries.some(item => item.id === id)) throw new VaultError(404, 'NOT_FOUND', '条目不存在。');
    const next = structuredClone(session.vault);
    next.entries = next.entries.filter(item => item.id !== id);
    next.revision++;
    return this.persist(session, next);
  }

  async settings(token: string | undefined, body: unknown): Promise<VaultResponse> {
    const session = this.requireSession(token);
    const input = validate.record(body);
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
    this.checkRevision(session, input.revision);
    if (input.confirmed !== true || input.storagePath !== this.rootStoragePath) {
      throw new VaultError(400, 'INVALID_INPUT', '请核对当前存储位置并确认迁移。');
    }
    const requestedDirectory = storageDirectory(input.directory);
    const previousStoragePath = this.rootStoragePath;
    const guards: { path: string; handle: Awaited<ReturnType<typeof open>> }[] = [];
    let targetPath: string | undefined;
    let createdTarget = false;
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
      for (const directory of [this.rootDirectory, targetDirectory]) {
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
      const source = await this.backup(token);
      targetPath = join(targetDirectory, 'vault.pvlt');
      let target;
      try {
        target = await open(targetPath, 'wx', 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new VaultError(409, 'TARGET_EXISTS', '新目录已存在 vault.pvlt，不能覆盖。请使用其他目录。');
        }
        throw error;
      }
      createdTarget = true;
      try {
        await target.writeFile(source, 'utf8');
        await target.sync();
      } finally {
        await target.close();
      }
      if (fingerprint(await readFile(targetPath, 'utf8')) !== session.fingerprint) {
        throw new VaultError(500, 'MIGRATION_FAILED', '新文件校验失败，仍使用原目录。');
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
      if (createdTarget && !committed && targetPath) await unlink(targetPath).catch(() => undefined);
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
    this.throttle();
    this.clearPending();
    const current = await this.readSource();
    const salt = Buffer.from(envelope.salt, 'base64');
    const key = await deriveKey(password, salt);
    try {
      const vault = decrypt(envelope, key);
      this.pending = {
        token: randomBytes(32).toString('base64url'), key, salt, vault, source,
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
    try {
      const safetyBackupPath = await this.atomicWrite(pending.source, pending.expectedFingerprint, true);
      return { ...this.beginSession(pending.key, pending.salt, pending.vault, pending.source), safetyBackupPath };
    } catch (error) {
      pending.key.fill(0);
      throw error;
    }
  }
}
