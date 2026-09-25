import { expect, test, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MASTER = 'Vault-UI-Test-2026-only';
// Ticket "changes the master password" rotates the default profile's password; later tests must use it.
const ROTATED = 'Vault-UI-Rotated-2026-confirmed';
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

// Selecting a profile is client-side state, so this must not reload the page.
async function unlockInPlace(page: Page, password: string) {
  await page.getByLabel('主密码', { exact: true }).fill(password);
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
  const selection = page.getByLabel('新存储目录', { exact: true });
  const submit = page.getByRole('button', { name: '迁移并使用新位置', exact: true });
  const choose = page.getByRole('button', { name: '选择文件夹', exact: true });
  await expect(selection).toHaveText('尚未选择文件夹');
  await expect(page.getByRole('dialog').getByRole('textbox')).toHaveCount(0);
  await expect(submit).toBeDisabled();
  let chosenDirectory: string | null = null;
  await page.route('**/api/storage-location/select-folder', route => route.fulfill({ json: { directory: chosenDirectory } }));
  await choose.click();
  await expect(page.getByText('已取消选择，存储位置未改变。')).toBeVisible();
  await expect(submit).toBeDisabled();

  const occupied = join(directory, 'already-occupied');
  await mkdir(occupied);
  await writeFile(join(occupied, 'vault.pvlt'), 'existing-file-must-stay');
  chosenDirectory = occupied;
  await choose.click();
  await expect(selection).toHaveText(occupied);
  page.once('dialog', dialog => dialog.accept());
  await submit.click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('已存在');
  expect(await readFile(join(occupied, 'vault.pvlt'), 'utf8')).toBe('existing-file-must-stay');

  const originalPath = join(directory, 'vault.pvlt');
  const original = await readFile(originalPath);
  const target = join(await realpath(directory), '自定义 目录');
  await mkdir(target);
  chosenDirectory = target;
  await choose.click();
  await expect(selection).toHaveText(target);
  chosenDirectory = null;
  await choose.click();
  await expect(page.getByText('已取消选择，存储位置未改变。')).toBeVisible();
  await expect(selection).toHaveText(target);
  page.once('dialog', dialog => dialog.dismiss());
  await submit.click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(selection).toHaveText(target);
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
  await expect(choose).toBeVisible();
  await expect(selection).toHaveText('尚未选择文件夹');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('storage-mobile.png'), fullPage: true });
});

