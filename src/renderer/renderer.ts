/**
 * The contract every renderer implements. A renderer displays a Terminal's
 * state; it never changes it (keyboard input goes through KeyboardMapper).
 */
import type { Terminal } from '../core/terminal.js';
import type { DisplayMode } from './cell-style.js';
import type { Theme } from './theme.js';

export interface CellMetrics {
  /** CSS pixels. */
  width: number;
  height: number;
}

export interface RendererOptions {
  theme?: Theme;
  /** Default `color` for 3279 terminals, `monochrome` for 3278s. Can be switched live. */
  displayMode?: DisplayMode;
  cursorStyle?: 'block' | 'underline';
  cursorBlink?: boolean;
  /** Draw the status line with x3270's 3270 glyphs (default) or in plain words. */
  oiaGlyphs?: boolean;
}

export interface Renderer {
  /** Start displaying a terminal; repaints fully, then follows its events. */
  attach(terminal: Terminal): void;
  /** Stop following the terminal (the element stays as it is). */
  detach(): void;
  /** Repaint everything, e.g. after a theme or size change. */
  refresh(): void;
  /** Switch between the colour and monochrome looks, like a 3279's switch. */
  setDisplayMode(mode: DisplayMode): void;
  /** Show the shift indicator (Shift or Caps Lock is down). Called by the keyboard mapper. */
  setShift(down: boolean): void;
  /** The screen cell under a point in client coordinates, if any (for mouse input). */
  cellAt(clientX: number, clientY: number): { row: number; col: number } | undefined;
  /** The selected block's text, one line per row ('' when nothing is selected). */
  readonly selectionText: string;
  /** Clear the block selection. */
  clearSelection(): void;
  /** Size of one character cell, once known. */
  readonly cellMetrics: CellMetrics | undefined;
  /** The element that should receive keyboard focus. */
  readonly element: HTMLElement;
  focus(): void;
  /** Detach and remove everything the renderer added to the page. */
  dispose(): void;
}
