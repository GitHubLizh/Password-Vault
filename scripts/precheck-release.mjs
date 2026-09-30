import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const stage = join(root, 'release', 'PasswordVault');
const zipFile = join(root, 'release', 'PasswordVault-win-x64.zip');

const problems = [];
const infos = [];
const fail = (message) => problems.push(message);
const ok = (message) => infos.push(message);

// Paths that actually change the bytes inside the shipped package; docs and tests are excluded on
// purpose so a README-only commit never makes the package look stale. package.json is narrowed to
// its "version" line (see VERSION_LINE below) because npm-script edits don't ship, and only
// scripts/package.mjs counts — the other scripts never enter the package.
const SHIPPED_SOURCES = ['server', 'shared', 'src', 'scripts/package.mjs', 'index.html', 'vite.config.ts', 'tsconfig.json', 'tsconfig.server.json', 'package-lock.json'];
const VERSION_LINE = '/"version":/,+1:package.json';

// Newest commit that could have changed package bytes: whole-file sources, or the version line.
function newestShippedCommit() {
  const candidates = [
    { time: Number(git('log', '-1', '--format=%ct', '--', ...SHIPPED_SOURCES)), subject: git('log', '-1', '--format=%h %s', '--', ...SHIPPED_SOURCES) },
    { time: Number(git('log', '-1', '--format=%ct', '-L', VERSION_LINE)), subject: git('log', '-1', '--format=%h %s', '-L', VERSION_LINE).split('\n')[0] },
  ].filter(candidate => Number.isFinite(candidate.time) && candidate.time > 0);
  return candidates.sort((left, right) => right.time - left.time)[0] ?? null;
}

async function filesWithExtension(dir, extension, base = dir) {
  if (!existsSync(dir)) return [];
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await filesWithExtension(path, extension, base));
    else if (entry.name.endsWith(extension) && !entry.name.endsWith(`.${extension}.map`)) found.push(relative(base, path).split(sep).join('/'));
  }
  return found;
}

async function builtFiles() {
  if (!existsSync(join(root, 'dist-server'))) {
    fail('dist-server/ 不存在，请先执行 npm run build。');
    return null;
  }
  return filesWithExtension(join(root, 'dist-server'), '.js');
}

function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

async function checkBuildMatchesSources() {
  const compiled = await builtFiles();
  if (compiled === null) return;

  const sources = [];
  for (const directory of ['server', 'shared']) {
    sources.push(...(await filesWithExtension(join(root, directory), '.ts', root)).map(item => `${item.slice(0, -3)}.js`));
  }
  const compiledSet = new Set(compiled);
  const sourceSet = new Set(sources);

  for (const missing of sources.filter(item => !compiledSet.has(item))) {
    fail(`编译产物缺失：${missing}（源码存在但没编出来）`);
  }
  const orphans = compiled.filter(item => !sourceSet.has(item));
  if (orphans.length > 0) {
    fail(`孤立产物：${orphans.join(', ')} —— 源码已删除但旧产物还在，会被打进包里。跑 npm run build（含 clean）清掉。`);
  } else {
    ok('dist-server 与 server/ + shared/ 的 .ts 一一对应，无孤立产物');
  }

  let stale = 0;
  for (const item of compiled) {
    const source = join(root, 'dist-server', item.slice(0, -3) + '.ts');
    if (!existsSync(source)) continue;
    if ((await stat(source)).mtimeMs > (await stat(join(root, 'dist-server', item))).mtimeMs) {
      stale++;
      fail(`产物比源码旧：dist-server/${item}（源码改过但没重新构建）`);
    }
  }
  if (stale === 0 && compiled.length > 0) ok(`${compiled.length} 个编译产物都不比源码旧`);

  for (const required of ['server/index.js', 'server/app.js']) {
    if (!compiledSet.has(required)) fail(`关键产物缺失：dist-server/${required}`);
  }
}

async function checkStaticBundle() {
  const index = join(root, 'dist', 'index.html');
  if (!existsSync(index)) {
    fail('dist/index.html 不存在，请先执行 npm run build。');
    return;
  }
  const html = await readFile(index, 'utf8');
  const assets = [...html.matchAll(/(?:src|href)="\/(assets\/[^"]+)"/g)].map(match => match[1]);
  if (assets.length === 0) fail('dist/index.html 里没有引用任何 /assets/ 资源，前端构建可能坏了。');
  for (const asset of assets) {
    if (!existsSync(join(root, 'dist', asset))) fail(`index.html 引用的资源不存在：dist/${asset}`);
  }
  if (assets.length > 0) ok(`dist/index.html 引用 ${assets.length} 个资源，全部存在`);
}

