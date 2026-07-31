# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/) (0.x: minor bumps may change behavior).

## [Unreleased]

## [0.2.0] - UNRELEASED

Pending the real-CLI release gate in [docs/RELEASE_CHECKLIST.md](./docs/RELEASE_CHECKLIST.md).

### Added
- **Cancellation:** a client that disconnects mid-completion now has its CLI child
  killed (SIGTERM, then SIGKILL after 2s) instead of the child running to completion or
  the 15-minute timeout. Best effort: only the direct child is signalled.
- **Output cap:** `BRIDGE_MAX_PROCESS_OUTPUT_BYTES` (default 10 MB) bounds total child
  output — stdout + stderr + the Codex result file. On breach the child is killed and
  the request fails 502.
- **Exact argv forms:** `BRIDGE_COMMAND_JSON`, `BRIDGE_CLAUDE_ARGS_JSON`,
  `BRIDGE_CODEX_ARGS_JSON` take a JSON array of strings and win over the template forms.
- `SECURITY.md` (threat model, hardening checklist, private-advisory reporting),
  `docs/RELEASE_CHECKLIST.md`, and a tag-triggered npm release workflow with provenance.
- Test suite grew from 6 smoke tests to 72 tests: cancellation (including slot retention
  and SIGKILL escalation), output caps, multibyte round-trips, keepalive contracts,
  argv parsing, backend build/parse units, and model-caps precedence.

### Changed
- **Keepalive default is now `auto`** (was: always-on 20s). The Cloudflare-524 heartbeat
  runs only for requests carrying Cloudflare edge headers; direct local requests keep
  real HTTP status codes. Numeric values keep the old absolute semantics (`0` never,
  `N` ms always). If you relied on the old default while fronting the bridge with a
  proxy that strips Cloudflare headers, set a numeric interval explicitly.
- **Backend timeout now returns 504** (Gateway Timeout); other backend failures remain
  502. With the heartbeat active both still arrive in-body on the committed 200.
- **Multi-turn conversations** are folded as a symmetric labeled transcript
  (`User:` / `Assistant:` / `Tool:`); previously only assistant turns were labeled.
  Single-user-turn requests are unchanged (byte-identical passthrough).
- **Unknown models omit capability figures** on `/v1/models` (previously an invented
  128k/8k floor was advertised); `caps_source: "unknown"` is now the whole answer.
  Known-family defaults moved to `config/model-capability-defaults.json`.
- `BRIDGE_COMMAND` / `BRIDGE_CLAUDE_ARGS` / `BRIDGE_CODEX_ARGS` are parsed with a
  quote-aware limited argv parser instead of naive whitespace splitting. Values
  containing none of `"` `'` `\` tokenize exactly as before; values containing
  those characters **change meaning** — quotes now group and are stripped
  (shell-style) instead of passing through literally, backslashes escape, and
  unbalanced quotes fail loudly at request time. Migration: a value that relied
  on literal quotes reaching the CLI (e.g. a Codex TOML override
  `-c model_reasoning_effort="high"`) must nest them in single quotes
  (`-c 'model_reasoning_effort="high"'`) or move to the new `*_ARGS_JSON` exact
  form.
- Message roles are validated (`system`, `developer`, `user`, `assistant`, `tool`,
  `function`); unknown roles are rejected 400 instead of leaking into prompt text.
  `developer` messages fold into the system text.
- Explicit `null` for `stream`/`tools`/`tool_choice`/`response_format`/`functions`/`n`
  is tolerated (several SDKs serialize unset optionals as null); truthy non-boolean
  `stream` values are now rejected.

### Fixed
- **Concurrency slots no longer leak on disconnect:** a cancelled request's slot is
  released when its child exits, so abandoned long calls can no longer wedge the bridge
  into 429s for up to 15 minutes — and the ceiling is never exceeded while a killed
  child is still dying.
- **The codex backend silently dropped system messages**; system/developer text is now
  prepended to the piped prompt (`codex exec` has no system flag).
- **Multibyte UTF-8 corruption** on chunk boundaries fixed on every byte path: child
  stdout/stderr (StringDecoder) and the HTTP request body (Buffer concatenation).
- `{model}` substitution in `BRIDGE_COMMAND` now replaces every occurrence, not just
  the first.
- A killed child's stdin EPIPE can no longer crash the bridge process.
- `null` message content folds to empty text instead of the literal word "null".
- A request body of literal `null` (or a string/array) crashed the whole bridge
  process via an unhandled rejection; non-object bodies are now a 400.
- Two concurrent Codex completions starting in the same millisecond could share
  one result file (crossed answers, or one deleting the other's); result files
  are now UUID-suffixed.

## [0.1.1] - 2026-07-29

### Changed
- Friendly error on port collision (EADDRINUSE) instead of a stack trace.
- README: npm badge, npx quickstart, tunnel quickstart via npx.

## [0.1.0] - 2026-07-28

### Added
- Initial release: OpenAI-compatible bridge for locally authenticated CLI model tools
  (`claude`, `codex`, arbitrary stdin command), Cloudflare tunnel launcher, smoke tests,
  CI, npm packaging.
