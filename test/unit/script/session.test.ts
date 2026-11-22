import { describe, expect, it } from 'vitest';
import { Terminal } from '../../../src/core/terminal.js';
import {
  ScriptError,
  Session,
  toIspfPrimary,
  tsoLogoff,
  tsoLogon,
  waitForLogonScreen,
} from '../../../src/script/index.js';
import { ReplayDriver, loadTrace } from '../../helpers/replay-driver.js';

async function replay(name: string) {
  const host = new ReplayDriver(loadTrace(name));
  const term = new Terminal();
  const connected = term.connect(host);
  host.start();
  await connected;
  return { host, term, s: new Session(term, { quietMs: 20, timeoutMs: 2_000 }) };
}

describe('Session and the TSO helpers, on the recorded TK5 logon', () => {
  it('logs on through *** to ISPF, then logs off to the logon screen', async () => {
    const { host, s } = await replay('tk5/tso-logon');
    await waitForLogonScreen(s);
    expect(s.state.kind).toBe('vtam-logon');
    await tsoLogon(s, { user: 'HERC01', password: 'NOTUSED' });
    expect(s.state.kind).toBe('ispf-primary');
    await tsoLogoff(s);
    expect(s.state.kind).toBe('vtam-logon');
    expect(host.remaining).toBe(0); // it sent exactly what the recorded session sent
  });
});

describe('Session, on the recorded ISPF tour', () => {
  it('fills fields by label, enters commands and waits for panels', async () => {
    const { s } = await replay('tk5/ispf-tour');
    await waitForLogonScreen(s);
    await tsoLogon(s, { user: 'HERC01', password: 'NOTUSED' });
    await s.command('3.4', 'ispf-panel');
    expect(s.state.title).toBe('RFE DSLIST');
    s.fill(/Data set name prefix/, 'SYS1.PROCLIB');
    await s.press('ENTER', /SYS1\.PROCLIB\s+TK5RES/);
    expect(s.screen).toContain('SYS1.PROCLIB');
    expect(() => s.fill(/No such label/, 'x')).toThrow(ScriptError);
  });

  it('times out with the screen in the message', async () => {
    const { s } = await replay('tk5/ispf-tour');
    await waitForLogonScreen(s);
    await expect(s.waitFor(/never on screen/, { timeoutMs: 100 })).rejects.toThrow(
      /timed out waiting for .*never on screen[\s\S]*Logon ===>/,
    );
  });

  it('rejects an unknown screen kind', () => {
    const s = new Session(new Terminal());
    expect(() => s.waitFor('nonsense' as 'more')).toThrow(/unknown screen kind/);
  });
});

void toIspfPrimary;
