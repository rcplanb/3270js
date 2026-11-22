/** The session player page: a recorded trace replayed into each renderer. */
import { type Page, expect, test } from '@playwright/test';

const text = (page: Page) =>
  page.evaluate(() =>
    (
      window as unknown as { __player: { terminal: { text: string[] } } }
    ).__player.terminal.text.join('\n'),
  );

for (const renderer of ['dom', 'canvas'] as const) {
  test(`plays and seeks a recorded session (${renderer} renderer)`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`/player.html?trace=tk5/ispf-tour-3279&renderer=${renderer}&speed=20&autoplay`);
    // At 20x the whole recording plays in about a second: wait for the end.
    const state = () =>
      page.evaluate(() => {
        const p = (
          window as unknown as { __player?: { frame: number; frames: number; playing: boolean } }
        ).__player;
        // The page loads the trace before it creates the player.
        if (!p) return { frame: -1, last: 0, playing: true };
        return { frame: p.frame, last: p.frames - 1, playing: p.playing };
      });
    await expect
      .poll(
        async () => {
          const s = await state();
          return !s.playing && s.frame === s.last;
        },
        { timeout: 20_000 },
      )
      .toBe(true);
    expect(await text(page)).toContain('Logon ===>'); // the recording ends after LOGOFF
    // Seek back with the slider: the ISPF menu, then the RFE data set list.
    const seek = (frame: number) =>
      page.locator('#seek').evaluate((el: HTMLInputElement, f) => {
        el.value = String(f);
        el.dispatchEvent(new Event('input'));
      }, frame);
    // Find the frames by content (the colour recording's numbering is its own).
    const frameWith = (needle: string) =>
      page.evaluate((n) => {
        const p = (
          window as unknown as {
            __player: { frames: number; seekFrame(f: number): void; terminal: { text: string[] } };
          }
        ).__player;
        for (let f = 0; f < p.frames; f++) {
          p.seekFrame(f);
          if (p.terminal.text.join('\n').includes(n)) return f;
        }
        return -1;
      }, needle);
    const menu = await frameWith('ISPF primary option menu');
    const dslist = await frameWith('RFE DSLIST');
    expect(menu).toBeGreaterThan(0);
    expect(dslist).toBeGreaterThan(menu);
    await seek(menu);
    expect(await text(page)).toContain('ISPF primary option menu');
    await seek(dslist);
    expect(await text(page)).toContain('RFE DSLIST');
    await expect(page.locator('#position')).toContainText(`screen ${dslist + 1} of`);
    await expect(page.locator('#terminal')).toHaveScreenshot(`player-dslist-${renderer}.png`);
    expect(errors).toEqual([]);
  });
}
