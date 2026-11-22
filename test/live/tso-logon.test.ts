/**
 * Checkpoint B: log on to TSO on a real TK5 system using only 3270js, reach
 * ISPF, exit to READY, log off. Prints every screen as text.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { TsoSession, env, liveEnabled } from './tso.js';

describe.skipIf(!liveEnabled)(`TSO logon on ${env.host ?? '(no host)'}`, () => {
  const tso = new TsoSession(
    'TSO logon to ISPF, PF3 to READY, LOGOFF (test/live/tso-logon.test.ts)',
  );
  afterAll(() => tso.close());

  it('connects and shows the VTAM logon screen', async () => {
    await tso.connect();
    expect(tso.term.terminalType).toBe('IBM-3278-2-E');
    tso.show('logon screen');
  });

  it('logs on to TSO and reaches ISPF', async () => {
    await tso.logon();
    tso.show('ISPF');
    expect(tso.screen).toContain('ISPF primary option menu');
    expect(tso.screen).toMatch(new RegExp(`USERID\\s+:\\s+${env.user}`));
  });

  it('exits ISPF to READY and logs off', async () => {
    await tso.logoff();
    tso.show('after LOGOFF');
  });
});
