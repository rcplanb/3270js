/**
 * Drive the demo with real keystrokes through a replayed TK5 session, in each
 * browser and with each renderer, and compare screenshots per browser.
 */
import { expect, test } from '@playwright/test';
import { logonToIspf, screenText, waitForScreen } from './helpers.js';

for (const renderer of ['dom', 'canvas'] as const) {
  test.describe(`${renderer} renderer`, () => {
    test('logs on to ISPF and opens the data set list by keyboard', async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(`/?target=replay&renderer=${renderer}&color=1&autoconnect`);

      await logonToIspf(page, 'HERC01', 'NOTUSED');
      await expect(page.locator('#terminal')).toHaveScreenshot(`ispf-menu-${renderer}.png`);

      await page.keyboard.type('3.4');
      await page.keyboard.press('Enter');
      await waitForScreen(page, /Data set name prefix/, 'the DSLIST entry panel');
      await page.keyboard.press('End'); // Erase EOF
      await page.keyboard.type('SYS1.PROCLIB');
      await page.keyboard.press('Enter');
      await waitForScreen(page, /SYS1\.PROCLIB\s+TK5RES/, 'the data set list');
      await expect(page.locator('#terminal')).toHaveScreenshot(`dslist-${renderer}.png`);

      expect(await screenText(page)).toContain('RFE DSLIST');
      expect(errors).toEqual([]);
    });
  });
}

test('typed text appears on the screen in the browser', async ({ page }) => {
  await page.goto('/?target=replay&autoconnect');
  await waitForScreen(page, /Logon ===>/, 'the logon screen');
  await page.keyboard.type('herc01');
  expect((await screenText(page)).split('\n')[22]).toContain('Logon ===> herc01');
});
