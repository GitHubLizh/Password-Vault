import { expect, test, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MASTER = 'Vault-UI-Test-2026-only';
const ACCOUNT_SECRET = '  UI-secret-中文-2026  ';
let server: ChildProcess;
let directory: string;
let origin: string;
let nextPasswordAttempt = 0;

async function submitPassword(page: Page, label: string) {
  if (Date.now() < nextPasswordAttempt) {
    await expect.poll(() => Date.now(), { intervals: [100], timeout: 2000 }).toBeGreaterThanOrEqual(nextPasswordAttempt);
  }
  nextPasswordAttempt = Date.now() + 1100;
  await page.getByRole('button', { name: label, exact: true }).click();
}

test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'password-vault-browser-'));
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  origin = `http://127.0.0.1:${port}`;
  await startTestServer();
});

async function startTestServer() {
  server = spawn(process.execPath, ['dist-server/server/index.js'], {
    cwd: process.cwd(), env: { ...process.env, VAULT_PORT: new URL(origin).port, VAULT_DATA_DIR: directory },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Test server startup timed out')), 15000);
    server.once('error', error => { clearTimeout(timeout); reject(error); });
    server.once('exit', code => { clearTimeout(timeout); reject(new Error(`Test server stopped: ${code}`)); });
    server.stdout!.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('本地密码库已启动')) { clearTimeout(timeout); resolve(); }
    });
  });
}
test.afterAll(async () => {
  if (server && server.exitCode === null) {
    const stopped = once(server, 'exit');
    server.kill();
    await stopped;
  }
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function unlock(page: Page) {
  await page.goto(origin);
  await page.getByLabel('主密码', { exact: true }).fill(MASTER);
  await submitPassword(page, '解锁保管库');
  await expect(page.getByRole('button', { name: '新增条目', exact: true })).toBeVisible();
}

async function openEditor(page: Page, type: '网站与应用' | '服务器' | 'API 凭据') {
  await page.getByRole('button', { name: '新增条目', exact: true }).click();
  await expect(page.getByLabel('名称 *', { exact: true })).toBeFocused();
  await page.getByRole('radio', { name: type, exact: true }).check();
}

async function save(page: Page, name: string) {
  await page.getByRole('button', { name: '保存条目', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.locator('.detail-identity h2')).toHaveText(name);
}

test('create and manage three credential types, copy and render safely at desktop/mobile sizes', async ({ page, context }, info) => {
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
  await submitPassword(page, '创建我的保管库');
  await expect(page.getByRole('heading', { name: '从第一条密码开始' })).toBeVisible();

  await openEditor(page, '网站与应用');
  await page.getByLabel('名称 *', { exact: true }).fill('网站测试');
  await page.getByLabel('用户名 / 账号', { exact: true }).fill('demo-account');
  await page.getByLabel('网站 / 应用地址', { exact: true }).fill('https://example.invalid/login');
  await page.getByLabel('密码', { exact: true }).fill(ACCOUNT_SECRET);
  await page.getByLabel('备注可选', { exact: true }).fill('<img src=x onerror="window.__unsafeNote=true">');
  await save(page, '网站测试');
  const secretField = page.locator('.detail-field').filter({ has: page.locator('.field-label', { hasText: /^密码$/ }) });
  await expect(secretField.locator('.field-value')).toHaveClass(/masked/);
  await page.getByRole('button', { name: '显示密码', exact: true }).click();
  expect(await secretField.locator('.field-value').textContent()).toBe(ACCOUNT_SECRET);
  await page.getByRole('button', { name: '隐藏密码', exact: true }).click();
  await page.getByRole('button', { name: '显示备注', exact: true }).click();
  await expect(page.locator('.detail-fields img')).toHaveCount(0);
  expect(await page.evaluate(() => '__unsafeNote' in window)).toBe(false);
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  await page.getByRole('button', { name: '复制密码', exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(ACCOUNT_SECRET);
  await page.getByRole('button', { name: '编辑条目', exact: true }).click();
  await page.getByLabel('名称 *', { exact: true }).fill('网站测试-已编辑');
  await save(page, '网站测试-已编辑');

  await openEditor(page, '服务器');
  await page.getByLabel('名称 *', { exact: true }).fill('服务器测试');
  await page.getByLabel('用户名 / 账号', { exact: true }).fill('demo-admin');
  await page.getByLabel('主机地址', { exact: true }).fill('192.0.2.10');
  await page.getByLabel('端口（可选）', { exact: true }).fill('65536');
  await page.getByLabel('密码', { exact: true }).fill('server-fixture-only');
  await page.getByRole('button', { name: '保存条目', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('1–65535');
  await page.getByLabel('端口（可选）', { exact: true }).fill('22');
  await save(page, '服务器测试');

  await openEditor(page, 'API 凭据');
  await page.getByLabel('名称 *', { exact: true }).fill('API测试');
  await page.getByLabel('标识 / Access Key ID（可选）', { exact: true }).fill('demo-access-id');
  await page.getByRole('button', { name: '保存条目', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('API Key 或 Secret');
  await page.getByLabel('API Key', { exact: true }).fill('api-fixture-only');
  await save(page, 'API测试');
  await expect(page.locator('.detail-fields')).toContainText('demo-access-id');

  const search = page.getByRole('textbox', { name: '搜索名称、用户名或地址' });
  await search.fill('api-fixture-only');
  await expect(page.locator('.entry-row')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '没有找到相关条目' })).toBeVisible();
  await search.fill('服务器测试');
  await expect(page.locator('.entry-row')).toHaveCount(1);
  await search.fill('');
  await expect(page.locator('.entry-row')).toHaveCount(3);
  await page.getByRole('button', { name: 'API 凭据 1', exact: true }).click();
  await expect(page.locator('.entry-row')).toHaveCount(1);
  await page.getByRole('button', { name: '全部条目 3', exact: true }).click();
  await page.locator('.entry-row').filter({ hasText: '网站测试-已编辑' }).click();
  await expect(page.locator('.entry-row.selected')).toContainText('网站测试-已编辑');
  await expect(page.locator('.detail-identity h2')).toHaveText('网站测试-已编辑');
  await page.screenshot({ path: info.outputPath('desktop.png'), fullPage: true });
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
  expect(foreignRequests).toEqual([]);
  expect(pageErrors).toEqual([]);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: '返回列表' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('mobile-detail.png'), fullPage: true });
  await page.getByRole('button', { name: '返回列表' }).click();
  await expect(page.locator('.entry-row')).toHaveCount(3);
  await page.locator('.entry-row').filter({ hasText: 'API测试' }).click();
  await expect(page.locator('.detail-identity h2')).toHaveText('API测试');
});

test('wrong passwords, refresh and a second page revoke only the old session', async ({ page, context }) => {
  await page.goto(origin);
  await page.getByLabel('主密码', { exact: true }).fill('not-the-master-password');
  await submitPassword(page, '解锁保管库');
  await expect(page.getByRole('alert')).toContainText('主密码不正确');
  await expect(page.getByLabel('主密码', { exact: true })).toHaveValue('');
  await expect(page.locator('.entry-row')).toHaveCount(0);
  await page.reload();
  await page.getByLabel('主密码', { exact: true }).fill(MASTER);
  await submitPassword(page, '解锁保管库');
  await expect(page.locator('.entry-row')).toHaveCount(3);
  await page.reload();
  await expect(page.getByRole('heading', { name: '欢迎回来' })).toBeVisible();
  await expect(page.locator('.entry-row')).toHaveCount(0);
  await page.getByLabel('主密码', { exact: true }).fill(MASTER);
  await submitPassword(page, '解锁保管库');
  await expect(page.locator('.entry-row')).toHaveCount(3);
  const other = await context.newPage();
  await unlock(other);
  await expect(page.getByRole('heading', { name: '欢迎回来' })).toBeVisible();
  await expect(other.locator('.entry-row')).toHaveCount(3);
  await page.close();
  await expect(other.getByRole('button', { name: '新增条目', exact: true })).toBeVisible();
  await other.getByRole('button', { name: '锁定', exact: true }).click();
  await expect(other.getByRole('heading', { name: '欢迎回来' })).toBeVisible();
});

test('download, reject broken backups, delete and restore with a safety copy', async ({ page }) => {
  await unlock(page);
  await page.getByRole('button', { name: '设置与备份', exact: true }).click();
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出备份', exact: true }).click();
  const download = await downloadEvent;
  const backupPath = await download.path();
  expect(backupPath).toBeTruthy();
  const source = await readFile(backupPath!, 'utf8');
  expect(JSON.parse(source).cipher).toBe('aes-256-gcm');
  expect(source.includes(ACCOUNT_SECRET)).toBe(false);
  await page.getByRole('button', { name: '恢复备份', exact: true }).click();
  await page.getByLabel('选择加密备份文件').setInputFiles({ name: 'broken.pvlt', mimeType: 'application/octet-stream', buffer: Buffer.from('{}') });
  await page.getByLabel('备份主密码', { exact: true }).fill(MASTER);
  await submitPassword(page, '验证并预览');
  await expect(page.getByRole('alert')).toContainText('文件不是受支持');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '全部条目 3', exact: true }).click();
  await page.locator('.entry-row').filter({ hasText: 'API测试' }).click();
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('button', { name: '删除此条目', exact: true }).click();
  await expect(page.locator('.entry-row')).toHaveCount(3);
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: '删除此条目', exact: true }).click();
  await expect(page.locator('.entry-row')).toHaveCount(2);
  await page.getByRole('button', { name: '设置与备份', exact: true }).click();
  await page.getByRole('button', { name: '恢复备份', exact: true }).click();
  await page.getByLabel('选择加密备份文件').setInputFiles(backupPath!);
  await page.getByLabel('备份主密码', { exact: true }).fill(MASTER);
  await submitPassword(page, '验证并预览');
  await expect(page.getByText('备份密码验证成功', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '确认恢复', exact: true })).toBeDisabled();
  await page.getByRole('checkbox').check();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: '确认恢复', exact: true }).click();
  await expect(page.locator('.entry-row')).toHaveCount(3);
  await expect(page.locator('.safety-path')).toContainText('before-restore-');
  const files = await readdir(directory);
  expect(files.filter(name => name.startsWith('before-restore-'))).toHaveLength(1);
});

