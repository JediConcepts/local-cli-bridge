# Local CLI Bridge, setup & install

[![CI](https://github.com/JediConcepts/local-cli-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/JediConcepts/local-cli-bridge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![npm](https://img.shields.io/npm/v/local-cli-bridge)](https://www.npmjs.com/package/local-cli-bridge)

## Quickest start

```sh
npx local-cli-bridge          # an OpenAI compatible endpoint in front of your local CLI login
```

To expose it to a remote application through a named Cloudflare tunnel (one time setup in [docs/REMOTE_BRIDGE.md](./docs/REMOTE_BRIDGE.md)):

```sh
BRIDGE_TUNNEL_NAME=my-bridge \
BRIDGE_TUNNEL_CONFIG=~/.cloudflared/my-bridge.yml \
BRIDGE_API_KEY='a strong random key' \
npx local-cli-bridge-tunnel
```

Working from a clone instead of npm? `npm run bridge` and `npm run bridge:tunnel` are the same two entry points.



An OpenAI-compatible HTTP shim in front of local coding-agent CLIs (`claude`, `codex`) or
any stdin command, plus a launcher that exposes it to a **remote** application over a named
Cloudflare Tunnel behind Cloudflare Access.

> **Local CLI Bridge** is a minimal, self-hosted OpenAI-compatible adapter for one-shot
> completions through locally authenticated CLI model tools. A development and testing
> bridge, not a hosted-model service.

It lets any tool that can call an OpenAI `/v1/chat/completions` endpoint route a request to a
**Claude / Codex subscription running on your workstation**, without opening a port.

```
your application ──HTTP /v1/chat/completions──► local-cli-bridge ──shell──► claude -p / codex exec ──► your subscription
 (custom endpoint)                               (127.0.0.1:8787)
```

> ⚠️ **Dev / testing tool.** It binds to loopback by default and spawns a CLI once per
> request (seconds of overhead per call). Not for production traffic.

---

## 1. Prerequisites

| Need | For | Notes |
|---|---|---|
| **Node.js 18+** | always | Zero runtime dependencies, no `npm install` needed. Check: `node --version` |
| **A logged-in CLI** | the backend | **Claude Code** (`claude`) and/or **Codex** (`codex`), authenticated with their *own* subscription login (see step 3). At least one is required unless you use the `command` backend. |
| **`cloudflared`** | remote exposure only | Install + `cloudflared tunnel login`. Skip for local-only use. See [`docs/REMOTE_BRIDGE.md`](./docs/REMOTE_BRIDGE.md). |
| **A Cloudflare Zero Trust account + a domain** | remote exposure only | For the named tunnel + Access service token. |

Verify the CLI you intend to use works standalone before touching the bridge:

```bash
claude -p "say ok"      # Claude Code backend
codex exec "say ok"     # Codex backend
```

If either says **"Not logged in"**, run it once interactively and `/login` first (step 3).

---

## 2. Install

There is nothing to build or compile, the bridge is a single zero-dependency Node script.

```bash
npm run bridge                           # starts on http://127.0.0.1:8787
#, or, identically,
node scripts/local-cli-bridge.mjs
```

`npm run bridge` and `npm run bridge:tunnel` are thin aliases defined in `package.json`;
everywhere the docs use them, the direct `node scripts/…` invocation works the same.

---

## 3. Configure CLI auth (important)

By default the bridge **strips provider API keys** (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …)
from the CLI's environment and runs it in a neutral working directory, so each CLI falls back
to its **own subscription login**:

- `claude` → `~/.claude` (run `claude` once and `/login`)
- `codex` → `~/.codex/auth.json` (run `codex login`)

This is deliberate, a stray API key in your shell/`.env` otherwise pushes the CLI into
API-key mode and it reports *"Not logged in · Please run /login"* even after you've logged in.

- To use an API key on purpose instead, set `BRIDGE_KEEP_ENV_KEYS=1`.
- **Still see "Not logged in"?** Confirm `claude -p "say ok"` works in a plain terminal, then
  restart the bridge. Full flow: [`docs/TROUBLESHOOTING.md`](./docs/TROUBLESHOOTING.md).

---

## 4. Quick start (local, loopback only)

```bash
# Claude Code (default backend)
npm run bridge

# Codex CLI
BRIDGE_BACKEND=codex npm run bridge

# BOTH from one bridge on one port, dispatched by requested model id
BRIDGE_BACKEND=auto BRIDGE_MODELS="sonnet,sonnet:xhigh,opus,haiku,gpt-5.6-sol,gpt-5.6-sol:high,gpt-5.6-terra,gpt-5.6-luna:low,gpt-5.5" npm run bridge

# Any other CLI that reads a prompt on stdin and prints the answer
BRIDGE_BACKEND=command BRIDGE_COMMAND='ollama run {model}' npm run bridge
```

On start it prints the listen address, backend, and OpenAI base URL
(`http://127.0.0.1:8787/v1`).

### Config from a file (so you don't retype env vars)

The bridge auto-loads the first of these that exists (override with `BRIDGE_ENV_FILE=<path>`):

1. `.env.bridge.local`, the recommended home (keep it gitignored)
2. `.env.local`, shared app env

Only `BRIDGE_*` keys (and `CLOUDFLARED_BIN`) are read, other secrets in the file are ignored,
and values are never logged. Copy [`.env.example`](./.env.example) to `.env.bridge.local`:

```bash
# .env.bridge.local
BRIDGE_BACKEND=auto
BRIDGE_MODELS="sonnet,sonnet:xhigh,opus,haiku,gpt-5.6-sol,gpt-5.6-sol:high,gpt-5.6-terra,gpt-5.6-luna:low,gpt-5.5"
BRIDGE_API_KEY=<a-strong-random-key>     # if set, callers must send Authorization: Bearer <it>
```

---

## 5. Verify it works

```bash
# Health / model discovery (requires the Bearer if BRIDGE_API_KEY is set;
# a direct loopback browser is allowed without it)
curl -s http://127.0.0.1:8787/health -H "Authorization: Bearer $BRIDGE_API_KEY"
# → {"ok":true,"backend":"auto","models":["opus","sonnet","haiku","gpt-5.5"]}

# A real completion
curl -s http://127.0.0.1:8787/v1/chat/completions \
  -H "Authorization: Bearer $BRIDGE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"sonnet","messages":[{"role":"user","content":"say ok"}]}'
```

### Wire it into your application

1. Add a **custom OpenAI-compatible endpoint**, Base URL `http://localhost:8787/v1`,
   API key = your `BRIDGE_API_KEY` (or blank if unset).
2. Request the **model id** the backend expects (`opus` / `sonnet` for Claude, your Codex
   slug for Codex).

Reasoning effort is selectable per request via a model-id suffix, `sonnet:xhigh`,
`gpt-5.6-sol:high`. See [`docs/LOCAL_BRIDGE.md`](./docs/LOCAL_BRIDGE.md).

---

## 6. Expose to a remote app (optional)

To let a **remote** application reach this bridge over a named Cloudflare Tunnel behind
Cloudflare Access, follow [`docs/REMOTE_BRIDGE.md`](./docs/REMOTE_BRIDGE.md). In short:

```bash
BRIDGE_TUNNEL_NAME=llm-bridge \
BRIDGE_TUNNEL_CONFIG=~/.cloudflared/llm-bridge.yml \
BRIDGE_API_KEY='<a-strong-random-key>' \
npm run bridge:tunnel
```

Three layers must all pass for a request to reach a CLI: **Cloudflare Access service token**
(edge) → **named tunnel** → **bridge Bearer key** (`BRIDGE_API_KEY`) → **loopback binding**.
The tunnel launcher **fails closed**, it refuses to start without `BRIDGE_API_KEY`.

> If you already run `cloudflared` for another hostname, do **not** use `bridge-tunnel.mjs`,
> add the bridge as an extra ingress rule on that tunnel and run the bridge alone
> (Arrangement A in `docs/REMOTE_BRIDGE.md`). Two connectors on one tunnel round-robin to 404s.

---

## 7. Common settings

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `8787` | listen port |
| `HOST` | `127.0.0.1` | bind address, keep it loopback |
| `BRIDGE_BACKEND` | `claude` | `claude` \| `codex` \| `command` \| `auto` |
| `BRIDGE_MODELS` | per-backend | comma-separated ids advertised on `/v1/models` |
| `BRIDGE_API_KEY` |, | Bearer key callers must send |
| `BRIDGE_TIMEOUT_MS` | `900000` | per-request CLI timeout (long-running pipeline stages can take minutes) |
| `BRIDGE_MAX_CONCURRENT` | `4` | max simultaneous CLI runs (excess → 429); single-user setups can lower it |
| `BRIDGE_KEEPALIVE_MS` | `20000` | heartbeat interval that defeats the Cloudflare 524 (0 disables) |
| `BRIDGE_EXPOSE_ERROR_DETAILS` | `0` | `1` returns raw backend error messages to clients, local debugging only |
| `BRIDGE_KEEP_ENV_KEYS` |, | `1` keeps provider API keys in the child env |

Full reference (effort suffixes, model capabilities, `command` backend, `auto` dispatch) is in
[`docs/LOCAL_BRIDGE.md`](./docs/LOCAL_BRIDGE.md).

---

## 8. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `"Not logged in"` in the response | CLI isn't logged in, or an API key is leaking in. `/login` the CLI; confirm `claude -p "hi"` works; restart. |
| `401 Unauthorized` | `BRIDGE_API_KEY` is set but the caller's `Authorization: Bearer …` doesn't match. |
| `429` busy | More than `BRIDGE_MAX_CONCURRENT` in-flight completions, raise it or retry. |
| `413` | Request body over `BRIDGE_MAX_BODY_BYTES` (default 10 MB). |
| Remote call dies at ~100s with a `524` | The keep-alive should prevent this; ensure `BRIDGE_KEEPALIVE_MS` isn't `0`. |
| Remote connection test fails | A single authenticated `GET /health` names the failing layer (Access → tunnel → bridge → Bearer → discovery). |

Full layer-by-layer failure table and the "Not logged in" flow:
[`docs/TROUBLESHOOTING.md`](./docs/TROUBLESHOOTING.md).

---

## Docs map

- **`README.md`** (this file), setup & install.
- **[`docs/LOCAL_BRIDGE.md`](./docs/LOCAL_BRIDGE.md)**, local run + full config/env reference.
- **[`docs/REMOTE_BRIDGE.md`](./docs/REMOTE_BRIDGE.md)**, Cloudflare Tunnel + Access walkthrough and security model.
- **[`docs/TROUBLESHOOTING.md`](./docs/TROUBLESHOOTING.md)**, failure-state table and common fixes.
- **[`.env.example`](./.env.example)**, every setting, with comments.

## License

[MIT](./LICENSE) © Jedi Concepts
