# Security Policy

## Scope and intended deployment

Local CLI Bridge is a **development and testing** tool. It binds to `127.0.0.1` by
default and shells out to locally installed AI CLIs (`claude`, `codex`, or an arbitrary
`BRIDGE_COMMAND`). Spawned CLIs run **with your user's privileges and your CLI login**:
anything that can reach the endpoint with the Bearer key can spend your subscription's
quota and exercise whatever the CLI itself can do. It is not designed to be an
internet-facing, multi-tenant, or production inference service.

## Threat model

**Network exposure.** Loopback-only by default. The one supported remote path is a named
Cloudflare Tunnel behind Cloudflare Access with a service-token policy, plus the bridge's
own Bearer key — three independent layers, all required (`docs/REMOTE_BRIDGE.md`). The
tunnel launcher **fails closed**: it refuses to start without `BRIDGE_API_KEY`. The
bridge itself never terminates TLS and adds no transport security of its own.

**Authentication.** The Bearer key is compared with a constant-time comparison
(`crypto.timingSafeEqual`); key length is the only timing signal. Discovery-route
relaxations are narrow and explicit: direct-loopback browsers (detected by the *absence*
of Cloudflare edge headers) may view `GET` discovery routes; `?key=` and
`Cf-Access-Jwt-Assertion` trust are opt-in, `GET`-only, and the JWT check is a
**presence** check, not signature verification — sound only while Access actually covers
the hostname. Completions always require the Bearer. Note the bridge ships **one shared
static key**: there is no per-client identity, rotation, or rate limiting per caller.

**Prompt content.** A prompt is whatever a caller sent: a meeting transcript, a scraped
page, a document. Anything said or written in it is untrusted. So every Claude Code run
starts with:

- `--safe-mode`: none of this machine's CLAUDE.md, skills, plugins, hooks, MCP servers
  or custom agents (admin-managed policy settings still apply);
- `--tools ""` (written `--tools=`): no tools, so nothing in a prompt can get Claude
  Code to read, write or run anything on this machine. A request with
  `"web_search": true` gets WebSearch and WebFetch only;
- `--no-session-persistence`: the prompt and the answer are not saved as a session.

`BRIDGE_CLAUDE_ARGS` and `BRIDGE_CLAUDE_ARGS_JSON` are an allowlist of options that shape
or narrow a run, so configuration cannot give Claude Code tools, turn these options off
or resume a session; a value that would stops a `claude` or `auto` bridge at start.
Codex runs `--ephemeral --sandbox read-only`, and the `command` backend runs whatever the
operator configured.

**Secrets.** Provider API keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …) are stripped
from the spawned CLI's environment by default, so a stray key in your shell cannot be
exfiltrated through a CLI that echoes its environment, and the CLI stays on its own
login. `ANTHROPIC_BASE_URL` is removed for every backend, even with
`BRIDGE_KEEP_ENV_KEYS=1`: left set by another tool or a proxy setup, it would send every
prompt to a host other than Anthropic. The env-file loader imports only allowlisted
`BRIDGE_*` keys, never other app secrets. Raw backend error messages (which can reveal executable names, paths, and login
state) are redacted from clients by default and replaced with a correlation id that keys
the full detail in the server log; messages the bridge itself generates about limits and
timeouts are exposed because they reveal nothing about the host.

**Resource abuse.** Request bodies are capped (`BRIDGE_MAX_BODY_BYTES`, 10 MB), total
child output is capped (`BRIDGE_MAX_PROCESS_OUTPUT_BYTES`, 10 MB, covering stdout,
stderr, and the Codex result file), concurrent CLI children are capped
(`BRIDGE_MAX_CONCURRENT`, a hard ceiling that is held until a child actually exits), and
every run has a timeout (`BRIDGE_TIMEOUT_MS`) after which the child is killed. A client
that disconnects mid-completion has its CLI child killed rather than left running.

**Cancellation is best effort.** The bridge terminates the *direct* child process
(SIGTERM, then SIGKILL after a short grace). Termination of subprocesses launched by the
CLI itself may depend on the operating system and CLI behaviour — no process-group
management is performed, and Windows signal semantics differ.

**Residual risks / non-goals.** No TLS of its own; one shared static key; no per-caller
rate limiting or audit trail; the `command` backend runs whatever command the operator
configures (the bridge parses the template without a shell, but the configured executable
itself is trusted by definition); capability figures on `/v1/models` are configured
assumptions, not verified facts. A request with `"web_search": true` lets Claude Code
fetch any URL, so a prompt that asks it to can send parts of itself to a web server:
opt in only for prompts you trust. Once an event stream (`stream: true`) has started, a
failure can no longer change the status code: it arrives as a `data: {"error":…}`
event on the `200`, and a client must treat it as a failure.

## Supported versions

Only the latest published 0.x release receives security fixes.

## Reporting a vulnerability

Please use **GitHub private security advisories** on
[JediConcepts/local-cli-bridge](https://github.com/JediConcepts/local-cli-bridge/security/advisories/new)
rather than public issues. Reports are acknowledged on a best-effort basis — this is a
maintained side project, not a staffed security team.

## Hardening checklist

- Keep the bind loopback (`HOST=127.0.0.1`); never expose the port directly.
- Set `BRIDGE_API_KEY` even for local use if anything else on the machine is untrusted.
- Keep `BRIDGE_EXPOSE_ERROR_DETAILS=0` anywhere a remote party can see responses.
- For remote use: Cloudflare Access service token + named tunnel + strong random Bearer,
  and rotate the Bearer when a client machine is retired.
- No CLI-side hardening flags are needed: Claude Code already runs with `--safe-mode`,
  no tools and no saved session, and `BRIDGE_CLAUDE_ARGS` cannot loosen that; Codex
  already runs `--sandbox read-only`.
- Leave `"web_search": true` off for prompts you do not trust.
- Lower `BRIDGE_MAX_CONCURRENT` and `BRIDGE_TIMEOUT_MS` to the minimum your workload needs.
