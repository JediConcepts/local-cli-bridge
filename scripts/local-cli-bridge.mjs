#!/usr/bin/env node
/**
 * local-cli-bridge, an OpenAI-compatible HTTP shim in front of a local CLI.
 *
 * Any application that can call an OpenAI-compatible endpoint can route a request
 * to a model tool running on your workstation. Ollama and LM Studio already expose
 * such a server, so they work directly. Claude Code and Codex are CLIs, NOT servers,
 * this bridge is the missing piece: it listens on localhost, speaks the OpenAI
 * `/v1/chat/completions` shape, and shells out to the CLI per request, returning the
 * result in OpenAI form.
 *
 * Run it on the workstation that has the CLI + subscription, then point your
 * application at http://localhost:<port>/v1 as a custom OpenAI-compatible endpoint.
 *
 * Zero dependencies (Node built-ins only). NOT for production, a dev/testing bridge,
 * bound to loopback by default.
 *
 * Usage:
 *   node scripts/local-cli-bridge.mjs                 # backend from BRIDGE_BACKEND (default: claude)
 *   BRIDGE_BACKEND=codex node scripts/local-cli-bridge.mjs
 *   BRIDGE_BACKEND=command BRIDGE_COMMAND='my-llm --model {model}' node scripts/local-cli-bridge.mjs
 *
 * Env:
 *   PORT               (default 8787)
 *   HOST               (default 127.0.0.1, loopback; set 0.0.0.0 only if you must)
 *   BRIDGE_BACKEND     claude | codex | command
 *   BRIDGE_COMMAND     for backend=command: a shell-word template; {model} is substituted,
 *                      the system+prompt text is written to the process stdin
 *   BRIDGE_MODEL       default model id when a request omits one
 *   BRIDGE_TIMEOUT_MS  per-request CLI timeout (default 900000 = 15m; long-running
 *                      pipeline stages can take minutes)
 *   BRIDGE_API_KEY     if set, requests must send `Authorization: Bearer <it>`
 *   BRIDGE_KEEPALIVE_MS  whitespace heartbeat interval while the CLI runs (default 20000;
 *                      0 disables). See "Cloudflare 524" note on the completions handler.
 *   BRIDGE_MAX_BODY_BYTES    request body ceiling (default 10485760 = 10MB, the CLI stdin cap)
 *   BRIDGE_MAX_CONCURRENT    max simultaneous CLI completions (default 4; excess → 429)
 *   BRIDGE_EXPOSE_ERROR_DETAILS  0 (default) returns a generic message + correlation id
 *                      to the client, full details stay in the server log. Set 1
 *                      explicitly to return raw backend error messages ("Not logged
 *                      in", CLI errors), only sensible for a trusted local deployment.
 *   BRIDGE_ALLOW_QUERY_KEY  1 enables GET /v1/models?key=<BRIDGE_API_KEY> for browser
 *                      viewing through the tunnel (key lands in history/logs, opt-in).
 *                      A browser on the workstation itself needs nothing: direct
 *                      loopback requests (not tunnel-forwarded) skip discovery auth.
 *   BRIDGE_TRUST_CF_ACCESS  1 lets any request that PASSED Cloudflare Access (edge-
 *                      stamped Cf-Access-Jwt-Assertion) view GET discovery routes,
 *                      an Access-logged-in browser just loads /v1/models, no key in
 *                      the URL. Only sound while Access covers the hostname.
 *
 * Reasoning effort: request model "<id>:<effort>" and the bridge maps it per backend,
 *   "gpt-5.6-sol:high" → codex exec --model gpt-5.6-sol -c model_reasoning_effort="high"
 *   "sonnet:xhigh"     → claude -p --model sonnet --effort xhigh
 * Advertise the variants you want via BRIDGE_MODELS. Effort values a backend doesn't
 * support are stripped and ignored (Claude accepts low|medium|high|xhigh|max).
 */

import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadBridgeEnv } from "./lib/load-bridge-env.mjs";
import { argsFromEnv } from "./lib/parse-argv.mjs";

// Pull BRIDGE_* config from .env.bridge.local / .env.local (allowlisted) before reading it,
// so the command can be run bare. Inline env still wins.
loadBridgeEnv();

// Numeric env values are validated, NaN / negatives / non-integers silently falling
// through to arithmetic is how a typo'd env var becomes a 0ms timeout.
function positiveInteger(value, fallback, { allowZero = false } = {}) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  const minimum = allowZero ? 0 : 1;
  return Number.isSafeInteger(parsed) && parsed >= minimum ? parsed : fallback;
}