async function checkPackage() {
  if (!existsSync(stage)) {
    fail(`绿色包目录不存在：release/PasswordVault（先跑 npm run package）`);
    return;
  }
  const launcher = join(stage, '启动密码库.bat');
  const bytes = existsSync(launcher) ? await readFile(launcher) : null;
  if (bytes === null) {
    fail('包内缺少 启动密码库.bat');
  } else {
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) fail('启动密码库.bat 带 UTF-8 BOM，cmd 会把首行解析坏。');
    const bare = [...bytes].reduce((count, value, index) => value === 0x0a && bytes[index - 1] !== 0x0d ? count + 1 : count, 0);
    if (bare > 0) fail(`启动密码库.bat 有 ${bare} 处 LF 换行，cmd 解析批处理会错位（必须 CRLF）。`);
    if (!bytes.includes(Buffer.from('dist-server\\server\\index.js', 'utf8'))) fail('启动密码库.bat 里没有引用 dist-server\\server\\index.js，入口路径可能变了。');
  }
  if (!existsSync(join(stage, '使用说明.txt'))) fail('包内缺少 使用说明.txt');

  const runtime = join(stage, 'runtime', 'node.exe');
  if (!existsSync(runtime)) {
    fail('包内缺少 runtime/node.exe');
  } else {
    const bundled = execFileSync(runtime, ['-p', 'process.versions.node'], { encoding: 'utf8' }).trim();
    const local = process.versions.node;
    if (bundled.split('.')[0] !== local.split('.')[0]) fail(`包内 Node ${bundled} 与构建用的 Node ${local} 主版本不一致。`);
    else ok(`包内运行时 Node ${bundled}（本机 ${local}）`);
  }

  const manifest = join(stage, 'app', 'package.json');
  if (!existsSync(manifest)) {
    fail('包内缺少 app/package.json（dist-server 的 .js 靠它的 type:module 才按 ESM 加载）');
  } else {
    const value = JSON.parse(await readFile(manifest, 'utf8'));
    if (value.type !== 'module') fail(`app/package.json 的 type 是 "${value.type}"，必须是 module。`);
    const rootManifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    if (value.version !== rootManifest.version) fail(`包内版本 ${value.version} 与 package.json 版本 ${rootManifest.version} 不一致，需重新组装。`);
  }

  const modules = join(stage, 'app', 'node_modules');
  const rootManifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  for (const dependency of Object.keys(rootManifest.dependencies ?? {})) {
    if (!existsSync(join(modules, ...dependency.split('/')))) fail(`包内缺生产依赖 ${dependency}。`);
  }
  const leaked = Object.keys(rootManifest.devDependencies ?? {}).filter(name => existsSync(join(modules, ...name.split('/'))));
  if (leaked.length > 0) fail(`包内混入开发依赖：${leaked.join(', ')}（package-lock 的 dev 标记或依赖归类有问题）。`);
  else ok(`生产依赖 ${Object.keys(rootManifest.dependencies ?? {}).length} 个齐、无开发依赖混入`);

  if (!existsSync(join(stage, 'app', 'dist-server', 'server', 'index.js'))) fail('包内缺 app/dist-server/server/index.js');
  if (!existsSync(join(stage, 'app', 'dist', 'index.html'))) fail('包内缺 app/dist/index.html');
}

async function checkPackageFreshness() {
  if (!existsSync(zipFile)) {
    fail('release/PasswordVault-win-x64.zip 不存在，无法发布。');
    return;
  }
  const info = await stat(zipFile);
  const newest = newestShippedCommit();
  const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
  const hash = createHash('sha256').update(await readFile(zipFile)).digest('hex');
  infos.push(`zip：${info.size} 字节，sha256 ${hash.slice(0, 16)}…（发布后用同一算法与线上附件比对）`);

  if (newest && newest.time * 1000 > info.mtimeMs) {
    fail(`zip 早于最近一次影响包内容的提交（${newest.subject}），包里可能是旧代码。重跑 npm run package。`);
  } else {
    ok(`zip 不早于任何影响包内容的改动（最近一次：${newest?.subject ?? '无'}）`);
  }
  if (git('tag', '-l', `v${version}`)) {
    fail(`标签 v${version} 已存在，说明这个版本发过一次；要发新包先升 package.json 的 version。`);
  }
}

await checkBuildMatchesSources();
await checkStaticBundle();
await checkPackage();
await checkPackageFreshness();

for (const line of infos) console.log(`  · ${line}`);
if (problems.length > 0) {
  console.error(`\n发布前自检未通过（${problems.length} 项）：`);
  for (const line of problems) console.error(`  ✗ ${line}`);
  console.error('\n修好后重跑：npm run build && npm run package && node scripts/precheck-release.mjs');
  process.exitCode = 1;
} else {
  console.log(`\n发布前自检通过（${infos.length} 项检查）。可以 gh release create 挂包。`);
}
