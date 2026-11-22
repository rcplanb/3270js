import { describe, expect, it } from 'vitest';
import { cp037 } from '../../../../src/core/codepage/index.js';
import { Aid } from '../../../../src/core/inbound/index.js';
import { Keyboard, type KeyAction, type KeyResult } from '../../../../src/core/keyboard/index.js';
import { AddressMode, Screen, encodeAddress } from '../../../../src/core/screen/index.js';

const t = (s: string) => [...cp037.encode(s)];
const at = (a: number) => encodeAddress(a, AddressMode.Coded12);

/**
 * Layout used by most tests (80 columns):
 *   0  protected "NAME"      data 1..9
 *   10 unprotected           data 11..19
 *   20 protected             data 21..29
 *   30 unprotected numeric   data 31..39
 *   40 autoskip (prot+num)   data 41..49
 *   50 unprotected           data 51..1919
 */
function setup(options: ConstructorParameters<typeof Keyboard>[1] = {}) {
  const screen = new Screen(24, 80);
  screen.startField(0, 0x60);
  t('NAME').forEach((b, i) => screen.writeChar(1 + i, b));
  screen.startField(10, 0x40);
  screen.startField(20, 0x60);
  screen.startField(30, 0x50);
  screen.startField(40, 0x70);
  screen.startField(50, 0x40);
  const kb = new Keyboard(screen, options);
  kb.connected();
  kb.hostWrite({ keyboardRestore: true });
  screen.cursor = 11;
  return { screen, kb };
}

function text(screen: Screen, address: number, length: number): string {
  let s = '';
  for (let i = 0; i < length; i++) {
    const b = screen.charAt((address + i) % screen.size);
    s += b === 0 ? '·' : cp037.toUnicode(b);
  }
  return s;
}

function typeText(kb: Keyboard, s: string): KeyResult[] {
  return t(s).map((byte) => kb.press({ type: 'char', byte }));
}

const press = (kb: Keyboard, ...actions: KeyAction['type'][]) =>
  actions.map((type) => kb.press({ type } as KeyAction));

describe('lifecycle and locking', () => {
  it('is inhibited until connected and the host first writes', () => {
    const screen = new Screen(24, 80);
    const kb = new Keyboard(screen);
    expect(kb.inhibit).toBe('notConnected');
    expect(kb.press({ type: 'char', byte: 0xc1 })).toMatchObject({
      accepted: false,
      rejected: 'notConnected',
    });
    kb.connected();
    expect(kb.inhibit).toBe('awaitingFirst');
    kb.hostWrite({ keyboardRestore: false });
    expect(kb.isLocked).toBe(false);
  });

  it('locks with X-wait after an AID; a write without restore turns it into X SYSTEM', () => {
    const { kb } = setup();
    kb.press({ type: 'aid', key: 'ENTER' });
    expect(kb.inhibit).toBe('wait');
    kb.hostWrite({ keyboardRestore: false });
    expect(kb.inhibit).toBe('system');
    kb.hostWrite({ keyboardRestore: true });
    expect(kb.isLocked).toBe(false);
  });

  it('rejects input while inhibited', () => {
    const { kb, screen } = setup();
    kb.press({ type: 'aid', key: 'ENTER' });
    expect(typeText(kb, 'A')[0]).toMatchObject({ accepted: false, rejected: 'wait' });
    expect(kb.press({ type: 'aid', key: 'PF3' }).accepted).toBe(false);
    expect(kb.press({ type: 'aid', key: 'CLEAR' }).accepted).toBe(false);
    expect(screen.charAt(11)).toBe(0);
  });

  it('Reset clears every lock and insert mode', () => {
    const { kb } = setup();
    kb.press({ type: 'insert' });
    kb.press({ type: 'aid', key: 'ENTER' });
    kb.press({ type: 'reset' });
    expect(kb.isLocked).toBe(false);
    expect(kb.insertMode).toBe(false);
  });

  it('a disconnect inhibits input again', () => {
    const { kb } = setup();
    kb.disconnected();
    expect(kb.inhibit).toBe('notConnected');
    expect(kb.press({ type: 'reset' }).accepted).toBe(false);
  });
});

