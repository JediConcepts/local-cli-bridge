# Changelog

## Unreleased

### Upgrading from 0.3.0

Suggested version: **0.4.0**. The HTTP API is a superset of 0.3.0's (streaming is new,
nothing a 0.3.0 client sends is now read differently), but some configurations stop the
bridge at start and Codex no longer reads `~/.codex/config.toml`. Under semver a 0.x minor
is where breaking changes go, and the project still calls itself a development and testing
bridge, so 1.0.0 would promise a stability it has not claimed yet.

Every change a current user could notice, marked **breaking** (you may need to act) or
**improvement** (nothing to do):

| Change | Kind | Who it affects | What to do |
| --- | --- | --- | --- |
| `BRIDGE_CLAUDE_ARGS` / `_JSON` are an allowlist; anything else (`--add-dir`, `--mcp-config`, `--allowedTools`, `--resume`, ...) stops a `claude` or `auto` bridge at start | breaking | anyone whose extra Claude arguments used a flag not on the list | remove the flag; the message names it |
| `BRIDGE_CODEX_ARGS` / `_JSON` are an allowlist (`--model`/`-m`, `--disable`, `--color`, `-c` for three output settings); `--enable`, `--sandbox`, `--dangerously-*`, `--add-dir`, `--profile`, `--oss`, other `-c` and bare arguments stop a `codex` or `auto` bridge at start | breaking | anyone with such Codex extras | remove the flag; the message names it |
| Codex runs with `--ignore-user-config`: `config.toml`'s model, effort, profiles, MCP servers and providers no longer apply | breaking | Codex users who relied on `config.toml` for the model or effort | send the model in the request or set `BRIDGE_MODEL`; use an effort suffix such as `gpt-5.5:high` |
| Codex runs with `--ignore-rules`, web search off unless asked for, and every tool feature disabled, so it cannot run commands, read files, browse or use apps | breaking for a workflow that let Codex use tools; an improvement for everyone else | anyone who expected Codex to act on the machine | none for chat use; a tool-using agent was never what the bridge offered |
| Codex is refused (503, saying why) when `codex features list` cannot be run or read | breaking where `codex` is missing from the service PATH (it would have failed anyway) | `codex` and `auto` bridges | make `codex features list` work as the bridge's user |
| Claude Code runs with `--safe-mode`, `--tools=` and `--no-session-persistence`: no CLAUDE.md, skills, plugins, hooks, MCP servers or tools, and no saved session | breaking for a setup that relied on those; an improvement for everyone else | Claude users whose prompts leaned on their CLAUDE.md or tools | put standing instructions in the system message |
| `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, `OPENAI_API_BASE`, `CODEX_EXEC_SERVER_URL` and `CODEX_URL` never reach a child, even with `BRIDGE_KEEP_ENV_KEYS=1` | breaking for anyone routing a CLI through a gateway with these | gateway or proxy setups | none supported; the bridge talks to each CLI's own provider |
| A request `model` that starts with `-` (or is not a string) is a 400 | improvement (breaking only for a client sending such an id) | none known | send a real model id |
| The request's model and system text are joined to their flags (`--model=...`) | improvement | anyone reading the argv in logs or wrappers | none |
| `"stream": true` gets an event stream instead of a 400 | improvement | streaming clients, which can now use the bridge | none |
| Model `system` runs Apple's model through a built-in backend (`apple`), with fixed arguments; `BRIDGE_BACKEND=apple` works | improvement | macOS 27 users | drop any `BRIDGE_AUTO_DEFAULT=command` / `BRIDGE_COMMAND=fm ...` lines |
| In `auto` mode, model `system` always goes to `apple`, even with `BRIDGE_AUTO_DEFAULT=command` | breaking for a `command` backend that served a model called `system` with something other than `fm` | very few | rename that model |
| A prompt too long for model `system` is a 400 with code `context_length_exceeded`, naming the limit (`BRIDGE_APPLE_CONTEXT_TOKENS`, default 4096) | improvement | Apple model users | send long prompts elsewhere |
| A missing env file logs a warning naming the paths tried | improvement | everyone | none |
| `web_search: true` opts a request in to web search | improvement | anyone who wants it | none |

The `command` backend is unchanged and unchecked.

**Checked against 0.3.0's own tests.** The published package has no tests, so 0.3.0's
test files were taken from `b3bb079` (also version 0.3.0; its scripts differ from the
published ones only in the env-file warning) and run against this code: 89 of 99 pass.
The 10 that fail each pin an old behaviour on purpose: two expect the old Claude argv
(separate `--model sonnet` tokens, no safety options), two pass `--add-dir` or `--exact`
through `BRIDGE_CLAUDE_ARGS` (now refused), four build a Codex run without the feature
list (now refused) and with `--model` as a separate token, and two expect
`"stream": true` to be a 400.

### Security (Codex and Apple's model)

- **Codex runs with no tools, nothing saved and no user settings.** Every `codex exec`
  gets `--ephemeral`, `--sandbox read-only`, `--ignore-user-config` and `--ignore-rules`,
  `-c web_search="disabled"` unless the request opted in to web search (then the top-level
  `--search`, nothing else), and `--disable` for every feature `codex features list` shows
  except removed ones and six that give the model nothing to call. Codex has no single
  switch for "no tools", and disabling by rule means a tool feature added by a later
  Codex release is off too. The list is read once with no prompt; if it cannot be read,
  Codex is refused. The request's model is joined to `--model=`.
- **`BRIDGE_CODEX_ARGS` and `BRIDGE_CODEX_ARGS_JSON` are an allowlist**, checked when a
  `codex` or `auto` bridge starts.
- **Codex's endpoint is fixed.** `OPENAI_BASE_URL`, `OPENAI_API_BASE`,
  `CODEX_EXEC_SERVER_URL` and `CODEX_URL` are removed from every child's environment,
  like `ANTHROPIC_BASE_URL`.
- **Apple's on-device model is a built-in backend.** Model `system` (or
  `BRIDGE_BACKEND=apple`) runs `fm respond --no-stream`, prompt on stdin, system text as
  `-i`, and never `--tool`, `--resume`, `--save-transcript`, `--image` or `--schema`. It
  needs no `BRIDGE_COMMAND`, works in `auto` mode and streams like every backend. A prompt
  estimated above `BRIDGE_APPLE_CONTEXT_TOKENS` (default 4096) is a 400 with code
  `context_length_exceeded` that names the limit.
- The `command` backend is documented as unchecked.

### Added

- **Streaming (`stream: true`).** A truthy `stream` used to be a 400; it now gets an
  OpenAI-style event stream. The bridge answers `200 text/event-stream` at once, sends an
  SSE comment heartbeat at least every 10 s (or every `BRIDGE_KEEPALIVE_MS` when that is
  shorter) while the CLI runs, then a role chunk, the whole answer as one content chunk,
  a `stop` chunk and `data: [DONE]`. `stream_options.include_usage` adds a usage chunk
  with the same estimate a buffered completion reports. A failure after the headers is
  one `data: {"error":{…}}` event, redacted as before, and the stream ends without
  `[DONE]`. Auth, validation, the concurrency limit, `BRIDGE_TIMEOUT_MS` and killing the
  CLI when the client disconnects work as before, and the JSON keepalive never writes
  into a stream. Clients that always stream, such as a meeting recorder whose minutes can
  take 15 minutes to write, can now use the bridge. Non-streaming responses are
  unchanged.
- An opt-in end-to-end test (`tests/meetingbox.test.mjs`) that runs meetingbox's
  minutes writer, a real streaming client built on ai-execution-router, against the
  bridge. It is skipped unless `MEETINGBOX_MINUTES_DIR` points at an installed copy.

- **`docs/RUNNING_AS_A_SERVICE.md`.** Running the bridge under launchd, `systemd --user`,
  and Windows Task Scheduler. The foreground quick start is fine for a trial, but the
  tunnel setup this project exists for needs an origin that survives a closed terminal.
  Covers the three things that make service managers fail where a shell succeeds: the env
  file binds to the script's location (not the cwd), services inherit no `PATH` and so
  cannot find the backend CLI, and hardcoding a version-manager Node path breaks on the
  next upgrade.
- Troubleshooting rows for those service failure modes, and for Codex 400s caused by a
  global `model_reasoning_effort` in `~/.codex/config.toml` that the requested model does
  not support.

### Changed

- **A missing env file now warns instead of returning silently.** `loadBridgeEnv()` fell
  through to the built-in defaults without a word, so a bridge pointed at the wrong
  checkout would start clean, log a healthy banner, and serve `backend=claude` with only
  `opus,sonnet,haiku` — indistinguishable from a working deployment until someone asked
  why their models were missing. It now names the paths it tried. A file that exists but
  applies nothing (every key already set inline, or no `BRIDGE_*` keys at all) says which
  of the two it was.
- **`BRIDGE_CLAUDE_ARGS` and `BRIDGE_CLAUDE_ARGS_JSON` are an allowlist.** They may use
  `--model`, `--fallback-model`, `--effort`, `--append-system-prompt`, `--system-prompt`,
  `--max-turns`, `--max-budget-usd`, `--permission-mode` (`default`, `manual`, `dontAsk`
  or `plan`), `--disallowedTools`, `--strict-mcp-config`, `--disable-slash-commands` and
  `--no-chrome`, and nothing else. A `claude` or `auto` bridge given anything else, such
  as `--add-dir`, `--mcp-config`, `--allowedTools` or `--resume`, refuses to start and
  names the flag. **Breaking** for a configuration that used one of those.

### Security

- **Claude Code runs with no tools, in safe mode, with no saved session.** Every run now
  adds `--safe-mode`, `--no-session-persistence` and `--tools=` (no tools), so nothing in
  a prompt, which is whatever a caller sent, can get Claude Code to run anything on this
  machine, and the prompt is not kept as a session. A request with `"web_search": true`
  gets `--tools=WebSearch,WebFetch` and the existing `--allowedTools=WebSearch,WebFetch`,
  and nothing more. The tool lists are single `--flag=value` tokens, so the variadic
  flags cannot swallow a later argument.
- **Nothing a request sends can stand in Claude Code's argv as an option.** The
  request's model, effort and system text used to be separate tokens after `--model`,
  `--effort` and `--append-system-prompt`, so a request could put an exact flag token
  such as `--settings={...}` there. They are now joined to their flags in one token
  (`--model=sonnet`), so such a value is only ever the flag's value. A request `model`
  that starts with `-`, or is not a string, is now a 400 for every backend, because the
  `codex` and `command` backends pass the model as its own argument.
- **`ANTHROPIC_BASE_URL` never reaches a CLI.** It is removed from the child's
  environment for every backend, even with `BRIDGE_KEEP_ENV_KEYS=1`, so a stray setting
  cannot send prompts to a host other than Anthropic.

## 0.3.0

### Added

- **Embeddings proxy.** The CLI backends cannot embed — neither Claude Code nor Codex
  has an embeddings mode — so `/v1/embeddings` (OpenAI shape) and `/api/embeddings` +
  `/api/pull` (Ollama's native shape) forward to a local Ollama at
  `BRIDGE_OLLAMA_URL`. That lets **one tunnelled surface carry both chat and
  embeddings**, instead of standing up a second tunnel for the second shape: a client
  points `OLLAMA_BASE_URL` at the bridge and authenticates with `OLLAMA_API_KEY` set
  to the bridge key.

  Upstreamed from a vendored fork that had carried it privately. Keeping it there
  meant a copy of the whole bridge drifting out of sync — the fork was 590 lines
  against 969 here, and had missed every hardening change in between.

  Same auth, same `BRIDGE_MAX_BODY_BYTES` ceiling and same error shape as the chat
  route, so embeddings cannot bypass a limit chat respects. An unreachable Ollama
  returns a 502 that **names the URL it tried** and the setting that changes it —
  "is Ollama even running?" is always the first question. Token counts are reported
  as `0` rather than estimated: Ollama returns none, and an obviously absent number
  beats a fabricated one.

  New: `BRIDGE_OLLAMA_URL`, `BRIDGE_EMBED_MODEL`.

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
