import Fastify from 'fastify';
import staticFiles from '@fastify/static';
import { VaultError } from './errors.js';
import { VaultService } from './vault.js';
import { StorageLocation } from './storage-location.js';
import type { FolderPicker } from './folder-picker.js';
import { record } from './validation.js';

interface AppOptions {
  directory: string;
  origin: string;
  staticDirectory?: string;
  now?: () => number;
  folderPicker?: FolderPicker;
}

export function buildApp(options: AppOptions) {
  const app = Fastify({ logger: false, bodyLimit: 128 * 1024, requestTimeout: 15000, connectionTimeout: 20000 });
  let service: VaultService;
  app.addHook('onReady', async () => {
    service = new VaultService(await StorageLocation.load(options.directory), options.now, options.folderPicker);
  });
  const authority = new URL(options.origin).host;

  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Cross-Origin-Resource-Policy', 'same-origin');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    reply.header('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'");
    if (request.headers.host !== authority) {
      throw new VaultError(403, 'FORBIDDEN_HOST', '请使用启动窗口中显示的本机地址访问。');
    }
    const origin = request.headers.origin;
    if (origin !== undefined && origin !== options.origin) {
      throw new VaultError(403, 'FORBIDDEN_ORIGIN', '不允许来自其他网页的请求。');
    }
    if (request.routeOptions.url?.startsWith('/api/')) {
      const site = request.headers['sec-fetch-site'];
      if (request.headers['x-vault-client'] !== 'local-web'
        || (site !== undefined && site !== 'same-origin' && site !== 'none')) {
        throw new VaultError(403, 'FORBIDDEN_CLIENT', '请通过本机密码库界面操作。');
      }
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof VaultError) {
      if (error.statusCode === 429) reply.header('Retry-After', '1');
      return reply.code(error.statusCode).send({ code: error.code, message: error.message });
    }
    const known = error as { statusCode?: number };
    if (known.statusCode && known.statusCode >= 400 && known.statusCode < 500) {
      return reply.code(known.statusCode).send({ code: 'INVALID_REQUEST', message: '请求格式不正确或内容过大，请检查后重试。' });
    }
    return reply.code(500).send({ code: 'STORAGE_ERROR', message: '操作失败，请检查数据目录权限和磁盘空间后重试；不会自动覆盖或新建密码库。' });
  });

  const token = (authorization: string | undefined) => authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;
  app.get('/api/status', request => service.run(() => service.status(token(request.headers.authorization))));
  app.get('/api/profiles', () => service.run(() => service.profiles()));
  app.post('/api/profiles', request => service.run(() => service.createProfile(request.body)));
  app.post('/api/profiles/default-name', request => service.run(() => service.renameDefaultProfile(token(request.headers.authorization), request.body)));
  app.delete('/api/profiles', request => service.run(() => service.deleteProfile(token(request.headers.authorization), request.body)));
  app.post('/api/create', request => service.run(() => service.create(record(request.body).password)));
  app.post('/api/unlock', request => service.run(() => service.unlock(request.body)));
  app.post('/api/master-password', request => service.run(() => service.changeMasterPassword(token(request.headers.authorization), request.body)));
  app.post('/api/lock', request => service.run(() => service.lock(token(request.headers.authorization))));
  app.post('/api/activity', request => service.run(() => service.activity(token(request.headers.authorization))));
  app.get('/api/vault', request => service.run(() => service.getVault(token(request.headers.authorization))));
  app.post('/api/entries', request => service.run(() => service.saveEntry(token(request.headers.authorization), request.body)));
  app.put<{ Params: { id: string } }>('/api/entries/:id', request => service.run(() => service.saveEntry(token(request.headers.authorization), request.body, request.params.id)));
  app.delete<{ Params: { id: string } }>('/api/entries/:id', request => service.run(() => service.deleteEntry(token(request.headers.authorization), request.body, request.params.id)));
  app.put('/api/settings', request => service.run(() => service.settings(token(request.headers.authorization), request.body)));
  app.post('/api/storage-location', request => service.run(() => service.changeStorageLocation(token(request.headers.authorization), request.body)));
  app.post('/api/storage-location/select-folder', async (request, reply) => {
    request.raw.socket?.setTimeout?.(135000);
    const controller = new AbortController();
    const abort = () => controller.abort();
    reply.raw.on('close', abort);
    try {
      return await service.selectStorageFolder(token(request.headers.authorization), controller.signal);
    } finally {
      reply.raw.off('close', abort);
      request.raw.socket?.setTimeout?.(20000);
    }
  });
  app.get('/api/backup', async (request, reply) => {
    const source = await service.run(() => service.backup(token(request.headers.authorization)));
    return reply.header('Content-Disposition', 'attachment; filename="password-vault.pvlt"')
      .type('application/octet-stream').send(Buffer.from(source));
  });
  app.post('/api/restore/preview', { bodyLimit: 12 * 1024 * 1024 }, request => service.run(() => service.previewRestore(request.body)));
  app.post('/api/restore/confirm', request => service.run(() => service.confirmRestore(request.body)));
  app.post('/api/restore/cancel', request => service.run(() => service.cancelRestore(request.body)));

  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ code: 'NOT_FOUND', message: '页面或接口不存在。' }));
  if (options.staticDirectory) {
    app.register(staticFiles, { root: options.staticDirectory, cacheControl: false, etag: false, lastModified: false, dotfiles: 'deny' });
  }
  app.addHook('preClose', async () => service?.dispose());
  return app;
}