const PORT = positiveInteger(process.env.PORT || process.env.BRIDGE_PORT, 8787);
const HOST = process.env.HOST || process.env.BRIDGE_HOST || "127.0.0.1";
const BACKEND = process.env.BRIDGE_BACKEND || "claude";
const DEFAULT_MODEL = process.env.BRIDGE_MODEL || "";
const TIMEOUT_MS = positiveInteger(process.env.BRIDGE_TIMEOUT_MS, 900_000);
// Whitespace heartbeat interval for in-flight completions (0 disables). 20s sits far
// inside every relevant idle limit (Cloudflare's ~100s response-start ceiling, undici's
// 300s bodyTimeout) without measurable overhead.
const KEEPALIVE_MS = positiveInteger(process.env.BRIDGE_KEEPALIVE_MS, 20_000, { allowZero: true });
// Request body ceiling, matches the Claude CLI's 10MB stdin cap; a caller (or stolen
// token) can't exhaust memory with an unbounded body.
const MAX_BODY_BYTES = positiveInteger(process.env.BRIDGE_MAX_BODY_BYTES, 10 * 1024 * 1024);
// Every completion spawns a CLI process, cap how many run at once. Default 4 covers
// a client legitimately running a few completions in parallel (long-running pipeline
// stages often fan out) while keeping a request burst from forking a process storm;
// single-user operators can lower it. A 429 is refused BEFORE the keep-alive commits a 200.
const MAX_CONCURRENT = positiveInteger(process.env.BRIDGE_MAX_CONCURRENT, 4);
// Raw backend error messages can reveal executable names, paths, and login state.
// OFF by default: clients get a generic message + a correlation id, and the full
// detail stays in the server log. Set BRIDGE_EXPOSE_ERROR_DETAILS=1 explicitly on a
// trusted local deployment where the caller (or its error classifier) needs the real
// message ("Not logged in", CLI errors).
const EXPOSE_ERROR_DETAILS = process.env.BRIDGE_EXPOSE_ERROR_DETAILS === "1";