test('idle lock removes an unsaved draft and a fresh session cannot recover it', async ({ page, browser }) => {
  await page.clock.install();
  await unlock(page);
  await page.locator('.entry-row').filter({ hasText: '网站测试-已编辑' }).click();
  await page.getByRole('button', { name: '显示密码', exact: true }).click();
  await expect(page.getByRole('button', { name: '隐藏密码', exact: true })).toBeVisible();
  await page.clock.fastForward(31000);
  await expect(page.getByRole('button', { name: '显示密码', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '设置与备份', exact: true }).click();
  await page.getByLabel('无操作等待时间', { exact: true }).selectOption('1');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(page.locator('.sidebar-footnote')).toContainText('1 分钟');
  await openEditor(page, '网站与应用');
  await page.getByLabel('名称 *', { exact: true }).fill('不应保存的草稿');
  await page.clock.fastForward(61000);
  await expect(page.getByRole('heading', { name: '欢迎回来' })).toBeVisible();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.locator('body')).not.toContainText('不应保存的草稿');
  const fresh = await browser.newContext();
  try {
    const reopened = await fresh.newPage();
    await unlock(reopened);
    await reopened.getByRole('textbox', { name: '搜索名称、用户名或地址' }).fill('不应保存的草稿');
    await expect(reopened.locator('.entry-row')).toHaveCount(0);
  } finally {
    await fresh.close();
  }
});

