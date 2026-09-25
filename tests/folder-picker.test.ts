import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, sep } from 'node:path';
import { request } from 'node:http';
import test, { type TestContext } from 'node:test';
import { buildApp } from '../server/app.js';
import type { FolderPicker } from '../server/folder-picker.js';

const origin = 'http://127.0.0.1:43871';
const endpoint = '/api/storage-location/select-folder';
const password = 'folder-picker-test-only-master-password';
const headers = { host: new URL(origin).host, origin, 'x-vault-client': 'local-web' };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function promptly<T>(promise: PromiseLike<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Request blocked behind the native picker')), 3000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Snapshot only this test's temporary tree, including unexpected configuration files.
async function snapshot(directory: string, prefix = ''): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const key = `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      result[`${key}/`] = 'directory';
      Object.assign(result, await snapshot(join(directory, entry.name), `${key}/`));
    } else {
      result[key] = (await readFile(join(directory, entry.name))).toString('hex');
    }
  }
  return result;
}

async function fixture(t: TestContext, folderPicker: FolderPicker, release = () => {}) {
  const root = await mkdtemp(join(tmpdir(), 'vault-folder-picker-'));
  const directory = join(root, 'data');
  const selected = join(root, '中文 空格目录');
  let clock = 1_800_000_000_000;
  const app = buildApp({ directory, origin, folderPicker, now: () => clock });
  t.after(async () => {
    release();
    try { await app.close(); } finally { await rm(root, { recursive: true, force: true }); }
  });
  await mkdir(directory);
  await mkdir(selected);
  const created = await app.inject({ method: 'POST', url: '/api/create', headers, payload: { password } });
  assert.equal(created.statusCode, 200, created.body);
  const session = created.json<{ token: string; expiresAt: number }>();
  const auth = { ...headers, authorization: `Bearer ${session.token}` };
  return {
    root, directory, selected, app, session, auth,
    setNow: (value: number) => { clock = value; },
    select: (requestHeaders = auth) => app.inject({ method: 'POST', url: endpoint, headers: requestHeaders }),
  };
}

function heldPicker() {
  const started = deferred<{ initialDirectory: string; signal: AbortSignal }>();
  const result = deferred<string | null>();
  let calls = 0;
  const picker: FolderPicker = (initialDirectory, signal) => {
    calls++;
    started.resolve({ initialDirectory, signal });
    // Deliberately ignore abort: the service must reject a helper's stale result.
    return result.promise;
  };
  return { picker, started, result, calls: () => calls };
}

function assertFailure(response: { statusCode: number; body: string; json: () => any }, status: number, code: string) {
  assert.equal(response.statusCode, status, response.body);
  assert.equal(response.json().code, code, response.body);
  assert.equal(response.json().directory, undefined);
}

test('unauthorized and cross-origin requests never launch the folder picker', { timeout: 15000 }, async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; return null; });
  const before = await snapshot(f.root);
  assertFailure(await f.app.inject({ method: 'POST', url: endpoint, headers }), 401, 'LOCKED');
  for (const authorization of ['Bearer invalid', `Bearer ${'A'.repeat(43)}`, `Basic ${f.session.token}`]) {
    assertFailure(await f.app.inject({ method: 'POST', url: endpoint, headers: { ...headers, authorization } }), 401, 'LOCKED');
  }
  assertFailure(await f.select({ ...f.auth, origin: 'https://other.example' }), 403, 'FORBIDDEN_ORIGIN');
  assertFailure(await f.app.inject({ method: 'POST', url: endpoint, headers: { ...f.auth, 'sec-fetch-site': 'cross-site' } }), 403, 'FORBIDDEN_CLIENT');
  assertFailure(await f.select({ ...f.auth, host: 'other.example' }), 403, 'FORBIDDEN_HOST');
  assertFailure(await f.app.inject({ method: 'POST', url: endpoint, headers: { host: headers.host, origin, authorization: f.auth.authorization } }), 403, 'FORBIDDEN_CLIENT');
  assert.equal(calls, 0);
  assert.deepEqual(await snapshot(f.root), before);
});

test('selection returns a canonical existing absolute directory; cancel returns null without writes', { timeout: 15000 }, async t => {
  let chosen: string | null = null;
  const inputs: { directory: string; signal: AbortSignal }[] = [];
  const f = await fixture(t, async (directory, signal) => { inputs.push({ directory, signal }); return chosen; });
  const before = await snapshot(f.root);
  chosen = `${f.selected}${sep}..${sep}中文 空格目录${sep}.${sep}`;
  const selected = await f.select();
  assert.equal(selected.statusCode, 200, selected.body);
  assert.deepEqual(selected.json(), { directory: await realpath(f.selected) });
  assert.ok(isAbsolute(selected.json().directory));
  assert.equal(inputs[0].directory, f.directory);
  assert.equal(inputs[0].signal.aborted, false);
  assert.deepEqual(await snapshot(f.root), before);
  chosen = null;
  const cancelled = await f.select();
  assert.equal(cancelled.statusCode, 200, cancelled.body);
  assert.deepEqual(cancelled.json(), { directory: null });
  assert.equal(inputs.length, 2);
  assert.deepEqual(await snapshot(f.root), before);
  const status = await f.app.inject({ method: 'GET', url: '/api/status', headers: f.auth });
  assert.equal(status.statusCode, 200);
  assert.equal(status.json().unlocked, true);
  assert.equal(status.json().storagePath, join(f.directory, 'vault.pvlt'));
});

test('an open picker returns PICKER_BUSY for another request but does not block status or lock', { timeout: 15000 }, async t => {
  const held = heldPicker();
  const f = await fixture(t, held.picker, () => held.result.resolve(null));
  const before = await snapshot(f.root);
  const pending = f.select().then(response => response);
  const { signal } = await promptly(held.started.promise);
  assert.equal(signal.aborted, false);
  assertFailure(await promptly(f.select()), 409, 'PICKER_BUSY');
  assert.equal(held.calls(), 1);
  const status = await promptly(f.app.inject({ method: 'GET', url: '/api/status', headers: f.auth }));
  assert.equal(status.statusCode, 200);
  assert.equal(status.json().unlocked, true);
  const locked = await promptly(f.app.inject({ method: 'POST', url: '/api/lock', headers: f.auth }));
  assert.equal(locked.statusCode, 200, locked.body);
  assert.equal(signal.aborted, true);
  held.result.resolve(f.selected);
  assertFailure(await promptly(pending), 401, 'LOCKED');
  assertFailure(await f.select(), 401, 'LOCKED');
  assert.equal(held.calls(), 1);
  assert.deepEqual(await snapshot(f.root), before);
});

test('disconnecting the HTTP request cancels its native picker without locking the vault', { timeout: 15000 }, async t => {
  const started = deferred<void>();
  const aborted = deferred<void>();
  const f = await fixture(t, async (_directory, signal) => {
    started.resolve();
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { aborted.resolve(); reject(new Error('cancelled')); }, { once: true });
    });
  });
  const address = await f.app.listen({ port: 0, host: '127.0.0.1' });
  const controller = new AbortController();
  const pending = new Promise<void>((resolve, reject) => {
    const outgoing = request(`${address}${endpoint}`, { method: 'POST', headers: f.auth, signal: controller.signal }, response => {
      response.resume();
      response.once('end', () => reject(new Error(`Picker completed before disconnect: ${response.statusCode}`)));
    });
    outgoing.on('error', error => controller.signal.aborted ? resolve() : reject(error));
    outgoing.end();
  });
  try {
    await promptly(started.promise);
    controller.abort();
    await promptly(aborted.promise);
    await pending;
    const status = await f.app.inject({ method: 'GET', url: '/api/status', headers: f.auth });
    assert.equal(status.statusCode, 200);
    assert.equal(status.json().unlocked, true);
  } finally {
    controller.abort();
    await pending;
  }
});

for (const invalidate of ['expiry-status', 'expiry-on-result', 'new-unlock', 'lock-then-unlock'] as const) {
  test(`${invalidate} aborts the picker and rejects stale results`, { timeout: 15000 }, async t => {
    const held = heldPicker();
    const f = await fixture(t, held.picker, () => held.result.resolve(null));
    const before = await snapshot(f.root);
    const pending = f.select().then(response => response);
    const { signal } = await promptly(held.started.promise);
    let nextAuth = f.auth;
    if (invalidate.startsWith('expiry')) {
      f.setNow(f.session.expiresAt);
      if (invalidate === 'expiry-status') {
        const status = await promptly(f.app.inject({ method: 'GET', url: '/api/status', headers: f.auth }));
        assert.equal(status.statusCode, 200);
        assert.equal(status.json().unlocked, false);
        assert.equal(signal.aborted, true);
      }
    } else {
      if (invalidate === 'lock-then-unlock') {
        const locked = await promptly(f.app.inject({ method: 'POST', url: '/api/lock', headers: f.auth }));
        assert.equal(locked.statusCode, 200, locked.body);
        assert.equal(signal.aborted, true);
      }
      f.setNow(1_800_000_001_001);
      const unlocked = await promptly(f.app.inject({ method: 'POST', url: '/api/unlock', headers, payload: { password } }));
      assert.equal(unlocked.statusCode, 200, unlocked.body);
      assert.notEqual(unlocked.json().token, f.session.token);
      nextAuth = { ...headers, authorization: `Bearer ${unlocked.json().token}` };
      assert.equal(signal.aborted, true);
    }
    held.result.resolve(f.selected);
    assertFailure(await promptly(pending), 401, 'LOCKED');
    assert.equal(signal.aborted, true);
    assert.deepEqual(await snapshot(f.root), before);
    if (!invalidate.startsWith('expiry')) {
      const fresh = await f.select(nextAuth);
      assert.equal(fresh.statusCode, 200, fresh.body);
      assert.deepEqual(fresh.json(), { directory: await realpath(f.selected) });
      assert.equal(held.calls(), 2);
      assert.deepEqual(await snapshot(f.root), before);
    }
  });
}

test('invalid paths and helper failures fail safely and release the picker slot', { timeout: 15000 }, async t => {
  let chosen: string | null = null;
  let helperError: Error | undefined;
  const f = await fixture(t, async () => { if (helperError) throw helperError; return chosen; });
  const ordinaryFile = join(f.root, 'not-a-directory.txt');
  await writeFile(ordinaryFile, 'test fixture, not a vault');
  const before = await snapshot(f.root);
  const cases: [string, string, number, string][] = [
    ['empty', '', 400, 'INVALID_DIRECTORY'],
    ['relative', 'not-an-absolute-directory', 400, 'INVALID_DIRECTORY'],
    ['NUL', `${f.selected}\0`, 400, 'INVALID_DIRECTORY'],
    ['ordinary file', ordinaryFile, 400, 'INVALID_DIRECTORY'],
    ['missing directory', join(f.root, 'does-not-exist'), 503, 'PICKER_FAILED'],
  ];
  for (const [name, value, status, code] of cases) {
    await t.test(name, async () => {
      chosen = value;
      const response = await f.select();
      assertFailure(response, status, code);
      assert.ok(!response.body.includes(f.root));
      assert.deepEqual(await snapshot(f.root), before);
      chosen = null;
      const retry = await f.select();
      assert.equal(retry.statusCode, 200, retry.body);
      assert.deepEqual(retry.json(), { directory: null });
    });
  }
  await t.test('helper rejection hides internal errors', async () => {
    helperError = new Error(`private-helper-detail: ${f.selected}`);
    const failed = await f.select();
    assertFailure(failed, 503, 'PICKER_FAILED');
    assert.ok(!failed.body.includes('private-helper-detail'));
    assert.ok(!failed.body.includes(f.selected));
    helperError = undefined;
    chosen = f.selected;
    const retry = await f.select();
    assert.equal(retry.statusCode, 200, retry.body);
    assert.deepEqual(retry.json(), { directory: await realpath(f.selected) });
    assert.deepEqual(await snapshot(f.root), before);
  });
});
