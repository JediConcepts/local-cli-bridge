# Local model bridge (`scripts/local-cli-bridge.mjs`)

> Installed from npm rather than a clone? Wherever this guide says `npm run bridge` or `npm run bridge:tunnel`, use `npx local-cli-bridge` or `npx local-cli-bridge-tunnel`.


Route a request from your application to a model running on your own machine.

## When you need it

If your application can call a **named custom OpenAI-compatible endpoint**, whether you
need this bridge depends on what the local model exposes:

| Local model | Exposes an OpenAI server? | Needs the bridge? |
|---|---|---|
| **Ollama** (`ollama serve`) | Yes, `http://localhost:11434/v1` | ❌ point your application straight at it |
| **LM Studio** | Yes, `http://localhost:1234/v1` | ❌ point your application straight at it |
| **Claude Code CLI** | No, it's a CLI | ✅ run the bridge |
| **Codex CLI** | No, it's a CLI | ✅ run the bridge |

The bridge is the shim that makes a CLI *look like* an OpenAI server:

```
your application ──HTTP /v1/chat/completions──► local-cli-bridge ──shell──► claude -p / codex exec ──► your subscription
 (custom endpoint)                               (127.0.0.1:8787)
```

> ⚠️ Dev/testing tool only. It binds to loopback by default and spawns the CLI once
> per request (seconds of overhead per call). Not for production traffic.

## Run it

On the workstation that has the CLI + subscription:

```bash
# Claude Code (default backend)
node scripts/local-cli-bridge.mjs
#   → listening on http://127.0.0.1:8787 ; backend=claude

# Codex CLI
BRIDGE_BACKEND=codex node scripts/local-cli-bridge.mjs

# Anything else that reads a prompt on stdin and prints the answer
BRIDGE_BACKEND=command BRIDGE_COMMAND='ollama run {model}' node scripts/local-cli-bridge.mjs

# BOTH Claude and Codex from ONE bridge on ONE port, dispatched by model id
BRIDGE_BACKEND=auto BRIDGE_MODELS="opus,sonnet,haiku,gpt-5.5" node scripts/local-cli-bridge.mjs
```

Or `npm run bridge` (same as the default `claude` backend).

**One endpoint for both:** in `auto` mode a request for `opus`/`sonnet`/`haiku` routes to
Claude Code and a request for a `gpt-*`/`codex` model routes to Codex, so you register a
single custom endpoint in your application and pick the model per request. Set
`BRIDGE_MODELS` to the union of both families so a model dropdown prefills them all.

### Apple Foundation Models (macOS 27)

