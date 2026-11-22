# 3270js

A TN3270/TN3270E terminal emulator library for the browser and Node — an
[xterm.js](https://xtermjs.org/) analogue for IBM 3270 display terminals.

**Status:** pre-alpha. Design is in [SPEC.md](SPEC.md); no code yet.

- Headless, dependency-free core (telnet, 3270 data stream, field model, keyboard)
- Pluggable renderers (DOM and canvas)
- Pluggable transports (WebSocket, Node TCP)

## Development

Requires Node 24 (`nvm use`).

```sh
npm install
npm run check          # typecheck + lint + unit tests
npm run build          # dist/ (ESM + CJS + .d.ts)
npm run check:exports  # build, then load every entry point via require() and import
```

`src/core` must stay platform-neutral (no DOM, no Node APIs). Both
`tsconfig.core.json` and ESLint enforce this.

## License

MIT