describe('typing (x3270 key_Character)', () => {
  it('overtypes, advances and sets the MDT', () => {
    const { kb, screen } = setup();
    typeText(kb, 'HERC');
    expect(text(screen, 11, 5)).toBe('HERC·');
    expect(screen.cursor).toBe(15);
    expect(screen.fieldAt(11)!.modified).toBe(true);
  });

  it('refuses protected fields and attribute cells ("do not enter")', () => {
    const { kb, screen } = setup();
    screen.cursor = 22;
    expect(typeText(kb, 'A')[0]).toMatchObject({ accepted: false, error: 'protected' });
    expect(kb.operatorError).toBe('protected');
    expect(kb.isLocked).toBe(true);
    kb.press({ type: 'reset' });
    screen.cursor = 10;
    expect(typeText(kb, 'A')[0]).toMatchObject({ error: 'protected' });
  });

  it('a movement key clears an operator error', () => {
    const { kb, screen } = setup();
    screen.cursor = 22;
    typeText(kb, 'A');
    kb.press({ type: 'tab' });
    expect(kb.isLocked).toBe(false);
    expect(screen.cursor).toBe(31);
  });

  it('accepts anything in numeric fields unless numeric lock is on', () => {
    const plain = setup();
    plain.screen.cursor = 31;
    expect(typeText(plain.kb, 'A')[0]!.accepted).toBe(true);

    const locked = setup({ numericLock: true });
    locked.screen.cursor = 31;
    expect(typeText(locked.kb, '7')[0]!.accepted).toBe(true);
    expect(typeText(locked.kb, '-')[0]!.accepted).toBe(true);
    expect(typeText(locked.kb, 'A')[0]).toMatchObject({ accepted: false, error: 'numeric' });
  });

  it('skips over the next attribute when the field fills up', () => {
    const { kb, screen } = setup();
    screen.cursor = 19;
    typeText(kb, 'Z');
    expect(screen.cursor).toBe(21); // stepped over FA at 20 into the protected field
  });

  it('jumps past an autoskip field to the next unprotected field', () => {
    const { kb, screen } = setup();
    screen.cursor = 39;
    typeText(kb, '9');
    expect(screen.cursor).toBe(51); // FA 40 is autoskip
  });

  it('types anywhere on an unformatted screen, wrapping', () => {
    const screen = new Screen(24, 80);
    const kb = new Keyboard(screen);
    kb.connected();
    kb.hostWrite({ keyboardRestore: true });
    screen.cursor = 1919;
    typeText(kb, 'AB');
    expect(text(screen, 1919, 2)).toBe('AB');
    expect(screen.cursor).toBe(1);
  });

  it('marks GE characters with the APL character set', () => {
    const { kb, screen } = setup();
    kb.press({ type: 'char', byte: 0xad, ge: true });
    expect(screen.attributesAt(11).charset).toBe(0xf1);
  });

  describe('insert mode', () => {
    it('shifts the rest of the field right into nulls', () => {
      const { kb, screen } = setup();
      typeText(kb, 'ACD');
      screen.cursor = 12;
      kb.press({ type: 'insert' });
      typeText(kb, 'B');
      expect(text(screen, 11, 5)).toBe('ABCD·');
      expect(screen.cursor).toBe(13);
    });

    it('fails with "too much" when the field has no null to absorb the shift', () => {
      const { kb, screen } = setup();
      typeText(kb, 'ABCDEFGHI'); // fills 11..19
      screen.cursor = 11;
      kb.press({ type: 'toggleInsert' });
      expect(typeText(kb, 'X')[0]).toMatchObject({ accepted: false, error: 'overflow' });
      expect(text(screen, 11, 9)).toBe('ABCDEFGHI');
    });

    it('uses the nearest null, leaving later characters in place', () => {
      const { kb, screen } = setup();
      typeText(kb, 'AB');
      screen.cursor = 15;
      typeText(kb, 'EF');
      screen.cursor = 11;
      kb.press({ type: 'insert' });
      typeText(kb, 'X');
      expect(text(screen, 11, 7)).toBe('XAB·EF·'); // the null at 13 absorbed the shift
    });

    it('with blank fill, treats trailing blanks as room', () => {
      const { kb, screen } = setup({ blankFill: true });
      t('ABCDEFG  ').forEach((b, i) => screen.writeChar(11 + i, b));
      screen.cursor = 11;
      kb.press({ type: 'insert' });
      expect(typeText(kb, 'X')[0]!.accepted).toBe(true);
      expect(text(screen, 11, 9)).toBe('XABCDEFG ');
    });

    it('is turned off by an AID', () => {
      const { kb } = setup();
      kb.press({ type: 'insert' });
      kb.press({ type: 'aid', key: 'ENTER' });
      expect(kb.insertMode).toBe(false);
    });
  });

  it('blank fill turns nulls before the cursor into blanks', () => {
    const { kb, screen } = setup({ blankFill: true });
    screen.cursor = 14;
    typeText(kb, 'A');
    expect(text(screen, 11, 4)).toBe('   A');
  });
});