macOS 27 ships Apple's on-device Foundation Model with an `fm` CLI at `/usr/bin/fm`. The
bridge has it built in: model `system` runs `fm respond` with fixed, safe arguments (see
[How the backends invoke the CLIs](#how-the-backends-invoke-the-clis)). No
`BRIDGE_COMMAND` is needed. In an `auto` bridge, add it to the advertised list:

```bash
BRIDGE_BACKEND=auto
BRIDGE_MODELS=sonnet,opus,haiku,gpt-5.5,system   # your existing list, plus "system"
```

Or serve it alone with `BRIDGE_BACKEND=apple`. Requests for model `system` then go to the
on-device model, and Claude and Codex ids route as before. The bridge's API key check and
the Cloudflare Tunnel path apply to it like any other backend. Check `fm available` reports
the model as available, and read Apple's terms with `fm license` before exposing it
remotely.

An older setup (`BRIDGE_AUTO_DEFAULT=command` with `BRIDGE_COMMAND='fm respond --no-stream'`)
still starts, but model `system` now goes to the built-in backend. Remove both lines, so
that a mistyped model id reaches Claude and gets an error rather than an answer from `fm`.

Things to know:

- **`BRIDGE_AUTO_DEFAULT` catches every other id.** An id that is not `system` and not
  recognisably Claude (`opus`/`sonnet`/`haiku`/`claude`) or Codex (`gpt`/`codex`/`o1` and
  so on) goes to it. With the default (`claude`), a typo reaches Claude.
- **Long prompts are refused.** About 4096 tokens fit; a longer one gets a 400 naming the
  limit. Send transcripts and other long work to Claude or Codex.
- **Prompts stay on the Mac.** The model runs on the device and `--no-stream` saves no
  transcript. The bridge logs only the model id, response size and timing for a successful
  request. A failed request logs the error, which can include the CLI's stderr.
- **It is a small model.** Good for tagging, classification, short summaries and field
  extraction; not a replacement for Claude or Codex on long or hard work.
- **Local only? You may not need the bridge.** `fm serve --port 1976` runs Apple's own
  Chat Completions server, with streaming and reported token counts. It has no auth, and
  it streams when a request omits `stream`, so send `"stream": false` for a single JSON
  reply. Use the bridge when you want an API key, the tunnel, or one endpoint for every
  model.

### Environment

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `8787` | listen port |
| `HOST` | `127.0.0.1` | bind address, keep it loopback unless you must expose it |
| `BRIDGE_BACKEND` | `claude` | `claude` \| `codex` \| `apple` \| `command` \| `auto` (dispatch by model id; model `system` goes to `apple`) |
| `BRIDGE_AUTO_DEFAULT` | `claude` | `auto` mode: backend for an ambiguous model id |
| `BRIDGE_COMMAND` |, | `command` backend: a quoted command template; `{model}` tokens are substituted, prompt piped to stdin. Quoting and backslash escapes are supported (a **limited argv parser** — no shell expansion, no substitution; see `scripts/lib/parse-argv.mjs` for the exact grammar) |
| `BRIDGE_COMMAND_JSON` |, | `command` backend, exact form: a JSON array of strings (`'["ollama","run","{model}"]'`). Wins over `BRIDGE_COMMAND` when both are set |
| `BRIDGE_MODEL` |, | default model id when a request omits one |
| `BRIDGE_MODELS` | per-backend | comma-separated ids advertised on `/v1/models` to prefill a routing dropdown. Defaults: `claude` **and** `auto` advertise `opus,sonnet,haiku`; `codex` and `command` advertise nothing (empty list — a routing UI can fall back to free-text). Codex slugs vary per account, so set your own, e.g. `BRIDGE_MODELS="gpt-5.5,gpt-5.6-sol"` — especially in `auto` mode, where the Claude-only default otherwise prefills ids a Codex-only deployment can't serve |
| `BRIDGE_TIMEOUT_MS` | `900000` | per-request CLI timeout; on expiry the child is killed (SIGTERM, then SIGKILL after 2s) and the request fails `504` |
| `BRIDGE_API_KEY` |, | if set, callers must send `Authorization: Bearer <it>` |
| `BRIDGE_KEEPALIVE_MS` | `auto` | Cloudflare-524 heartbeat. `auto` heartbeats **only requests carrying Cloudflare edge headers** (a heuristic on `cf-ray` / `cf-connecting-ip` — forgeable, and forging merely turns the heartbeat on for that request), so local calls keep real status codes; `0` never heartbeats, a number heartbeats every N ms for every request (see [REMOTE_BRIDGE.md](./REMOTE_BRIDGE.md)). An event stream (`stream: true`) heartbeats with SSE comments instead, whatever this says: every N ms when N is under 10 s, otherwise every 10 s (see [Streaming](#streaming)) |
| `BRIDGE_MAX_BODY_BYTES` | `10485760` | request body ceiling (10 MB, the CLI stdin cap); excess → 413 |
| `BRIDGE_MAX_PROCESS_OUTPUT_BYTES` | `10485760` | ceiling on **total child process output** — stdout + stderr + the Codex result file, agent chatter included, not just the model answer. On breach the child is killed and the request fails `502` |
| `BRIDGE_MAX_CONCURRENT` | `4` | ceiling on live CLI child processes; excess → 429. Held until a child actually exits — including one that is being killed after its client disconnected — so it can never be exceeded during cancellation. Single-user operators can lower it |
| `BRIDGE_LOG_TIME` | `human` | timestamp prefix on log lines: `human` (`YYYY-MM-DD HH:MM:SS.mmm`, local), `iso` (UTC, matches a caller's audit record `timestamp`), or `off` for supervisors that stamp their own |
| `BRIDGE_OLLAMA_URL` | `http://127.0.0.1:11434` | where the embeddings proxy forwards |
| `BRIDGE_EMBED_MODEL` | `nomic-embed-text` | model for `/v1/embeddings` requests that omit one |
| `BRIDGE_EXPOSE_ERROR_DETAILS` | `0` | `1` returns raw backend error messages to the client (they can reveal executable names, paths, and login state), set it only on a trusted local deployment; the default returns a generic message + correlation id, with full detail in the server log |
| `BRIDGE_ALLOW_QUERY_KEY` | `0` | `1` enables `GET /v1/models?key=<BRIDGE_API_KEY>` for browser viewing through the tunnel (key lands in history/logs, opt-in) |
| `BRIDGE_TRUST_CF_ACCESS` | `0` | `1` lets requests that passed Cloudflare Access (edge-stamped `Cf-Access-Jwt-Assertion`) view GET discovery routes. Only sound while Access covers the hostname |
| `BRIDGE_CLAUDE_ARGS` / `BRIDGE_CODEX_ARGS` |, | extra CLI flags appended to the preset. Quoted values are supported (`--append-system-prompt "be very concise"`), same limited argv grammar as `BRIDGE_COMMAND`. Quotes group **and are stripped** (shell-style): a flag whose value must contain literal quotes — a Codex TOML override, say — needs them nested, `-c 'model_reasoning_effort="high"'`, or the `*_ARGS_JSON` form. Both are allowlists, checked at start: see [How the backends invoke the CLIs](#how-the-backends-invoke-the-clis) |
| `BRIDGE_APPLE_CONTEXT_TOKENS` | `4096` | the most tokens (estimated) a prompt and system text for model `system` may have; a longer one gets a 400 naming the limit |
| `BRIDGE_CLAUDE_ARGS_JSON` / `BRIDGE_CODEX_ARGS_JSON` |, | exact form: a JSON array of strings, wins over the plain variable when both are set |
| `BRIDGE_KEEP_ENV_KEYS` |, | set `1` to keep provider API keys in the child env (default strips them). `ANTHROPIC_BASE_URL` is removed either way |
| `BRIDGE_ENV_FILE` |, | explicit env-file path, overriding the auto-load order below |
| `BRIDGE_MODEL_CAPS` |, | per-model capability overrides: `"gpt-5.5=1000000:128000,opus=200000:32000"` (`<id>=<context>:<maxOutput>`). Overrides win over the family defaults and are reported with `caps_source: "override"` |

### Model capabilities are CONFIGURED ASSUMPTIONS, not discovered values

`/v1/models` advertises a `context_window` and `max_output_tokens` per model so a consumer
that sizes prompts from discovery gets sensible figures. **Neither the Claude Code CLI nor
the Codex CLI exposes a machine-readable capability endpoint**, so these numbers are never
*discovered from the CLI* — they are the bridge's configured assumptions. Each entry is
stamped with `caps_source` so a consumer can tell what it is getting:

| `caps_source` | Meaning |
|---|---|
| `override` | You set it via `BRIDGE_MODEL_CAPS` for this deployment |
| `default` | A per-family figure from [`config/model-capability-defaults.json`](../config/model-capability-defaults.json) (a documented API limit, **not** discovered) |
| `unknown` | No family matched — `context_window` / `max_output_tokens` are **omitted entirely** rather than invented; fall back to your client's own sizing |

The family defaults ship in `config/model-capability-defaults.json` (with the catalog
citations and checked-on date in the file), so reviewing or adjusting them is a data-file
edit, not a code change. Highlights: **Opus 4.x caps at 32k output** (not 64k, it is split
out from the Claude family for this reason), Sonnet/Haiku 4.x reach 64k over a 200k
context, and the GPT-5.x family reaches **128k output** over contexts from 400k to
1,050,000 tokens depending on the model. Model identifiers drift as providers ship new
families; if a figure looks stale or your subscription's usable ceiling differs, set
`BRIDGE_MODEL_CAPS` (comma-separated `<substring>=<context>:<maxOutput>` — the longest
matching substring wins) and the value flips to `caps_source: "override"`.

### Run it bare, config from a file

So you don't retype `BRIDGE_API_KEY=… BRIDGE_MODELS=… npm run bridge` each time, both
`npm run bridge` and `npm run bridge:tunnel` **auto-load** the first of these that exists
(override with `BRIDGE_ENV_FILE=<path>`):

1. `.env.bridge.local`, gitignored; the recommended home
2. `.env.local`, a shared app env file, if the bridge lives inside an app repo

Copy `.env.example` → `.env.bridge.local`, fill it in, then just run `npm run bridge`.
**Only `BRIDGE_*` keys (and `CLOUDFLARED_BIN`) are read**, even when it loads `.env.local`,
it never pulls `DATABASE_URL` / `ANTHROPIC_API_KEY` / other app secrets into the bridge
process. Inline env still wins (`BRIDGE_BACKEND=codex npm run bridge` overrides the file for
one run). Values are never logged, only a `loaded N setting(s) from <file>` line.

**If a key appears twice in the file, the first occurrence wins**, unlike a shell script,
where the last assignment wins. `.env.example` shows some keys twice (for example the
default `BRIDGE_COMMAND` and the Apple one), so when you uncomment one, comment out the
other.

### Auth: the CLIs use their OWN login, not your API keys

By default the bridge **strips** `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / … from the CLI's
environment before spawning, and runs it in a neutral cwd. So each CLI falls back to its
own subscription login, `claude` uses `~/.claude` (`/login`), `codex` uses
`~/.codex/auth.json`. This is deliberate: a stray API key in your shell/`.env` otherwise
sends the CLI into API-key mode and it reports **"Not logged in · Please run /login"** even
after you've logged in. (Set `BRIDGE_KEEP_ENV_KEYS=1` to keep the keys, e.g. to use an API
key on purpose.)

`ANTHROPIC_BASE_URL` is removed from every CLI's environment, for every backend, even with
`BRIDGE_KEEP_ENV_KEYS=1`. It points Claude Code (and anything else built on Anthropic's SDK)
at a different API host. Left in a shell profile by some other tool, or set for a proxy, it
would quietly send every prompt the bridge handles, a meeting transcript say, to that host
instead of Anthropic. `BRIDGE_KEEP_ENV_KEYS` keeps a credential on purpose; it is not a way
to reroute traffic.

**If you still see "Not logged in":** run `claude` once interactively and `/login`, confirm
`claude -p "say ok"` works in a plain terminal, then restart the bridge. Full flow:
[TROUBLESHOOTING.md](./TROUBLESHOOTING.md).

### How the backends invoke the CLIs

This section is authoritative for what the bridge actually runs:

- **`claude`**, `claude -p --output-format json --safe-mode --no-session-persistence
  --tools= --model=<m> --append-system-prompt=<s>`, prompt piped on stdin. Notably **no
  `--bare`**, which isolates the run and stops Claude Code from seeing the login
  credentials that `claude` + `/login` set up. JSON output has no token counts, so the
  bridge estimates them (~4 chars/token); stdin caps at 10 MB (fine for ~60k-token
  prompts).

  A prompt is whatever a caller sent, a meeting transcript or a scraped page, so three
  options are on every run, whatever the request or the configuration:

  - `--safe-mode`: none of this machine's CLAUDE.md, skills, plugins, hooks, MCP servers
    or custom agents (admin-managed policy settings still apply);
  - `--tools=` (the same as `--tools ""`): no tools at all, so nothing said in a prompt
    can get Claude Code to run anything. A request with `"web_search": true` gets
    `--tools=WebSearch,WebFetch` and `--allowedTools=WebSearch,WebFetch`, the read-only
    web tools and nothing else;
  - `--no-session-persistence`: the prompt and the answer are not saved as a session.

  Both tool flags are written as one `--flag=value` token: they are variadic, and as
  separate tokens they would take every following argument that does not start with `-`.

  The request's model, effort and system text are written the same way (`--model=<m>`,
  `--effort=<e>`, `--append-system-prompt=<s>`). They are a caller's strings, so a value
  such as `--settings={...}` or `--resume` is then only ever that flag's value, to Claude
  Code's parser and to anything that reads argv token by token, and never an option of
  its own. A request whose `model` starts with `-`, or is not a string, is refused with a
  400 for every backend, since the `codex` and `command` backends pass the model as its
  own argument.

  `BRIDGE_CLAUDE_ARGS` / `BRIDGE_CLAUDE_ARGS_JSON` are appended after these and are an
  **allowlist**, so they cannot give Claude Code tools, turn these options off or resume
  a session. Every token that starts with `-` must be one of these, wherever it stands:

  | Option | Takes |
  |---|---|
  | `--model`, `--fallback-model`, `--effort` | one value |
  | `--append-system-prompt`, `--system-prompt` | one value |
  | `--max-turns`, `--max-budget-usd` | one value |
  | `--permission-mode` | `default`, `manual`, `dontAsk` or `plan` only |
  | `--disallowedTools`, `--disallowed-tools` | one or more tool names |
  | `--strict-mcp-config`, `--disable-slash-commands`, `--no-chrome` | nothing |

  A value may follow as the next token or after `=` (`--append-system-prompt="- be brief"`
  for one that starts with `-`). Anything else, such as `--tools`, `--allowedTools`,
  `--add-dir`, `--mcp-config`, `--settings`, `--dangerously-skip-permissions`,
  `--permission-mode bypassPermissions`, `--resume` or `--continue`, a short flag or a
  bare argument, stops a `claude` or `auto` bridge at start with a message naming the
  variable and the flag. The old advice to add hardening here (`--permission-mode
  dontAsk --max-turns 1`) still works but is no longer needed: there are no tools to
  permit.
- **`codex`**, prompt on stdin, as

  ```
  codex [--search] exec --ephemeral --sandbox read-only --ignore-user-config --ignore-rules
    --skip-git-repo-check --output-last-message <tmp> [-c web_search="disabled"]
    --disable <feature> ... [--model=<m>] [-c model_reasoning_effort="<e>"] [BRIDGE_CODEX_ARGS]
  ```

  Codex writes only its final message to `<tmp>`, which the bridge reads, so agent
  chatter on stdout never pollutes the answer. `--skip-git-repo-check` is required
  because the bridge runs every CLI from a neutral temp directory (not a git repo).
  `codex exec` has no system-prompt flag, so system/developer text is **prepended to the
  piped prompt** rather than dropped.

  A prompt can be an untrusted transcript, so every run is made as safe as Claude's:

  | Option | What it does |
  | --- | --- |
  | `--ephemeral` | no session files are saved |
  | `--sandbox read-only` | nothing on disk can be changed |
  | `--ignore-user-config` | `~/.codex/config.toml` is not loaded: no MCP servers, profiles, providers or base URL from it. The login still works. |
  | `--ignore-rules` | no user or project execpolicy rules |
  | `--disable <feature>` | one for every feature Codex lists, except a short allowlist (below) |
  | `-c web_search="disabled"` | web search is off, unless the request sends `"web_search": true`, which gets `--search` and nothing else |

  **Codex has no single "no tools" switch.** Its shell, apps, plugins, browser and
  computer use, image tools, hooks, skills and the rest are each a *feature*. Before the
  first Codex run the bridge runs `codex features list` (no prompt, nothing sent to a
  model) and passes `--disable` for every feature it lists, on or off, except those marked
  `removed` and these, which change how a request is sent and give the model nothing it
  can call: `api_key_model_discovery`, `auth_elicitation`, `content_item_kinds`,
  `enable_request_compression`, `system_proxy_fallback`, `unbounded_connection_retries`.
  Features that are off are disabled too, because `--ignore-user-config` brings each one
  back to its default. A new Codex release that adds a tool feature is disabled by the same
  rule, without a bridge update. The list is read once and reused; **if it cannot be run
  or read, the bridge refuses to run Codex** (a 503 that says why) and tries again on the
  next request.

  Because `config.toml` is no longer read, its `model` and `model_reasoning_effort` no
  longer apply: send the model in the request (or set `BRIDGE_MODEL`) and use an effort
  suffix such as `gpt-5.5:high`.

  `BRIDGE_CODEX_ARGS` / `BRIDGE_CODEX_ARGS_JSON` are an **allowlist**, checked when a
  `codex` or `auto` bridge starts: `--model`/`-m`, `--disable <feature>`,
  `--color always|never|auto`, and `-c`/`--config` for `model_reasoning_effort`,
  `model_reasoning_summary` or `model_verbosity` with a plain word as the value. Anything
  else (`--enable`, `--sandbox`, `-s`, `--full-auto`, `--dangerously-*`, `--add-dir`,
  `--cd`, `--profile`, `--oss`, any other `-c`, a bare argument such as `resume`) refuses
  to start the bridge, naming the flag.

  `OPENAI_BASE_URL`, `OPENAI_API_BASE`, `CODEX_EXEC_SERVER_URL` and `CODEX_URL` are removed
  from every child's environment, like `ANTHROPIC_BASE_URL`, even with
  `BRIDGE_KEEP_ENV_KEYS=1`: each can send Codex's requests to another server.

- **`apple`** (model `system`), Apple's on-device model, as
  `fm respond --no-stream [-i <system text>]`, prompt on stdin. The arguments are fixed:
  never `--tool`, `--resume`, `--save-transcript`, `--image` or `--schema`, and nothing
  from configuration. A system text that starts with `-` gets a leading space, so `fm`
  only ever reads it as the value of `-i`. A web-search request gets no tool here either.
  The model's context window is small (4096 tokens), so a prompt the bridge estimates
  (about 4 characters a token) as larger is refused with a 400, code
  `context_length_exceeded`, naming the limit, before `fm` runs.
  `BRIDGE_APPLE_CONTEXT_TOKENS` changes the limit.

- **`command`** is **unchecked**: the bridge cannot know what `BRIDGE_COMMAND` does, so
  none of the options above apply. Only point it at a program you trust with whatever a
  caller sends.

### Cancellation

When a client disconnects mid-completion, the bridge kills the spawned CLI (SIGTERM, then
SIGKILL after 2 seconds if ignored) instead of letting it run to completion for nobody.
The request's concurrency slot is held until the child has actually exited, so
`BRIDGE_MAX_CONCURRENT` remains a hard ceiling on live child processes even under
cancellation pressure. Termination is **best effort**: only the direct child is signalled
— subprocesses the CLI spawned itself may survive on some platforms, and Windows signal
semantics differ.

### Streaming

A request with a truthy `stream` (on `/v1/chat/completions` or `/chat/completions`) gets
an OpenAI-style event stream. The CLIs answer in one piece, so the stream is shaped
around that:

1. `200` with `Content-Type: text/event-stream` at once, before the CLI starts.
2. While the CLI runs, an SSE comment (`: keepalive`) at once and then at least every
   10 s, or every `BRIDGE_KEEPALIVE_MS` when that is shorter. Clients skip comments, but
   the bytes keep idle timeouts (Node's fetch gives up after 300 s of silence,
   Cloudflare's edge after about 100 s) from closing a long run. The JSON keepalive's
   bare newline is never written into a stream.
3. When the CLI finishes, `chat.completion.chunk`s: one with `delta.role` `assistant`,
   one with the whole text as `delta.content`, one with `finish_reason` `stop`, then
   `data: [DONE]`. With `stream_options.include_usage`, a last chunk before `[DONE]`
   carries the estimated `usage` (the same figures a buffered completion reports), and
   the others carry `usage: null`, as OpenAI does.

A failure after the headers went out (the CLI failed or timed out) is one
`data: {"error":{"message":…,"type":"bridge_backend_error","id":…}}` event, redacted
as a buffered error is, and the stream ends with no `[DONE]`. Everything before the
headers is unchanged: a bad key is still `401`, a busy bridge `429`, and `tools`,
`response_format`, `n > 1` or content blocks still `400`. A client that disconnects has
its CLI killed, and `BRIDGE_TIMEOUT_MS` applies as usual. Falsy values (`false`, `null`,
`0`) keep the single buffered JSON completion.

### Reasoning effort, per-request, via a model-id suffix (both backends)

Both CLIs take a per-run reasoning effort. The bridge encodes it as a **suffix on the
model id**, so a client selects its effort just by picking a model, with no schema or UI
change:

```
request model "gpt-5.6-sol:high"
  → codex exec --model gpt-5.6-sol -c model_reasoning_effort="high"
request model "sonnet:xhigh"
  → claude -p --model=sonnet --effort=xhigh
```

Advertise the variants you actually want in the dropdown, e.g.:

```bash
BRIDGE_MODELS="sonnet,sonnet:xhigh,opus,gpt-5.6-sol,gpt-5.6-sol:high,gpt-5.6-luna:low,gpt-5.5"
```

Recognised suffixes: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`.
Per-backend vocabulary differs: **Claude Code's `--effort`** accepts
`low|medium|high|xhigh|max` (default `high`), other values are stripped and ignored for
Claude models. **Codex** support varies per model (e.g. `max` is 5.6-family;
`gpt-5.4-pro` starts at `medium`); an unsupported level is rejected by the CLI itself and
surfaces as a normal bridge error. Caps matching sees through the suffix (a variant
inherits its base model's family caps or `BRIDGE_MODEL_CAPS` override). Anything
unrecognised is treated as part of the model id and passed through untouched.

Default caps for the GPT-5.x family follow the official OpenAI catalog (2026-07): 5.6
sol/terra/luna and 5.4/5.4-pro → 1,050,000 context; 5.5 → ~1,000,000; 5.4-mini/nano and
bare gpt-5 → 400,000, all 128,000 max output. Remember the context window is **shared**
by prompt + reasoning + output, and a ChatGPT-subscription login is additionally bound by
plan usage caps, not API TPM tiers.

## Wire it into your application

1. Add a **custom OpenAI-compatible endpoint** in your application's settings:
   - Base URL: `http://localhost:8787/v1`
   - API key: leave blank (or set `BRIDGE_API_KEY` and paste the same value)
2. Route a request to that endpoint and use the **model id** the backend expects,
   e.g. `opus` / `sonnet` for Claude Code, or the Codex model id.
3. Make the call. The bridge logs each one: `[bridge] claude opus → N chars in Xms`.

A typical split routes bulky, long-running pipeline stages to local CLI subscriptions via
the bridge, while keeping latency- or quality-critical calls on hosted models, the `auto`
backend lets one endpoint serve both CLI families.

## Exposing it to a remote application

To let a **remote** application instance reach this bridge on your workstation, over a
named Cloudflare Tunnel behind Cloudflare Access, with `npm run bridge:tunnel`, see
[REMOTE_BRIDGE.md](./REMOTE_BRIDGE.md). The bridge exposes an auth-enforced `GET /health`
that a remote connection test can use to pinpoint which layer (Cloudflare Access → tunnel →
bridge → Bearer → model discovery) failed, see
[TROUBLESHOOTING.md](./TROUBLESHOOTING.md).
