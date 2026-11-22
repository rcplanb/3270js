/** Write Control Character. GA23-0059 §3.4. */
export const Wcc = {
  RESET: 0x40,
  START_PRINTER: 0x08,
  SOUND_ALARM: 0x04,
  KEYBOARD_RESTORE: 0x02,
  RESET_MDT: 0x01,
} as const;

export interface WccInfo {
  reset: boolean;
  startPrinter: boolean;
  soundAlarm: boolean;
  keyboardRestore: boolean;
  resetMdt: boolean;
}

export function decodeWcc(wcc: number): WccInfo {
  return {
    reset: (wcc & Wcc.RESET) !== 0,
    startPrinter: (wcc & Wcc.START_PRINTER) !== 0,
    soundAlarm: (wcc & Wcc.SOUND_ALARM) !== 0,
    keyboardRestore: (wcc & Wcc.KEYBOARD_RESTORE) !== 0,
    resetMdt: (wcc & Wcc.RESET_MDT) !== 0,
  };
}
