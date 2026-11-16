# Troubleshooting

## The remote request path, which layer failed?

A remote request crosses five layers, and each one fails differently. One authenticated
`GET /health` walks the whole chain (see the curl command in
[REMOTE_BRIDGE.md](./REMOTE_BRIDGE.md)); the first layer that fails tells you exactly what
to fix:

| Layer | Meaning | Typical symptom | Typical fix |
|---|---|---|---|
| **Cloudflare Access** | The service token was refused at the edge | edge `403` | Check the Client ID/Secret and that the token is in the hostname's Access policy |
| **Named tunnel** | Edge reached but the tunnel is down | `530` / error `1033` | Start/restart `cloudflared` (Arrangement A) or `npm run bridge:tunnel` (dedicated tunnel) |
| **Bridge reachable** | Tunnel up but the origin didn't answer | `502` | Is the bridge process running on `127.0.0.1:8787`? |
| **Bridge key** | Reached the bridge, but it rejected the Bearer | `401` from the bridge | The endpoint API key must equal `BRIDGE_API_KEY` |
| **Model discovery** | Fully connected, lists the advertised models | `200` + model ids | Success: everything works |

You can run the probe with candidate credentials *before* storing them in your
application, to validate a token without persisting it.

## "Not logged in", the auth flow

The most common bridge failure is the backend CLI reporting **"Not logged in · Please run
/login"** even though you *have* logged in. Cause: a provider API key
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …) in your shell or an `.env` file pushes the CLI
into API-key mode, bypassing its subscription login.

The bridge defends against this by default, it **strips provider API keys** from the
spawned CLI's environment and runs it in a neutral working directory, so each CLI falls
back to its own login:

- `claude` → `~/.claude` (run `claude` once interactively and `/login`)
- `codex` → `~/.codex/auth.json` (run `codex login`)

If you still see "Not logged in":

1. Confirm the CLI works standalone in a plain terminal:
   ```bash
   claude -p "say ok"      # Claude Code
   codex exec "say ok"     # Codex
   ```
2. If that fails, run the CLI once interactively and log in (`/login` for `claude`,
   `codex login` for `codex`), then repeat step 1.
3. Restart the bridge (it must re-spawn CLIs with the clean environment).
4. If you *intend* to use an API key rather than a subscription login, set
   `BRIDGE_KEEP_ENV_KEYS=1`, that disables the stripping on purpose.

