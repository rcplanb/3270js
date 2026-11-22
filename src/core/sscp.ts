/**
 * SSCP-LU mode (TN3270E SSCP-LU-DATA): the terminal talking to VTAM's SSCP
 * rather than an application. Data is plain text with no 3270 command, and
 * input is the text typed since the host last wrote. Rules follow the 3174
 * Functional Description as x3270 applies them.
 */
import type { Screen } from './screen/index.js';

const NL = 0x15;
const SF = 0x1d;
const IC = 0x13;
const SBA = 0x11;
const GE = 0x08;
const NULL = 0x00;
const SPACE = 0x40;
/** SSCP-LU input is at most this long. */
const MAX_INPUT = 255;

/** Scroll the (unformatted) screen up a row, blanking the last. */
function scroll(screen: Screen): void {
  const { cols, size } = screen;
  for (let a = cols; a < size; a++) screen.writeChar(a - cols, screen.charAt(a));
  for (let a = size - cols; a < size; a++) screen.writeChar(a, NULL);
}

/**
 * Write SSCP-LU data at `address`, scrolling at the bottom. Anything but NL
 * is shown as a graphic; stray SF, IC and SBA orders from badly-behaved hosts
 * are filtered as x3270 does. Returns the address after the text, which is
 * where the cursor goes and where the next input starts.
 */
export function writeSscpLu(screen: Screen, data: Uint8Array, address: number): number {
  const { cols, size } = screen;
  let addr = address;
  const put = (byte: number) => {
    screen.writeChar(addr, byte);
    addr = (addr + 1) % size;
    if (addr === 0) {
      scroll(screen);
      addr = size - cols;
    }
  };
  for (let i = 0; i < data.length; i++) {
    const b = data[i]!;
    switch (b) {
      case NL: {
        const row = Math.floor(addr / cols);
        while (Math.floor(addr / cols) === row && addr !== 0) {
          screen.writeChar(addr, NULL);
          addr = (addr + 1) % size;
        }
        if (addr === 0) {
          scroll(screen);
          addr = size - cols;
        }
        break;
      }
      case SF:
        i++; // skip the attribute
        put(SPACE);
        break;
      case IC:
        break;
      case SBA:
        i += 2;
        break;
      case GE: {
        i++;
        if (i < data.length) put(data[i]! <= SPACE ? SPACE : data[i]!);
        break;
      }
      default:
        put(b);
    }
  }
  return addr;
}

/** The operator's input: the text from `start` to the end of the screen, nulls dropped. */
export function readSscpLu(screen: Screen, start: number): Uint8Array {
  const out: number[] = [];
  for (let a = start; a < screen.size && out.length < MAX_INPUT; a++) {
    const c = screen.charAt(a);
    if (c !== NULL) out.push(c);
  }
  return Uint8Array.from(out);
}
