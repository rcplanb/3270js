/** The DOM renderer's stylesheet, injected once per document. */
export const DOM_CSS = `
.t3270 {
  --t3270-line: 1.25em;
  display: inline-block;
  position: relative;
  padding: 0.5em;
  font-variant-ligatures: none;
  outline: none;
  cursor: text;
}
.t3270:focus-visible { box-shadow: 0 0 0 2px var(--t3270-cursor); }
.t3270-screen { position: relative; }
.t3270-row {
  height: var(--t3270-line);
  line-height: var(--t3270-line);
  white-space: pre;
}
.t3270-cursor {
  position: absolute;
  width: 1ch;
  height: var(--t3270-line);
  pointer-events: none;
}
.t3270-cursor-block { background: var(--t3270-cursor); opacity: 0.6; }
.t3270-cursor-underline {
  height: 0.15em;
  margin-top: calc(var(--t3270-line) - 0.15em);
  background: var(--t3270-cursor);
}
.t3270-blink { animation: t3270-blink 1.2s step-end infinite; }
@keyframes t3270-blink { 50% { visibility: hidden; } }
.t3270-oia {
  margin-top: 0.25em;
  border-top: 1px solid var(--t3270-oia-rule);
  height: var(--t3270-line);
  line-height: var(--t3270-line);
  white-space: pre;
  color: var(--t3270-oia);
}
.t3270-glyph {
  display: inline-block;
  width: 1ch;
  height: var(--t3270-line);
  vertical-align: top;
  fill: currentColor;
  shape-rendering: crispEdges;
}
.t3270-sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: pre;
}
`;