Note: with the public default `BRIDGE_EXPOSE_ERROR_DETAILS=0`, the client sees only
`"The local model backend failed"` plus a correlation id, the real message ("Not logged
in", CLI errors) is in the **bridge's server log**, keyed by that id. Set
`BRIDGE_EXPOSE_ERROR_DETAILS=1` on a trusted local deployment to surface raw messages to
the caller.

## Quick symptom table (local or remote)

| Symptom | Likely cause / fix |
|---|---|
| `"Not logged in"` in the response or server log | See the flow above. |
| `401 Unauthorized` | `BRIDGE_API_KEY` is set but the caller's `Authorization: Bearer …` doesn't match. |
| `429` busy | More than `BRIDGE_MAX_CONCURRENT` (default 4) in-flight completions, raise it or retry. |
| `413` | Request body over `BRIDGE_MAX_BODY_BYTES` (default 10 MB). |
| `400 Unsupported request feature` | The bridge rejects `tools`, `tool_choice`, `response_format`, `functions`, and `n > 1` loudly rather than silently ignoring them (explicit `null` values are tolerated). `stream` is supported: see [Streaming](./LOCAL_BRIDGE.md#streaming). |
| `refusing to start: BRIDGE_CLAUDE_ARGS…` at start | An extra Claude argument would give Claude Code tools, turn off `--safe-mode`, `--tools ""` or `--no-session-persistence`, or resume a session. The message names the flag; remove it. The allowed options are in [LOCAL_BRIDGE.md](./LOCAL_BRIDGE.md#how-the-backends-invoke-the-clis). |
| `refusing to start: BRIDGE_CODEX_ARGS...` at start | An extra Codex argument is not on the allowlist (`--model`/`-m`, `--disable`, `--color`, and `-c` for `model_reasoning_effort`, `model_reasoning_summary` or `model_verbosity` only). The message names the flag. Remove it: `--enable`, `--sandbox`, `--dangerously-*`, `--add-dir`, `--profile`, `--oss` and other `-c` overrides would give Codex tools or another config. |
| `503` with `refusing to run Codex: could not read its feature list...` | The bridge runs `codex features list` before every Codex run so it can disable every tool feature, and that failed: `codex` is not on the bridge's PATH, it is older than the tested 0.162.1 (it needs `features list`, `--ignore-user-config`, `--ignore-rules` and `--disable`), it timed out, or its output changed shape. Run `codex features list` yourself as the bridge's user, and upgrade Codex if it is older. |
| A `502` from Codex naming an unexpected argument | Codex is older than 0.162.1 and lacks `--ignore-user-config`, `--ignore-rules` or `--disable`. Upgrade Codex. |
| Codex answers with a different model than `config.toml` names | The bridge runs Codex with `--ignore-user-config`, so `config.toml` is not read. Send the model in the request, or set `BRIDGE_MODEL`. |
| Codex or Claude cannot connect behind a corporate proxy that inspects TLS | The bridge removes the CA overrides (`SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`, `CODEX_CA_CERTIFICATE` and the like) from every child, so a proxy cannot read prompts. Run the bridge on a network that does not intercept TLS. |
| `400` with code `context_length_exceeded` for model `system` | The prompt is longer than Apple's on-device model can take (default 4096 tokens, estimated at about 4 ASCII characters a token and one token for every other character). Send it to Claude or Codex, or shorten it. `BRIDGE_APPLE_CONTEXT_TOKENS` changes the limit. |
| `502 bridge_backend_error` | The CLI failed to spawn, exited non-zero, produced unparsable output, or exceeded `BRIDGE_MAX_PROCESS_OUTPUT_BYTES`. Full detail is in the server log under the correlation id. |
| `504 bridge_backend_error` | The CLI outlived `BRIDGE_TIMEOUT_MS` and was killed. |
| Remote call dies at ~100s with a `524` | Cloudflare's edge waits ~100 seconds for response headers. The default `BRIDGE_KEEPALIVE_MS=auto` heartbeats tunnel-forwarded requests to prevent this; ensure it isn't set to `0`, and see [REMOTE_BRIDGE.md](./REMOTE_BRIDGE.md) if your arrangement strips the Cloudflare headers. |
| A `200` completion with an `{"error":{…}}` body | Tunnel-keepalive contract: the backend failure arrived after the heartbeat committed the status code. Clients must treat an `error` body as failure. Local (non-tunnel) requests keep real status codes under the default `auto`. |
| An event stream that ends with `data: {"error":{…}}` and no `[DONE]` | The CLI failed or timed out after the stream started. Treat it as a failure; the correlation id is in the event. |
| Hostname 404s intermittently through the tunnel | Two connectors on one tunnel with different ingress, Cloudflare round-robins to the one lacking the hostname. Run ONE connector per tunnel (Arrangement A in [REMOTE_BRIDGE.md](./REMOTE_BRIDGE.md)). |
| Generic error + `id` field in the response | Redacted error (default). Look up the correlation id in the bridge's server log for the full detail. |
| Only `opus,sonnet,haiku` advertised, or `BRIDGE_*` settings apparently ignored | No env file was found, so the built-in defaults applied. Since v0.3.1 the log says so: `no env file found, using built-in defaults — looked for: …`. `.env.bridge.local` is resolved from the **script's own location**, not the cwd, so this usually means a service or alias is launching a different copy of the checkout. Pin it with `BRIDGE_ENV_FILE=<absolute path>`. See [RUNNING_AS_A_SERVICE.md](./RUNNING_AS_A_SERVICE.md). |
| `502 bridge_backend_error` from a service, but the same command works in your shell | The service manager inherits no PATH and sources no shell rc, so `claude` / `codex` aren't found. Put their directories on the service's `PATH` — note that a Node version manager installs global CLIs **per Node version**, so the CLI dir must match the Node the service resolved. See [RUNNING_AS_A_SERVICE.md](./RUNNING_AS_A_SERVICE.md). |
| Service dies at every restart after a Node upgrade | The unit hardcodes a version-manager path like `~/.nvm/versions/node/vX.Y.Z/bin/node`, which moves on `nvm install`. Resolve the interpreter at start time instead (`nvm which default`). |
| Codex model 400s with `Unsupported value: '<effort>' is not supported with the '<model>' model` | Since the bridge runs Codex with `--ignore-user-config`, a `model_reasoning_effort` in `~/.codex/config.toml` no longer reaches it. The effort now comes from the request's model suffix (`gpt-5.5:high`) or a `-c model_reasoning_effort=...` in `BRIDGE_CODEX_ARGS`: drop or change the one the model does not support. |
