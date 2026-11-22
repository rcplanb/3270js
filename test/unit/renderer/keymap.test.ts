// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cp037 } from '../../../src/core/codepage/index.js';
import { Terminal } from '../../../src/core/terminal.js';
import { DomRenderer } from '../../../src/renderer/dom/dom-renderer.js';
import { DEFAULT_KEYMAP, KeyboardMapper, comboOf } from '../../../src/renderer/keymap.js';
import { FakeHost, HERCULES_NEGOTIATION, frame } from '../../helpers/fake-host.js';

const ebc = (s: string) => Buffer.from(cp037.encode(s)).toString('hex');

async function setup(options: ConstructorParameters<typeof KeyboardMapper>[2] = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const term = new Terminal();
  const host = new FakeHost();
  const renderer = new DomRenderer(container);
  renderer.attach(term);
  const mapper = new KeyboardMapper(term, renderer, options);
  const ready = term.connect(host);
  for (const c of HERCULES_NEGOTIATION) host.write(c);
  await ready;
  // Input field at 0 (data 1..9), protected label at 10, input field at 80 (row 1).
  host.write(
    frame('f5c3' + '1d40' + '11404a' + '1d60' + ebc('LABEL') + '11c150' + '1d40' + '114040' + '13'),
  );
  term.moveCursor(1);
  host.takeSent();
  return { term, host, renderer, mapper };
}

function key(mapper: KeyboardMapper, init: KeyboardEventInit & { code?: string }) {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  mapper.textarea.dispatchEvent(e);
  return e;
}

