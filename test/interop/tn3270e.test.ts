/**
 * TN3270E interop (RFC 2355): every client in CLIENTS must behave the same
 * against the scripted test host. s3270 is the reference.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  DataType,
  Fn,
  type HostEvent,
  type HostSession,
  Reason,
  ResponseFlag,
  ebcdic,
  type StartedHost,
  startTn3270eHost,
} from '../helpers/tn3270e-host.js';
import { CLIENTS, type InteropClient } from './clients.js';

// EW, WCC (reset, restore keyboard), then "HELLO" in EBCDIC, unformatted.
const HELLO = [0xf5, 0xc3, 0xc8, 0xc5, 0xd3, 0xd3, 0xd6];
// The same with an invalid order byte sequence: SBA to an address past the screen end.
const BAD_ADDRESS = [0xf5, 0xc3, 0x11, 0x7f, 0x7f, 0xc8];

const isRecord = (e: HostEvent): e is Extract<HostEvent, { kind: 'record' }> => e.kind === 'record';
const settle = () => new Promise((r) => setTimeout(r, 200));

describe.each(CLIENTS)('TN3270E interop: $name', (factory) => {
  const { available } = factory;
  let host: StartedHost | undefined;
  let client: InteropClient | undefined;
  afterEach(async () => {
    await client?.close();
    await host?.close();
    client = host = undefined;
  });

  async function session(script = {}, lu?: string): Promise<HostSession> {
    host = await startTn3270eHost(script);
    client = factory.create();
    const connected = client.connect(host.port, lu);
    const s = await host.next();
    await s.waitFor((e) => e.kind === 'negotiated');
    await connected;
    return s;
  }

  it.skipIf(!available)('negotiates an -E 3278 device type and the three functions', async () => {
    const s = await session();
    const req = s.events.find((e) => e.kind === 'deviceTypeRequest');
    // RFC 2355 names only 3278 types; colour is announced by Query Reply instead.
    expect(req).toEqual({ kind: 'deviceTypeRequest', type: 'IBM-3278-2-E' });
    const done = s.events.at(-1);
    expect(done).toMatchObject({ kind: 'negotiated', mode: 'tn3270e', lu: 'LU00001' });
    for (const f of [Fn.BIND_IMAGE, Fn.RESPONSES, Fn.SYSREQ])
      expect(done?.kind === 'negotiated' && done.functions).toContain(f);
  });

  it.skipIf(!available)('asks for a named LU with CONNECT', async () => {
    const s = await session({}, 'MYLU01');
    expect(s.events.find((e) => e.kind === 'deviceTypeRequest')).toMatchObject({
      connect: 'MYLU01',
    });
    expect(s.events.at(-1)).toMatchObject({ lu: 'MYLU01' });
  });

  it.skipIf(!available)('accepts a counter-offer that drops a function', async () => {
    const s = await session({ functions: [Fn.BIND_IMAGE, Fn.RESPONSES] });
    expect(s.events.at(-1)).toMatchObject({
      kind: 'negotiated',
      functions: [Fn.BIND_IMAGE, Fn.RESPONSES],
    });
  });

  it.skipIf(!available)('falls back to plain TN3270 when the device type is rejected', async () => {
    const s = await session({ reject: Reason.UNSUPPORTED_REQ });
    expect(s.events.some((e) => e.kind === 'wont')).toBe(true);
    expect(s.events.at(-1)).toMatchObject({
      kind: 'negotiated',
      mode: 'tn3270',
      type: 'IBM-3279-2-E',
    });
    s.send3270(HELLO);
    await settle();
    expect((await client!.text())[0]).toMatch(/^HELLO/);
  });

  it.skipIf(!available)('ignores 3270 data until BIND', async () => {
    const s = await session();
    // Erase/Write "GOODBYE WORLD" before BIND, then a plain Write of "HELLO" after it:
    // a client that processed the first would show "HELLOYE WORLD".
    s.send3270([0xf5, 0xc3, ...ebcdic('GOODBYE WORLD')]);
    await settle();
    s.bind();
    s.send3270([0xf1, 0xc3, 0x11, 0x40, 0x40, ...ebcdic('HELLO')]);
    await settle();
    expect((await client!.text())[0]!.trimEnd()).toBe('HELLO');
  });

  it.skipIf(!available)('sends a positive response when asked ALWAYS-RESPONSE', async () => {
    const s = await session();
    s.bind();
    s.send3270(HELLO); // seq 0, no response wanted
    const seq = s.send3270(HELLO, ResponseFlag.ALWAYS_RESPONSE);
    const r = await s.waitFor(isRecord);
    expect(seq).toBe(1);
    expect(r.record.header).toEqual({
      dataType: DataType.RESPONSE,
      requestFlag: 0,
      responseFlag: 0,
      seq: 1,
    });
    expect([...r.record.data]).toEqual([0x00]); // device end
  });

  it.skipIf(!available)('sends a negative response for a bad buffer address', async () => {
    const s = await session();
    s.bind();
    s.send3270(BAD_ADDRESS, ResponseFlag.ERROR_RESPONSE);
    const r = await s.waitFor(isRecord);
    expect(r.record.header).toMatchObject({ dataType: DataType.RESPONSE, responseFlag: 1, seq: 0 });
    expect([...r.record.data]).toEqual([0x02]); // operation check
  });

  it.skipIf(!available)('sends Attn as IAC IP and SysReq as IAC AO', async () => {
    const s = await session();
    s.bind();
    s.send3270(HELLO);
    await settle();
    await client!.attn();
    await client!.sysReq();
    await s.waitFor((e) => e.kind === 'command' && e.command === 'AO');
    const cmds = s.events.filter((e) => e.kind === 'command').map((e) => e.command);
    expect(cmds).toEqual(['IP', 'AO']);
  });

  it.skipIf(!available)('shows SSCP-LU data and sends input back as SSCP-LU data', async () => {
    const s = await session();
    // SSCP-LU data is unformatted text with no 3270 command.
    s.send(DataType.SSCP_LU_DATA, ebcdic('HELLO'));
    await settle();
    expect((await client!.text())[0]).toMatch(/^HELLO/);
    await client!.enter();
    const r = await s.waitFor(isRecord);
    expect(r.record.header?.dataType).toBe(DataType.SSCP_LU_DATA);
  });

  it.skipIf(!available)('clears the screen on UNBIND', async () => {
    const s = await session();
    s.bind();
    s.send3270(HELLO);
    await settle();
    s.send(DataType.UNBIND, [0x01]);
    await settle();
    expect((await client!.text())[0]!.trim()).toBe('');
  });
});