// Models this bridge advertises on /v1/models (so a client app can prefill its model
// dropdown). Override with BRIDGE_MODELS="a,b,c"; otherwise sensible per-backend defaults.
const DEFAULT_MODELS_BY_BACKEND = {
  claude: "opus,sonnet,haiku",
  // Codex model slugs vary per install (gpt-5.5, gpt-5.6-sol/terra, …), so don't guess,
  // set BRIDGE_MODELS to your real slugs, or leave blank and Codex uses its config default.
  codex: "",
  command: "",
  // auto: one bridge serving BOTH, advertises Claude's models by default; add your
  // Codex slugs with BRIDGE_MODELS="opus,sonnet,haiku,gpt-5.5".
  auto: "opus,sonnet,haiku",
};
const ADVERTISED_MODELS = (process.env.BRIDGE_MODELS || DEFAULT_MODELS_BY_BACKEND[BACKEND] || DEFAULT_MODEL)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// The bridge is the AUTHORITY on local model capabilities (context + output), but
// neither the Claude Code CLI nor the Codex CLI exposes a machine-readable per-model
// capability endpoint, so NONE of these values are ever "discovered" from the CLI. They
// are configured DEFAULTS (a known-model assumption) or operator OVERRIDES. Every
// /v1/models entry is stamped with `caps_source` so a consumer can tell an assumption
// from a confirmed value and never presents a family default as though the CLI reported it:
//   "override", operator-set via BRIDGE_MODEL_CAPS (authoritative for this deployment)
//   "default" , a family fallback below (a documented per-family API limit, NOT discovered)
//   "unknown" , no family matched; conservative floor
// Output ceilings track each model's real API max_tokens: Opus 4.x caps at 32k,
// Sonnet/Haiku 4.x reach 64k. GPT-5.x figures follow the official OpenAI model catalog
// (developers.openai.com/api/docs/models, checked 2026-07-21): the 5.6 family and
// 5.4/5.4-pro are 1,050,000 context; 5.5 ≈ 1,000,000; 5.4-mini/nano and bare gpt-5 are
// 400,000, all with 128,000 max output. NOTE the context window is SHARED by prompt +
// reasoning + output, so 1M in AND 128k out in one request is not generally achievable.
// First matching row wins (order specific → generic). Override per model with
// BRIDGE_MODEL_CAPS="gpt-5.5=1000000:128000,opus=200000:32000".
const MODEL_CAPS_DEFAULTS = [
  [/\bopus\b/i,                  200000, 32000], // Opus 4.x API output ceiling is 32k, not 64k
  [/\b(sonnet|haiku)\b|claude/i, 200000, 64000],
  [/gpt-?5\.6/i,                1050000, 128000], // sol / terra / luna
  [/gpt-?5\.5/i,                1000000, 128000],
  [/gpt-?5\.4-(mini|nano)/i,     400000, 128000],
  [/gpt-?5\.4/i,                1050000, 128000], // incl. -pro
  [/gpt-?5\b|codex/i,            400000, 128000], // bare gpt-5 / unknown Codex slugs, conservative
];
const MODEL_CAPS_OVERRIDES = (process.env.BRIDGE_MODEL_CAPS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((entry) => {
    const [k, v] = entry.split("=");
    const [c, o] = (v || "").split(":").map((n) => Number(n));
    return { key: (k || "").trim().toLowerCase(), context: c, output: o };
  })
  .filter((x) => x.key);

function modelCaps(id) {
  const lower = (id || "").toLowerCase();
  for (const ov of MODEL_CAPS_OVERRIDES) {
    if (lower.includes(ov.key)) {
      return { context_window: ov.context || 128000, max_output_tokens: ov.output || 8192, caps_source: "override" };
    }
  }
  for (const [re, c, o] of MODEL_CAPS_DEFAULTS) {
    if (re.test(id)) return { context_window: c, max_output_tokens: o, caps_source: "default" };
  }
  return { context_window: 128000, max_output_tokens: 8192, caps_source: "unknown" }; // conservative floor
}
const REQUIRE_KEY = process.env.BRIDGE_API_KEY || "";

// Provider API keys stripped from the spawned CLI's env by default, so each CLI uses
// its OWN login (Claude/Codex subscription) rather than an API key that happens to be
// in the shell/.env, the cause of "Not logged in" loops. Opt out with BRIDGE_KEEP_ENV_KEYS=1.
const STRIP_ENV_KEYS = [
  "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY",
  "GEMINI_API_KEY", "GOOGLE_API_KEY", "GROQ_API_KEY", "NVIDIA_API_KEY",
];

// ── Reasoning effort via model-id suffix ──────────────────────────────────────
// Both CLIs take a per-run reasoning effort (Codex: `-c model_reasoning_effort='"high"'`;
// Claude Code: `--effort xhigh`, works in -p mode). Encode it as a MODEL-ID SUFFIX,
// `gpt-5.6-sol:high`, `sonnet:xhigh`, so a client selects a per-request effort with
// NO schema change: the request's model string carries it.
// Advertise the variants you want in the dropdown explicitly
// (BRIDGE_MODELS="gpt-5.6-sol:high,sonnet:xhigh,gpt-5.6-luna:low,…"); caps matching
// (regex/substring) sees through the suffix, so variants inherit the base model's caps.
// Effort values a backend doesn't support are stripped and ignored, never passed through.
// Effort vocabulary across the Codex model range (per-model support varies, e.g. "max"
// is 5.6-family, "minimal" is bare gpt-5, 5.4-pro starts at medium). The bridge doesn't
// gate per model: the CLI rejects an unsupported level and that error surfaces normally.
const REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
// The subset the Claude Code CLI's --effort flag accepts (docs: cli-reference; default high).
const CLAUDE_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
function splitModelEffort(model) {
  const i = (model || "").lastIndexOf(":");
  if (i < 0) return { id: model || "", effort: null };
  const effort = model.slice(i + 1).trim().toLowerCase();
  return REASONING_EFFORTS.has(effort) ? { id: model.slice(0, i), effort } : { id: model || "", effort: null };
}

// ── Backends ──────────────────────────────────────────────────────────────────
// Each backend maps an OpenAI request → { cmd, args, stdin } and parses the CLI's
// stdout back to { text, promptTokens, completionTokens }. Backends are finalised
// below (claude / codex presets); `command` is the universal escape hatch.

const BACKENDS = {
  /**
   * Claude Code CLI in headless print mode, one-shot completion, JSON output.
   * Invocation (authoritative, see also docs/LOCAL_BRIDGE.md):
   *   claude -p --output-format json [--model <m>] [--effort <e>] [--append-system-prompt <s>]
   * with the prompt piped on stdin (fine up to Claude Code's 10MB stdin cap).
   * --output-format json → { result, is_error, session_id, ... }. Errors go to stderr +
   * a non-zero exit, which the runner surfaces. No token counts are in the JSON, so the
   * bridge estimates them (~4 chars/token).
   */
  claude: {
    build({ model, system, prompt }) {
      // Minimal, subscription-friendly invocation. Deliberately NO --bare: it isolates
      // the run and stops Claude Code from seeing the ~/.claude credentials that
      // `claude` + `/login` set up ("Not logged in"). The child env also has the
      // provider API keys stripped (see runBackend) so the CLI uses your subscription
      // login, not an ANTHROPIC_API_KEY. Add hardening flags (e.g.
      // --permission-mode dontAsk --max-turns 1) via BRIDGE_CLAUDE_ARGS if wanted.
      const args = ["-p", "--output-format", "json"];
      // The effort suffix drives Claude too: current Claude Code has a first-class
      // `--effort low|medium|high|xhigh|max` (default high) that works in -p mode,
      // so "sonnet:xhigh" → `--model sonnet --effort xhigh`. Values outside Claude's
      // vocabulary (none/minimal/ultra are Codex-side) are stripped and ignored so an
      // invalid flag value never reaches the CLI.
      const { id: modelId, effort } = splitModelEffort(model);
      if (modelId) args.push("--model", modelId);
      if (effort && CLAUDE_EFFORTS.has(effort)) args.push("--effort", effort);
      if (system) args.push("--append-system-prompt", system);
      const extra = argsFromEnv({
        json: process.env.BRIDGE_CLAUDE_ARGS_JSON,
        text: process.env.BRIDGE_CLAUDE_ARGS,
        label: "BRIDGE_CLAUDE_ARGS_JSON",
      });
      return { cmd: "claude", args: [...args, ...extra], stdin: prompt };
    },
    parse(out) {
      const j = JSON.parse(out);
      if (j.is_error) throw new Error(typeof j.result === "string" ? j.result : "claude reported an error");
      const text = j.result ?? "";
      return { text: typeof text === "string" ? text : JSON.stringify(text) }; // tokens estimated upstream
    },
  },

  /**
   * Codex CLI in non-interactive exec mode:
   *   codex exec --ephemeral --sandbox read-only --output-last-message <tmp>
   * The prompt is piped on stdin; Codex writes ONLY its final message to <tmp>, which
   * the runner reads back, so agent chatter on stdout never pollutes the completion.
   * read-only sandbox means it can't modify the filesystem. Codex uses its own
   * ~/.codex/auth.json login (the child env has API keys stripped, see runBackend).
   */
  codex: {
    build({ model, prompt }) {
      const outFile = path.join(os.tmpdir(), `codex-bridge-${process.pid}-${Date.now()}.txt`);
      const args = ["exec", "--ephemeral", "--sandbox", "read-only", "--skip-git-repo-check", "--output-last-message", outFile];
      const { id, effort } = splitModelEffort(model);
      if (id) args.push("--model", id);
      // -c parses its value as TOML, the inner double quotes are required.
      if (effort) args.push("-c", `model_reasoning_effort="${effort}"`);
      const extra = argsFromEnv({
        json: process.env.BRIDGE_CODEX_ARGS_JSON,
        text: process.env.BRIDGE_CODEX_ARGS,
        label: "BRIDGE_CODEX_ARGS_JSON",
      });
      return { cmd: "codex", args: [...args, ...extra], stdin: prompt, resultFile: outFile };
    },
    parse(out) {
      let t = (out || "").trim();
      // Normal path: `out` is the clean --output-last-message file content. Fallback path
      // (empty file): `out` is the raw exec transcript, pull the assistant's final message
      // from between the last "codex" marker and the "tokens used" footer.
      if (/^tokens used\b/m.test(t) || /^codex\s*$/m.test(t)) {
        const afterCodex = t.split(/^codex\s*$/m).pop();
        t = (afterCodex ?? t).split(/^tokens used\b/m)[0].trim();
      }
      return { text: t };
    },
  },

  /**
   * Universal escape hatch: BRIDGE_COMMAND is a quoted command template (see
   * lib/parse-argv.mjs for the exact grammar — quoting supported, NO shell
   * expansion) whose `{model}` tokens are substituted; the combined system+prompt
   * text is piped to stdin and the process's raw stdout is taken as the completion.
   * Works for any CLI that reads a prompt on stdin and prints the answer.
   *   BRIDGE_BACKEND=command BRIDGE_COMMAND='ollama run {model}'
   * BRIDGE_COMMAND_JSON='["ollama","run","{model}"]' is the exact, quoting-proof form.
   */
  command: {
    build({ model, system, prompt }) {
      if (!process.env.BRIDGE_COMMAND_JSON && !process.env.BRIDGE_COMMAND) {
        throw new Error("BRIDGE_COMMAND (or BRIDGE_COMMAND_JSON) is required for backend=command");
      }
      const parts = argsFromEnv({
        json: process.env.BRIDGE_COMMAND_JSON,
        text: process.env.BRIDGE_COMMAND,
        label: "BRIDGE_COMMAND_JSON",
      }).map((p) => p.replaceAll("{model}", model || ""));
      if (!parts.length || !parts[0]) throw new Error("BRIDGE_COMMAND resolved to an empty command");
      return {
        cmd: parts[0],
        args: parts.slice(1),
        stdin: system ? `${system}\n\n${prompt}` : prompt,
      };
    },
    parse(out) {
      return { text: out.trim() };
    },
  },
};

// ── OpenAI <-> CLI mapping ──────────────────────────────────────────────────────

/** Flatten OpenAI `messages` into { system, prompt } the CLIs can take. */
function foldMessages(messages = []) {
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const convo = messages
    .filter((m) => m.role !== "system")
    .map((m) => (m.role === "assistant" ? `Assistant: ${m.content}` : m.content))
    .join("\n\n");
  return { system, prompt: convo };
}

function estimateTokens(str) {
  return Math.max(1, Math.round((str || "").length / 4)); // rough ~4 chars/token fallback
}

/**
 * In "auto" mode, pick the backend from the requested model so ONE bridge on ONE port
 * serves both: Claude models → claude, GPT/Codex models → codex. Any other backend
 * value is used as-is.
 */
function resolveBackendName(model) {
  if (BACKEND !== "auto") return BACKEND;
  const m = (model || "").toLowerCase();
  if (/\b(opus|sonnet|haiku)\b|claude/.test(m)) return "claude";
  if (/gpt|codex|^o[0-9]/.test(m)) return "codex";
  return process.env.BRIDGE_AUTO_DEFAULT || "claude"; // ambiguous id → default family
}

// Typed bridge failure. `code` classifies the condition (BACKEND_TIMEOUT,
// BACKEND_FAILED, SPAWN_FAILURE, PARSE_FAILURE, CLIENT_DISCONNECTED, ...) and
// `safeToExpose` marks messages that reveal nothing about the host (no paths,
// executables, or login state) and are actionable for remote callers even with
// error redaction on.
class BridgeError extends Error {
  constructor(message, { code, safeToExpose = false } = {}) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
    this.safeToExpose = safeToExpose;
  }
}

