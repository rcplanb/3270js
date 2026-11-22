/**
 * An interactive replay of a recorded trace for one Terminal: the host's bytes
 * up to the next point where the terminal sent a record, then wait for the
 * terminal to send one before going on (as scripts/trace-host.mjs does over
 * TCP). A script that sends what the original session sent walks through it.
 */
import { readFileSync } from 'node:fs';
import type { Trace } from '../../src/core/trace/index.js';
import { FakeHost, frame } from './fake-host.js';

export function loadTrace(name: string): Trace {
  return JSON.parse(
    readFileSync(new URL(`../traces/${name}.json`, import.meta.url), 'utf8'),
  ) as Trace;
}

export class ReplayDriver extends FakeHost {
  readonly #steps: Buffer[] = [];
  #next = 0;
  /** Terminal records received so far. */
  records = 0;

  constructor(trace: Trace) {
    super();
    let pending: Buffer[] = [];
    for (const e of trace.events) {
      if (e.dir === 'host') {
        pending.push(Buffer.from(e.kind === 'record' ? frame(e.hex) : e.hex, 'hex'));
      } else if (e.kind === 'record') {
        this.#steps.push(Buffer.concat(pending));
        pending = [];
      }
    }
    this.#steps.push(Buffer.concat(pending));
  }

  /** Send the host's opening (negotiation and first screens). */
  start(): void {
    this.#advance();
  }

  /** Steps not yet played. */
  get remaining(): number {
    return this.#steps.length - this.#next;
  }

  override send(data: Uint8Array): void {
    super.send(data);
    const s = Buffer.from(data);
    // Each IAC EOR from the terminal ends one record: play the next step, as a network would, later.
    for (
      let at = s.indexOf(Buffer.from([0xff, 0xef]));
      at >= 0;
      at = s.indexOf(Buffer.from([0xff, 0xef]), at + 2)
    ) {
      this.records++;
      setTimeout(() => this.#advance(), 5);
    }
  }

  #advance(): void {
    const step = this.#steps[this.#next++];
    if (step?.length) this.write(step);
  }
}
