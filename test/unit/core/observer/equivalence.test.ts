/**
 * The observer's screen must match a Terminal fed the same host bytes, after
 * every host record of every recorded trace: TK5 (monochrome, colour, models
 * 2-5), OS/390 2.10 over TN3270E, and the synthetic outlining screen. What
 * the operator sent is put back on both (applyInbound), as the recording
 * terminal's own screen showed it.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyInbound, parseInbound } from '../../../../src/core/inbound/index.js';
import { SessionObserver } from '../../../../src/core/observer/index.js';
import type { Screen } from '../../../../src/core/screen/index.js';
import { Terminal } from '../../../../src/core/terminal.js';
import type { Trace } from '../../../../src/core/trace/index.js';
import { FakeHost, frame } from '../../../helpers/fake-host.js';

const root = new URL('../../../traces/', import.meta.url);
const traces = readdirSync(root, { recursive: true })
  .map(String)
  .filter((f) => f.endsWith('.json'));

/** Every cell's character, field attribute and extended attributes, plus size and cursor. */
function snapshot(s: Screen): string {
  const cells: string[] = [];
  for (let a = 0; a < s.size; a++) {
    const x = s.attributesAt(a);
    cells.push(
      `${s.fieldAttributeAt(a) ?? '-'}:${s.charAt(a)}:${x.foreground}:${x.background}:${x.highlighting}:${x.charset}`,
    );
  }
  return `${s.rows}x${s.cols}@${s.cursor}|${cells.join(',')}`;
}

describe('SessionObserver matches Terminal on every recorded trace', () => {
  it.each(traces)('%s', (name) => {
    const trace = JSON.parse(readFileSync(new URL(name, root), 'utf8')) as Trace;
    const color = /3279/.test(trace.meta.terminalType);
    const options = { model: trace.meta.model, codePage: trace.meta.codePage, color };
    const observer = new SessionObserver(options);
    const term = new Terminal({ ...options, terminalType: trace.meta.terminalType });
    const host = new FakeHost();
    void term.connect(host).catch(() => undefined);

    let compared = 0;
    for (const e of trace.events) {
      const bytes = e.kind === 'record' ? frame(e.hex) : e.hex;
      const chunk = Uint8Array.from(Buffer.from(bytes, 'hex'));
      if (e.dir === 'terminal') {
        observer.terminal(chunk);
        if (e.kind === 'record') {
          const record = Buffer.from(e.hex, 'hex');
          const body = term.tn3270e ? (record[0] === 0 ? record.subarray(5) : undefined) : record;
          if (body?.length) applyInbound(term.screen, parseInbound(body, term.screen.size));
        }
        continue;
      }
      observer.host(chunk);
      host.write(chunk);
      if (e.kind !== 'record') continue;
      expect(snapshot(observer.screen), `${name}, host record ${compared}`).toBe(
        snapshot(term.screen),
      );
      compared++;
    }
    expect(compared).toBeGreaterThan(0);
    expect(observer.text).toEqual(term.text);
    expect(observer.tn3270e).toBe(Boolean(term.tn3270e));
  });
});
