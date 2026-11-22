/**
 * Screen recognisers: what kind of screen is showing, what it is called, where
 * its command line is, and whether the cursor is in a password field. For
 * prompt detection and the Docent (SimH Assist), in place of regexes over a
 * stream of text. They work on anything with a screen and its text: a
 * Terminal or a SessionObserver.
 *
 * The built-in kinds come from TK5 (MVS 3.8j) and OS/390 2.10 screens, as
 * recorded in test/traces.
 */
import type { Field, Screen } from '../screen/index.js';

/** A screen and its text: a Terminal or a SessionObserver. */
export interface ScreenSource {
  readonly screen: Screen;
  /** One string per row, non-display fields blank. */
  readonly text: readonly string[];
}

export type Matcher = (s: ScreenSource) => boolean;
type Pattern = string | RegExp;

const test = (pattern: Pattern, text: string) =>
  typeof pattern === 'string' ? text.includes(pattern) : pattern.test(text);

/** Building blocks for recognising screens. */
export const match = {
  /** The pattern appears anywhere on the screen (rows joined with newlines). */
  text:
    (pattern: Pattern): Matcher =>
    (s) =>
      test(pattern, s.text.join('\n')),
  /** The pattern appears on a row; negative rows count from the bottom. */
  row:
    (row: number, pattern: Pattern): Matcher =>
    (s) => {
      const line = s.text[row < 0 ? s.text.length + row : row];
      return line !== undefined && test(pattern, line);
    },
  /** The text appears at exactly (row, col). */
  at:
    (row: number, col: number, text: string): Matcher =>
    (s) =>
      (s.text[row] ?? '').startsWith(text, col),
  /** The cursor is in an unprotected non-display field: typing there is secret. */
  cursorInHiddenField: (): Matcher => (s) => {
    const f = s.screen.fieldAt(s.screen.cursor);
    return Boolean(f && !f.protected && f.display === 'hidden' && s.screen.cursor !== f.start);
  },
  all:
    (...ms: Matcher[]): Matcher =>
    (s) =>
      ms.every((m) => m(s)),
  any:
    (...ms: Matcher[]): Matcher =>
    (s) =>
      ms.some((m) => m(s)),
  not:
    (m: Matcher): Matcher =>
    (s) =>
      !m(s),
};

/**
 * The first unprotected field that starts after `label` on the same row (the
 * input field of "Option ===>", "Logon ===>" and the like).
 */
export function fieldAfter(s: ScreenSource, label: Pattern): Field | undefined {
  const cols = s.screen.cols;
  for (let row = 0; row < s.text.length; row++) {
    const line = s.text[row]!;
    const at = typeof label === 'string' ? line.indexOf(label) : (label.exec(line)?.index ?? -1);
    if (at < 0) continue;
    const after = row * cols + at;
    const field = s.screen.fields.find(
      (f) => !f.protected && f.dataStart >= after && Math.floor(f.dataStart / cols) === row,
    );
    if (field) return field;
  }
  return undefined;
}

/** The kinds of screen recognised. */
export type ScreenKind =
  /** Hercules' logo: the device is connected but VTAM hasn't written to it yet. */
  | 'hercules'
  /** VTAM's logon screen: TK5's "Logon ===>" or an OS/390 USS screen. */
  | 'vtam-logon'
  /** The cursor is in a non-display field (a password). */
  | 'password'
  /** TSO is waiting for Enter to show more ("***"), possibly over a panel. */
  | 'more'
  /** ISPF's primary option menu. */
  | 'ispf-primary'
  /** Any other ISPF (or ISPF-style) panel with a command line. */
  | 'ispf-panel'
  /** TSO line mode, at READY. */
  | 'tso-ready'
  | 'unknown';

export interface Recognised {
  kind: ScreenKind;
  /** The panel's title, for ISPF panels: e.g. "RFE DSLIST", "Utility selection menu". */
  title?: string;
  /** The field commands are typed into, when the screen has one. */
  commandField?: Field;
  /** The cursor is in a non-display field: whatever is typed is secret. */
  password: boolean;
}

