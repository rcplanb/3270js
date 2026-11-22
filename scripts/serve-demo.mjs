// Serves the demo page and the built library, and bridges WebSockets to
// named TN3270 targets. Shared by `npm run dev` and the e2e test server.
import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { createWebSocketProxy } from '../dist/node.js';

const root = resolve(import.meta.dirname, '..');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};
// Only these directories are served.
const MOUNTS = { '/dist/': join(root, 'dist'), '/': join(root, 'demo') };

/**
 * @param {{ port: number, host?: string, targets: Record<string, {host: string, port: number}>, log?: boolean, debug?: boolean }} o
 */
export async function startDemoServer(o) {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/targets.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify(
          Object.fromEntries(Object.entries(o.targets).map(([k, t]) => [k, `${t.host}:${t.port}`])),
        ),
      );
      return;
    }
    const [prefix, dir] = Object.entries(MOUNTS).find(([p]) => url.pathname.startsWith(p));
    const rel = normalize(decodeURIComponent(url.pathname.slice(prefix.length)) || 'index.html');
    const file = join(dir, rel === '.' ? 'index.html' : rel);
    if (!file.startsWith(dir + '/') && file !== dir) {
      res.writeHead(403).end();
      return;
    }
    try {
      if (!statSync(file).isFile()) throw new Error('not a file');
      res.writeHead(200, {
        'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      });
      createReadStream(file).pipe(res);
    } catch {
      res.writeHead(404).end('not found');
    }
  });

  await createWebSocketProxy({
    server,
    targets: o.targets,
    path: '/tn3270',
    onSession(session) {
      if (!o.log) return;
      const n = { host: 0, terminal: 0 };
      const t0 = Date.now();
      console.log(`session open (${session.target})`);
      session.onTraffic((dir, data) => {
        n[dir] += data.length;
        if (o.debug)
          console.log(
            `  +${Date.now() - t0}ms ${dir}: ${Buffer.from(data).toString('hex').slice(0, 48)}`,
          );
      });
      session.onEnd((reason) =>
        console.log(
          `session closed after ${Date.now() - t0}ms (${reason}): ${n.host} bytes from host, ${n.terminal} from terminal`,
        ),
      );
    },
  });
  await new Promise((r) => server.listen(o.port, o.host ?? '127.0.0.1', r));
  return server;
}
