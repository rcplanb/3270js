/**
 * A read-only tour of TK5's ISPF: data set list, browse, utilities, a TSO
 * command. Nothing on the system is changed. With RECORD_TRACE=path it saves a
 * trace used by the differential tests.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { TsoSession, env, liveEnabled } from './tso.js';

describe.skipIf(!liveEnabled)(`ISPF tour on ${env.host ?? '(no host)'}`, () => {
  const tso = new TsoSession(
    'Read-only ISPF tour: DSLIST, browse, utilities, TSO command (test/live/ispf-tour.test.ts)',
  );
  afterAll(() => tso.close());

  /** Put a line command into the input field on the same row as `text`. */
  function lineCommand(text: string, cmd: string) {
    const row = tso.term.text.findIndex((l) => l.includes(text));
    expect(row, `row with ${text}`).toBeGreaterThanOrEqual(0);
    const field = tso.term.screen.fields.find(
      (f) => !f.protected && Math.floor(f.dataStart / tso.term.screen.cols) === row,
    );
    expect(field, `input field on row ${row}`).toBeDefined();
    tso.term.screen.cursor = field!.dataStart;
    expect(tso.term.type(cmd).accepted).toBe(true);
  }

  it('logs on', async () => {
    await tso.connect();
    await tso.logon();
    expect(tso.screen).toContain('ISPF primary option menu');
  });

  it('lists SYS1.PROCLIB with RFE DSLIST (3.4)', async () => {
    await tso.command('3.4');
    expect(tso.screen).toContain('Data set name prefix');
    tso.show('DSLIST entry');
    await tso.key('ENTER', 'SYS1.PROCLIB');
    expect(tso.screen).toMatch(/SYS1\.PROCLIB\s+TK5RES/);
    tso.show('DSLIST');
  });

  it('browses the library and scrolls', async () => {
    lineCommand('SYS1.PROCLIB', 'B');
    await tso.key('ENTER');
    tso.show('browse');
    expect(tso.screen).not.toContain('INVALID');
    await tso.key('PF8');
    tso.show('browse, PF8');
    await tso.key('PF7');
  });

  it('returns to the primary menu and opens the utilities', async () => {
    for (let i = 0; i < 6 && !tso.screen.includes('ISPF primary option menu'); i++) {
      await tso.command('END');
    }
    expect(tso.screen).toContain('ISPF primary option menu');
    await tso.command('3');
    expect(tso.screen).toContain('Utility selection menu');
    tso.show('utilities');
    await tso.command('1');
    expect(tso.screen).toContain('LIBRARY UTILITY');
    tso.show('library utility');
  });

  it('runs a TSO command from option 6', async () => {
    await tso.command('=6');
    tso.show('option 6');
    await tso.command('TIME');
    tso.show('after TIME');
    expect(tso.screen).toMatch(/TIME-/);
  });

  it('logs off', async () => {
    await tso.logoff();
  });
});
