# Remote model bridge over Cloudflare

> Installed from npm rather than a clone? Wherever this guide says `npm run bridge` or `npm run bridge:tunnel`, use `npx local-cli-bridge` or `npx local-cli-bridge-tunnel`.


Expose the [local model bridge](./LOCAL_BRIDGE.md) to a **remote** instance of your
application so it can route a request to a Claude/Codex subscription running on your
workstation, without opening a port on your machine. Throughout this guide,
`llm.example.com` stands in for the hostname you choose on your own domain.

```
remote app ──HTTPS──► Cloudflare edge ──named tunnel──► cloudflared ──► bridge (127.0.0.1:8787) ──► claude / codex
                      (Access service token)                            (Bearer key)
```

Three independent layers must all pass for a request to reach a CLI:

1. **Cloudflare Access service token**, enforced at Cloudflare's edge. Your application
   sends `CF-Access-Client-Id` / `CF-Access-Client-Secret`; Access admits the request only
   if the token is authorised for the `llm.example.com` application.
2. **Bridge Bearer key** (`BRIDGE_API_KEY`), checked by the bridge itself. Stored in
   your application as the endpoint's API key.
3. **Loopback binding**, the bridge listens only on `127.0.0.1`; the *only* route in is
   through the tunnel.

> Treat the Access service token and the Bearer key as secrets in your application:
> store them write-only/encrypted, never return them to a browser, never log them. Only
> these two named service-token headers ever need to be sent, no arbitrary-header
> mechanism is required.

## Choose your tunnel arrangement

A single `config.yml` has **exactly one** `tunnel:` / `credentials-file:` and **one**
`ingress:` list, you expose more hostnames by adding ingress *rules*, never by adding a
second `tunnel:` block. So pick one of two arrangements:

- **A, reuse a tunnel you already run** (recommended when `cloudflared` is already up for
  another hostname). One connector serves every hostname.
- **B, a dedicated tunnel just for the bridge**. A separate config file so it can run
  alongside your other tunnel.

You need `cloudflared` installed and logged in (`cloudflared tunnel login`).

### Arrangement A, reuse an existing tunnel

Add `llm.example.com` as another **ingress rule** on the tunnel you already have (here, an
existing tunnel that already serves another app):

```yaml
tunnel: <tunnel-uuid>
credentials-file: ~/.cloudflared/<tunnel-uuid>.json
ingress:
  - hostname: other-app.example.com
    service: http://127.0.0.1:3000
  - hostname: llm.example.com
    service: http://127.0.0.1:8787
  - service: http_status:404
```

Route DNS for the new hostname, then **restart your existing `cloudflared`** so it reloads
the ingress (one connector now serves both hostnames):

```bash
cloudflared tunnel route dns <tunnel-uuid> llm.example.com
# then restart the existing cloudflared process
```

Start **only the bridge**, the existing connector already fronts it:

```bash
BRIDGE_API_KEY='<a-strong-random-key>' npm run bridge
```

> ⚠️ Do **not** run `npm run bridge:tunnel` here. It would start a *second* connector for
> the same tunnel with a partial ingress; Cloudflare round-robins requests across connectors,
> so whichever one lacks the hostname returns 404. One connector, one config, both hostnames.

### Arrangement B, a dedicated tunnel for the bridge

Create a separate tunnel with its **own config file** so it coexists with your other one:

```bash
cloudflared tunnel create llm-bridge
cloudflared tunnel route dns llm-bridge llm.example.com
```

`~/.cloudflared/llm-bridge.yml`:

```yaml
tunnel: <tunnel-uuid>
credentials-file: ~/.cloudflared/<tunnel-uuid>.json
ingress:
  - hostname: llm.example.com
    service: http://127.0.0.1:8787
  - service: http_status:404
```

Start the bridge **and** this tunnel together, one command, shut down together on Ctrl-C:

```bash
BRIDGE_TUNNEL_NAME=llm-bridge \
BRIDGE_TUNNEL_CONFIG=~/.cloudflared/llm-bridge.yml \
BRIDGE_API_KEY='<a-strong-random-key>' \
npm run bridge:tunnel
```

`BRIDGE_TUNNEL_CONFIG` is **required whenever a default `~/.cloudflared/config.yml` already
exists** for another tunnel, it tells `cloudflared` which config to run so the two don't
collide. See the env table in [LOCAL_BRIDGE.md](./LOCAL_BRIDGE.md) for `BRIDGE_BACKEND` /
`BRIDGE_MODELS` / `PORT` / `CLOUDFLARED_BIN`.

### Protect the hostname with Cloudflare Access

