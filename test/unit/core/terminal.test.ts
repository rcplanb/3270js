import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { Terminal } from '../../../src/core/terminal.js';
import { FakeHost, HERCULES_NEGOTIATION, frame } from '../../helpers/fake-host.js';

const logon = JSON.parse(
  readFileSync(new URL('../../fixtures/datastream/tk5-logon.json', import.meta.url), 'utf8'),
) as { records: string[]; expectedText: string[]; expectedCursor: [number, number] };
const inbound = JSON.parse(
  readFileSync(new URL('../../fixtures/datastream/tk5-inbound.json', import.meta.url), 'utf8'),
) as { typed: string; enter: string; pa1: string };

async function connected(options: ConstructorParameters<typeof Terminal>[0] = {}) {
  const term = new Terminal(options);
  const host = new FakeHost();
  const ready = term.connect(host);
  for (const c of HERCULES_NEGOTIATION) host.write(c);
  await ready;
  host.takeSent();
  return { term, host };
}

describe('Terminal', () => {
  describe('configuration', () => {
    it('defaults to a monochrome model 2 with CP037', () => {
      const t = new Terminal();
      expect(t.terminalType).toBe('IBM-3278-2');
      expect(t.model).toBe(2);
      expect(t.color).toBe(false);
      expect(t.codePage.id).toBe('cp037');
      expect([t.screen.rows, t.screen.cols]).toEqual([24, 80]);
    });

    it('announces a 3279 when colour is on, and other models', () => {
      expect(new Terminal({ color: true }).terminalType).toBe('IBM-3279-2');
      expect(new Terminal({ model: 5 }).terminalType).toBe('IBM-3278-5');
      expect(new Terminal({ terminalType: 'IBM-DYNAMIC' }).terminalType).toBe('IBM-DYNAMIC');
    });

    it('starts at 24x80 whatever the model (that is the default size)', () => {
      const t = new Terminal({ model: 5 });
      expect([t.screen.rows, t.screen.cols]).toEqual([24, 80]);
    });

    it('rejects an unknown code page', () => {
      expect(() => new Terminal({ codePage: 'cp9999' })).toThrow(/code page/);
    });
  });

  describe('connecting', () => {
    it('answers the TERMINAL-TYPE request with its type and resolves in 3270 mode', async () => {
      const term = new Terminal();
      const host = new FakeHost();
      const ready = term.connect(host);
      expect(term.oia.state.connection).toBe('connecting');
      host.write('fffd18');
      host.write('fffa1801fff0');
      expect(host.takeSent()).toBe(
        'fffb18' + 'fffa1800' + Buffer.from('IBM-3278-2').toString('hex') + 'fff0',
      );
      for (const c of HERCULES_NEGOTIATION.slice(2)) host.write(c);
      await expect(ready).resolves.toBeUndefined();
      expect(term.connected).toBe(true);
      expect(term.oia.state.connection).toBe('connected');
      expect(term.keyboard.inhibit).toBe('awaitingFirst');
    });

    it('rejects if the host hangs up during negotiation', async () => {
      const term = new Terminal();
      const host = new FakeHost();
      const ready = term.connect(host);
      host.hangUp('refused');
      await expect(ready).rejects.toThrow(/refused/);
      expect(term.oia.state.connection).toBe('disconnected');
    });

    it('refuses a second connection', async () => {
      const { term } = await connected();
      await expect(term.connect(new FakeHost())).rejects.toThrow(/already/);
    });

    it('reports disconnects and can reconnect', async () => {
      const { term, host } = await connected();
      const onDisconnect = vi.fn();
      term.on('disconnect', onDisconnect);
      host.hangUp('host gone');
      expect(onDisconnect).toHaveBeenCalledWith({ reason: 'host gone' });
      expect(term.connected).toBe(false);
      expect(term.keyboard.inhibit).toBe('notConnected');
      const again = new FakeHost();
      const ready = term.connect(again);
      for (const c of HERCULES_NEGOTIATION) again.write(c);
      await ready;
      expect(term.connected).toBe(true);
    });

    it('locks the keyboard if the host leaves 3270 mode', async () => {
      const { term, host } = await connected();
      host.write('fffe00'); // DONT BINARY
      expect(term.connected).toBe(false);
      expect(term.keyboard.inhibit).toBe('notConnected');
      expect(term.oia.state.connection).toBe('connecting');
    });

    it('reports telnet protocol errors', async () => {
      const { term, host } = await connected();
      const errors: string[] = [];
      term.on('error', (e) => errors.push(e.message));
      host.write('fffa1801fffd00'); // subnegotiation never closed
      expect(errors[0]).toMatch(/subnegotiation/);
    });

    it('accepts a CodePage object', () => {
      const cp = new Terminal().codePage;
      expect(new Terminal({ codePage: cp }).codePage).toBe(cp);
    });

    it('disconnect() closes the transport', async () => {
      const { term, host } = await connected();
      term.disconnect();
      expect(host.closed).toBe(true);
      expect(term.connected).toBe(false);
    });
  });

  describe('TK5 session (captured from Hercules)', () => {
    it('shows the logon screen exactly as s3270 did and unlocks the keyboard', async () => {
      const { term, host } = await connected();
      const settled = vi.fn();
      term.onScreenSettled(settled);
      for (const r of logon.records) host.write(frame(r));
      expect(term.text).toEqual(logon.expectedText);
      expect(term.screen.cursor).toBe(logon.expectedCursor[0] * 80 + logon.expectedCursor[1]);
      expect(term.keyboard.isLocked).toBe(false);
      expect(settled).toHaveBeenCalled();
    });

    it('sends exactly what s3270 sent for typed input and Enter, then PA1', async () => {
      const { term, host } = await connected();
      for (const r of logon.records) host.write(frame(r));
      term.type(inbound.typed);
      expect(term.aid('ENTER').accepted).toBe(true);
      expect(host.takeSent()).toBe(frame(inbound.enter));
      expect(term.oia.state.lock?.symbol).toBe('clock');

      host.write(frame('f1c2')); // Write with keyboard restore
      expect(term.keyboard.isLocked).toBe(false);
      term.aid('PA1');
      expect(host.takeSent()).toBe(frame(inbound.pa1));
    });
  });

  describe('host commands', () => {
    it('answers Read Modified and Read Buffer with the last AID', async () => {
      const { term, host } = await connected();
      host.write(frame('f5c2' + '1d40' + 'c1c2')); // EW, restore, SF unprotected, "AB"
      term.aid('PF3');
      host.takeSent();
      host.write(frame('f6')); // RM
      expect(host.takeSent()).toBe(frame('f3' + '4040'));
      host.write(frame('f2')); // RB
      expect(host.takeSent()).toBe(frame('f34040' + '1d40c1c2' + '00'.repeat(1917)));
    });

    it('uses "no AID" after the keyboard has been restored', async () => {
      const { term, host } = await connected();
      host.write(frame('f5c2'));
      term.aid('ENTER');
      host.write(frame('f1c2'));
      host.takeSent();
      host.write(frame('f6'));
      expect(host.takeSent()).toBe(frame('604040'));
    });

    it('turns a write without restore after an AID into X SYSTEM', async () => {
      const { term, host } = await connected();
      host.write(frame('f5c2'));
      term.aid('ENTER');
      host.write(frame('f140'));
      expect(term.oia.state.lock?.symbol).toBe('system');
    });

    it('switches to the alternate size on EWA', async () => {
      const { term, host } = await connected({ model: 4 });
      host.write(frame('7ec2'));
      expect([term.screen.rows, term.screen.cols]).toEqual([43, 80]);
      host.write(frame('f5c2'));
      expect([term.screen.rows, term.screen.cols]).toEqual([24, 80]);
    });

    it('reports the alarm', async () => {
      const { term, host } = await connected();
      const alarm = vi.fn();
      term.on('alarm', alarm);
      host.write(frame('f5c6'));
      expect(alarm).toHaveBeenCalledOnce();
    });

    it('reports data stream errors without stopping', async () => {
      const { term, host } = await connected();
      const errors: string[] = [];
      term.on('error', (e) => errors.push(e.message));
      host.write(frame('99'));
      host.write(frame('f5c2c1'));
      expect(errors).toEqual([expect.stringMatching(/unknown command/)]);
      expect(term.text[0]!.startsWith('A')).toBe(true);
    });

    it('reports structured fields as unsupported', async () => {
      const { term, host } = await connected();
      const errors: string[] = [];
      term.on('error', (e) => errors.push(e.message));
      host.write(frame('f3000501ff02'));
      expect(errors[0]).toMatch(/structured field/i);
    });

    it('passes NVT data through', () => {
      const term = new Terminal();
      const host = new FakeHost();
      const nvt = vi.fn();
      term.on('nvt', nvt);
      void term.connect(host).catch(() => {});
      host.write([0x48, 0x49]);
      expect(nvt).toHaveBeenCalledWith(Uint8Array.of(0x48, 0x49));
    });
  });

  describe('input', () => {
    async function form() {
      const c = await connected();
      // EW restore; SF prot "USER"; SF unprot (5); SF prot at 20; SF unprot at 30.
      c.host.write(frame('f5c2' + '1d60e4e2c5d9' + '1d40' + '11c0d4' + '1d60' + '11c0de' + '1d40'));
      c.host.takeSent();
      return c;
    }

    it('type() types text through the keyboard rules', async () => {
      const { term } = await form();
      term.screen.cursor = 6;
      expect(term.type('ABC').accepted).toBe(true);
      expect(term.text[0]!.slice(6, 9)).toBe('ABC');
    });

    it('type() stops at the first refused character', async () => {
      const { term } = await form();
      term.screen.cursor = 1;
      const r = term.type('AB');
      expect(r).toMatchObject({ accepted: false, error: 'protected' });
    });

    it('type() rejects characters the code page lacks', async () => {
      const { term } = await form();
      expect(() => term.type('€')).toThrow(RangeError);
    });

    it('fillField() replaces the contents of the nth unprotected field', async () => {
      const { term } = await form();
      term.screen.cursor = 6;
      term.type('OLDVALUE');
      term.fillField(0, 'HERC01');
      expect(term.text[0]!.slice(6, 14)).toBe('HERC01  ');
      term.fillField(1, 'X');
      expect(term.text[0]![31]).toBe('X');
      expect(() => term.fillField(2, 'Y')).toThrow(RangeError);
    });

    it('sends telnet BREAK for Attn', async () => {
      const { term, host } = await form();
      term.press({ type: 'attn' });
      expect(host.takeSent()).toBe(frame('6c') + 'fff3');
    });

    it('emits render after key presses and host writes', async () => {
      const { term, host } = await form();
      const render = vi.fn();
      term.on('render', render);
      term.screen.cursor = 6;
      term.type('A');
      host.write(frame('f1c2c2')); // Write "B" at the cursor
      expect(render).toHaveBeenCalledTimes(2);
    });

    it('emits keyboardUnlock when Reset clears an operator error', async () => {
      const { term } = await form();
      const unlock = vi.fn();
      term.onKeyboardUnlock(unlock);
      term.screen.cursor = 1;
      term.type('A');
      term.press({ type: 'reset' });
      expect(unlock).toHaveBeenCalledOnce();
    });

    it('unsubscribes', async () => {
      const { term } = await form();
      const render = vi.fn();
      const off = term.on('render', render);
      off();
      term.screen.cursor = 6;
      term.type('A');
      expect(render).not.toHaveBeenCalled();
    });

    it('refuses input before connecting', () => {
      const term = new Terminal();
      expect(term.aid('ENTER')).toMatchObject({ accepted: false, rejected: 'notConnected' });
    });
  });
});
