import type { AidKey } from '../inbound/index.js';

/**
 * What the operator did, independent of any physical keyboard. Renderers map
 * browser keys to these (task 19); programmatic input uses them directly.
 */
export type KeyAction =
  /** A character, as an EBCDIC byte. `ge`: from the APL/graphic-escape set. */
  | { type: 'char'; byte: number; ge?: boolean }
  /** Enter, Clear, PA1–3, PF1–24, SysReq. */
  | { type: 'aid'; key: AidKey }
  | {
      type:
        | 'tab'
        | 'backtab'
        | 'home'
        | 'newline'
        | 'left'
        | 'right'
        | 'up'
        | 'down'
        /** Move left (the 3270 Backspace key is not destructive). */
        | 'backspace'
        /** Destructive backspace: delete the character to the left. */
        | 'erase'
        | 'delete'
        | 'eraseEof'
        | 'eraseInput'
        | 'dup'
        | 'fieldMark'
        | 'reset'
        /** Turn insert mode on. */
        | 'insert'
        | 'toggleInsert'
        | 'attn';
    };

/** Why input is inhibited by the system (the OIA "X" conditions). */
export type InhibitReason =
  | 'notConnected'
  /** Connected, waiting for the host's first write. */
  | 'awaitingFirst'
  /** An AID was sent; waiting for the host (X-clock). */
  | 'wait'
  /** The host wrote without restoring the keyboard (X SYSTEM). */
  | 'system';

/** Operator errors: the keyboard locks until Reset or a movement key. */
export type OperatorError =
  /** Tried to change a protected field or an attribute position ("do not enter"). */
  | 'protected'
  /** Non-numeric character in a numeric field, with numeric lock on. */
  | 'numeric'
  /** Insert with no room left in the field ("too much"). */
  | 'overflow';

export type KeyOutput =
  /** An inbound 3270 record to send (not yet telnet-framed). */
  | { kind: 'record'; data: Uint8Array }
  /** A telnet command to send. */
  | { kind: 'telnet'; command: 'BREAK' | 'IP' };

export interface KeyResult {
  accepted: boolean;
  /** Set when the key was ignored because input is inhibited. */
  rejected?: InhibitReason | 'operatorError';
  /** Set when the key caused an operator error. */
  error?: OperatorError;
  outputs: KeyOutput[];
}
