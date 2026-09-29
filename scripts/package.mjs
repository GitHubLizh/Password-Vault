import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const releaseDir = join(projectRoot, 'release');
const packageName = 'PasswordVault';

const launchBat = `@echo off
chcp 65001 >nul
title 本地密码库
cd /d "%~dp0app"
if not exist "%~dp0runtime\\node.exe" (
  echo 缺少内置运行库 runtime\\node.exe，请重新完整解压压缩包。
  pause
  exit /b 1
)
"%~dp0runtime\\node.exe" dist-server\\server\\index.js --open
if errorlevel 1 (
  echo.
  echo 启动失败。若提示端口被其他程序占用，说明有别的软件占用了这个端口，请联系提供者换端口。
  pause
)
`;

const readmeTxt = `本地密码库 · 使用说明
=====================================

一、怎么用
1. 把整个文件夹解压到一个固定位置（例如 D:\\密码库）。不要只解压单个文件，也不要放在网盘同步目录里。
2. 双击「启动密码库.bat」。会弹出一个黑色窗口，这是密码库的服务窗口，浏览器会自动打开密码库页面。
3. 第一次使用请设置一个主密码。主密码不会保存在任何地方，忘记后数据无法找回，请一定记牢。
4. 用完以后：关掉浏览器页面并不会退出，需要关闭那个黑色窗口（或按 Ctrl+C）才算退出。
   黑色窗口开着的时候，密码库一直在本机运行，别人看不到，只允许这台电脑自己访问。

二、密码存在哪里
默认在 C:\\Users\\<你的用户名>\\AppData\\Local\\PasswordVault，文件是加密的（.pvlt）。
可以在页面「设置」里改到其他本机目录。这个文件夹跟解压位置无关：删掉或换掉解压文件夹，密码库数据不会丢。

三、备份
页面里有「导出备份」，导出的是加密文件，请放到安全的地方。忘记主密码时，备份同样打不开。

四、常见问题
· 双击后窗口一闪而过：右键「启动密码库.bat」→ 属性 → 若底部有「解除锁定」按钮，勾选确定后再双击。
· 重复双击是正常的：如果密码库已经在运行，新窗口会显示「密码库已在运行」并直接帮你打开页面后自动关闭，不会报错、也不会开出第二个库。
· 提示「端口 47821 被其他程序占用」：说明有别的软件占了这个端口，密码库没启动，请联系给你这个包的人换端口。
· 浏览器没有自动打开：手动访问启动窗口里显示的那串 http://127.0.0.1:47821 地址。
· 这个程序不联网，也不需要安装 Node.js 或其他东西，压缩包已经自带运行库。
`;

function run(command, args, options = {}) {
  // npm is npm.cmd on Windows, which spawnSync only finds through cmd.exe (same as scripts/launch.mjs).
  const wrapped = process.platform === 'win32' && /^(npm|npx)$/.test(command)
    ? ['cmd.exe', ['/d', '/s', '/c', command, ...args]]
    : [command, args];
  const result = spawnSync(wrapped[0], wrapped[1], { stdio: 'inherit', cwd: projectRoot, ...options });
  if (result.status !== 0) {
    console.error(`${command} ${args.join(' ')} 失败（${result.error?.message ?? `退出码 ${result.status}`}）。`);
    process.exit(result.status ?? 1);
  }
}

// Only the production dependency closure is shipped; devDependencies (vite, playwright, typescript)
// stay in the repository. Scoped packages are copied so sibling packages under the same scope survive.
async function productionPackages() {
  const lock = JSON.parse(await readFile(join(projectRoot, 'package-lock.json'), 'utf8'));
  const needed = new Set();
  const walk = (name) => {
    const entry = lock.packages[`node_modules/${name}`];
    if (entry === undefined || entry.dev === true || needed.has(name)) return;
    needed.add(name);
    for (const dependency of Object.keys(entry.dependencies ?? {})) walk(dependency);
  };
  for (const name of Object.keys(lock.packages[''].dependencies ?? {})) walk(name);
  return [...needed].sort();
}

async function copyPackage(name, destination) {
  const source = join(projectRoot, 'node_modules', ...name.split('/'));
  if (!existsSync(source)) {
    console.error(`缺少 node_modules\\${name}，请先执行 npm install。`);
    process.exit(1);
  }
  const target = join(destination, ...name.split('/'));
  await mkdir(dirname(target), { recursive: true });
  await cp(source, target, { recursive: true });
}

async function sizeOf(directory) {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    total += (await stat(join(entry.parentPath ?? entry.path, entry.name))).size;
  }
  return total;
}

function human(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// cmd.exe mis-parses label/paren blocks in LF-only batch files, and Notepad defaults to CRLF.
// Template literals inherit this file's line endings, so normalise to LF before doubling up.
const crlf = (text) => text.replaceAll(/\r?\n/g, '\r\n');

const argv = process.argv.slice(2);
const skipBuild = argv.includes('--no-build');
const version = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8')).version;

if (!skipBuild) run('npm', ['run', 'build']);
for (const built of ['dist/index.html', 'dist-server/server/index.js']) {
  if (!existsSync(join(projectRoot, built))) {
    console.error(`构建产物 ${built} 不存在，请先执行 npm run build。`);
    process.exit(1);
  }
}

const stage = join(releaseDir, packageName);
await rm(stage, { recursive: true, force: true });
await rm(join(releaseDir, `${packageName}-win-x64.zip`), { force: true });
await mkdir(join(stage, 'runtime'), { recursive: true });
await mkdir(join(stage, 'app'), { recursive: true });

const manifest = { name: packageName.toLowerCase(), version, private: true, type: 'module' };
await cp(process.execPath, join(stage, 'runtime', 'node.exe'));
await cp(join(projectRoot, 'dist'), join(stage, 'app', 'dist'), { recursive: true });
await cp(join(projectRoot, 'dist-server'), join(stage, 'app', 'dist-server'), { recursive: true });
await writeFile(join(stage, 'app', 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
await writeFile(join(stage, '启动密码库.bat'), crlf(launchBat), { encoding: 'utf8' });
await writeFile(join(stage, '使用说明.txt'), crlf(readmeTxt), { encoding: 'utf8' });

const packages = await productionPackages();
for (const name of packages) await copyPackage(name, join(stage, 'app', 'node_modules'));

const folderBytes = await sizeOf(stage);
console.log(`绿色包已组装：release\\${packageName}（${packages.length} 个运行时包，${human(folderBytes)}）`);

// Compress-Archive is used rather than tar because it records UTF-8 entry names, which Windows
// Explorer needs to show the Chinese launcher and guide filenames without mojibake.
const quote = (value) => `'${value.replaceAll("'", "''")}'`;
const zipFile = join(releaseDir, `${packageName}-win-x64.zip`);
run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
  `Compress-Archive -LiteralPath ${quote(stage)} -DestinationPath ${quote(zipFile)} -CompressionLevel Optimal -Force`]);
console.log(`已生成压缩包：release\\${packageName}-win-x64.zip（${human((await stat(zipFile)).size)}）`);
