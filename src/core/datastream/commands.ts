/**
 * 3270 commands. GA23-0059 §3.1. Each has a local (channel/SNA-style "EBCDIC")
 * code and a remote code; hosts send either, so both are accepted.
 */
export const Command = {
  W: 0xf1,
  EW: 0xf5,
  EWA: 0x7e,
  EAU: 0x6f,
  WSF: 0xf3,
  RB: 0xf2,
  RM: 0xf6,
  RMA: 0x6e,
  NOP: 0x03,
} as const;

export type CommandKind = keyof typeof Command;

const BY_CODE = new Map<number, CommandKind>([
  [0xf1, 'W'],
  [0x01, 'W'],
  [0xf5, 'EW'],
  [0x05, 'EW'],
  [0x7e, 'EWA'],
  [0x0d, 'EWA'],
  [0x6f, 'EAU'],
  [0x0f, 'EAU'],
  [0xf3, 'WSF'],
  [0x11, 'WSF'],
  [0xf2, 'RB'],
  [0x02, 'RB'],
  [0xf6, 'RM'],
  [0x06, 'RM'],
  [0x6e, 'RMA'],
  [0x0e, 'RMA'],
  [0x03, 'NOP'],
]);

export function commandKind(byte: number): CommandKind | undefined {
  return BY_CODE.get(byte);
}