test('a delayed migration response cannot unlock the page after a manual lock', async ({ page }) => {
  await unlock(page);
  await page.getByRole('button', { name: '设置与备份', exact: true }).click();
  await page.getByRole('button', { name: '修改存储位置', exact: true }).click();
  const target = join(await realpath(directory), 'delayed-response-target');
  await mkdir(target);
  await page.route('**/api/storage-location/select-folder', route => route.fulfill({ json: { directory: target } }));
  await page.getByRole('button', { name: '选择文件夹', exact: true }).click();
  await expect(page.getByLabel('新存储目录', { exact: true })).toHaveText(target);
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

test('folder selection errors can retry and closing or locking discards late selections', async ({ page }) => {
  await unlock(page);
  await page.getByRole('button', { name: '设置与备份', exact: true }).click();
  const open = page.getByRole('button', { name: '修改存储位置', exact: true });
  await open.click();
  let selectionRequests = 0;
  let release!: () => void;
  let waiting = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/storage-location/select-folder', async route => {
    selectionRequests++;
    if (selectionRequests === 1) {
      await route.fulfill({ status: 503, json: { code: 'PICKER_FAILED', message: '无法打开文件夹选择窗口，请重试。' } });
      return;
    }
    await waiting;
    await route.fulfill({ json: { directory: directory } }).catch(() => undefined);
  });
  await page.getByRole('button', { name: '选择文件夹', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('请重试');
  await page.getByRole('button', { name: '选择文件夹', exact: true }).click();
  await expect(page.getByRole('button', { name: '等待选择文件夹…', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '迁移并使用新位置', exact: true })).toBeDisabled();
  await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
  release();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await open.click();
  await expect(page.getByLabel('新存储目录', { exact: true })).toHaveText('尚未选择文件夹');
  waiting = new Promise<void>(resolve => { release = resolve; });
  await page.getByRole('button', { name: '选择文件夹', exact: true }).click();
  await expect.poll(() => selectionRequests).toBe(3);
  await page.getByRole('button', { name: '立即锁定并丢弃未保存内容', exact: true }).click();
  release();
  await expect(page.getByRole('heading', { name: '欢迎回来' })).toBeVisible();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.locator('.entry-row')).toHaveCount(0);
});

test('entry forms stay centered with keyboard focus, fixed actions and unsaved-change protection', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await unlock(page);
  const centered = async () => {
    const dialog = page.getByRole('dialog');
    const box = await dialog.boundingBox();
    const viewport = page.viewportSize()!;
    expect(box).not.toBeNull();
    expect(Math.abs(box!.x + box!.width / 2 - viewport.width / 2)).toBeLessThan(2);
    expect(Math.abs(box!.y + box!.height / 2 - viewport.height / 2)).toBeLessThan(2);
    expect(box!.x).toBeGreaterThanOrEqual(15);
    expect(box!.y).toBeGreaterThanOrEqual(15);
    const footer = dialog.locator('.modal-footer');
    const before = await footer.boundingBox();
    await expect(dialog.getByRole('button', { name: '保存条目', exact: true })).toBeInViewport();
    await dialog.locator('.modal-body').evaluate(element => { element.scrollTop = element.scrollHeight; });
    expect(await dialog.locator('.modal-body').evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    const after = await footer.boundingBox();
    expect(Math.abs(before!.y - after!.y)).toBeLessThan(1);
    await expect(dialog.getByRole('button', { name: '保存条目', exact: true })).toBeInViewport();
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await dialog.locator('.modal-body').evaluate(element => { element.scrollTop = 0; });
  };

  await openEditor(page, '网站与应用');
  await centered();
  const name = page.getByLabel('名称 *', { exact: true });
  await name.focus();
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('用户名 / 账号', { exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('网站 / 应用地址', { exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('密码', { exact: true })).toBeFocused();
  await name.focus();
  await page.screenshot({ path: info.outputPath('centered-create-desktop.png'), fullPage: true });
  await name.fill('不应保存的居中弹窗草稿');
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
  await expect(name).toHaveValue('不应保存的居中弹窗草稿');
  page.once('dialog', dialog => dialog.accept());
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.getByRole('button', { name: '新增条目', exact: true })).toBeFocused();

  await page.locator('.entry-row').filter({ hasText: '网站测试-已编辑' }).click();
  await page.getByRole('button', { name: '编辑条目', exact: true }).click();
  await expect(name).toBeFocused();
  await expect(name).toHaveValue('网站测试-已编辑');
  await centered();
  await page.screenshot({ path: info.outputPath('centered-edit-desktop.png'), fullPage: true });
  await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();

  for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 568 }, { width: 1280, height: 600 }]) {
    await page.setViewportSize(viewport);
    await openEditor(page, 'API 凭据');
    await centered();
    await page.screenshot({ path: info.outputPath(`centered-create-${viewport.width}.png`), fullPage: true });
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible();
  }
  expect(errors).toEqual([]);
});

