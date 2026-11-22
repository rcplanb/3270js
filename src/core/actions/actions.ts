/**
 * Docent actions: what an assistant (SimH Assist's Docent) may do on the
 * visitor's behalf after they click "Run". Fill fields, type a command, press
 * an AID key, exactly as the visitor could, through the same Terminal and
 * keyboard rules. Never into a hidden (password) field, never into a
 * protected one, never while the keyboard is locked, and never Attn or
 * SysReq, which change the session's state.
 *
 * Actions arrive as JSON from another service, so `parseAction` checks them
 * strictly, and `applyAction` checks everything before changing anything: an
 * action is applied whole or not at all.
 */
import type { AidKey } from '../inbound/index.js';
import { fieldAfter, recognise } from '../recognise/index.js';
import type { Field } from '../screen/index.js';
import type { Terminal } from '../terminal.js';

/** Which field to fill: its index among the unprotected fields, or the label before it. */
export type FieldRef = number | string;

export interface DocentAction {
  /** Fields to fill, in order (each is erased first). */
  fill?: { field: FieldRef; text: string }[];
  /** A command, typed on the screen's command line (or at the cursor at TSO READY). */
  command?: string;
  /** The AID key to press last. Default ENTER when `command` is given; none otherwise. */
  aid?: AidKey;
}

/** Why an action was refused. */
export type RefusalReason =
  /** The keyboard is locked: the host isn't waiting for input. */
  | 'locked'
  /** The target (a field, or the cursor for a command) is a non-display field. */
  | 'password'
  /** The target field is protected. */
  | 'protected'
  /** No field matches the reference. */
  | 'no-field'
  /** The text doesn't fit the field. */
  | 'too-long'
  /** The AID key isn't one the Docent may press. */
  | 'aid'
  /** The terminal isn't connected. */
  | 'not-connected';

export type ActionResult =
  | { ok: true; aid?: AidKey }
  | {
      ok: false;
      /** As SimH Assist's Docent bridge: a policy refusal, or a malformed action. */
      error: 'injection_blocked' | 'invalid_action';
      reason?: RefusalReason;
      message: string;
    };

/** The AID keys the Docent may press: the ones a visitor uses to work, not Attn or SysReq. */
export const DOCENT_AIDS: readonly AidKey[] = [
  'ENTER',
  'CLEAR',
  'PA1',
  'PA2',
  'PA3',
  ...Array.from({ length: 24 }, (_, i) => `PF${i + 1}` as AidKey),
];

/** Longest text accepted in one fill or command. */
const MAX_TEXT = 1920;

const invalid = (message: string): ActionResult => ({
  ok: false,
  error: 'invalid_action',
  message,
});
const blocked = (reason: RefusalReason, message: string): ActionResult => ({
  ok: false,
  error: 'injection_blocked',
  reason,
  message: `Cannot inject: ${message}`,
});

/**
 * Check untrusted JSON and return a DocentAction, or the reason it's malformed.
 */
export function parseAction(json: unknown): { action: DocentAction } | { error: ActionResult } {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    return { error: invalid('an action is an object') };
  }
  const o = json as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    if (key !== 'fill' && key !== 'command' && key !== 'aid') {
      return { error: invalid(`unknown property "${key}"`) };
    }
  }
  const action: DocentAction = {};
  if (o.fill !== undefined) {
    if (!Array.isArray(o.fill) || o.fill.length === 0 || o.fill.length > 32) {
      return { error: invalid('"fill" is a list of 1 to 32 { field, text }') };
    }
    action.fill = [];
    for (const f of o.fill as unknown[]) {
      const item = f as Record<string, unknown> | null;
      const field = item?.field;
      const text = item?.text;
      const validField =
        (typeof field === 'number' && Number.isInteger(field) && field >= 0) ||
        (typeof field === 'string' && field.length > 0 && field.length <= 80);
      if (!validField) return { error: invalid('"field" is a field index or a label') };
      if (typeof text !== 'string' || text.length > MAX_TEXT) {
        return { error: invalid('"text" is a string') };
      }
      action.fill.push({ field, text });
    }
  }
  if (o.command !== undefined) {
    if (typeof o.command !== 'string' || o.command.length === 0 || o.command.length > MAX_TEXT) {
      return { error: invalid('"command" is a non-empty string') };
    }
    action.command = o.command;
  }
  if (o.aid !== undefined) {
    if (typeof o.aid !== 'string' || !(DOCENT_AIDS as readonly string[]).includes(o.aid)) {
      return {
        error: blocked(
          'aid',
          typeof o.aid === 'string'
            ? `"${o.aid.slice(0, 16)}" is not a key the Docent may press`
            : '"aid" is the name of a key',
        ),
      };
    }
    action.aid = o.aid as AidKey;
  }
  if (!action.fill && action.command === undefined && !action.aid) {
    return { error: invalid('an action fills fields, types a command or presses a key') };
  }
  return { action };
}