describe('cursor movement', () => {
  it('Tab goes to the next unprotected field, wrapping', () => {
    const { kb, screen } = setup();
    press(kb, 'tab');
    expect(screen.cursor).toBe(31);
    press(kb, 'tab');
    expect(screen.cursor).toBe(51); // 41 is autoskip (protected)
    press(kb, 'tab');
    expect(screen.cursor).toBe(11);
  });

  it('Backtab goes to the start of this field, then the previous one', () => {
    const { kb, screen } = setup();
    screen.cursor = 35;
    press(kb, 'backtab');
    expect(screen.cursor).toBe(31);
    press(kb, 'backtab');
    expect(screen.cursor).toBe(11);
    press(kb, 'backtab');
    expect(screen.cursor).toBe(51);
  });

  it('Home goes to the first unprotected field (or 0 when unformatted)', () => {
    const { kb, screen } = setup();
    screen.cursor = 600;
    press(kb, 'home');
    expect(screen.cursor).toBe(11);

    const blank = new Screen(24, 80);
    const kb2 = new Keyboard(blank);
    kb2.connected();
    kb2.hostWrite({ keyboardRestore: true });
    blank.cursor = 99;
    kb2.press({ type: 'home' });
    expect(blank.cursor).toBe(0);
  });

  it('arrows move one cell or one row, wrapping around the screen', () => {
    const { kb, screen } = setup();
    screen.cursor = 0;
    press(kb, 'left');
    expect(screen.cursor).toBe(1919);
    press(kb, 'right');
    expect(screen.cursor).toBe(0);
    press(kb, 'up');
    expect(screen.cursor).toBe(1840);
    press(kb, 'down', 'down');
    expect(screen.cursor).toBe(80);
  });

  it('Backspace (non-destructive) moves left', () => {
    const { kb, screen } = setup();
    typeText(kb, 'AB');
    press(kb, 'backspace');
    expect(screen.cursor).toBe(12);
    expect(text(screen, 11, 2)).toBe('AB');
  });

  it('New Line goes to the next row’s first unprotected position', () => {
    const { kb, screen } = setup();
    press(kb, 'newline');
    expect(screen.cursor).toBe(80); // row 1, col 0 is inside the unprotected field at 50
    screen.startField(160, 0x60);
    screen.startField(170, 0x40);
    screen.cursor = 85;
    press(kb, 'newline');
    expect(screen.cursor).toBe(171);
  });
});

