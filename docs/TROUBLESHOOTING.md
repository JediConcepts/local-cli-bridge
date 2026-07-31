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
| `400 Unsupported request feature` | The bridge rejects `stream`, `tools`, `tool_choice`, `response_format`, `functions`, and `n > 1` loudly rather than silently ignoring them (explicit `null` values are tolerated). |
| `502 bridge_backend_error` | The CLI failed to spawn, exited non-zero, produced unparsable output, or exceeded `BRIDGE_MAX_PROCESS_OUTPUT_BYTES`. Full detail is in the server log under the correlation id. |
| `504 bridge_backend_error` | The CLI outlived `BRIDGE_TIMEOUT_MS` and was killed. |
| Remote call dies at ~100s with a `524` | Cloudflare's edge waits ~100 seconds for response headers. The default `BRIDGE_KEEPALIVE_MS=auto` heartbeats tunnel-forwarded requests to prevent this; ensure it isn't set to `0`, and see [REMOTE_BRIDGE.md](./REMOTE_BRIDGE.md) if your arrangement strips the Cloudflare headers. |
| A `200` completion with an `{"error":{…}}` body | Tunnel-keepalive contract: the backend failure arrived after the heartbeat committed the status code. Clients must treat an `error` body as failure. Local (non-tunnel) requests keep real status codes under the default `auto`. |
| Hostname 404s intermittently through the tunnel | Two connectors on one tunnel with different ingress, Cloudflare round-robins to the one lacking the hostname. Run ONE connector per tunnel (Arrangement A in [REMOTE_BRIDGE.md](./REMOTE_BRIDGE.md)). |
| Generic error + `id` field in the response | Redacted error (default). Look up the correlation id in the bridge's server log for the full detail. |
