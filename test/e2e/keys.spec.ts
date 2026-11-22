/**
 * Key coverage: which PC keys reach the 3270 keyboard in each browser. The
 * terminal's press() is intercepted so no AID is sent and the replay is not
 * disturbed. Every binding must arrive; the report is attached to the test.
 */
import { expect, test } from '@playwright/test';
import { waitForScreen } from './helpers.js';

const KEYS: [string, string][] = [
  ['Enter', 'aid:ENTER'],
  ['Shift+Enter', 'newline'],
  ['Escape', 'aid:CLEAR'],
  ['Control+KeyR', 'reset'],
  ['Alt+Digit1', 'aid:PA1'],
  ['Alt+Digit2', 'aid:PA2'],
  ['Alt+Digit3', 'aid:PA3'],
  ['Alt+KeyA', 'attn'],
  ['Alt+KeyS', 'aid:SYSREQ'],
  ['Alt+KeyD', 'dup'],
  ['Alt+KeyF', 'fieldMark'],
  ['Tab', 'tab'],
  ['Shift+Tab', 'backtab'],
  ['Home', 'home'],
  ['ArrowLeft', 'left'],
  ['ArrowRight', 'right'],
  ['ArrowUp', 'up'],
  ['ArrowDown', 'down'],
  ['Backspace', 'erase'],
  ['Delete', 'delete'],
  ['Insert', 'toggleInsert'],
  ['End', 'eraseEof'],
  ['Control+End', 'eraseInput'],
  ...Array.from({ length: 12 }, (_, i) => [`F${i + 1}`, `aid:PF${i + 1}`] as [string, string]),
  ...Array.from(
    { length: 12 },
    (_, i) => [`Shift+F${i + 1}`, `aid:PF${i + 13}`] as [string, string],
  ),
];

test('every mapped key reaches the terminal', async ({ page }, info) => {
  await page.goto('/?font=0&target=replay&autoconnect');
  await waitForScreen(page, /Logon ===>/, 'the logon screen');
  await page.evaluate(() => {
    const w = window as unknown as { __pressed: string[] };
    w.__pressed = [];
    const term = window.__3270!.term;
    term.press = (a: unknown) => {
      const action = a as { type: string; key?: string; byte?: number };
      w.__pressed.push(
        action.type === 'aid'
          ? `aid:${action.key}`
          : action.type === 'char'
            ? `char:${action.byte}`
            : action.type,
      );
      return { accepted: true, outputs: [] };
    };
  });

  const missing: string[] = [];
  for (const [combo, expected] of KEYS) {
    await page.evaluate(
      () => ((window as unknown as { __pressed: string[] }).__pressed.length = 0),
    );
    await page.keyboard.press(combo);
    const got = await page.evaluate(() => (window as unknown as { __pressed: string[] }).__pressed);
    if (!got.includes(expected))
      missing.push(`${combo} → expected ${expected}, got [${got.join(', ')}]`);
  }
  await info.attach('key coverage', {
    body: `${KEYS.length - missing.length}/${KEYS.length} keys reached the terminal\n${missing.join('\n')}`,
    contentType: 'text/plain',
  });
  expect(missing).toEqual([]);
});
