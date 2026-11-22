/**
 * Phase 1 acceptance (SPEC §10.1), on a real TK5 through the demo, with real
 * keystrokes and mouse clicks: log on to TSO, open ISPF, create a scratch
 * library, edit a new member in Revedit (insert a line, type, SAVE), reopen it
 * to verify, delete the library, log off. Once per renderer.
 */
import { type Page, expect, test } from '@playwright/test';
import { screenText, waitForScreen } from '../e2e/helpers.js';

const user = process.env.TSO_USER ?? 'HERC03';
const password = process.env.TSO_PASSWORD;
const live = Boolean(process.env.HERCULES_HOST && password);
const LIB = 'E2E.CNTL';
// TSO's continuation marker: a line starting with *** (not Revedit's ******).
const CONT = /^\s*\*\*\*(\s|$)/m;
const READY = /^\s*READY\s*$/m;

test.describe.configure({ mode: 'serial' });

/** Wait until the host has answered and the keyboard is free. */
async function settle(page: Page) {
  await expect
    .poll(() => page.evaluate(() => window.__3270?.term.keyboard.isLocked ?? true), {
      timeout: 30_000,
    })
    .toBe(false);
  await page.waitForTimeout(300);
}

async function press(page: Page, key: string) {
  await page.keyboard.press(key);
  await settle(page);
}

/** Click the cell at (row, col) of the terminal, as a user would. */
async function clickCell(page: Page, row: number, col: number) {
  const pt = await page.evaluate(
    ([r, c]) => {
      const el = window.__3270!.renderer as unknown as {
        cellAt(x: number, y: number): unknown;
        cellMetrics: { width: number; height: number };
        element: HTMLElement;
      };
      const target = (
        el.element.querySelector('.t3270-screen, canvas') as HTMLElement
      ).getBoundingClientRect();
      return {
        x: target.left + (c! + 0.5) * el.cellMetrics.width,
        y: target.top + (r! + 0.5) * el.cellMetrics.height,
      };
    },
    [row, col],
  );
  await page.mouse.click(pt.x, pt.y);
}

/** The first unprotected field on the row containing `label`: [row, col of first data cell, length]. */
async function inputFieldOnRow(page: Page, label: string) {
  return page.evaluate((l) => {
    const term = window.__3270!.term as unknown as {
      text: string[];
      screen: { cols: number; fields: { protected: boolean; dataStart: number; length: number }[] };
    };
    const row = term.text.findIndex((t) => t.includes(l));
    const cols = term.screen.cols;
    const f = term.screen.fields.find(
      (x) => !x.protected && Math.floor(x.dataStart / cols) === row,
    );
    return f ? ([row, f.dataStart % cols, f.length] as const) : undefined;
  }, label);
}

/**
 * Enter an ISPF/TSO command from the command line, paging through any "***".
 * Returns the screen as the host left it straight after the command, before
 * paging, so its messages can be checked.
 */
async function command(page: Page, text: string): Promise<string> {
  await page.keyboard.press('Home');
  await page.keyboard.press('End'); // Erase EOF
  await page.keyboard.type(text);
  await press(page, 'Enter');
  const output = await screenText(page);
  for (let i = 0; i < 4 && CONT.test(await screenText(page)); i++) {
    await press(page, 'Enter');
  }
  return output;
}

async function logon(page: Page) {
  try {
    await waitForScreen(page, /Logon ===>/, 'the logon screen', 5_000);
  } catch {
    await press(page, 'Escape'); // Clear: VTAM repaints, as at a real terminal
    await waitForScreen(page, /Logon ===>/, 'the logon screen after Clear');
  }
  await page.keyboard.type(user);
  await press(page, 'Enter');
  if ((await screenText(page)).includes('IN USE')) {
    await page.keyboard.type(`LOGON ${user} RECONNECT`);
    await press(page, 'Enter');
  }
  await waitForScreen(page, /PASSWORD/, 'the password prompt');
  await page.keyboard.type(password!);
  await press(page, 'Enter');
  for (let i = 0; i < 10; i++) {
    const s = await screenText(page);
    if (process.env.LIVE_DEBUG)
      console.log(
        `logon ${i}:`,
        s
          .split('\n')
          .filter((l) => l.trim())
          .slice(0, 2)
          .join(' | '),
      );
    if (s.includes('ISPF primary option menu')) return;
    if (CONT.test(s)) await press(page, 'Enter');
    else if (s.includes('RECONNECT SUCCESSFUL'))
      await press(page, 'Alt+Digit2'); // PA2: reshow
    // A reconnected session can be on any panel, even in a stale editor whose
    // data set has gone (END then can't autosave): CANCEL leaves without saving.
    else if (/^\s*REVEDIT\s[\s\S]*TOP OF DATA/.test(s)) await command(page, 'CANCEL');
    // Otherwise back out with F3 (END), using =X now and then.
    else if (i % 3 === 2) await command(page, '=X');
    else await press(page, 'F3');
    if (READY.test(await screenText(page))) {
      await page.keyboard.type('ISPF'); // ISPF ended: start it again
      await press(page, 'Enter');
    }
  }
  await waitForScreen(page, /ISPF primary option menu/, 'ISPF');
}

