# Contributing

Thank you for helping. Issues and pull requests are welcome.

3270js is maintained by one person, in a time zone that may not match yours,
so replies to issues and pull requests can take a few days. Every pull request
waits for the maintainer's review before it is merged.

## Setting up

Node 20 or later (`.nvmrc` has the version used for development).

```sh
npm install
npm run check        # type check, lint, unit tests, trace checks
npm run dev          # build and serve the demo
```

CI runs the same checks, plus the build, the export check and the package
check, on every pull request.

## Tests

- **Unit, differential and interop:** `npm test`. The differential tests
  compare 3270js with s3270 (from the x3270 suite) and skip with a warning if
  `s3270` is not installed.
- **Browser:** `npm run test:e2e` (Playwright: Chrome, Firefox and WebKit).
  The screenshot baselines are made on macOS.
- **Live:** `npm run test:live` drives a real TN3270 host, such as a Hercules
  TK5 system. See [test/live/README.md](test/live/README.md). Never commit a
  host's address or a password; pass them in the environment.

A change to behaviour comes with a test. A bug fix comes with a test that
failed before it.

## Ground rules

- **No x3270 source code.** 3270js is written from IBM's documentation
  (_3270 Data Stream Programmer's Reference_, GA23-0059, and RFC 2355 for
  TN3270E) and checked against s3270's behaviour. Reading x3270's source to
  understand behaviour is fine; copying or porting it is not. The few pieces
  taken from x3270 (status-line glyphs, the APL mapping) are listed in
  [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md); anything else taken from a
  third party must be added there with its licence.
- **No IBM software or manuals** in the repository: no disk images, no PDF
  manuals, no captured data you are not free to share.
- **Traces** (`test/traces/`) are recordings of real sessions. Check one
  before committing it: no passwords (the recorder redacts non-display
  fields, but check), and no internal host names or addresses on the
  screens.
- The core (`src/core`) has no dependencies and uses no DOM or Node APIs, so
  it runs anywhere. `npm run typecheck` enforces this.
- `SPEC.md` is the design; if a change departs from it, update it in the same
  pull request.

## Licence

By contributing you agree that your contribution is licensed under the MIT
licence, as the rest of 3270js is.
