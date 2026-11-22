/**
 * Block selection and copy (Phase 2 task 13): a real mouse drag selects a
 * rectangle of cells, Cmd/Ctrl+C copies it, and a plain click still moves the
 * cursor. In each browser and with each renderer.
 */
import { type Page, expect, test } from '@playwright/test';
import { logonToIspf } from './helpers.js';

/** Client coordinates of the centre of cell (row, col). */
async function cellPoint(page: Page, row: number, col: number) {
  return page.evaluate(
    ([r, c]) => {
      const rd = window.__3270!.renderer as unknown as {
        cellMetrics: { width: number; height: number };
        element: HTMLElement;
      };
      const box = (
        rd.element.querySelector('.t3270-screen, canvas') as HTMLElement
      ).getBoundingClientRect();
      return {
        x: box.left + (c! + 0.5) * rd.cellMetrics.width,
        y: box.top + (r! + 0.5) * rd.cellMetrics.height,
      };
    },
    [row, col],
  );
}

/** Record what the page puts on the clipboard in copy events. */
async function captureCopies(page: Page) {
  await page.evaluate(() => {
    (window as unknown as { copied: string[] }).copied = [];
    document.addEventListener(
      'copy',
      (e) => {
        const data = e.clipboardData!;
        const set = data.setData.bind(data);
        data.setData = (type: string, value: string) => {
          if (type === 'text/plain') (window as unknown as { copied: string[] }).copied.push(value);
          set(type, value);
        };
      },
      { capture: true },
    );
  });
}

const cursor = (page: Page) =>
  page.evaluate(
    () => (window.__3270!.term as unknown as { screen: { cursor: number } }).screen.cursor,
  );
const screenRows = (page: Page) =>
  page.evaluate(() => (window.__3270!.term as unknown as { text: string[] }).text);

for (const renderer of ['dom', 'canvas'] as const) {
  test(`drags a block and copies it (${renderer} renderer)`, async ({ page }) => {
    await page.goto(`/?font=0&target=replay&renderer=${renderer}&color=1&autoconnect`);
    await logonToIspf(page, 'HERC01', 'NOTUSED');
    await captureCopies(page);
    const before = await cursor(page);

    // The option numbers and names of the ISPF menu: rows 3-7, columns 3-17.
    const from = await cellPoint(page, 3, 3);
    const to = await cellPoint(page, 7, 17);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 5 });
    await page.mouse.up();
    expect(await cursor(page)).toBe(before); // a drag doesn't move the cursor

    const rows = await screenRows(page);
    const expected = rows
      .slice(3, 8)
      .map((r) => r.slice(3, 18).trimEnd())
      .join('\n');
    expect(expected).toContain('ISPF PARMS'); // the block really is the menu
    await page.keyboard.press('ControlOrMeta+KeyC');
    expect(await page.evaluate(() => (window as unknown as { copied: string[] }).copied)).toEqual([
      expected,
    ]);

    // A plain click clears the selection and moves the cursor.
    const click = await cellPoint(page, 10, 20);
    await page.mouse.click(click.x, click.y);
    expect(await cursor(page)).toBe(10 * 80 + 20);
    await page.keyboard.press('ControlOrMeta+KeyC');
    expect(
      await page.evaluate(() => (window as unknown as { copied: string[] }).copied),
    ).toHaveLength(1);
  });
}
