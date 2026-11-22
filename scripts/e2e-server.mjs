// The e2e test server: the demo plus a "replay" target that plays back a
// recorded TK5 session (and "tk5" if HERCULES_HOST is set, for live tests).
import { resolve } from 'node:path';
import { startDemoServer } from './serve-demo.mjs';
import { startTraceHost } from './trace-host.mjs';

const root = resolve(import.meta.dirname, '..');
const replay = await startTraceHost(resolve(root, 'test/traces/tk5/ispf-tour.json'));
const targets = { replay: { host: '127.0.0.1', port: replay.address().port } };
if (process.env.HERCULES_HOST) {
  targets.tk5 = {
    host: process.env.HERCULES_HOST,
    port: Number(process.env.HERCULES_PORT ?? 3270),
  };
}
const port = Number(process.env.E2E_PORT ?? 5271);
await startDemoServer({ port, targets });
console.log(`e2e server on http://127.0.0.1:${port}, targets: ${Object.keys(targets).join(', ')}`);