describe('editing keys', () => {
  it('Delete shifts the rest of the field left and nulls the end', () => {
    const { kb, screen } = setup();
    typeText(kb, 'ABCDEFGHI');
    screen.cursor = 12;
    press(kb, 'delete');
    expect(text(screen, 11, 9)).toBe('ACDEFGHI·');
    expect(screen.cursor).toBe(12);
  });

  it('Delete, Erase, Backspace and New Line are ignored after an operator error (x3270)', () => {
    const { kb, screen } = setup();
    screen.cursor = 2;
    typeText(kb, 'A');
    for (const type of ['delete', 'erase', 'backspace', 'newline'] as const) {
      expect(kb.press({ type })).toMatchObject({ accepted: false, rejected: 'operatorError' });
    }
    expect(kb.operatorError).toBe('protected');
  });

  it('Delete refuses protected fields', () => {
    const { kb, screen } = setup();
    screen.cursor = 3;
    expect(press(kb, 'delete')[0]).toMatchObject({ error: 'protected' });
  });

  it('Erase (destructive backspace) deletes the character to the left', () => {
    const { kb, screen } = setup();
    typeText(kb, 'ABC');
    press(kb, 'erase');
    expect(text(screen, 11, 3)).toBe('AB·');
    expect(screen.cursor).toBe(13);
  });

  it('Erase at the start of a field does nothing', () => {
    const { kb, screen } = setup();
    typeText(kb, 'A');
    screen.cursor = 11;
    expect(press(kb, 'erase')[0]!.accepted).toBe(true);
    expect(text(screen, 11, 1)).toBe('A');
  });

  it('Erase EOF nulls to the end of the field and sets the MDT', () => {
    const { kb, screen } = setup();
    typeText(kb, 'ABCDEF');
    screen.setModified(10, false);
    screen.cursor = 13;
    press(kb, 'eraseEof');
    expect(text(screen, 11, 9)).toBe('AB·······');
    expect(screen.fieldAt(11)!.modified).toBe(true);
    expect(screen.cursor).toBe(13);
  });

  it('Erase EOF refuses protected fields', () => {
    const { kb, screen } = setup();
    screen.cursor = 2;
    expect(press(kb, 'eraseEof')[0]).toMatchObject({ error: 'protected' });
  });

  it('Erase EOF on an unformatted screen nulls to the end of the buffer', () => {
    const screen = new Screen(1, 10);
    const kb = new Keyboard(screen);
    kb.connected();
    kb.hostWrite({ keyboardRestore: true });
    t('ABCDEFGHIJ').forEach((b, i) => screen.writeChar(i, b));
    screen.cursor = 4;
    kb.press({ type: 'eraseEof' });
    expect(text(screen, 0, 10)).toBe('ABCD······');
  });

  it('Erase Input clears every unprotected field and homes the cursor', () => {
    const { kb, screen } = setup();
    typeText(kb, 'ABC');
    screen.cursor = 51;
    typeText(kb, 'XYZ');
    press(kb, 'eraseInput');
    expect(text(screen, 11, 3)).toBe('···');
    expect(text(screen, 51, 3)).toBe('···');
    expect(text(screen, 1, 4)).toBe('NAME');
    expect(screen.cursor).toBe(11);
    expect(screen.fields.every((f) => !f.modified)).toBe(true);
  });

  it('Dup stores DUP and tabs to the next field', () => {
    const { kb, screen } = setup();
    press(kb, 'dup');
    expect(screen.charAt(11)).toBe(0x1c);
    expect(screen.cursor).toBe(31);
    expect(screen.fieldAt(11)!.modified).toBe(true);
  });

  it('Field Mark stores FM and advances', () => {
    const { kb, screen } = setup();
    press(kb, 'fieldMark');
    expect(screen.charAt(11)).toBe(0x1e);
    expect(screen.cursor).toBe(12);
  });
});

describe('AID keys', () => {
  it('Enter sends Read Modified and locks the keyboard', () => {
    const { kb, screen } = setup();
    typeText(kb, 'HERC01');
    const r = kb.press({ type: 'aid', key: 'ENTER' });
    expect(r.accepted).toBe(true);
    expect(r.outputs).toEqual([
      { kind: 'record', data: Uint8Array.from([0x7d, ...at(17), 0x11, ...at(11), ...t('HERC01')]) },
    ]);
    expect(screen.cursor).toBe(17);
  });

  it('PF keys send their AID', () => {
    const { kb } = setup();
    const r = kb.press({ type: 'aid', key: 'PF24' });
    expect(r.outputs[0]).toMatchObject({ kind: 'record' });
    expect((r.outputs[0] as { data: Uint8Array }).data[0]).toBe(Aid.PF24);
  });

  it('PA keys send a short read', () => {
    const { kb } = setup();
    typeText(kb, 'X');
    expect(kb.press({ type: 'aid', key: 'PA1' }).outputs).toEqual([
      { kind: 'record', data: Uint8Array.of(Aid.PA1) },
    ]);
  });

  it('Clear blanks the screen, homes the cursor and sends a short read', () => {
    const { kb, screen } = setup();
    typeText(kb, 'X');
    const r = kb.press({ type: 'aid', key: 'CLEAR' });
    expect(r.outputs).toEqual([{ kind: 'record', data: Uint8Array.of(Aid.CLEAR) }]);
    expect(screen.isFormatted).toBe(false);
    expect(screen.cursor).toBe(0);
    expect(kb.inhibit).toBe('wait');
  });

  it('AID keys are refused after an operator error until Reset', () => {
    const { kb, screen } = setup();
    screen.cursor = 2;
    typeText(kb, 'A');
    expect(kb.press({ type: 'aid', key: 'ENTER' }).accepted).toBe(false);
    kb.press({ type: 'reset' });
    expect(kb.press({ type: 'aid', key: 'ENTER' }).accepted).toBe(true);
  });

  it('SysReq sends a test request', () => {
    const { kb } = setup();
    const data = (kb.press({ type: 'aid', key: 'SYSREQ' }).outputs[0] as { data: Uint8Array }).data;
    expect([...data.subarray(0, 4)]).toEqual([0x01, 0x6c, 0x61, 0x02]);
  });

  it('Attn sends a PA1 short read and telnet BREAK, without locking (as x3270 does on TN3270)', () => {
    const { kb } = setup();
    const r = kb.press({ type: 'attn' });
    expect(r.outputs).toEqual([
      { kind: 'record', data: Uint8Array.of(Aid.PA1) },
      { kind: 'telnet', command: 'BREAK' },
    ]);
    expect(kb.isLocked).toBe(false);
  });
});

