/**
 * 3270 buffer addressing. GA23-0059 §3.3 ("Buffer Addressing").
 *
 * A buffer address is sent as two bytes. The top two bits of the first byte
 * select the form:
 * - B'00': 14-bit binary. The address is the low 14 bits of the pair.
 * - B'01' / B'11': 12-bit coded. Each byte carries 6 address bits, sent as a
 *   graphic EBCDIC character from the address code table. B'10' is reserved
 *   and decoded as 12-bit, as other emulators do.
 */

/** How a terminal encodes the addresses it sends. */
export const AddressMode = {
  /** 12-bit coded (6 bits per byte, as graphic characters). Buffers up to 4096 cells. */
  Coded12: 'coded12',
  /** 14-bit binary. Buffers up to 16384 cells. */
  Binary14: 'binary14',
} as const;
export type AddressMode = (typeof AddressMode)[keyof typeof AddressMode];

/**
 * 6-bit value → graphic EBCDIC code. Every entry's low six bits equal its
 * index, so decoding only needs a mask.
 */
// prettier-ignore
export const ADDRESS_CODES: readonly number[] = Object.freeze([
  0x40, 0xc1, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0x4a, 0x4b, 0x4c, 0x4d, 0x4e, 0x4f,
  0x50, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0x5a, 0x5b, 0x5c, 0x5d, 0x5e, 0x5f,
  0x60, 0x61, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0x6a, 0x6b, 0x6c, 0x6d, 0x6e, 0x6f,
  0xf0, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0x7a, 0x7b, 0x7c, 0x7d, 0x7e, 0x7f,
]);

const MAX_ADDRESS = {
  [AddressMode.Coded12]: 0x0fff,
  [AddressMode.Binary14]: 0x3fff,
} as const;

/** Decode a two-byte buffer address in either form. */
export function decodeAddress(b1: number, b2: number): number {
  if ((b1 & 0xc0) === 0x00) return ((b1 & 0x3f) << 8) | (b2 & 0xff);
  return ((b1 & 0x3f) << 6) | (b2 & 0x3f);
}

/** Encode a buffer address in the given form. */
export function encodeAddress(address: number, mode: AddressMode): [number, number] {
  if (!Number.isInteger(address) || address < 0 || address > MAX_ADDRESS[mode]) {
    throw new RangeError(`address ${address} cannot be encoded as ${mode}`);
  }
  if (mode === AddressMode.Binary14) return [(address >> 8) & 0x3f, address & 0xff];
  return [ADDRESS_CODES[(address >> 6) & 0x3f]!, ADDRESS_CODES[address & 0x3f]!];
}

/**
 * The address form a terminal should send for a buffer of this size: 12-bit
 * coded whenever it fits, which is every standard model (the largest, model 5,
 * has 3564 cells).
 */
export function addressModeFor(bufferSize: number): AddressMode {
  return bufferSize <= 0x1000 ? AddressMode.Coded12 : AddressMode.Binary14;
}

export function isValidAddress(address: number, bufferSize: number): boolean {
  return Number.isInteger(address) && address >= 0 && address < bufferSize;
}

/** The next address, wrapping from the last cell to the first. */
export function nextAddress(address: number, bufferSize: number): number {
  return address + 1 === bufferSize ? 0 : address + 1;
}

/** The previous address, wrapping from the first cell to the last. */
export function prevAddress(address: number, bufferSize: number): number {
  return address === 0 ? bufferSize - 1 : address - 1;
}

export function toRowCol(address: number, cols: number): { row: number; col: number } {
  return { row: Math.floor(address / cols), col: address % cols };
}

export function toAddress(row: number, col: number, cols: number): number {
  return row * cols + col;
}
