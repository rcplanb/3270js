// A TCP "host" that replays a recorded trace interactively: it sends the
// host's bytes up to the next point where the terminal sent a 3270 record,
// then waits for the connected terminal to send one before continuing. Real
// keystrokes in a browser therefore walk through a real recorded session.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';

const frame = (hex) => {
  const out = [];
  for (const b of Buffer.from(hex, 'hex')) {
    out.push(b);
    if (b === 0xff) out.push(0xff);
  }
  out.push(0xff, 0xef);
  return Buffer.from(out);
};

/** Split the trace into steps: host bytes to send, then whether to wait for a terminal record. */
function steps(trace) {
  const out = [];
  let pending = [];
  for (const e of trace.events) {
    if (e.dir === 'host')
      pending.push(e.kind === 'record' ? frame(e.hex) : Buffer.from(e.hex, 'hex'));
    else if (e.kind === 'record') {
      out.push({ send: Buffer.concat(pending), wait: true });
      pending = [];
    }
  }
  out.push({ send: Buffer.concat(pending), wait: false });
  return out;
}

export async function startTraceHost(tracePath, port = 0) {
  const plan = steps(JSON.parse(readFileSync(tracePath, 'utf8')));
  const server = createServer((sock) => {
    let i = 0;
    let buf = Buffer.alloc(0);
    const advance = () => {
      while (i < plan.length) {
        const s = plan[i++];
        if (s.send.length) sock.write(s.send);
        if (s.wait) return;
      }
    };
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      // Each IAC EOR from the terminal ends one record: take the next step.
      let at;
      while ((at = buf.indexOf(Buffer.from([0xff, 0xef]))) >= 0) {
        buf = buf.subarray(at + 2);
        advance();
      }
    });
    sock.on('error', () => undefined);
    advance();
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return server;
}