async function logoff(page: Page) {
  await page.keyboard.press('Control+KeyR'); // clear any operator error
  for (let i = 0; i < 10 && !READY.test(await screenText(page)); i++) {
    const s = await screenText(page);
    if (/Logon ===>/.test(s)) return;
    if (CONT.test(s)) await press(page, 'Enter');
    else if (/^\s*REVEDIT\s[\s\S]*TOP OF DATA/.test(s)) await command(page, 'CANCEL');
    else if (i % 2 === 0) await command(page, '=X');
    else await press(page, 'F3');
  }
  if (READY.test(await screenText(page))) {
    await page.keyboard.type('LOGOFF');
    await press(page, 'Enter');
  }
}

for (const renderer of ['dom', 'canvas'] as const) {
  test(`edit, save and verify a member on TK5 (${renderer} renderer)`, async ({ page }, info) => {
    test.skip(!live, 'set HERCULES_HOST and TSO_PASSWORD to run');
    const shot = async (name: string) =>
      info.attach(name, {
        body: await page.locator('#terminal').screenshot(),
        contentType: 'image/png',
      });
    const stamp = `3270JS ACCEPTANCE ${renderer.toUpperCase()} ${new Date().toISOString().slice(0, 19)}`;

    await page.goto(`/?target=tk5&renderer=${renderer}&color=1&autoconnect`);
    try {
      await logon(page);
      await shot('ispf');

      // A fresh scratch library (MVS 3.8 ALLOC takes DCB attributes via ATTR).
      await command(page, '=6');
      await command(page, `DELETE ${LIB}`);
      await command(page, 'ATTR E2E RECFM(F B) LRECL(80) BLKSIZE(3120)');
      const alloc = await command(page, `ALLOC DA(${LIB}) NEW CAT SP(1,1) TR DIR(2) USING(E2E)`);
      expect(alloc).not.toMatch(/NOT ALLOCATED|NOT FOUND|INVALID/);
      await command(page, `FREE DA(${LIB})`);

      // Revedit: click into DATA SET NAME, open a new member.
      await command(page, '=2');
      await waitForScreen(page, /DATA SET NAME/, 'the Revedit entry panel');
      const dsn = await inputFieldOnRow(page, 'DATA SET NAME');
      await clickCell(page, dsn![0], dsn![1]);
      await page.keyboard.press('End');
      await page.keyboard.type(`'${user}.${LIB}(ACCEPT)'`);
      await press(page, 'Enter');
      // The title line can show a message (e.g. REVEDIT1.BACKUP NOT REUSED) instead of the name.
      await waitForScreen(page, /^\s*REVEDIT\s[\s\S]*TOP OF DATA/, 'the editor');
      // Revedit may show a screen of empty input lines for a new member; Enter clears them.
      if ((await screenText(page)).includes("''''''")) await press(page, 'Enter');

      // Insert one line: Revedit reads the line command at the right-hand end of "******".
      const top = await inputFieldOnRow(page, 'TOP OF DATA');
      await clickCell(page, top![0], top![1] + top![2] - 2);
      await page.keyboard.type('I1');
      await press(page, 'Enter');
      const line = await inputFieldOnRow(page, "''''''");
      expect(line, 'an inserted line').toBeDefined();
      const data = await page.evaluate(
        ([r]) => {
          const t = window.__3270!.term as unknown as {
            screen: { cols: number; fields: { protected: boolean; dataStart: number }[] };
          };
          return (
            t.screen.fields.filter(
              (f) => !f.protected && Math.floor(f.dataStart / t.screen.cols) === r,
            )[1]!.dataStart % t.screen.cols
          );
        },
        [line![0]],
      );
      await clickCell(page, line![0], data);
      await page.keyboard.type(stamp);
      await press(page, 'Enter');
      await command(page, 'SAVE');
      await waitForScreen(page, /DATA SAVED/, 'DATA SAVED');
      await shot('saved');

      // Leave the editor, reopen the member, check the line is there.
      await press(page, 'F3');
      await waitForScreen(page, /REVEDIT- ENTRY PANEL/, 'the entry panel');
      await press(page, 'Enter');
      await waitForScreen(page, /000001 3270JS ACCEPTANCE/, 'the saved line');
      expect(await screenText(page)).toContain(`000001 ${stamp}`);
      await shot('reopened');
      await press(page, 'F3');

      await command(page, '=6');
      expect(await command(page, `DELETE ${LIB}`)).toMatch(/HERC\d\d\.E2E\.CNTL DELETED/);
    } catch (e) {
      // Keep the screen at the point of failure: the cleanup below changes it.
      const screen = await screenText(page);
      await info.attach('screen at failure', { body: screen, contentType: 'text/plain' });
      if (process.env.LIVE_DEBUG) console.log(`--- screen at failure ---\n${screen}`);
      await shot('failure');
      throw e;
    } finally {
      await logoff(page);
    }
    await waitForScreen(page, /Logon ===>/, 'the logon screen after LOGOFF');
  });
}