function input(mapper: KeyboardMapper, text: string) {
  mapper.textarea.value = text;
  mapper.textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('comboOf', () => {
  it('builds combos from modifiers and the key (or code for letters/digits with modifiers)', () => {
    const base = { ctrlKey: false, altKey: false, shiftKey: false, metaKey: false };
    expect(comboOf({ ...base, key: 'Enter', code: 'Enter' })).toBe('Enter');
    expect(comboOf({ ...base, shiftKey: true, key: 'F1', code: 'F1' })).toBe('Shift+F1');
    // Option+A on a Mac produces "å" but the code is still KeyA.
    expect(comboOf({ ...base, altKey: true, key: 'å', code: 'KeyA' })).toBe('Alt+KeyA');
    expect(comboOf({ ...base, ctrlKey: true, key: 'r', code: 'KeyR' })).toBe('Ctrl+KeyR');
    expect(comboOf({ ...base, key: 'a', code: 'KeyA' })).toBe('a');
  });
});

describe('DEFAULT_KEYMAP', () => {
  it('maps every PF key, the PA keys, Clear, Attn and SysReq', () => {
    expect(DEFAULT_KEYMAP['F1']).toBe('PF1');
    expect(DEFAULT_KEYMAP['F12']).toBe('PF12');
    expect(DEFAULT_KEYMAP['Shift+F1']).toBe('PF13');
    expect(DEFAULT_KEYMAP['Shift+F12']).toBe('PF24');
    expect(DEFAULT_KEYMAP['Alt+Digit2']).toBe('PA2');
    expect(DEFAULT_KEYMAP['Escape']).toBe('CLEAR');
    expect(DEFAULT_KEYMAP['Alt+KeyA']).toEqual({ type: 'attn' });
    expect(DEFAULT_KEYMAP['Alt+KeyS']).toBe('SYSREQ');
  });
});

describe('KeyboardMapper', () => {
  it('types text from input events through the code page', async () => {
    const { term, mapper } = await setup();
    input(mapper, 'herc01');
    expect(term.text[0]!.slice(1, 7)).toBe('herc01');
    expect(mapper.textarea.value).toBe('');
  });

  it('waits for IME composition to finish', async () => {
    const { term, mapper } = await setup();
    mapper.textarea.dispatchEvent(new Event('compositionstart'));
    input(mapper, 'é');
    expect(term.text[0]![1]).toBe(' ');
    mapper.textarea.value = 'é';
    mapper.textarea.dispatchEvent(new Event('compositionend'));
    expect(term.text[0]![1]).toBe('é');
  });

  it('ignores characters the code page lacks', async () => {
    const { term, mapper } = await setup();
    input(mapper, '€A');
    expect(term.text[0]!.slice(1, 3)).toBe('A ');
  });

  it('sends AIDs for mapped keys and suppresses the browser default', async () => {
    const { host, mapper } = await setup();
    const e = key(mapper, { key: 'F3', code: 'F3' });
    expect(e.defaultPrevented).toBe(true);
    expect(host.takeSent().startsWith('f3')).toBe(true);
  });

  it('maps Shift+F1 to PF13 and Alt+1 to PA1', async () => {
    const { host, mapper, term } = await setup();
    key(mapper, { key: 'F1', code: 'F1', shiftKey: true });
    expect(host.takeSent().startsWith('c1')).toBe(true); // PF13
    term.press({ type: 'reset' });
    key(mapper, { key: '¡', code: 'Digit1', altKey: true });
    expect(host.takeSent()).toBe('6cffef'); // PA1 short read
  });

  it('maps editing keys: Backspace erases, Tab moves to the next field', async () => {
    const { term, mapper } = await setup();
    input(mapper, 'AB');
    key(mapper, { key: 'Backspace', code: 'Backspace' });
    expect(term.text[0]!.slice(1, 3)).toBe('A ');
    key(mapper, { key: 'Tab', code: 'Tab' });
    expect(term.screen.cursor).toBe(81); // the field on row 1
  });

  it('leaves unmapped keys alone', async () => {
    const { mapper } = await setup();
    expect(key(mapper, { key: 'a', code: 'KeyA' }).defaultPrevented).toBe(false);
    expect(key(mapper, { key: 'c', code: 'KeyC', metaKey: true }).defaultPrevented).toBe(false);
  });

  it('accepts custom bindings and removes defaults with null', async () => {
    const { host, mapper } = await setup({
      keymap: { 'Ctrl+Enter': 'ENTER', Enter: { type: 'newline' }, Escape: null },
    });
    key(mapper, { key: 'Enter', code: 'Enter', ctrlKey: true });
    expect(host.takeSent().startsWith('7d')).toBe(true);
    expect(key(mapper, { key: 'Escape', code: 'Escape' }).defaultPrevented).toBe(false);
  });

  it('pastes text, turning newlines and tabs into 3270 keys', async () => {
    const { term, mapper } = await setup();
    mapper.paste('AB\tC\r\nD');
    expect(term.text[0]!.slice(1, 3)).toBe('AB');
    expect(term.text[1]![1]).toBe('C'); // tab: the next field
    expect(term.text[2]![0]).toBe('D'); // newline: the next row, still inside that field
  });

  it('reports refused keys', async () => {
    const onRejected = vi.fn();
    const { term, mapper } = await setup({ onRejected });
    term.moveCursor(15); // protected label
    input(mapper, 'X');
    expect(onRejected).toHaveBeenCalledWith(expect.objectContaining({ error: 'protected' }));
  });

  it('drives the shift indicator from Shift and Caps Lock', async () => {
    const { renderer, mapper } = await setup();
    key(mapper, { key: 'Shift', code: 'ShiftLeft', shiftKey: true });
    expect(renderer.element.querySelector('[data-glyph="upShift"]')).not.toBeNull();
    mapper.textarea.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', code: 'ShiftLeft' }));
    expect(renderer.element.querySelector('[data-glyph="upShift"]')).toBeNull();
  });

  it('forwards focus from the terminal element to its textarea', async () => {
    const { renderer, mapper } = await setup();
    renderer.focus();
    expect(document.activeElement).toBe(mapper.textarea);
  });

  it('stops listening when disposed', async () => {
    const { term, mapper } = await setup();
    mapper.dispose();
    input(mapper, 'Z');
    expect(term.text[0]![1]).toBe(' ');
  });
});

describe('Terminal.moveCursor', () => {
  it('moves the cursor and updates the status line', async () => {
    const { term } = await setup();
    term.moveCursor(85);
    expect(term.oia.state.cursor).toEqual({ row: 1, col: 5 });
  });
});
