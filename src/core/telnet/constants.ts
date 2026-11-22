/** Telnet command bytes. RFC 854, plus EOR from RFC 885. */
export const Telnet = {
  IAC: 0xff,
  DONT: 0xfe,
  DO: 0xfd,
  WONT: 0xfc,
  WILL: 0xfb,
  SB: 0xfa,
  GA: 0xf9,
  EL: 0xf8,
  EC: 0xf7,
  AYT: 0xf6,
  AO: 0xf5,
  IP: 0xf4,
  BREAK: 0xf3,
  DM: 0xf2,
  NOP: 0xf1,
  SE: 0xf0,
  EOR: 0xef,
} as const;

/** Telnet option codes relevant to TN3270. */
export const TelnetOption = {
  BINARY: 0, // RFC 856
  ECHO: 1, // RFC 857
  SGA: 3, // RFC 858
  TTYPE: 24, // RFC 1091
  EOR: 25, // RFC 885
  NAWS: 31, // RFC 1073
  TN3270E: 40, // RFC 2355
} as const;

/** TERMINAL-TYPE subnegotiation codes. RFC 1091. */
export const TerminalType = {
  IS: 0,
  SEND: 1,
} as const;
