import { type Page, expect } from '@playwright/test';

declare global {
  interface Window {
    __3270?: {
      term: { text: string[]; keyboard: { isLocked: boolean }; press: (a: unknown) => unknown };
      renderer: { refresh(): void };
    };
  }
}

export const screenText = (page: Page) =>
  page.evaluate(() => window.__3270?.term.text.join('\n') ?? '');

/** Wait until the screen matches and the keyboard is unlocked. */
export async function waitForScreen(page: Page, re: RegExp, what: string, timeout = 15_000) {
  await expect
    .poll(
      async () => {
        const locked = await page.evaluate(() => window.__3270?.term.keyboard.isLocked ?? true);
        return !locked && re.test(await screenText(page));
      },
      { message: `waiting for ${what}`, timeout },
    )
    .toBe(true);
}

// TSO's continuation marker: a line starting with *** (not Revedit's ******).
const CONTINUE = /^\s*\*\*\*(\s|$)/m;

/** Log on through a (replayed or live) TK5 logon to the ISPF primary menu, using real keystrokes. */
export async function logonToIspf(page: Page, user: string, password: string) {
  await waitForScreen(page, /Logon ===>/, 'the logon screen');
  await page.keyboard.type(user);
  await page.keyboard.press('Enter');
  await waitForScreen(page, /PASSWORD/, 'the password prompt');
  await page.keyboard.type(password);
  await page.keyboard.press('Enter');
  for (let i = 0; i < 6; i++) {
    await waitForScreen(page, /\*\*\*\s*$|ISPF primary option menu/m, 'logon progress');
    const s = await screenText(page);
    if (s.includes('ISPF primary option menu')) return;
    if (CONTINUE.test(s)) await page.keyboard.press('Enter');
  }
  await waitForScreen(page, /ISPF primary option menu/, 'ISPF');
}
