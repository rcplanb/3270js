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

/** TN3270E subnegotiation commands. RFC 2355 §3. */
export const Tn3270eOp = {
  ASSOCIATE: 0,
  CONNECT: 1,
  DEVICE_TYPE: 2,
  FUNCTIONS: 3,
  IS: 4,
  REASON: 5,
  REJECT: 6,
  REQUEST: 7,
  SEND: 8,
} as const;

/** DEVICE-TYPE REJECT reason codes. RFC 2355 §3. */
export const Tn3270eReason = {
  CONN_PARTNER: 0,
  DEVICE_IN_USE: 1,
  INV_ASSOCIATE: 2,
  INV_NAME: 3,
  INV_DEVICE_TYPE: 4,
  TYPE_NAME_ERROR: 5,
  UNKNOWN_ERROR: 6,
  UNSUPPORTED_REQ: 7,
} as const;

/** TN3270E functions. RFC 2355 §3. */
export const Tn3270eFunction = {
  BIND_IMAGE: 0,
  DATA_STREAM_CTL: 1,
  RESPONSES: 2,
  SCS_CTL_CODES: 3,
  SYSREQ: 4,
} as const;

/** TN3270E message header DATA-TYPE values. RFC 2355 §8.1.1. */
export const Tn3270eDataType = {
  DATA_3270: 0x00,
  SCS_DATA: 0x01,
  RESPONSE: 0x02,
  BIND_IMAGE: 0x03,
  UNBIND: 0x04,
  NVT_DATA: 0x05,
  REQUEST: 0x06,
  SSCP_LU_DATA: 0x07,
  PRINT_EOJ: 0x08,
} as const;

/** RESPONSE-FLAG values on 3270-DATA and SCS-DATA. RFC 2355 §8.1.3. */
export const Tn3270eResponseFlag = {
  NO_RESPONSE: 0x00,
  ERROR_RESPONSE: 0x01,
  ALWAYS_RESPONSE: 0x02,
  /** On a RESPONSE message. */
  POSITIVE: 0x00,
  /** On a RESPONSE message. */
  NEGATIVE: 0x01,
} as const;
