# Security

## Reporting a vulnerability

Please report security problems privately, not in a public issue: use
**Security → Report a vulnerability** on the GitHub repository
(<https://github.com/rcplanb/3270js/security/advisories/new>).

Include what you found, how to reproduce it, and what an attacker could do
with it. You should get a reply within a week.

## What counts

Anything that lets one party do more than it should, for example:

- **The WebSocket-to-TCP proxy** (in `3270js/node`) reaching a host or port it
  was not configured for. It is meant never to be an open relay.
- **Session traces** keeping a password or other non-display field that the
  redaction should have removed.
- **Host data** making the renderers run script or inject markup.
- Input from a host crashing or hanging the parser (the data stream is
  untrusted input).

A host behaving like a host (a mainframe sending you screens you can log on
to) is not a vulnerability in 3270js.
