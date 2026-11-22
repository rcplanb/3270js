/**
 * Recovery: a session dropped while logged on waits in TSO for RECONNECT.
 * Log on, drop the connection without logging off, then log on again: the
 * script helper must reconnect, redraw the panel and get back to ISPF.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { TsoSession, env, liveEnabled } from './tso.js';

describe.skipIf(!liveEnabled)(`TSO reconnect on ${env.host ?? '(no host)'}`, () => {
  const first = new TsoSession('reconnect: first session (dropped)');
  const second = new TsoSession('reconnect: second session (recovers)');
  afterAll(async () => {
    await second.close();
    first.term.disconnect();
  });

  it('logs on, then drops the connection without logging off', async () => {
    await first.connect();
    const { reconnected } = await first.logon();
    expect(reconnected).toBe(false);
    await first.command('3.4'); // leave it on a panel other than the menu
    first.loggedOn = false; // don't log off: drop it
    first.term.disconnect();
    await new Promise((r) => setTimeout(r, 3_000)); // let VTAM notice
  });

  it('logs on again: reconnects and gets back to ISPF', async () => {
    await second.connect();
    const { reconnected } = await second.logon();
    second.show('after reconnect');
    expect(reconnected).toBe(true);
    expect(second.screen).toMatch(/ISPF primary option menu|^\s*READY\s*$/m);
  });
});
