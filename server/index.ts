import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { buildApp } from './app.js';
import { VaultError } from './errors.js';

const port = Number(process.env.VAULT_PORT ?? 47821);
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error('VAULT_PORT must be an integer between 1024 and 65535.');
}
const customDirectory = process.env.VAULT_DATA_DIR;
if (customDirectory && !isAbsolute(customDirectory)) {
  throw new Error('VAULT_DATA_DIR must be an absolute path.');
}
const baseDirectory = process.platform === 'win32'
  ? process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
  : process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share');
const directory = customDirectory ?? join(baseDirectory, 'PasswordVault');
const origin = `http://127.0.0.1:${port}`;
const app = buildApp({ directory, origin, staticDirectory: resolve('dist') });

try {
  await app.listen({ host: '127.0.0.1', port });
  console.log(`本地密码库已启动：${origin}`);
  console.log(`启动配置目录：${directory}`);
  console.log('已保存的自定义存储位置优先，实际密码库文件位置请查看页面。');
  console.log('关闭浏览器页面不会停止服务；在此窗口按 Ctrl+C 退出。');
  if (process.argv.includes('--open')) {
    const command = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', origin] : [origin];
    execFile(command, args, error => {
      if (error) console.log(`无法自动打开浏览器，请手动访问：${origin}`);
    });
  }
} catch (error) {
  console.error(error instanceof VaultError ? error.message : (error as NodeJS.ErrnoException).code === 'EADDRINUSE'
    ? `端口 ${port} 已占用，请勿重复启动；确认原窗口是否已在运行。`
    : '启动失败，请检查端口、构建产物及本机访问权限。');
  await app.close();
  process.exitCode = 1;
}

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await app.close();
}
process.on('SIGINT', close);
process.on('SIGTERM', close);
