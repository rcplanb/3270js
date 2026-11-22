// The e2e test server: the demo plus "replay" targets that play back recorded
// TK5 sessions (model 2, and model 5 in colour) (and "tk5" if HERCULES_HOST is set, for live tests).
import { resolve } from 'node:path';
import { startDemoServer } from './serve-demo.mjs';
import { startTraceHost } from './trace-host.mjs';

const root = resolve(import.meta.dirname, '..');
const replay = await startTraceHost(resolve(root, 'test/traces/tk5/ispf-tour.json'));
// Model 5 (27x132), recorded in colour: ISPF switches to the alternate size with EWA.
const replay5 = await startTraceHost(resolve(root, 'test/traces/tk5/ispf-tour-3279-5.json'));
// A synthetic screen of outlined and transparent fields.
const outlining = await startTraceHost(resolve(root, 'test/traces/synthetic/outlining.json'));
const targets = {
  replay: { host: '127.0.0.1', port: replay.address().port },
  outlining: { host: '127.0.0.1', port: outlining.address().port },
  'replay-model5': { host: '127.0.0.1', port: replay5.address().port },
};
if (process.env.HERCULES_HOST) {
  targets.tk5 = {
    host: process.env.HERCULES_HOST,
    port: Number(process.env.HERCULES_PORT ?? 3270),
  };
}
const port = Number(process.env.E2E_PORT ?? 5271);
await startDemoServer({ port, targets });
console.log(`e2e server on http://127.0.0.1:${port}, targets: ${Object.keys(targets).join(', ')}`);
