// Dev server: serves the demo page and the built library, and bridges
// WebSockets to the TN3270 host. Run with `npm run dev`.
//
//   HERCULES_HOST  TN3270 host (default 127.0.0.1)
//   HERCULES_PORT  default 3270
//   DEV_PORT       default 5270
//   DEV_HOST       interface to listen on (default 127.0.0.1)
import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { createWebSocketProxy } from '../dist/node.js';

const root = resolve(import.meta.dirname, '..');
const host = process.env.HERCULES_HOST ?? '127.0.0.1';
const hostPort = Number(process.env.HERCULES_PORT ?? 3270);
const port = Number(process.env.DEV_PORT ?? 5270);
const listen = process.env.DEV_HOST ?? '127.0.0.1';
const targets = { tk5: { host, port: hostPort } };

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

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/targets.json') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify(
        Object.fromEntries(Object.entries(targets).map(([k, t]) => [k, `${t.host}:${t.port}`])),
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
  targets,
  path: '/tn3270',
  onSession(session) {
    const n = { host: 0, terminal: 0 };
    console.log(`session open (${session.target})`);
    const t0 = Date.now();
    session.onTraffic((dir, data) => {
      n[dir] += data.length;
      if (process.env.DEV_DEBUG)
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
server.listen(port, listen, () => {
  console.log(`3270js demo: http://${listen === '0.0.0.0' ? 'localhost' : listen}:${port}`);
  console.log(`  target tk5 -> ${host}:${hostPort}`);
});
