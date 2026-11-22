// Dev server: the demo page plus a proxy to a TN3270 host. Run with `npm run dev`.
//
//   HERCULES_HOST  TN3270 host (default 127.0.0.1)
//   HERCULES_PORT  default 3270
//   DEV_PORT       default 5270
//   DEV_HOST       interface to listen on (default 127.0.0.1)
//   DEV_DEBUG      log timed traffic
import { startDemoServer } from './serve-demo.mjs';

const host = process.env.HERCULES_HOST ?? '127.0.0.1';
const hostPort = Number(process.env.HERCULES_PORT ?? 3270);
const port = Number(process.env.DEV_PORT ?? 5270);
const listen = process.env.DEV_HOST ?? '127.0.0.1';

await startDemoServer({
  port,
  host: listen,
  targets: { tk5: { host, port: hostPort } },
  log: true,
  debug: Boolean(process.env.DEV_DEBUG),
});
console.log(`3270js demo: http://${listen === '0.0.0.0' ? 'localhost' : listen}:${port}`);
console.log(`  target tk5 -> ${host}:${hostPort}`);