// SIGTERM → SIGKILL grace: long enough for a CLI to flush and clean up, short
// enough that cancellation pressure doesn't pile up dying children.
const KILL_GRACE_MS = 2_000;

// Best-effort child termination: SIGTERM first (lets the CLI clean up), SIGKILL
// after a short grace if it ignored the signal. This signals the DIRECT child
// only — subprocesses the CLI spawned itself may survive on some platforms
// (no process-group management), and Windows signal semantics differ, so
// cancellation is best effort, not a guarantee.
function killChildGracefully(child) {
  if (child.exitCode !== null || child.signalCode !== null) return; // already gone
  try { child.kill("SIGTERM"); } catch { /* already gone */ }
  const hardKill = setTimeout(() => {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }, KILL_GRACE_MS);
  hardKill.unref();
  child.once("close", () => clearTimeout(hardKill));
}

function runBackend({ model, system, prompt }, { signal } = {}) {
  const backendName = resolveBackendName(model);
  const backend = BACKENDS[backendName];
  if (!backend) throw new Error(`Unknown backend "${backendName}" (claude | codex | command | auto)`);
  const { cmd, args, stdin, resultFile } = backend.build({ model: model || DEFAULT_MODEL, system, prompt });

  // Force the CLI onto its own login: strip provider API keys from the child env.
  const childEnv = { ...process.env };
  if (process.env.BRIDGE_KEEP_ENV_KEYS !== "1") {
    for (const k of STRIP_ENV_KEYS) delete childEnv[k];
  }

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      return reject(new BridgeError("client disconnected before the CLI started", { code: "CLIENT_DISCONNECTED" }));
    }
    // Neutral cwd so the CLI doesn't load the current project's config files.
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], env: childEnv, cwd: os.tmpdir() });
    let out = "";
    let err = "";
    // The promise settles ONLY when the child closes (or fails to spawn), never
    // at the moment of a timeout or client abort: the caller's finally-block
    // releases the concurrency slot on settlement, so MAX_CONCURRENT stays a
    // true ceiling on live child processes even while a kill is in flight.
    let fate = null; // null | "timeout" | "aborted"
    const timer = setTimeout(() => {
      fate = "timeout";
      killChildGracefully(child);
    }, TIMEOUT_MS);
    const onAbort = () => {
      if (fate) return;
      fate = "aborted";
      killChildGracefully(child);
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    };

    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      cleanup();
      reject(new BridgeError(`Failed to spawn "${cmd}": ${e.message}`, { code: "SPAWN_FAILURE" }));
    });
    child.on("close", (code) => {
      cleanup();
      if (fate) {
        if (resultFile) { try { fs.unlinkSync(resultFile); } catch { /* ignore */ } }
        return reject(
          fate === "timeout"
            ? new BridgeError(`CLI timed out after ${TIMEOUT_MS}ms`, { code: "BACKEND_TIMEOUT", safeToExpose: true })
            : new BridgeError("client disconnected before the CLI finished", { code: "CLIENT_DISCONNECTED" }),
        );
      }
      if (code !== 0) {
        // Surface the most useful reason. Prefer a structured stdout error (Claude Code's
        // {"is_error":true,"result":"Not logged in…"}); otherwise pick the stderr line that
        // looks like the real error rather than a status banner ("Reading prompt from
        // stdin…"), e.g. Codex's "ERROR … failed to load models cache".
        let reason = "";
        try {
          const j = JSON.parse(out);
          if (typeof j?.result === "string") reason = j.result;
          else if (j?.error) reason = typeof j.error === "string" ? j.error : JSON.stringify(j.error);
        } catch { /* stdout wasn't JSON */ }
        if (!reason) {
          const lines = (err || out).split("\n").map((l) => l.trim()).filter(Boolean);
          reason = lines.find((l) => /error|failed|not logged|unauthor|invalid|denied|panic/i.test(l)) || lines[0] || "unknown error";
        }
        if (resultFile) { try { fs.unlinkSync(resultFile); } catch { /* ignore */ } }
        return reject(new BridgeError(`${cmd} failed (exit ${code}): ${reason.slice(0, 400)}`, { code: "BACKEND_FAILED" }));
      }
      try {
        // Backends that write their answer to a file (Codex --output-last-message) are
        // read from there; the rest parse stdout.
        let payload = out;
        if (resultFile) {
          try {
            const fileContent = fs.readFileSync(resultFile, "utf8");
            if (fileContent.trim()) payload = fileContent; // else keep stdout (parse extracts it)
          } catch { /* fall back to stdout */ }
          try { fs.unlinkSync(resultFile); } catch { /* ignore */ }
        }
        resolve(backend.parse(payload, { system, prompt }));
      } catch (e) {
        reject(new BridgeError(`Failed to parse ${cmd} output: ${e.message}\n${out.slice(0, 500)}`, { code: "PARSE_FAILURE" }));
      }
    });

    if (stdin != null) {
      // A killed child can EPIPE the write; without a handler that stream error
      // would crash the whole bridge process.
      child.stdin.on("error", () => {});
      child.stdin.write(stdin);
      child.stdin.end();
    }
  });
}

