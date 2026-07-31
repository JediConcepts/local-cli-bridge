# Local CLI Bridge

[![CI](https://github.com/JediConcepts/local-cli-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/JediConcepts/local-cli-bridge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![npm](https://img.shields.io/npm/v/local-cli-bridge)](https://www.npmjs.com/package/local-cli-bridge)

Use **Claude Code, Codex, or any stdin-based AI CLI** through an OpenAI-compatible HTTP
API. The bridge turns the locally authenticated CLI you're already logged into — a
**Claude / Codex subscription on your own workstation** — into a small, self-hosted
`/v1/chat/completions` endpoint for development, integration testing, and internal tools.

> This is an interoperability bridge for development and testing. It does not bypass
> provider authentication, plan limits, or usage controls — it runs the same CLI you
> would run by hand, under the same login. See [Provider terms](#provider-terms).

## Why this exists

Applications speak HTTP and OpenAI-style JSON; Claude Code and Codex are **CLIs, not
servers**. Ollama and LM Studio already expose an OpenAI endpoint, so they don't need
this. The coding-agent CLIs don't, so the bridge is the missing shim:

```
your application ──HTTP /v1/chat/completions──► local-cli-bridge ──shell──► claude -p / codex exec ──► your subscription
 (custom endpoint)                               (127.0.0.1:8787)
```

Anything that can call a custom OpenAI-compatible endpoint — an app you're building, a
test harness, an internal pipeline — can route a request to the CLI on your machine
without opening a port: loopback by default, with an optional Cloudflare Tunnel + Access
path for one remote application.

> ⚠️ **Dev / testing tool.** It spawns a CLI process per request (seconds of overhead per
> call) and buffers one completion at a time. Not for production traffic.

## Compatibility: an OpenAI chat-completions-compatible **subset**

The bridge implements a deliberately small slice of the OpenAI surface and **rejects the
rest loudly** (400 with the feature named) instead of silently ignoring it:

| Capability | Support | Notes |
|---|---|---|
| `POST /v1/chat/completions` | ✅ | one buffered (non-streaming) completion |
| `GET /v1/models` | ✅ | plus `context_window` / `max_output_tokens` / `caps_source` ([configured assumptions](./docs/LOCAL_BRIDGE.md#model-capabilities-are-configured-assumptions-not-discovered-values), not discovered) |
| `GET /health` | ✅ (extension) | auth-enforced liveness + model list |
| System / developer messages | ✅ | folded into the CLI's system text |
| Multi-turn history | ✅ | flattened to a labeled transcript (the CLIs are one-shot) |
| Model-id `:effort` suffix | ✅ (extension) | `sonnet:xhigh`, `gpt-5.6-sol:high` |
| Streaming (`stream`) | ❌ 400 | any truthy value |
| Tools / functions / `tool_choice` | ❌ 400 | explicit `null` tolerated |
| `response_format` | ❌ 400 | |
| Image / content-block messages | ❌ 400 | string content only |
| `n > 1` | ❌ 400 | exactly one choice |
| `temperature`, `top_p`, `max_tokens`, … | accepted, ignored | the CLIs take no equivalent |
| `usage` token counts | estimated | ~4 chars/token, not provider-reported |

## Quick start

```sh
npx local-cli-bridge          # OpenAI-compatible endpoint in front of your local CLI login
```

Then point your app at Base URL `http://localhost:8787/v1` and request model `sonnet`
(Claude) or your Codex slug. To expose it to one remote application through a named
Cloudflare tunnel (one-time setup in [docs/REMOTE_BRIDGE.md](./docs/REMOTE_BRIDGE.md)):

```sh
BRIDGE_TUNNEL_NAME=my-bridge \
BRIDGE_TUNNEL_CONFIG=~/.cloudflared/my-bridge.yml \
BRIDGE_API_KEY='a strong random key' \
npx local-cli-bridge-tunnel
```

Working from a clone instead of npm? `npm run bridge` and `npm run bridge:tunnel` are the
same two entry points.

## Setup

### 1. Prerequisites

| Need | For | Notes |
|---|---|---|
| **Node.js 18+** | always | Zero runtime dependencies, no `npm install` needed. Check: `node --version` |
| **A logged-in CLI** | the backend | **Claude Code** (`claude`) and/or **Codex** (`codex`), authenticated with their *own* subscription login (see step 2). At least one is required unless you use the `command` backend. |
| **`cloudflared`** | remote exposure only | Install + `cloudflared tunnel login`. Skip for local-only use. |
| **Cloudflare Zero Trust account + a domain** | remote exposure only | For the named tunnel + Access service token. |

Verify the CLI you intend to use works standalone before touching the bridge:

```bash
claude -p "say ok"      # Claude Code backend
codex exec "say ok"     # Codex backend
```

If either says **"Not logged in"**, run it once interactively and `/login` first.

### 2. Configure CLI auth (important)

By default the bridge **strips provider API keys** (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …)
from the CLI's environment and runs it in a neutral working directory, so each CLI falls back
to its **own subscription login**:

- `claude` → `~/.claude` (run `claude` once and `/login`)
- `codex` → `~/.codex/auth.json` (run `codex login`)

This is deliberate, a stray API key in your shell/`.env` otherwise pushes the CLI into
API-key mode and it reports *"Not logged in · Please run /login"* even after you've logged in.
To use an API key on purpose instead, set `BRIDGE_KEEP_ENV_KEYS=1`.

### 3. Run it

```bash
# Claude Code (default backend)
npm run bridge

# Codex CLI
BRIDGE_BACKEND=codex npm run bridge

# BOTH from one bridge on one port, dispatched by requested model id
BRIDGE_BACKEND=auto BRIDGE_MODELS="sonnet,sonnet:xhigh,opus,haiku,gpt-5.6-sol,gpt-5.5" npm run bridge

# Any other CLI that reads a prompt on stdin and prints the answer
BRIDGE_BACKEND=command BRIDGE_COMMAND='ollama run {model}' npm run bridge
```

Config can live in a file instead of the shell: the bridge auto-loads `.env.bridge.local` /
`.env.local` (only `BRIDGE_*` keys are read). Copy [`.env.example`](./.env.example) to get
started.

### 4. Verify

```bash
# Health / model discovery (requires the Bearer if BRIDGE_API_KEY is set;
# a direct loopback browser is allowed without it)
curl -s http://127.0.0.1:8787/health -H "Authorization: Bearer $BRIDGE_API_KEY"

# A real completion
curl -s http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $BRIDGE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"sonnet","messages":[{"role":"user","content":"say ok"}]}'
```

## Remote exposure (optional)

To let a **remote** application reach this bridge, follow
[`docs/REMOTE_BRIDGE.md`](./docs/REMOTE_BRIDGE.md). Three layers must all pass for a
request to reach a CLI: **Cloudflare Access service token** (edge) → **named tunnel** →
**bridge Bearer key** (`BRIDGE_API_KEY`), with the bridge itself staying loopback-bound.
The tunnel launcher **fails closed**, it refuses to start without `BRIDGE_API_KEY`.

> If you already run `cloudflared` for another hostname, do **not** use the launcher —
> add the bridge as an extra ingress rule on that tunnel and run the bridge alone
> (Arrangement A in the docs). Two connectors on one tunnel round-robin to 404s.

## Common settings

| Var | Default | Purpose |
|---|---|---|
| `PORT` / `HOST` | `8787` / `127.0.0.1` | listen address, keep it loopback |
| `BRIDGE_BACKEND` | `claude` | `claude` \| `codex` \| `command` \| `auto` |
| `BRIDGE_MODELS` | per-backend | comma-separated ids advertised on `/v1/models` |
| `BRIDGE_API_KEY` | — | Bearer key callers must send |
| `BRIDGE_TIMEOUT_MS` | `900000` | per-request CLI timeout; on expiry the child is killed and the request fails `504` |
| `BRIDGE_MAX_CONCURRENT` | `4` | ceiling on live CLI child processes (excess → 429) |
| `BRIDGE_MAX_BODY_BYTES` | 10 MB | request body ceiling (413 above it) |
| `BRIDGE_MAX_PROCESS_OUTPUT_BYTES` | 10 MB | ceiling on total child output — stdout + stderr + result file (502 above it) |
| `BRIDGE_KEEPALIVE_MS` | `auto` | Cloudflare-524 heartbeat: `auto` heartbeats only tunnel-forwarded requests, local calls keep real status codes; `0` never, `N` ms always |
| `BRIDGE_EXPOSE_ERROR_DETAILS` | `0` | `1` returns raw backend error messages to clients, local debugging only |
| `BRIDGE_CLAUDE_ARGS` / `BRIDGE_CODEX_ARGS` | — | extra CLI flags (quoted values supported); `*_ARGS_JSON` variants take a JSON array for exact argv |

Full reference (effort suffixes, model capabilities, `command` backend, `auto` dispatch,
JSON argv forms, cancellation semantics) is in
[`docs/LOCAL_BRIDGE.md`](./docs/LOCAL_BRIDGE.md).

## Security model

- Loopback bind by default; the only supported remote path is tunnel + Access + Bearer.
- Constant-time Bearer comparison; the tunnel launcher fails closed without a key.
- Provider API keys are stripped from the CLI's environment by default.
- Request body, process output, concurrency, and per-request time are all capped; a
  disconnected client's CLI child is killed (best effort — see [SECURITY.md](./SECURITY.md)).
- Raw backend errors are redacted from clients by default, with a correlation id linking
  to the server log.

Threat model, residual risks, and vulnerability reporting: [SECURITY.md](./SECURITY.md).

## Provider terms

> Local CLI Bridge is an independent open source utility and is not affiliated with,
> endorsed by, or sponsored by Anthropic or OpenAI. It invokes command line tools that you
> have installed and authenticated on your own machine. Use of each backend remains
> subject to the provider's applicable plan, usage limits, acceptable use policies, and
> software terms. You are responsible for ensuring that your use complies with those
> requirements.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `"Not logged in"` in the response | CLI isn't logged in, or an API key is leaking in. `/login` the CLI; confirm `claude -p "hi"` works; restart. |
| `401 Unauthorized` | `BRIDGE_API_KEY` is set but the caller's `Authorization: Bearer …` doesn't match. |
| `429` busy | More than `BRIDGE_MAX_CONCURRENT` in-flight completions, raise it or retry. |
| `413` | Request body over `BRIDGE_MAX_BODY_BYTES` (default 10 MB). |
| `502` / `504` | Backend failed / backend timed out. Details are in the server log under the response's correlation id. |
| Remote call dies at ~100s with a `524` | The keepalive defeats this for tunnel traffic by default (`auto`); ensure `BRIDGE_KEEPALIVE_MS` isn't `0`. |
| A `200` with an `{"error":{…}}` body | Tunnel-keepalive contract: the failure arrived after the status was committed. Treat an `error` body as failure. |

Full layer-by-layer failure table and the "Not logged in" flow:
[`docs/TROUBLESHOOTING.md`](./docs/TROUBLESHOOTING.md).

## Docs map

- **`README.md`** (this file), what it is + quick start.
- **[`docs/LOCAL_BRIDGE.md`](./docs/LOCAL_BRIDGE.md)**, local run + full config/env reference.
- **[`docs/REMOTE_BRIDGE.md`](./docs/REMOTE_BRIDGE.md)**, Cloudflare Tunnel + Access walkthrough and security model.
- **[`docs/TROUBLESHOOTING.md`](./docs/TROUBLESHOOTING.md)**, failure-state table and common fixes.
- **[`SECURITY.md`](./SECURITY.md)**, threat model and vulnerability reporting.
- **[`CHANGELOG.md`](./CHANGELOG.md)**, release history.
- **[`.env.example`](./.env.example)**, every setting, with comments.

## License

[MIT](./LICENSE) © Jedi Concepts
