import { expect, test } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The green package is the only artifact non-technical users ever touch, and its runtime differs
// from the repository's: its own node.exe, its own cwd, its own node_modules layout. This suite
// drives the assembled release/PasswordVault directory so that difference is covered before upload.
const packageRoot = join(process.cwd(), 'release', 'PasswordVault');
const nodePath = join(packageRoot, 'runtime', 'node.exe');
const appDirectory = join(packageRoot, 'app');
const MASTER = 'Package-UI-Test-2026-only';
const SECRET = '  包内实测-秘密-2026  ';

test.skip(process.platform !== 'win32', '免安装绿色包只面向 Windows 分发');

let server: ChildProcess;
let dataDirectory: string;
let origin: string;
let nextPasswordAttempt = 0;

async function startServer() {
  server = spawn(nodePath, ['dist-server/server/index.js'], {
    cwd: appDirectory,
    env: { ...process.env, VAULT_PORT: new URL(origin).port, VAULT_DATA_DIR: dataDirectory },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('包内服务未在 20 秒内报告启动完成')), 20000);
    server.once('error', error => { clearTimeout(timeout); reject(error); });
    server.once('exit', code => { clearTimeout(timeout); reject(new Error(`包内服务提前退出：${code}`)); });
    server.stdout!.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('本地密码库已启动')) { clearTimeout(timeout); resolve(); }
    });
  });
}

async function submit(page: import('@playwright/test').Page, label: string) {
  // The server throttles password attempts per profile slot, so clicks need a small gap.
  if (Date.now() < nextPasswordAttempt) {
    await expect.poll(() => Date.now(), { intervals: [100], timeout: 2000 }).toBeGreaterThanOrEqual(nextPasswordAttempt);
  }
  nextPasswordAttempt = Date.now() + 1100;
  await page.getByRole('button', { name: label, exact: true }).click();
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  if (!existsSync(nodePath)) {
    throw new Error(`找不到 ${nodePath}；先执行 npm run package 组装绿色包，再跑本套件。`);
  }
  dataDirectory = await mkdtemp(join(tmpdir(), 'password-vault-package-ui-'));
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  origin = `http://127.0.0.1:${port}`;
  await startServer();
});

test.afterAll(async () => {
  if (server && server.exitCode === null) {
    const stopped = once(server, 'exit');
    server.kill();
    await stopped;
  }
  if (dataDirectory) await rm(dataDirectory, { recursive: true, force: true });
});

test('the packaged runtime serves the UI and a first-time user can create, save and read a credential', async ({ page, context }, info) => {
  const foreignRequests: string[] = [];
  const pageErrors: string[] = [];
  page.on('request', request => { if (!request.url().startsWith(origin)) foreignRequests.push(request.url()); });
  page.on('pageerror', error => pageErrors.push(error.message));

  await page.goto(origin);
  await expect(page.getByRole('heading', { name: '从一把主钥匙开始' })).toBeVisible();
  await page.screenshot({ path: info.outputPath('create.png'), fullPage: true });

  await page.getByLabel('设置主密码', { exact: true }).fill(MASTER);
  await page.getByLabel('确认主密码', { exact: true }).fill(MASTER);
  await page.getByRole('checkbox').check();
  await submit(page, '创建我的保管库');
  await expect(page.getByRole('heading', { name: '从第一条密码开始' })).toBeVisible();

  await page.getByRole('button', { name: '新增条目', exact: true }).click();
  await page.getByRole('radio', { name: '网站与应用', exact: true }).check();
  await page.getByLabel('名称 *', { exact: true }).fill('包内实测');
  await page.getByLabel('用户名 / 账号', { exact: true }).fill('demo-account');
  await page.getByLabel('网站 / 应用地址', { exact: true }).fill('https://example.invalid/login');
  await page.getByLabel('密码', { exact: true }).fill(SECRET);
  await page.getByRole('button', { name: '保存条目', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.locator('.detail-identity h2')).toHaveText('包内实测');

  const secretField = page.locator('.detail-field').filter({ has: page.locator('.field-label', { hasText: /^密码$/ }) });
  await expect(secretField.locator('.field-value')).toHaveClass(/masked/);
  await page.getByRole('button', { name: '显示密码', exact: true }).click();
  expect(await secretField.locator('.field-value').textContent()).toBe(SECRET);
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  await page.getByRole('button', { name: '复制密码', exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(SECRET);

  await page.getByRole('button', { name: '设置与备份', exact: true }).click();
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出备份', exact: true }).click();
  const source = await readFile((await (await downloadEvent).path())!, 'utf8');
  expect(JSON.parse(source).cipher).toBe('aes-256-gcm');
  expect(source.includes(SECRET)).toBe(false);
  await page.screenshot({ path: info.outputPath('settings.png'), fullPage: true });

  await page.getByRole('button', { name: '锁定', exact: true }).click();
  await expect(page.getByRole('heading', { name: '欢迎回来' })).toBeVisible();
  await page.getByLabel('主密码', { exact: true }).fill(MASTER);
  await submit(page, '解锁保管库');
  await expect(page.locator('.entry-row')).toHaveCount(1);
  await expect(page.locator('.entry-row')).toContainText('包内实测');

  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
  expect(foreignRequests).toEqual([]);
  expect(pageErrors).toEqual([]);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.entry-row').first().click();
  await expect(page.getByRole('button', { name: '返回列表' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('mobile.png'), fullPage: true });
});