function openAiResponse({ model, text, promptTokens, completionTokens }) {
  return {
    id: `chatcmpl-bridge-${process.hrtime.bigint().toString(36)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model || DEFAULT_MODEL || BACKEND,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

// ── HTTP server ─────────────────────────────────────────────────────────────────

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
  res.end(payload);
}

function authOk(req) {
  if (!REQUIRE_KEY) return true;
  // Constant-time comparison, plain === leaks the match length/prefix via timing.
  const supplied = Buffer.from(String(req.headers["authorization"] || ""));
  const expected = Buffer.from(`Bearer ${REQUIRE_KEY}`);
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

// ── Browser-friendly discovery access ─────────────────────────────────────────
// Operators like to eyeball /v1/models in a browser, where sending a Bearer header
// is awkward. Safe paths, none of which reopen the remote surface:
//
// 1. DIRECT LOOPBACK (zero config): a request from the workstation's own browser
//    (http://127.0.0.1:8787/v1/models) skips auth. Tunnel traffic ALSO arrives on
//    loopback (cloudflared proxies locally), so "direct" additionally requires the
//    ABSENCE of Cloudflare's edge headers (cf-ray / cf-connecting-ip, always added
//    by the edge). Spoofing that requires being on the box already.
// 2. QUERY KEY (opt-in, BRIDGE_ALLOW_QUERY_KEY=1): GET /v1/models?key=<BRIDGE_API_KEY>
//   , bookmarkable through the tunnel. Trade-off: the key lands in browser history
//    and any proxy logs, hence the explicit opt-in. GET discovery only, never
//    completions.
// 3. TRUST CF ACCESS (opt-in, BRIDGE_TRUST_CF_ACCESS=1): a request that passed
//    Cloudflare Access carries a Cf-Access-Jwt-Assertion header stamped by the edge,
//    an identity-authenticated browser session qualifies, so /v1/models just loads
//    after the CF login, no key in the URL. The bridge checks PRESENCE, not the JWT
//    signature, so this is only sound while Access actually covers the hostname
//    (with Access off, the header is trivially forgeable), hence the explicit opt-in.
//    GET discovery only; completions always require the Bearer.
const ALLOW_QUERY_KEY = process.env.BRIDGE_ALLOW_QUERY_KEY === "1";
const TRUST_CF_ACCESS = process.env.BRIDGE_TRUST_CF_ACCESS === "1";
function isDirectLoopback(req) {
  const ra = req.socket?.remoteAddress || "";
  const loopback = ra === "127.0.0.1" || ra === "::1" || ra === "::ffff:127.0.0.1";
  const viaTunnel = Boolean(req.headers["cf-ray"] || req.headers["cf-connecting-ip"]);
  return loopback && !viaTunnel;
}
function queryKeyOk(req) {
  if (!ALLOW_QUERY_KEY || !REQUIRE_KEY) return false;
  try {
    const supplied = Buffer.from(new URL(req.url || "", "http://localhost").searchParams.get("key") || "");
    const expected = Buffer.from(REQUIRE_KEY);
    return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
  } catch {
    return false;
  }
}
/** Auth for GET discovery routes: Bearer, direct local browser, opted-in query key,
 *  or (opt-in) an edge-stamped Cloudflare Access assertion. */
function discoveryAuthOk(req) {
  return (
    authOk(req) ||
    isDirectLoopback(req) ||
    queryKeyOk(req) ||
    (TRUST_CF_ACCESS && Boolean(req.headers["cf-access-jwt-assertion"]))
  );
}

// Concurrency gate, see MAX_CONCURRENT above.
let activeCompletions = 0;

// OpenAI request features the bridge does NOT implement. Rejecting them loudly beats
// silently ignoring them, a caller that sets `stream: true` would otherwise wait for
// SSE that never comes and misread the buffered JSON.
const UNSUPPORTED_FIELDS = ["tools", "tool_choice", "response_format", "functions"];
function unsupportedFeature(body) {
  if (body.stream === true) return "stream: true (the bridge returns a single buffered completion)";
  if (body.n !== undefined && body.n !== 1) return "n > 1";
  for (const f of UNSUPPORTED_FIELDS) if (body[f] !== undefined) return f;
  return null;
}

function handleRequest(req, res) {
  const url = (req.url || "").split("?")[0];

  // Auth-enforced liveness/readiness probe. Behind Cloudflare Access (edge) AND the
  // bridge's own Bearer, so a single GET distinguishes: Cloudflare auth (edge 403),
  // tunnel down (530/1033), origin down (502), bridge auth (401 here), and success
  // (200 + advertised model ids = model discovery). Returns no secrets.
  if (req.method === "GET" && (url === "/health" || url === "/v1/health")) {
    // discoveryAuthOk: tunnel-forwarded requests (they carry CF headers) still require the
    // Bearer, a remote connection test's bridge-auth 401 detection is unaffected.
    if (!discoveryAuthOk(req)) return send(res, 401, { error: { message: "Unauthorized" } });
    const ids = ADVERTISED_MODELS.length ? ADVERTISED_MODELS : (DEFAULT_MODEL ? [DEFAULT_MODEL] : []);
    return send(res, 200, { ok: true, backend: BACKEND, models: ids });
  }

  if (req.method === "GET" && (url === "/v1/models" || url === "/models")) {
    // Auth-enforced like every other route: an unauthenticated discovery endpoint leaks
    // the backend, model inventory, and capability figures to anyone reaching the origin.
    // (A client's discovery/catalog fetch normally sends the same Bearer key it uses for
    // completions.) Browser convenience is preserved via discoveryAuthOk: direct-loopback
    // and opt-in ?key=.
    if (!discoveryAuthOk(req)) return send(res, 401, { error: { message: "Unauthorized" } });
    // Empty list when nothing is advertised, a routing UI can then fall back to a
    // free-text model field rather than offering a placeholder that isn't a real model.
    const ids = ADVERTISED_MODELS.length ? ADVERTISED_MODELS : (DEFAULT_MODEL ? [DEFAULT_MODEL] : []);
    return send(res, 200, {
      object: "list",
      // context_window / max_output_tokens make the bridge authoritative for consumers
      // that size prompts from discovery.
      data: ids.map((id) => ({ id, object: "model", owned_by: BACKEND, ...modelCaps(id) })),
    });
  }

  if (req.method === "POST" && (url === "/v1/chat/completions" || url === "/chat/completions")) {
    if (!authOk(req)) return send(res, 401, { error: { message: "Unauthorized" } });
    let raw = "";
    let receivedBytes = 0;
    let bodyTooLarge = false;
    req.on("data", (d) => {
      receivedBytes += d.length;
      if (bodyTooLarge) return;
      if (receivedBytes > MAX_BODY_BYTES) {
        bodyTooLarge = true;
        // Refuse before buffering more; 413 goes out first, then the socket closes.
        send(res, 413, { error: { message: `Request body exceeds ${MAX_BODY_BYTES} bytes` } });
        req.destroy();
        return;
      }
      raw += d;
    });
    req.on("end", async () => {
      if (bodyTooLarge) return;
      let body;
      try {
        body = JSON.parse(raw || "{}");
      } catch {
        return send(res, 400, { error: { message: "Invalid JSON body" } });
      }
      // Validate shape + reject unimplemented OpenAI features BEFORE committing a 200.
      if (body.messages !== undefined && !Array.isArray(body.messages)) {
        return send(res, 400, { error: { message: "messages must be an array" } });
      }
      if ((body.messages ?? []).some((m) => m == null || (m.content != null && typeof m.content !== "string"))) {
        return send(res, 400, { error: { message: "message content must be a string (content blocks are not supported)" } });
      }
      const unsupported = unsupportedFeature(body);
      if (unsupported) {
        return send(res, 400, { error: { message: `Unsupported request feature: ${unsupported}` } });
      }
      // Concurrency gate, decided while the status code is still ours to choose.
      if (activeCompletions >= MAX_CONCURRENT) {
        return send(res, 429, { error: { message: "Bridge is busy, too many concurrent completions", type: "rate_limit_error" } });
      }
      activeCompletions += 1;
      const { system, prompt } = foldMessages(body.messages);
      const t0 = Date.now();

      // ── Cloudflare 524 defence ──────────────────────────────────────────────
      // Behind a Cloudflare tunnel, the edge 524s any request whose ORIGIN hasn't
      // returned response headers within ~100s, and a CLI-backed completion on a
      // large prompt routinely takes minutes, so without a defence every long call
      // through the tunnel dies at the ~100s mark regardless of any timeout you
      // configure. So: commit to 200 + send a first byte NOW (stops the edge clock),
      // then heartbeat whitespace while the CLI runs (keeps idle/body timeouts
      // alive). Leading whitespace is valid JSON, so any ordinary client parses the
      // eventual body unchanged.
      //
      // Consequence: once the heartbeat starts, the status code is spent, a late
      // CLI failure is delivered IN-BODY as {"error":{...}} on the 200. Clients
      // must treat an `error` body as failure; auth/validation failures above still
      // return real 401/400 because they fail before this point.
      if (KEEPALIVE_MS > 0) {
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.write("\n");
      }
      const beat = KEEPALIVE_MS > 0
        ? setInterval(() => { if (!res.writableEnded && !res.destroyed) res.write("\n"); }, KEEPALIVE_MS)
        : null;
      let settled = false;
      // A response 'close' before finish() means the CLIENT went away mid-flight
      // (it also fires after a normal end, hence the settled guard): abort the
      // backend so the workstation isn't burning a CLI run nobody will read.
      // The concurrency slot is NOT released here — runBackend only settles once
      // the child has actually closed, so the slot keeps counting the dying child.
      const ac = new AbortController();
      res.on("close", () => {
        if (beat) clearInterval(beat);
        if (!settled) ac.abort();
      });
      const finish = (status, obj) => {
        settled = true;
        if (beat) clearInterval(beat);
        if (res.writableEnded || res.destroyed) return;
        if (KEEPALIVE_MS > 0) return res.end(JSON.stringify(obj)); // headers already sent
        return send(res, status, obj);
      };

      try {
        const { text, promptTokens, completionTokens } = await runBackend(
          { model: body.model, system, prompt },
          { signal: ac.signal },
        );
        console.log(
          `[bridge] ${resolveBackendName(body.model)} ${body.model || DEFAULT_MODEL || ""} → ${text.length} chars in ${Date.now() - t0}ms`,
        );
        return finish(
          200,
          openAiResponse({
            model: body.model,
            text,
            promptTokens: promptTokens ?? estimateTokens(system + prompt),
            completionTokens: completionTokens ?? estimateTokens(text),
          }),
        );
      } catch (e) {
        if (e.code === "CLIENT_DISCONNECTED") {
          // The socket is gone, there is nobody to answer; just record it.
          console.log(`[bridge] client disconnected after ${Date.now() - t0}ms, ${resolveBackendName(body.model)} child terminated`);
          return;
        }
        // Full detail always lands in the SERVER log with a correlation id; whether the
        // CLIENT sees the raw message is governed by BRIDGE_EXPOSE_ERROR_DETAILS (raw
        // messages can reveal executable names, paths, and login state, redacted by
        // default) — except BridgeErrors marked safeToExpose, which reveal nothing
        // about the host and stay actionable for remote callers.
        const errorId = crypto.randomUUID();
        console.error(`[bridge] error ${errorId}: ${e.stack || e.message}`);
        const message = EXPOSE_ERROR_DETAILS || e.safeToExpose ? e.message : "The local model backend failed";
        // A timed-out backend is a gateway timeout; every other backend failure
        // (spawn, non-zero exit, parse) is a bad gateway. With the keepalive
        // heartbeat active the status is already spent and this arrives in-body.
        const status = e.code === "BACKEND_TIMEOUT" ? 504 : 502;
        return finish(status, { error: { message, type: "bridge_backend_error", id: errorId } });
      } finally {
        // Settlement-scoped release: runBackend settles only after its child
        // closed, so this can never let a new spawn overlap a dying child.
        activeCompletions -= 1;
      }
    });
    return;
  }

  send(res, 404, { error: { message: `No route for ${req.method} ${url}` } });
}

/** Build (but do not bind) the bridge's HTTP server. */
function createBridgeServer() {
  return http.createServer(handleRequest);
}

// Pure pieces exported for unit tests; importing this module never starts a
// server or registers signal handlers (see the is-main guard below).
export { foldMessages, modelCaps, BACKENDS, splitModelEffort, unsupportedFeature, createBridgeServer, BridgeError };

const IS_MAIN = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (IS_MAIN) {
  const server = createBridgeServer();

  // Friendly startup failures: EADDRINUSE is the most common first run collision
  // (something else, often another bridge, already owns the port).
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(`[bridge] port ${PORT} on ${HOST} is already in use (another bridge or service?).`);
      console.error(`[bridge] pick another port:  PORT=8790 npx local-cli-bridge`);
      process.exit(1);
    }
    if (err.code === "EACCES") {
      console.error(`[bridge] no permission to bind ${HOST}:${PORT}. Ports below 1024 need elevated rights.`);
      process.exit(1);
    }
    throw err;
  });

  server.listen(PORT, HOST, () => {
    console.log(`[bridge] local-cli-bridge listening on http://${HOST}:${PORT}`);
    console.log(`[bridge] backend=${BACKEND}  default-model=${DEFAULT_MODEL || "(request-supplied)"}  max-concurrent=${MAX_CONCURRENT}`);
    console.log(`[bridge] OpenAI-compatible base URL: http://${HOST}:${PORT}/v1`);
  });

  // Graceful shutdown: stop accepting connections, let in-flight completions drain
  // (their CLI children are killed by the runner's own timeout at worst).
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      console.log(`[bridge] ${sig}, shutting down`);
      server.close(() => process.exit(0));
      // Hard exit if a long completion holds the server open past a grace period.
      setTimeout(() => process.exit(0), 5_000).unref();
    });
  }
}