Either arrangement, add a **service-token** Access policy over `llm.example.com` (Zero
Trust → Access → Applications: a self-hosted app for the hostname; Access → Service Auth
for the token; policy *Action = Service Auth* including that token). This is independent of
which tunnel serves the hostname. Note the **Client ID + Secret** for your application's
endpoint configuration.

## Wire it into your application

1. Add a **custom OpenAI-compatible endpoint**:
   - Base URL: `https://llm.example.com/v1`
   - API key: the same value as `BRIDGE_API_KEY`
2. Configure the endpoint's **CF Access Client ID** and **CF Access Client Secret** (the
   service token) so every request to the endpoint carries the `CF-Access-Client-Id` /
   `CF-Access-Client-Secret` headers. Store both write-only/encrypted.
3. Verify the whole chain with an authenticated `GET /health` (below). Once model
   discovery succeeds, route requests to the endpoint's models.

### Or configure the token via environment variables

If your application reads endpoint credentials from environment variables instead of (or
as a fallback to) stored settings, a common pattern is an upper-cased endpoint-id prefix.
For an endpoint whose id is `endpoint`:

```bash
# the application's server-side env, NOT the bridge's .env.bridge.local
ENDPOINT_CF_ACCESS_CLIENT_ID=<client id>
ENDPOINT_CF_ACCESS_CLIENT_SECRET=<client secret>
ENDPOINT_API_KEY=<bridge bearer key>        # optional; only if not stored in the app
```

A value stored in the application should always win; env vars fill only blank fields, and
both CF vars should be required together (a lone id is ignored).

### Verify the full chain with curl

```bash
KEY='<bridge bearer key>'
CFID='<access client id>'
CFSECRET='<access client secret>'

curl -sS https://llm.example.com/health \
  -H "CF-Access-Client-Id: $CFID" \
  -H "CF-Access-Client-Secret: $CFSECRET" \
  -H "Authorization: Bearer $KEY"
# → {"ok":true,"backend":"auto","models":[…]}
```

The response (or failure mode) of this single request identifies which of the five layers
broke, Cloudflare Access, the named tunnel, bridge reachability, the Bearer key, or model
discovery. The full failure-state table is in
[TROUBLESHOOTING.md](./TROUBLESHOOTING.md).

## Long calls: Cloudflare 524 and the keep-alive

Cloudflare's edge waits ~**100 seconds** for the origin to return response headers, then
kills the request with a **524** (an HTML error page, it surfaces in client logs as
`524: <!DOCTYPE html>…`). A CLI-backed completion on a very large prompt (a long-running
pipeline stage with a ~100k-token prompt, say) routinely takes minutes, so without a
defence *every* long call through the tunnel dies at the 100s mark, regardless of any
timeout you configure on the bridge or the client.

The bridge defends itself per request (`BRIDGE_KEEPALIVE_MS=auto`, the default): a
completion request that arrives **carrying Cloudflare edge headers** (`cf-ray` /
`cf-connecting-ip`) **commits to a 200 and sends a first byte immediately** (stopping the
edge clock), then heartbeats a newline every 20 seconds until the CLI finishes, and
finally writes the JSON body. Leading whitespace is valid JSON, so clients parse the
response unchanged. Requests **without** those headers — direct local calls to the same
bridge — skip the heartbeat entirely and keep real HTTP status codes (a timeout is a
`504`, a backend failure a `502`).

Note the detection is a **header heuristic, not authenticated tunnel detection**: any
local caller could forge `cf-ray`, which merely turns the heartbeat on for that request
and costs the forger their own status code. It steers response framing, never
authentication.

Three consequences to know about:

- For tunnel traffic, a CLI failure **after** the heartbeat starts can't change the
  status code any more, it is delivered in-body as `{"error":{...}}` on the 200. Your
  client must detect that shape and fail the call properly; a generic OpenAI client that
  ignores `error` bodies would see an empty completion instead.
- Set `BRIDGE_KEEPALIVE_MS` to a number to force the old absolute behavior: `0` never
  heartbeats (the bridge logs a warning if tunnel-forwarded traffic then shows up), `N`
  heartbeats every N ms for **every** request, local ones included.
- If your tunnel arrangement somehow strips the Cloudflare headers before they reach the
  bridge, `auto` would treat that traffic as local and long calls would 524 again —
  verify with one long request, and force a numeric interval if needed.

After updating the bridge script on the workstation, **restart the bridge process** to pick
up the change.

## Scope of this feature

Intentionally minimal: a single named tunnel, one service token, one Bearer key, loopback
binding, two write-only CF-Access credential fields on the client side, one health probe
that identifies the failing layer, and one start command. No arbitrary request headers, no
long-lived sessions, no bridge-management UI.