/** Resolve a field reference to an unprotected or protected field, or undefined. */
function resolve(term: Terminal, ref: FieldRef): Field | undefined {
  if (typeof ref === 'number') return term.screen.fields.filter((f) => !f.protected)[ref];
  // A label: the field after it on its row (any field, so protected ones are refused, not missed).
  return fieldAfter(term, ref) ?? labelledField(term, ref);
}

/** The first field of any kind starting after `label` on its row. */
function labelledField(term: Terminal, label: string): Field | undefined {
  const cols = term.screen.cols;
  for (let row = 0; row < term.text.length; row++) {
    const at = term.text[row]!.indexOf(label);
    if (at < 0) continue;
    const after = row * cols + at;
    const f = term.screen.fields.find(
      (x) => x.dataStart >= after && Math.floor(x.dataStart / cols) === row,
    );
    if (f) return f;
  }
  return undefined;
}

/**
 * Apply an action to the terminal, as the visitor would: fill the fields,
 * type the command, press the AID key. Everything is checked first; if
 * anything is refused, nothing is changed.
 */
export function applyAction(term: Terminal, action: DocentAction): ActionResult {
  if (!term.connected) return blocked('not-connected', 'the terminal is not connected');
  if (term.keyboard.isLocked) {
    return blocked('locked', 'the keyboard is locked (the host is not waiting for input)');
  }
  const aid = action.aid ?? (action.command !== undefined ? 'ENTER' : undefined);
  if (aid && !DOCENT_AIDS.includes(aid)) {
    return blocked('aid', `${aid} is not a key the Docent may press`);
  }

  // Check every target before touching anything.
  const fills: { field: Field; text: string }[] = [];
  for (const f of action.fill ?? []) {
    const field = resolve(term, f.field);
    if (!field) return blocked('no-field', `no field ${JSON.stringify(f.field)} on this screen`);
    if (field.display === 'hidden') return blocked('password', 'that is a password field');
    if (field.protected)
      return blocked('protected', `field ${JSON.stringify(f.field)} is protected`);
    if (f.text.length > field.length) {
      return blocked(
        'too-long',
        `"${f.text.slice(0, 20)}" does not fit (${field.length} characters)`,
      );
    }
    fills.push({ field, text: f.text });
  }
  let commandAt: number | undefined;
  if (action.command !== undefined) {
    const cf = recognise(term).commandField;
    const at = cf?.dataStart ?? term.screen.cursor;
    const field = term.screen.fieldAt(at);
    if (field?.display === 'hidden')
      return blocked('password', 'the cursor is in a password field');
    if (field?.protected && !cf) return blocked('protected', 'the cursor is in a protected field');
    if (field && action.command.length > field.length) {
      return blocked('too-long', `the command does not fit (${field.length} characters)`);
    }
    commandAt = cf ? cf.dataStart : undefined;
  }
  // Every character must exist in the code page.
  for (const text of [...fills.map((f) => f.text), action.command ?? '']) {
    try {
      term.codePage.encode(text);
    } catch (e) {
      return invalid((e as Error).message);
    }
  }

  // Apply.
  for (const { field, text } of fills) {
    term.moveCursor(field.dataStart);
    term.press({ type: 'eraseEof' });
    if (!term.type(text).accepted)
      return invalid(`typing into field at ${field.dataStart} was refused`);
  }
  if (action.command !== undefined) {
    if (commandAt !== undefined) term.moveCursor(commandAt);
    term.press({ type: 'eraseEof' });
    if (!term.type(action.command).accepted) return invalid('typing the command was refused');
  }
  if (aid) {
    if (!term.aid(aid).accepted) return blocked('locked', `${aid} was refused`);
    return { ok: true, aid };
  }
  return { ok: true };
}
