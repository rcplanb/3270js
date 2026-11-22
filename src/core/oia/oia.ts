/**
 * The Operator Information Area (status line) as data. Renderers decide how
 * each symbol looks; this module decides which symbols are showing.
 * Layout and symbols per the 3174 OIA (GA27-3831); x3270 shows the same set.
 */
import type { InhibitReason, OperatorError } from '../keyboard/index.js';

export type ConnectionState = 'disconnected' | 'connecting' | 'connected';

/**
 * Input-inhibited symbols. Each is shown after the "X":
 * - `system`: X SYSTEM
 * - `clock`: X with a clock (waiting for the host)
 * - `notConnected`: X with a question mark
 * - `doNotEnter`: X with the "go elsewhere" symbol (protected field)
 * - `numeric`: X NUM
 * - `tooMuch`: X with the "too much" symbol (insert overflow)
 */
export type OiaLockSymbol =
  'system' | 'clock' | 'notConnected' | 'doNotEnter' | 'numeric' | 'tooMuch';

export interface OiaState {
  connection: ConnectionState;
  /** Input inhibited, and why; undefined when the keyboard is usable. */
  lock: { symbol: OiaLockSymbol; reason: InhibitReason | OperatorError } | undefined;
  /** Insert mode (the "^" indicator). */
  insert: boolean;
  /** Zero-origin cursor position. */
  cursor: { row: number; col: number };
  /** Terminal model, e.g. `3279-2-E`. */
  model: string;
  /** The LU the session is bound to, when known (TN3270E). */
  luName?: string;
}

export interface OiaInputs {
  connection: ConnectionState;
  inhibit: InhibitReason | undefined;
  operatorError: OperatorError | undefined;
  insertMode: boolean;
  cursor: number;
  cols: number;
  model: string;
  luName?: string;
}

const INHIBIT_SYMBOL: Record<InhibitReason, OiaLockSymbol> = {
  notConnected: 'notConnected',
  awaitingFirst: 'system',
  wait: 'clock',
  system: 'system',
};

const ERROR_SYMBOL: Record<OperatorError, OiaLockSymbol> = {
  protected: 'doNotEnter',
  numeric: 'numeric',
  overflow: 'tooMuch',
};

export function computeOia(i: OiaInputs): OiaState {
  let lock: OiaState['lock'];
  if (i.inhibit) lock = { symbol: INHIBIT_SYMBOL[i.inhibit], reason: i.inhibit };
  else if (i.operatorError)
    lock = { symbol: ERROR_SYMBOL[i.operatorError], reason: i.operatorError };

  const state: OiaState = {
    connection: i.connection,
    lock,
    insert: i.insertMode,
    cursor: { row: Math.floor(i.cursor / i.cols), col: i.cursor % i.cols },
    model: i.model,
  };
  if (i.luName !== undefined) state.luName = i.luName;
  return state;
}

/** Holds the current OIA state and notifies listeners when it changes. */
export class OiaModel {
  #state: OiaState = computeOia({
    connection: 'disconnected',
    inhibit: 'notConnected',
    operatorError: undefined,
    insertMode: false,
    cursor: 0,
    cols: 80,
    model: '',
  });
  #key = JSON.stringify(this.#state);
  #listeners = new Set<(state: OiaState) => void>();

  get state(): OiaState {
    return this.#state;
  }

  onChange(listener: (state: OiaState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Recompute from the terminal's current state; notifies if anything visible changed. */
  update(inputs: OiaInputs): void {
    const next = computeOia(inputs);
    const key = JSON.stringify(next);
    if (key === this.#key) return;
    this.#state = next;
    this.#key = key;
    for (const l of this.#listeners) l(next);
  }
}
