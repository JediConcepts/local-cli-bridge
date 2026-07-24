# Local model bridge (`scripts/local-cli-bridge.mjs`)

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

### Environment

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `8787` | listen port |
| `HOST` | `127.0.0.1` | bind address, keep it loopback unless you must expose it |
| `BRIDGE_BACKEND` | `claude` | `claude` \| `codex` \| `command` \| `auto` (dispatch by model id) |
| `BRIDGE_AUTO_DEFAULT` | `claude` | `auto` mode: backend for an ambiguous model id |
| `BRIDGE_COMMAND` |, | `command` backend: a template; `{model}` is substituted, prompt piped to stdin |
| `BRIDGE_MODEL` |, | default model id when a request omits one |
| `BRIDGE_MODELS` | claude only | comma-separated ids advertised on `/v1/models` to prefill a routing dropdown (claude default: `opus,sonnet,haiku`). Codex slugs vary per account, so set your own, e.g. `BRIDGE_MODELS="gpt-5.5,gpt-5.6-sol"`, otherwise discovery returns an empty list |
| `BRIDGE_TIMEOUT_MS` | `900000` | per-request CLI timeout (long-running pipeline stages can take minutes) |
| `BRIDGE_API_KEY` |, | if set, callers must send `Authorization: Bearer <it>` |
| `BRIDGE_KEEPALIVE_MS` | `20000` | whitespace-heartbeat interval for in-flight completions; `0` disables (see [REMOTE_BRIDGE.md](./REMOTE_BRIDGE.md) on the Cloudflare 524) |
| `BRIDGE_MAX_BODY_BYTES` | `10485760` | request body ceiling (10 MB, the CLI stdin cap); excess → 413 |
| `BRIDGE_MAX_CONCURRENT` | `4` | max simultaneous CLI completions; excess → 429. Single-user operators can lower it |
| `BRIDGE_EXPOSE_ERROR_DETAILS` | `0` | `1` returns raw backend error messages to the client (they can reveal executable names, paths, and login state), set it only on a trusted local deployment; the default returns a generic message + correlation id, with full detail in the server log |
| `BRIDGE_ALLOW_QUERY_KEY` | `0` | `1` enables `GET /v1/models?key=<BRIDGE_API_KEY>` for browser viewing through the tunnel (key lands in history/logs, opt-in) |
| `BRIDGE_TRUST_CF_ACCESS` | `0` | `1` lets requests that passed Cloudflare Access (edge-stamped `Cf-Access-Jwt-Assertion`) view GET discovery routes. Only sound while Access covers the hostname |
| `BRIDGE_CLAUDE_ARGS` / `BRIDGE_CODEX_ARGS` |, | extra CLI flags appended to the preset |
| `BRIDGE_KEEP_ENV_KEYS` |, | set `1` to keep provider API keys in the child env (default strips them) |
| `BRIDGE_ENV_FILE` |, | explicit env-file path, overriding the auto-load order below |
| `BRIDGE_MODEL_CAPS` |, | per-model capability overrides: `"gpt-5.5=1000000:128000,opus=200000:32000"` (`<id>=<context>:<maxOutput>`). Overrides win over the family defaults and are reported with `caps_source: "override"` |

### Model capabilities are DEFAULTS, not discovered values

`/v1/models` advertises a `context_window` and `max_output_tokens` per model so a consumer
that sizes prompts from discovery gets correct figures (this is what stops a GPT-5.x model
with a real 400k to 1,050k context from being silently under-sized at a conservative 128k
floor). **Neither the Claude Code CLI nor the Codex CLI exposes a machine-readable
capability endpoint**, so these numbers are never *discovered from the CLI*, they are
configured. Each entry is stamped with `caps_source` so a consumer can tell an assumption
from a confirmed value:

| `caps_source` | Meaning |
|---|---|
| `override` | You set it via `BRIDGE_MODEL_CAPS`, authoritative for this deployment |
| `default` | A built-in per-family fallback (a documented API limit, **not** discovered) |
| `unknown` | No family matched, a conservative `128000 : 8192` floor |

Built-in defaults track each model's documented API limits: **Opus 4.x caps at 32k
output** (not 64k, it is split out from the Claude family for this reason), Sonnet/Haiku
4.x reach 64k over a 200k context, and the GPT-5.x family reaches **128k output**,
over a 1,050,000-token context for the 5.6 family (sol/terra/luna) and 5.4/5.4-pro,
~1,000,000 for 5.5, and 400,000 for 5.4-mini/nano and bare `gpt-5`. If your
subscription's usable ceiling differs, set `BRIDGE_MODEL_CAPS` and the value flips to
`caps_source: "override"`.

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

### Auth: the CLIs use their OWN login, not your API keys

By default the bridge **strips** `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / … from the CLI's
environment before spawning, and runs it in a neutral cwd. So each CLI falls back to its
own subscription login, `claude` uses `~/.claude` (`/login`), `codex` uses
`~/.codex/auth.json`. This is deliberate: a stray API key in your shell/`.env` otherwise
sends the CLI into API-key mode and it reports **"Not logged in · Please run /login"** even
after you've logged in. (Set `BRIDGE_KEEP_ENV_KEYS=1` to keep the keys, e.g. to use an API
key on purpose.)

**If you still see "Not logged in":** run `claude` once interactively and `/login`, confirm
`claude -p "say ok"` works in a plain terminal, then restart the bridge. Full flow:
[TROUBLESHOOTING.md](./TROUBLESHOOTING.md).

### How the backends invoke the CLIs

This section is authoritative for what the bridge actually runs:

- **`claude`**, `claude -p --output-format json --model <m> --append-system-prompt <s>`,
  prompt piped on stdin. Minimal flags, notably **no `--bare`**, which isolates the run
  and stops Claude Code from seeing the login credentials that `claude` + `/login` set up.
  Add hardening (`--permission-mode dontAsk --max-turns 1`) via `BRIDGE_CLAUDE_ARGS` if you
  want. JSON output has no token counts, so the bridge estimates them (~4 chars/token);
  stdin caps at 10 MB (fine for ~60k-token prompts).
- **`codex`**, `codex exec --ephemeral --sandbox read-only --output-last-message <tmp>`,
  prompt on stdin. Codex writes only its final message to `<tmp>`, which the bridge reads,
  so agent chatter on stdout never pollutes the answer, and `read-only` blocks filesystem
  writes.

### Reasoning effort, per-request, via a model-id suffix (both backends)

Both CLIs take a per-run reasoning effort. The bridge encodes it as a **suffix on the
model id**, so a client selects its effort just by picking a model, with no schema or UI
change:

```
request model "gpt-5.6-sol:high"
  → codex exec --model gpt-5.6-sol -c model_reasoning_effort="high"
request model "sonnet:xhigh"
  → claude -p --model sonnet --effort xhigh
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
