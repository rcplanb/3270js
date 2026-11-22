/** Replays of real OS/390 2.10 TN3270E sessions (the museum's Multiprise 3000). */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type Trace, replayTrace } from '../../../../src/core/trace/index.js';

const load = (name: string) =>
  JSON.parse(
    readFileSync(new URL(`../../../traces/os390/${name}`, import.meta.url), 'utf8'),
  ) as Trace;

describe('OS/390 2.10 TN3270E traces', () => {
  it('negotiates TN3270E, takes the telnet server BIND and shows the USS screen', () => {
    const { session, final } = replayTrace(load('uss-screen.json'));
    expect(session.tn3270e).toMatchObject({ luName: 'SC0TCP01', functions: [0, 2, 4] });
    expect(session.bind?.plu).toBe('TELNET');
    expect(final.text.join('\n')).toContain('OS/390 APPLICATION SERVICES SYSTEM - RELEASE 2.10.0');
    expect(final.text[14]).toContain('TERMINAL NAME = SC0TCP01');
  });

  it('follows LOGON through the UNBIND to the TSO BIND', () => {
    const { session } = replayTrace(load('tso-logon-unanswered.json'));
    expect(session.mode).toBe('lu-lu');
    expect(session.bind?.plu).toBe('A06TSO01');
  });
});
