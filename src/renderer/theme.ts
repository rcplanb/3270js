/**
 * Colour slots a renderer paints with, and themes that give them values.
 * cellStyle() picks slots; renderers look them up in a theme.
 */
export type ColorSlot =
  /** Screen background. */
  | 'background'
  /** Monochrome normal text (3278). */
  | 'default'
  /** Monochrome intensified text. */
  | 'intensified'
  // The 3279 colours (X'F0'–X'F7').
  | 'neutralBlack'
  | 'blue'
  | 'red'
  | 'pink'
  | 'green'
  | 'turquoise'
  | 'yellow'
  | 'neutralWhite'
  // Extended colours (X'F8'–X'FF', as x3270 supports them).
  | 'black'
  | 'deepBlue'
  | 'orange'
  | 'purple'
  | 'paleGreen'
  | 'paleTurquoise'
  | 'grey'
  | 'white';

export interface Theme {
  colors: Record<ColorSlot, string>;
  cursor: string;
  /** Status line (OIA) text and its separator line. */
  oia: string;
  oiaRule: string;
  fontFamily: string;
}

/** Colours close to x3270's defaults. */
export const DEFAULT_THEME: Theme = {
  colors: {
    background: '#000000',
    default: '#33cc33',
    intensified: '#7dff7d',
    neutralBlack: '#000000',
    blue: '#5f87ff',
    red: '#ff3b3b',
    pink: '#ff5fd7',
    green: '#33cc33',
    turquoise: '#33e0e0',
    yellow: '#ffff33',
    neutralWhite: '#f0f0f0',
    black: '#000000',
    deepBlue: '#3355ff',
    orange: '#ffa033',
    purple: '#b05fff',
    paleGreen: '#a0ffa0',
    paleTurquoise: '#a0ffff',
    grey: '#b0b0b0',
    white: '#ffffff',
  },
  cursor: '#7dff7d',
  oia: '#5f87ff',
  oiaRule: '#5f87ff',
  fontFamily: '"IBM 3270", "3270", Menlo, Consolas, "DejaVu Sans Mono", monospace',
};