const CONTINUE = /^\s*\*\*\*(\s|$)/m; // "***", not Revedit's or logoff's "******"
const READY = /^\s*READY\s*$/m;
const ISPF_PRIMARY = /ISPF primary option menu/i;
const COMMAND_LINE = /\b(Option|Command)\s*===>/i;
const TK5_LOGON = /Logon ===>/;
const USS = /ENTER\s+"?LOGON"?|ENTER L FOLLOWED BY THE APPLID/i;

/** Recognise the screen. The first kind that applies, in this order, wins. */
export function recognise(s: ScreenSource): Recognised {
  const all = s.text.join('\n');
  const password = match.cursorInHiddenField()(s);
  const result = (kind: ScreenKind, extra: Partial<Recognised> = {}): Recognised => ({
    kind,
    password,
    ...extra,
  });

  if (password) return result('password');
  if (CONTINUE.test(all)) return result('more');
  if (ISPF_PRIMARY.test(all)) {
    const commandField = fieldAfter(s, COMMAND_LINE);
    return result('ispf-primary', {
      title: 'ISPF Primary Option Menu',
      ...(commandField ? { commandField } : {}),
    });
  }
  if (TK5_LOGON.test(all)) {
    const commandField = fieldAfter(s, TK5_LOGON);
    return result('vtam-logon', commandField ? { commandField } : {});
  }
  if (USS.test(all)) return result('vtam-logon');
  if (s.screen.isFormatted) {
    const commandField = fieldAfter(s, COMMAND_LINE) ?? fieldAfter(s, /===>/);
    if (commandField) {
      const title = screenTitle(s);
      return result('ispf-panel', { commandField, ...(title ? { title } : {}) });
    }
  }
  if (READY.test(all)) return result('tso-ready');
  if (/^\s*Hercules Version/m.test(all)) return result('hercules');
  return result('unknown');
}

/**
 * An ISPF panel's title: the first piece of its first non-blank row, without
 * the dashes that frame it, a scroll position or a version.
 */
export function screenTitle(s: ScreenSource): string | undefined {
  const line = s.text.find((l) => l.trim());
  if (!line) return undefined;
  // ISPF frames titles with dashes ("---  RFE DSLIST  ---- Row 1 of 4"); what
  // follows the frame (a scroll position, a version) is not the title.
  const piece = line
    .split(/-{2,}/)
    .map((p) => p.trim())
    .find((p) => p);
  const title = piece?.replace(/\s+Row\s+\d+\s+of\s+\d+$/i, '').trim();
  return title || undefined;
}

/** A field as the Docent sees it. */
export interface FieldView {
  /** Index among the screen's unprotected fields (for actions). */
  index?: number;
  row: number;
  col: number;
  length: number;
  protected: boolean;
  hidden: boolean;
  /** The text just before the field on its row (e.g. "Option ===>"). */
  label?: string;
  /** The field's contents; always '' for hidden fields. */
  value: string;
}

export interface ScreenState extends Recognised {
  /** The keyboard is free: the host is waiting for the operator. */
  ready: boolean;
  cursor: { row: number; col: number };
  text: string[];
  fields: FieldView[];
}

/**
 * Everything about the screen in one plain object (e.g. for the Docent).
 * `locked` is the keyboard lock: `Terminal.keyboard.isLocked` or
 * `SessionObserver.keyboardLocked`. Hidden fields' values are never included.
 */
export function screenState(s: ScreenSource, locked: boolean): ScreenState {
  const { cols } = s.screen;
  const text = [...s.text];
  let index = 0;
  const fields = s.screen.fields.map((f): FieldView => {
    const row = Math.floor(f.dataStart / cols);
    const col = f.dataStart % cols;
    const hidden = f.display === 'hidden';
    const line = text[row] ?? '';
    const label = line
      .slice(0, Math.max(0, col - 1))
      .split(/\s{2,}/)
      .pop()
      ?.trim();
    const value = hidden ? '' : line.slice(col, col + f.length).trimEnd();
    return {
      ...(f.protected ? {} : { index: index++ }),
      row,
      col,
      length: f.length,
      protected: f.protected,
      hidden,
      ...(label ? { label } : {}),
      value,
    };
  });
  return {
    ...recognise(s),
    ready: !locked,
    cursor: { row: Math.floor(s.screen.cursor / cols), col: s.screen.cursor % cols },
    text,
    fields,
  };
}
