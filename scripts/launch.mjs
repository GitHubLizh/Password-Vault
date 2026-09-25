import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
if (Number(process.versions.node.split('.')[0]) !== 24) {
  console.error('请安装 Node.js 24 后再启动。');
  process.exit(1);
}
if (!existsSync(new URL('../node_modules/fastify/package.json', import.meta.url))) {
  console.error('首次使用请在项目目录执行 npm install，然后重新启动。');
  process.exit(1);
}
if (!existsSync(new URL('../dist/index.html', import.meta.url)) || !existsSync(new URL('../dist-server/server/index.js', import.meta.url))) {
  console.log('正在构建本地密码库，请稍候……');
  const result = process.platform === 'win32'
    ? spawnSync('cmd.exe', ['/d', '/s', '/c', 'npm run build'], { cwd: root, stdio: 'inherit' })
    : spawnSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
process.argv.push('--open');
await import('../dist-server/server/index.js');