describe('change events', () => {
  it('notifies listeners when lock state or insert mode change', () => {
    const { kb, screen } = setup();
    const seen: string[] = [];
    kb.onChange(() =>
      seen.push(`${kb.inhibit ?? '-'}/${kb.operatorError ?? '-'}/${kb.insertMode}`),
    );
    kb.press({ type: 'insert' });
    screen.cursor = 2;
    typeText(kb, 'A');
    kb.press({ type: 'reset' });
    expect(seen).toEqual(['-/-/true', '-/protected/true', '-/-/false']);
  });

  it('can unsubscribe', () => {
    const { kb } = setup();
    let n = 0;
    const off = kb.onChange(() => n++);
    off();
    kb.press({ type: 'insert' });
    expect(n).toBe(0);
  });
});

describe('edge cases', () => {
  function unformatted(rows = 1, cols = 10) {
    const screen = new Screen(rows, cols);
    const kb = new Keyboard(screen);
    kb.connected();
    kb.hostWrite({ keyboardRestore: true });
    return { screen, kb };
  }

  it('movement keys are refused while the system inhibits input', () => {
    const { kb, screen } = setup();
    kb.press({ type: 'aid', key: 'ENTER' });
    expect(kb.press({ type: 'tab' })).toMatchObject({ accepted: false, rejected: 'wait' });
    expect(screen.cursor).toBe(11);
  });

  it('ignores host writes before connecting', () => {
    const kb = new Keyboard(new Screen(24, 80));
    kb.hostWrite({ keyboardRestore: true });
    expect(kb.inhibit).toBe('notConnected');
  });

  it('toggleInsert turns insert mode off again', () => {
    const { kb } = setup();
    kb.press({ type: 'toggleInsert' });
    kb.press({ type: 'toggleInsert' });
    expect(kb.insertMode).toBe(false);
  });

  it('Backtab with no unprotected fields goes to 0', () => {
    const screen = new Screen(24, 80);
    screen.startField(100, 0x60);
    const kb = new Keyboard(screen);
    kb.connected();
    kb.hostWrite({ keyboardRestore: true });
    screen.cursor = 500;
    kb.press({ type: 'backtab' });
    expect(screen.cursor).toBe(0);
  });

  it('inserts and deletes across the whole buffer when unformatted', () => {
    const { kb, screen } = unformatted();
    t('ABC').forEach((b, i) => screen.writeChar(i, b));
    screen.cursor = 0;
    kb.press({ type: 'insert' });
    typeText(kb, 'X');
    expect(text(screen, 0, 5)).toBe('XABC·');
    screen.cursor = 1;
    kb.press({ type: 'delete' });
    expect(text(screen, 0, 5)).toBe('XBC··');
  });

  it('an insert on a full unformatted buffer is "too much"', () => {
    const { kb, screen } = unformatted(1, 3);
    t('ABC').forEach((b, i) => screen.writeChar(i, b));
    screen.cursor = 0;
    kb.press({ type: 'insert' });
    expect(typeText(kb, 'X')[0]).toMatchObject({ error: 'overflow' });
  });

  it('blank fill stops at an all-null row (x3270)', () => {
    const screen = new Screen(3, 10);
    screen.startField(0, 0x40); // one field covering rows 0-2
    const kb = new Keyboard(screen, { blankFill: true });
    kb.connected();
    kb.hostWrite({ keyboardRestore: true });
    screen.cursor = 25; // row 2, col 5; rows 0-1 are all nulls
    typeText(kb, 'A');
    expect(text(screen, 20, 6)).toBe('     A'); // row 2 filled from its start
    expect(text(screen, 10, 10)).toBe('··········'); // row 1 left alone
  });

  it('blank fill continues across rows that have data', () => {
    const screen = new Screen(3, 10);
    screen.startField(0, 0x40);
    const kb = new Keyboard(screen, { blankFill: true });
    kb.connected();
    kb.hostWrite({ keyboardRestore: true });
    screen.writeChar(15, t('Q')[0]!);
    screen.cursor = 22;
    typeText(kb, 'A');
    expect(text(screen, 15, 8)).toBe('Q      A');
    expect(text(screen, 10, 5)).toBe('     ');
  });
});