test('changes the master password from settings and reopens the vault with the new one', async ({ page }) => {
  const rotated = ROTATED;
  await page.setViewportSize({ width: 1440, height: 1000 });
  await unlock(page);
  await page.getByRole('button', { name: '全部条目', exact: false }).click();
  const namesBefore = await page.locator('.entry-row strong').allTextContents();
  expect(namesBefore.length).toBeGreaterThan(0);
  await page.getByRole('button', { name: '设置与备份', exact: true }).click();
  await page.getByRole('button', { name: '修改主密码', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: '修改主密码', exact: true })).toBeVisible();
  await expect(dialog.getByText('必须提供当前主密码', { exact: false })).toBeVisible();

  await page.getByLabel('当前主密码', { exact: true }).fill(MASTER);
  await page.getByLabel('新主密码', { exact: true }).fill('short');
  await page.getByLabel('确认新主密码', { exact: true }).fill('short');
  await page.getByRole('button', { name: '确认修改', exact: true }).click();
  await expect.poll(() => page.getByLabel('新主密码', { exact: true }).evaluate((input: HTMLInputElement) => !input.checkValidity())).toBe(true);
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByLabel('当前主密码', { exact: true })).toHaveValue(MASTER);

  await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.getByRole('button', { name: '修改主密码', exact: true }).click();
  await expect(page.getByLabel('当前主密码', { exact: true })).toHaveValue('');

  await page.getByLabel('当前主密码', { exact: true }).fill(MASTER);
  await page.getByLabel('新主密码', { exact: true }).fill(rotated);
  await page.getByLabel('确认新主密码', { exact: true }).fill('Vault-UI-Typo-2026-confirmed');
  await page.getByRole('button', { name: '确认修改', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('两次输入的新主密码不一致');

  await page.getByLabel('当前主密码', { exact: true }).fill('not-the-master-password');
  await page.getByLabel('确认新主密码', { exact: true }).fill(rotated);
  await submitPassword(page, '确认修改');
  await expect(dialog.getByRole('alert')).toContainText('当前主密码不正确');

  await page.getByLabel('当前主密码', { exact: true }).fill(MASTER);
  await page.getByLabel('新主密码', { exact: true }).fill(MASTER);
  await page.getByLabel('确认新主密码', { exact: true }).fill(MASTER);
  await submitPassword(page, '确认修改');
  await expect(dialog.getByRole('alert')).toContainText('新主密码不能与当前主密码相同');

  await page.getByLabel('新主密码', { exact: true }).fill(rotated);
  await page.getByLabel('确认新主密码', { exact: true }).fill(rotated);
  await submitPassword(page, '确认修改');
  await expect(page.getByRole('heading', { name: '欢迎回来' })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('主密码已修改，请使用新主密码重新解锁');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await page.getByLabel('主密码', { exact: true }).fill(MASTER);
  await submitPassword(page, '解锁保管库');
  await expect(page.getByRole('alert')).toContainText('主密码不正确');
  await page.getByLabel('主密码', { exact: true }).fill(rotated);
  await submitPassword(page, '解锁保管库');
  await expect(page.getByRole('button', { name: '新增条目', exact: true })).toBeVisible();
  await expect(page.locator('.entry-row strong').allTextContents()).resolves.toEqual(namesBefore);
});

const PROFILE_PASSWORD = 'Vault-UI-工作档-口令-2026';

test('creates an identity profile from the login page and keeps profiles apart', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(origin);
  await expect(page.getByRole('button', { name: '默认', exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('profile-picker.png'), fullPage: true });

  await page.getByRole('button', { name: '新建身份档', exact: true }).click();
  await page.getByLabel('身份档名称', { exact: true }).fill('工作');
  await page.getByLabel('设置主密码', { exact: true }).fill(PROFILE_PASSWORD);
  await page.getByLabel('确认主密码', { exact: true }).fill(PROFILE_PASSWORD);
  await page.getByRole('checkbox').check();
  await submitPassword(page, '创建并进入');
  await expect(page.getByRole('heading', { name: '从第一条密码开始' })).toBeVisible();
  await expect(page.locator('.sidebar-top .eyebrow')).toContainText('工作');

  await openEditor(page, '网站与应用');
  await page.getByLabel('名称 *', { exact: true }).fill('只有工作档看得见');
  await page.getByLabel('用户名 / 账号', { exact: true }).fill('profile-only');
  await save(page, '只有工作档看得见');

  await page.getByRole('button', { name: '锁定', exact: true }).click();
  await expect(page.getByRole('button', { name: '默认', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '工作', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '默认', exact: true }).click();
  await unlockInPlace(page, ROTATED);
  await page.getByRole('textbox', { name: '搜索名称、用户名或地址' }).fill('只有工作档看得见');
  await expect(page.locator('.entry-row')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '没有找到相关条目' })).toBeVisible();

  await page.getByRole('button', { name: '设置与备份', exact: true }).click();
  await page.getByLabel('默认身份档名称', { exact: true }).fill('个人');
  await page.getByRole('button', { name: '保存名称', exact: true }).click();
  await expect(page.locator('.notice-bar')).toContainText('默认身份档已改名为「个人」');
  await page.getByRole('button', { name: '锁定', exact: true }).click();
  await expect(page.getByRole('button', { name: '个人', exact: true })).toBeVisible();

  await page.getByRole('button', { name: '工作', exact: true }).click();
  await unlockInPlace(page, PROFILE_PASSWORD);
  await page.getByRole('textbox', { name: '搜索名称、用户名或地址' }).fill('只有工作档看得见');
  await expect(page.locator('.entry-row')).toHaveCount(1);
  await page.screenshot({ path: info.outputPath('profile-work.png'), fullPage: true });
});
