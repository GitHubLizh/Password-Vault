import { request } from 'node:http';

// Probes whether a vault service is already answering on this origin, so a second launch can
// open the running page instead of failing with a port-conflict error. Only our own response
// shape counts: another program on the same port must still surface the EADDRINUSE error.
// node:http with agent:false rather than fetch, because undici's keep-alive pool holds the
// event loop open long enough to trip a libuv assertion when the launcher tries to exit.
export function runningInstance(origin: string): Promise<boolean> {
  return new Promise(resolve => {
    const url = new URL('/api/status', origin);
    const req = request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'GET',
      headers: { 'x-vault-client': 'local-web' },
      agent: false,
      timeout: 2000,
    }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        response.destroy();
        if (response.statusCode !== 200) {
          resolve(false);
          return;
        }
        try {
          const value = JSON.parse(body) as Record<string, unknown>;
          resolve(typeof value.exists === 'boolean'
            && typeof value.unlocked === 'boolean'
            && typeof value.storagePath === 'string');
        } catch {
          resolve(false);
        }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
    req.end();
  });
}
