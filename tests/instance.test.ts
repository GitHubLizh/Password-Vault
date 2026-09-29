import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildApp } from '../server/app.js';
import { runningInstance } from '../server/instance.js';

async function freePort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  return port;
}

async function withDecoy(respond: Server, operation: (origin: string) => Promise<void>) {
  respond.listen(0, '127.0.0.1');
  await once(respond, 'listening');
  try {
    await operation(`http://127.0.0.1:${(respond.address() as AddressInfo).port}`);
  } finally {
    await new Promise<void>((resolve, reject) => respond.close(error => error ? reject(error) : resolve()));
  }
}

test('a running vault service is recognised through its own status shape', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'local-vault-instance-test-'));
  const port = await freePort();
  const app = buildApp({ directory, origin: `http://127.0.0.1:${port}`, staticDirectory: join(process.cwd(), 'dist') });
  await app.listen({ host: '127.0.0.1', port });
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  assert.equal(await runningInstance(`http://127.0.0.1:${port}`), true);
});

test('another program on the port is not mistaken for the vault', async () => {
  await withDecoy(createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true }));
  }), async origin => assert.equal(await runningInstance(origin), false));

  await withDecoy(createServer((_request, response) => {
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ exists: false, unlocked: false, storagePath: '/tmp/vault.pvlt' }));
  }), async origin => assert.equal(await runningInstance(origin), false));

  assert.equal(await runningInstance(`http://127.0.0.1:${await freePort()}`), false);
});