test('customize storage, protect existing files and remember the directory across server restarts', async ({ page }, info) => {
  await unlock(page);
  await page.getByRole('button', { name: '设置与备份', exact: true }).click();
  await page.getByRole('button', { name: '修改存储位置', exact: true }).click();
  const input = page.getByLabel('新存储目录', { exact: true });
  const submit = page.getByRole('button', { name: '迁移并使用新位置', exact: true });
  await input.fill('relative-directory');
  await submit.click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('绝对');
  await expect(input).toHaveValue('relative-directory');

  const occupied = join(directory, 'already-occupied');
  await mkdir(occupied);
  await writeFile(join(occupied, 'vault.pvlt'), 'existing-file-must-stay');
  await input.fill(occupied);
  page.once('dialog', dialog => dialog.accept());
  await submit.click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('已存在');
  expect(await readFile(join(occupied, 'vault.pvlt'), 'utf8')).toBe('existing-file-must-stay');

  const originalPath = join(directory, 'vault.pvlt');
  const original = await readFile(originalPath);
  const target = join(await realpath(directory), '自定义 目录');
  await input.fill(target);
  page.once('dialog', dialog => dialog.dismiss());
  await submit.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(input).toHaveValue(target);
  expect((await readdir(directory)).includes('storage-location.json')).toBe(false);
  await page.screenshot({ path: info.outputPath('storage-dialog.png'), fullPage: true });

  page.once('dialog', dialog => dialog.accept());
  await submit.click();
  await expect(page.getByRole('heading', { name: '欢迎回来' })).toBeVisible();
  await expect(page.locator('.storage-location code')).toHaveText(join(target, 'vault.pvlt'));
  expect((await readFile(originalPath)).equals(original)).toBe(true);
  expect((await readFile(join(target, 'vault.pvlt'))).equals(original)).toBe(true);
  expect(JSON.parse(await readFile(join(directory, 'storage-location.json'), 'utf8')).directory).toBe(target);
  await unlock(page);
  await expect(page.locator('.entry-row')).toHaveCount(3);
  await openEditor(page, '网站与应用');
  await page.getByLabel('名称 *', { exact: true }).fill('仅新目录中的条目');
  await page.getByLabel('用户名 / 账号', { exact: true }).fill('directory-test-user');
  await save(page, '仅新目录中的条目');
  expect((await readFile(originalPath)).equals(original)).toBe(true);
  expect((await readFile(join(target, 'vault.pvlt'))).equals(original)).toBe(false);

  await page.getByRole('button', { name: '锁定', exact: true }).click();
  await expect(page.getByRole('heading', { name: '欢迎回来' })).toBeVisible();
  const stopped = once(server, 'exit');
  server.kill();
  await stopped;
  await startTestServer();
  await unlock(page);
  await expect(page.locator('.entry-row')).toHaveCount(4);
  await page.getByRole('button', { name: '设置与备份', exact: true }).click();
  await expect(page.locator('.path-block')).toHaveText(join(target, 'vault.pvlt'));
  await page.screenshot({ path: info.outputPath('storage-settings.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '修改存储位置', exact: true }).click();
  await expect(input).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('storage-mobile.png'), fullPage: true });
});

test('a delayed migration response cannot unlock the page after a manual lock', async ({ page }) => {
  await unlock(page);
  await page.getByRole('button', { name: '设置与备份', exact: true }).click();
  await page.getByRole('button', { name: '修改存储位置', exact: true }).click();
  const target = join(await realpath(directory), 'delayed-response-target');
  await page.getByLabel('新存储目录', { exact: true }).fill(target);
  let deliver!: () => void;
  const delivery = new Promise<void>(resolve => { deliver = resolve; });
  let migrated = false;
  await page.route('**/api/storage-location', async route => {
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    migrated = true;
    await delivery;
    await route.fulfill({ response });
  });
  try {
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: '迁移并使用新位置', exact: true }).click();
    await expect.poll(() => migrated).toBe(true);
    await page.getByRole('button', { name: '立即锁定并丢弃未保存内容', exact: true }).click();
    await expect(page.getByRole('heading', { name: '欢迎回来' })).toBeVisible();
    deliver();
    await expect(page.locator('.storage-location code')).toHaveText(join(target, 'vault.pvlt'));
    await expect(page.locator('.entry-row')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: '欢迎回来' })).toBeVisible();
  } finally {
    deliver();
  }
});
