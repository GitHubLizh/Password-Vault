import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { isAbsolute, join, normalize, resolve } from 'node:path';
import { VaultError } from './errors.js';

export function storageDirectory(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || /[\x00-\x1f]/.test(value)) {
    throw new VaultError(400, 'INVALID_DIRECTORY', '请输入有效的本机绝对目录，不要填写文件名。');
  }
  const directory = value.trim();
  if (!isAbsolute(directory) || /^[\\/]{2}/.test(directory) || /\.pvlt[\\/]*$/i.test(directory)) {
    throw new VaultError(400, 'INVALID_DIRECTORY', '请填写本机绝对目录，不支持相对路径、网络共享或 .pvlt 文件路径。');
  }
  if (process.platform === 'win32') {
    if (!/^[a-z]:[\\/]/i.test(directory) || /[<>:"|?*]/.test(directory.slice(2))) {
      throw new VaultError(400, 'INVALID_DIRECTORY', '请输入以盘符开头的目录，例如 D:\\PasswordVaultData。');
    }
    for (const part of directory.slice(3).split(/[\\/]/)) {
      if (part === '.' || part === '..') continue;
      if (/[. ]$/.test(part) || /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(part)) {
        throw new VaultError(400, 'INVALID_DIRECTORY', '目录包含 Windows 不支持的名称或结尾空格、句点。');
      }
    }
  }
  return normalize(resolve(directory));
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

export class StorageLocation {
  readonly configPath: string;
  private source: string | null = null;
  private selected: string;

  constructor(readonly profileDirectory: string) {
    this.configPath = join(profileDirectory, 'storage-location.json');
    this.selected = profileDirectory;
  }

  get directory(): string { return this.selected; }

  static async load(profileDirectory: string): Promise<StorageLocation> {
    const location = new StorageLocation(profileDirectory);
    let source: string;
    try {
      source = await readFile(location.configPath, 'utf8');
    } catch (error) {
      if (missing(error)) return location;
      throw new VaultError(500, 'CONFIG_UNAVAILABLE', '无法读取存储目录配置，请检查启动配置目录的权限。');
    }
    try {
      const value = JSON.parse(source) as { version?: unknown; directory?: unknown };
      if (!value || value.version !== 1) throw new Error('Invalid configuration');
      location.selected = storageDirectory(value.directory);
      location.source = source;
    } catch {
      throw new VaultError(500, 'CONFIG_INVALID', '存储目录配置已损坏，请检查 storage-location.json；为避免打开旧库，不会自动回退。');
    }
    try {
      const info = await stat(join(location.directory, 'vault.pvlt'));
      if (!info.isFile()) throw new Error('Not a file');
    } catch {
      throw new VaultError(500, 'LOCATION_UNAVAILABLE', '自定义目录中的密码库不可访问，请连接对应磁盘并检查文件和权限；不会自动创建空库或回退到旧库。');
    }
    return location;
  }

  async assertCurrent(): Promise<void> {
    let current: string | null;
    try {
      current = await readFile(this.configPath, 'utf8');
    } catch (error) {
      if (!missing(error)) throw error;
      current = null;
    }
    if (current !== this.source) {
      throw new VaultError(409, 'LOCATION_CHANGED', '存储目录已被另一个实例修改，请关闭并重新启动本地服务，不要继续使用旧密码库。');
    }
    if (this.source !== null) {
      try {
        if (!(await stat(join(this.directory, 'vault.pvlt'))).isFile()) throw new Error('Not a file');
      } catch {
        throw new VaultError(503, 'LOCATION_UNAVAILABLE', '自定义目录中的密码库不可访问，请检查磁盘和文件；不会创建空库替代。');
      }
    }
  }

  async save(directory: string): Promise<void> {
    await mkdir(this.profileDirectory, { recursive: true, mode: 0o700 });
    const guardPath = join(this.profileDirectory, 'storage-location.write-lock');
    let guard;
    try {
      guard = await open(guardPath, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new VaultError(409, 'FILE_BUSY', '存储配置正在修改，请稍后再试。');
      }
      throw error;
    }
    const temporaryPath = join(this.profileDirectory, `.storage-location-${randomUUID()}.tmp`);
    const source = JSON.stringify({ version: 1, directory });
    try {
      await this.assertCurrent();
      const temporary = await open(temporaryPath, 'wx', 0o600);
      try {
        await temporary.writeFile(source, 'utf8');
        await temporary.sync();
      } finally {
        await temporary.close();
      }
      await rename(temporaryPath, this.configPath);
      this.source = source;
      this.selected = directory;
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
      await guard.close().catch(() => undefined);
      await unlink(guardPath).catch(() => undefined);
    }
  }
}
