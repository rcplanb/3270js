/**
 * Splits a raw telnet byte stream into 3270 records (on IAC EOR, IAC
 * undoubled) and raw telnet command sequences, without taking part in
 * negotiation. Used to observe a session from outside, e.g. in a proxy.
 */
const IAC = 0xff;
const SB = 0xfa;
const SE = 0xf0;
const EOR = 0xef;
const VERBS = new Set([0xfb, 0xfc, 0xfd, 0xfe]); // WILL WONT DO DONT

export type FramedItem =
  { kind: 'record'; data: Uint8Array } | { kind: 'telnet'; data: Uint8Array };

const enum S {
  Data,
  Iac,
  Verb,
  Sb,
  SbIac,
}

export class TelnetFramer {
  #state = S.Data;
  #record: number[] = [];
  #command: number[] = [];

  push(chunk: Uint8Array): FramedItem[] {
    const out: FramedItem[] = [];
    const command = () => {
      out.push({ kind: 'telnet', data: Uint8Array.from(this.#command) });
      this.#command = [];
    };
    for (const b of chunk) {
      switch (this.#state) {
        case S.Data:
          if (b === IAC) this.#state = S.Iac;
          else this.#record.push(b);
          break;
        case S.Iac:
          if (b === IAC) {
            this.#record.push(IAC);
            this.#state = S.Data;
          } else if (b === EOR) {
            out.push({ kind: 'record', data: Uint8Array.from(this.#record) });
            this.#record = [];
            this.#state = S.Data;
          } else if (VERBS.has(b)) {
            this.#command = [IAC, b];
            this.#state = S.Verb;
          } else if (b === SB) {
            this.#command = [IAC, SB];
            this.#state = S.Sb;
          } else {
            this.#command = [IAC, b];
            command();
            this.#state = S.Data;
          }
          break;
        case S.Verb:
          this.#command.push(b);
          command();
          this.#state = S.Data;
          break;
        case S.Sb:
          this.#command.push(b);
          if (b === IAC) this.#state = S.SbIac;
          break;
        case S.SbIac:
          this.#command.push(b);
          if (b === SE) {
            command();
            this.#state = S.Data;
          } else {
            this.#state = S.Sb;
          }
          break;
      }
    }
    return out;
  }
}
