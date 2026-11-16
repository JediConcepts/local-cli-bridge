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
 *   BRIDGE_BACKEND     claude | codex | apple | command | auto
 *   BRIDGE_COMMAND     for backend=command: a quoted command template ({model} is
 *                      substituted, the system+prompt text is written to the process
 *                      stdin). Quoting supported via lib/parse-argv.mjs — no shell.
 *                      BRIDGE_COMMAND_JSON (a JSON array of strings) is the exact form.
 *   BRIDGE_MODEL       default model id when a request omits one
 *   BRIDGE_TIMEOUT_MS  per-request CLI timeout (default 900000 = 15m; long-running
 *                      pipeline stages can take minutes)
 *   BRIDGE_API_KEY     if set, requests must send `Authorization: Bearer <it>`
 *   BRIDGE_KEEPALIVE_MS  whitespace heartbeat while the CLI runs. Default "auto":
 *                      heartbeat only for Cloudflare-forwarded requests (header
 *                      heuristic), local requests keep real status codes. 0 never,
 *                      N ms always. See "Cloudflare 524" note on the completions handler.
 *                      A `stream: true` request is an event stream instead, which
 *                      always heartbeats with SSE comments, at least every 10 s.
 *   BRIDGE_MAX_BODY_BYTES    request body ceiling (default 10485760 = 10MB, the CLI stdin cap)
 *   BRIDGE_MAX_PROCESS_OUTPUT_BYTES  ceiling on total child output, stdout+stderr+result
 *                      file (default 10485760 = 10MB; breach kills the child → 502)
 *   BRIDGE_MAX_CONCURRENT    ceiling on live CLI child processes (default 4; excess → 429)
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
 *   "sonnet:xhigh"     → claude -p --model=sonnet --effort=xhigh
 * Advertise the variants you want via BRIDGE_MODELS. Effort values a backend doesn't
 * support are stripped and ignored (Claude accepts low|medium|high|xhigh|max).
 */

import http from "node:http";
import crypto from "node:crypto";
import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { StringDecoder } from "node:string_decoder";
import { loadBridgeEnv } from "./lib/load-bridge-env.mjs";
import { argsFromEnv } from "./lib/parse-argv.mjs";
import { log } from "./lib/log.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

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
// Whitespace heartbeat for in-flight completions. Default "auto": heartbeat ONLY
// for requests that arrive Cloudflare-forwarded (a header heuristic, see
// isTunnelForwarded), so purely local calls keep their real HTTP status codes
// while tunnel traffic keeps its Cloudflare-524 defence. Numeric values keep the
// absolute semantics: 0 never heartbeats, N heartbeats every N ms for EVERY
// request. 20s sits far inside every relevant idle limit (Cloudflare's ~100s
// response-start ceiling, undici's 300s bodyTimeout) without measurable overhead.
const KEEPALIVE_MS = (() => {
  const v = process.env.BRIDGE_KEEPALIVE_MS;
  if (v === undefined || v === "" || v === "auto") return "auto";
  return positiveInteger(v, 20_000, { allowZero: true });
})();
const AUTO_KEEPALIVE_MS = 20_000;
// Request body ceiling, matches the Claude CLI's 10MB stdin cap; a caller (or stolen
// token) can't exhaust memory with an unbounded body.
const MAX_BODY_BYTES = positiveInteger(process.env.BRIDGE_MAX_BODY_BYTES, 10 * 1024 * 1024);

// Embeddings proxy target. The CLI backends cannot embed — Claude Code and Codex
// have no embeddings mode — but a local Ollama can, so the bridge forwards these
// routes rather than pretending to serve them. That lets ONE tunnelled surface
// carry both chat and embeddings, instead of a second tunnel for the second shape.
const OLLAMA_URL = (process.env.BRIDGE_OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/+$/, "");
const EMBED_MODEL = process.env.BRIDGE_EMBED_MODEL || "nomic-embed-text";
// Ceiling on TOTAL child process output — stdout + stderr + the Codex result
// file — counted in raw bytes before decoding. Deliberately named "process
// output": agent chatter and stderr logging count against it, not just the
// model answer. Symmetric with the input cap so a broken (or hostile) backend
// can't grow the bridge's memory without bound; on breach the child is killed
// and the request fails.
const MAX_PROCESS_OUTPUT_BYTES = positiveInteger(process.env.BRIDGE_MAX_PROCESS_OUTPUT_BYTES, 10 * 1024 * 1024);
// Only a bounded tail of stderr is RETAINED for diagnostics (every byte still
// counts against the output cap): stderr exists here to pick an error reason
// out of, and the useful line is invariably near the end.
const STDERR_TAIL_CHARS = 64 * 1024;
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
  // set BRIDGE_MODELS to your real slugs, or leave blank and Codex uses its built-in default
  // (the bridge runs it with --ignore-user-config, so config.toml's model is not read).
  codex: "",
  apple: "system",
  command: "",
  // auto: one bridge serving BOTH, advertises Claude's models by default; add your
  // Codex slugs with BRIDGE_MODELS="opus,sonnet,haiku,gpt-5.5".
  auto: "opus,sonnet,haiku",
};
const ADVERTISED_MODELS = (process.env.BRIDGE_MODELS || DEFAULT_MODELS_BY_BACKEND[BACKEND] || DEFAULT_MODEL)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Model capabilities (context + output) are the bridge's CONFIGURED ASSUMPTIONS,
// never discovered values: neither the Claude Code CLI nor the Codex CLI exposes a
// machine-readable per-model capability endpoint. Known-family defaults live in
// config/model-capability-defaults.json (resolved relative to this module, so the
// npm-installed binary finds it from any cwd); operators override per deployment
// with BRIDGE_MODEL_CAPS="gpt-5.5=1000000:128000,opus=200000:32000". Every
// /v1/models entry is stamped with `caps_source` so a consumer can tell what it
// is getting:
//   "override", operator-set via BRIDGE_MODEL_CAPS for this deployment
//   "default" , a family figure from the config file (a documented API limit,
//               NOT read from any CLI)
//   "unknown" , no family matched — capability figures are OMITTED entirely
//               rather than invented, a prompt-sizing consumer must not treat a
//               made-up floor as meaningful
// Fail-soft: a missing or corrupt config file logs a warning and every model
// simply reports "unknown"; a capability table must never stop completions.
const MODEL_CAPS_DEFAULTS = (() => {
  const file = path.join(here, "..", "config", "model-capability-defaults.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return (parsed.defaults || []).map((e) => [new RegExp(e.match, "i"), e.context_window, e.max_output_tokens]);
  } catch (e) {
    log.warn(`could not load model capability defaults (${file}): ${e.message}; models will report caps_source "unknown"`);
    return [];
  }
})();
// Longest key first: overrides match by substring, so an operator listing both
// "gpt" and "gpt-5.6" must have the specific entry win for gpt-5.6 models.
const MODEL_CAPS_OVERRIDES = (process.env.BRIDGE_MODEL_CAPS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((entry) => {
    const [k, v] = entry.split("=");
    const [c, o] = (v || "").split(":").map((n) => Number(n));
    return { key: (k || "").trim().toLowerCase(), context: c, output: o };
  })
  .filter((x) => x.key)
  .sort((a, b) => b.key.length - a.key.length);

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
  return { caps_source: "unknown" }; // no figures: omitting beats inventing
}
const REQUIRE_KEY = process.env.BRIDGE_API_KEY || "";

// Provider API keys stripped from the spawned CLI's env by default, so each CLI uses
// its OWN login (Claude/Codex subscription) rather than an API key that happens to be
// in the shell/.env, the cause of "Not logged in" loops. Opt out with BRIDGE_KEEP_ENV_KEYS=1.
const STRIP_ENV_KEYS = [
  "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY",
  "GEMINI_API_KEY", "GOOGLE_API_KEY", "GROQ_API_KEY", "NVIDIA_API_KEY",
];
// Removed from EVERY child's environment, for every backend, even with
// BRIDGE_KEEP_ENV_KEYS=1. ANTHROPIC_BASE_URL sends Claude Code (and anything else
// built on Anthropic's SDK) to a different API host. Left behind in a shell profile
// by some other tool, or set for a proxy, it would quietly send every prompt the
// bridge handles (a meeting transcript, say) to that host instead of Anthropic. The
// bridge's contract is "the CLI you are logged into, talking to its own provider",
// so this is never passed on: BRIDGE_KEEP_ENV_KEYS keeps a credential on purpose,
// it is not a way to reroute traffic.
// The same holds for Codex: OPENAI_BASE_URL (and the older OPENAI_API_BASE) points
// OpenAI's clients at another host, and the Codex binary also reads
// CODEX_EXEC_SERVER_URL and CODEX_URL, which point it at another server. None of
// them reaches a child.
const ALWAYS_STRIP_ENV_KEYS = [
  "ANTHROPIC_BASE_URL",
  "OPENAI_BASE_URL", "OPENAI_API_BASE", "CODEX_EXEC_SERVER_URL", "CODEX_URL",
];

/** A child's environment: the bridge's own, less the keys above. */
function childEnvironment() {
  const env = { ...process.env };
  if (process.env.BRIDGE_KEEP_ENV_KEYS !== "1") {
    for (const k of STRIP_ENV_KEYS) delete env[k];
  }
  for (const k of ALWAYS_STRIP_ENV_KEYS) delete env[k];
  return env;
}

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

// ── BRIDGE_CLAUDE_ARGS: an allowlist ──────────────────────────────────────────
// Extra Claude Code arguments may shape a run (model, effort, prompt text, budgets)
// or narrow it, never widen it. The rule is an ALLOWLIST, because a denylist is only
// as good as its knowledge of every flag Claude Code has now or adds later:
//   - every token that starts with "-" must be one of the options below, wherever it
//     stands, even where a value is expected (`--model --resume` is refused, not read
//     as a model called "--resume");
//   - an option takes exactly the values it needs (`--name value` or `--name=value`),
//     and `--permission-mode` only the modes that ask or deny, never one that grants;
//   - nothing else may appear: no bare argument, no "--", no short flag.
// So no extra can give Claude Code tools (--tools, --allowedTools, --mcp-config,
// --add-dir, --settings, --plugin-dir, --dangerously-skip-permissions,
// --permission-mode bypassPermissions, ...), turn the safety options off, or resume
// a session (--resume, --continue, --session-id, ...). A value that breaks the rule
// is refused when the bridge starts, naming the flag.
const CLAUDE_EXTRA_OPTIONS = new Map([
  ["--model", { takes: "value" }],
  ["--fallback-model", { takes: "value" }],
  ["--effort", { takes: "value" }],
  ["--append-system-prompt", { takes: "value" }],
  ["--system-prompt", { takes: "value" }],
  ["--max-turns", { takes: "value" }],
  ["--max-budget-usd", { takes: "value" }],
  ["--permission-mode", { takes: "value", only: new Set(["default", "manual", "dontAsk", "plan"]) }],
  ["--disallowedTools", { takes: "values" }],
  ["--disallowed-tools", { takes: "values" }],
  ["--strict-mcp-config", { takes: "nothing" }],
  ["--disable-slash-commands", { takes: "nothing" }],
  ["--no-chrome", { takes: "nothing" }],
]);

/** Throw, naming `label` and the offending flag, unless `tokens` keep to the allowlist above. */
function checkClaudeExtraArgs(tokens, label) {
  return checkExtraArgs(tokens, label, CLAUDE_EXTRA_OPTIONS, "Claude Code with --safe-mode, no tools and no saved session");
}

/**
 * The allowlist rule shared by BRIDGE_CLAUDE_ARGS and BRIDGE_CODEX_ARGS: every token
 * is an option from `options` (long `--name value` / `--name=value`, or a short
 * option written as its own token), taking exactly the values its spec allows.
 * `only` limits a value to a set; `check(value)` returns a reason to refuse, or "".
 */
function checkExtraArgs(tokens, label, options, runsWith) {
  const refuse = (why) => {
    throw new Error(
      `${label}: ${why}. The bridge always runs ${runsWith}; ` +
        `extra arguments may only use ${[...options.keys()].join(", ")}`,
    );
  };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token.startsWith("-") || token === "-") refuse(`"${token}" is not allowed (a bare argument)`);
    const eq = token.startsWith("--") ? token.indexOf("=") : -1;
    const name = eq > 0 ? token.slice(0, eq) : token;
    const spec = options.get(name);
    if (!spec) refuse(`"${name}" is not allowed`);
    if (spec.takes === "nothing") {
      if (eq > 0) refuse(`"${name}" takes no value`);
      continue;
    }
    const values = [];
    if (eq > 0) values.push(token.slice(eq + 1));
    else {
      // A following token that starts with "-" is an option, checked on its own turn.
      while (i + 1 < tokens.length && !tokens[i + 1].startsWith("-")) {
        values.push(tokens[++i]);
        if (spec.takes === "value") break;
      }
    }
    if (!values.length) refuse(`"${name}" needs a value (write ${name}=<value> for one that starts with "-")`);
    for (const value of values) {
      if (spec.only && !spec.only.has(value)) {
        refuse(`"${name}" may not be "${value}" (only ${[...spec.only].join(", ")})`);
      }
      const why = spec.check ? spec.check(value) : "";
      if (why) refuse(`"${name}" may not be "${value}" (${why})`);
    }
  }
  return tokens;
}

// ── BRIDGE_CODEX_ARGS: an allowlist ───────────────────────────────────────────
// The same rule for Codex. Extra arguments may pick the model, tune its output, or
// turn more features off. They may never turn a feature on (--enable), widen the
// sandbox (--sandbox, -s, --full-auto, --dangerously-*), reach more files
// (--add-dir, --cd), load a profile or a local model server (--profile, --oss), or
// override config with -c, except the three output settings named below, whose
// values are a word or a quoted word: no table, no array, nothing that could carry
// a command, a path or a URL.
const CODEX_SAFE_CONFIG_KEYS = new Set(["model_reasoning_effort", "model_reasoning_summary", "model_verbosity"]);
function checkCodexConfigValue(value) {
  const m = /^([a-z_]+)=("?)([A-Za-z0-9_.-]+)\2$/.exec(value);
  if (!m) return "write key=value with a plain word as the value";
  if (!CODEX_SAFE_CONFIG_KEYS.has(m[1])) return `only ${[...CODEX_SAFE_CONFIG_KEYS].join(", ")} may be set`;
  return "";
}
const CODEX_EXTRA_OPTIONS = new Map([
  ["--model", { takes: "value" }],
  ["-m", { takes: "value" }],
  ["-c", { takes: "value", check: checkCodexConfigValue }],
  ["--config", { takes: "value", check: checkCodexConfigValue }],
  ["--disable", { takes: "value", check: (v) => (/^[a-z0-9_.]+$/.test(v) ? "" : "not a feature name") }],
  ["--color", { takes: "value", only: new Set(["always", "never", "auto"]) }],
]);

/** BRIDGE_CODEX_ARGS_JSON (exact) or BRIDGE_CODEX_ARGS (quoted), checked against the allowlist. */
function codexExtraArgs() {
  const json = process.env.BRIDGE_CODEX_ARGS_JSON;
  const tokens = argsFromEnv({ json, text: process.env.BRIDGE_CODEX_ARGS, label: "BRIDGE_CODEX_ARGS_JSON" });
  return checkExtraArgs(
    tokens,
    json !== undefined && json !== "" ? "BRIDGE_CODEX_ARGS_JSON" : "BRIDGE_CODEX_ARGS",
    CODEX_EXTRA_OPTIONS,
    "Codex ephemeral and read-only, with no user config and its tool features disabled",
  );
}

// ── Codex features: everything off except a short no-tool allowlist ──────────
// Codex has no single "no tools" switch: its shell, apps, plugins, browser and
// computer use, image tools, hooks and the rest are each a feature. So before a run
// the bridge reads `codex features list` (no prompt, nothing sent to a model) and
// passes `--disable <name>` for EVERY feature it lists, enabled or not, except
// those below, which change how a request is sent and give the model nothing it can
// call. "Enabled or not" because the run uses --ignore-user-config, so a feature
// the user's config turned off can come back on at its default. Features the list
// marks "removed" are skipped: they no longer do anything.
// Fail closed: if the list cannot be run or read, Codex is not run at all.
const CODEX_NO_TOOL_FEATURES = new Set([
  "api_key_model_discovery",
  "auth_elicitation",
  "content_item_kinds",
  "enable_request_compression",
  "system_proxy_fallback",
  "unbounded_connection_retries",
]);
const CODEX_FEATURES_TIMEOUT_MS = 15_000;
let codexDisablesCache = null; // a successful read is reused; a failed one is tried again

/** Parse `codex features list` into the names to disable. Throws when it cannot. */
function codexDisablesFrom(listing) {
  const rows = [];
  for (const line of String(listing).split("\n")) {
    if (!line.trim()) continue;
    const m = /^([a-z0-9_.]+)\s+(.+?)\s+(true|false)\s*$/.exec(line.trim());
    if (!m) throw new Error(`unexpected line in the feature list: "${line.trim().slice(0, 80)}"`);
    rows.push({ name: m[1], stage: m[2], enabled: m[3] === "true" });
  }
  if (!rows.length) throw new Error("the feature list was empty");
  return rows.filter((r) => r.stage !== "removed" && !CODEX_NO_TOOL_FEATURES.has(r.name)).map((r) => r.name);
}

function codexDisables() {
  if (codexDisablesCache) return Promise.resolve(codexDisablesCache);
  return new Promise((resolve, reject) => {
    const refuse = (why) => reject(new BridgeError(
      `refusing to run Codex: could not read its feature list to turn its tools off (${why})`,
      { code: "CODEX_REFUSED", safeToExpose: true },
    ));
    execFile("codex", ["features", "list"], {
      env: childEnvironment(), cwd: os.tmpdir(), timeout: CODEX_FEATURES_TIMEOUT_MS, maxBuffer: 1024 * 1024,
    }, (error, stdout) => {
      if (error) return refuse(error.code === "ENOENT" ? "codex was not found" : `codex features list failed`);
      try {
        codexDisablesCache = codexDisablesFrom(stdout);
        resolve(codexDisablesCache);
      } catch (e) {
        refuse(e.message);
      }
    }).stdin?.end();
  });
}

// ── Apple's on-device model ───────────────────────────────────────────────────
// Its context window is small (Apple documents 4096 tokens), so a prompt that
// will not fit is refused up front with the limit named, rather than left to fail
// inside `fm`. BRIDGE_APPLE_CONTEXT_TOKENS changes the limit.
const APPLE_CONTEXT_TOKENS = positiveInteger(process.env.BRIDGE_APPLE_CONTEXT_TOKENS, 4096);

/** BRIDGE_CLAUDE_ARGS_JSON (exact) or BRIDGE_CLAUDE_ARGS (quoted), checked against the allowlist. */
function claudeExtraArgs() {
  const json = process.env.BRIDGE_CLAUDE_ARGS_JSON;
  const tokens = argsFromEnv({ json, text: process.env.BRIDGE_CLAUDE_ARGS, label: "BRIDGE_CLAUDE_ARGS_JSON" });
  return checkClaudeExtraArgs(tokens, json !== undefined && json !== "" ? "BRIDGE_CLAUDE_ARGS_JSON" : "BRIDGE_CLAUDE_ARGS");
}

// ── Backends ──────────────────────────────────────────────────────────────────
// Each backend maps an OpenAI request → { cmd, args, stdin } and parses the CLI's
// stdout back to { text, promptTokens, completionTokens }. Backends are finalised
// below (claude / codex presets); `command` is the universal escape hatch.

const BACKENDS = {
  /**
   * Claude Code CLI in headless print mode, one-shot completion, JSON output.
   * Invocation (authoritative, see also docs/LOCAL_BRIDGE.md):
   *   claude -p --output-format json --safe-mode --no-session-persistence --tools=
   *     [--model=<m>] [--effort=<e>] [--append-system-prompt=<s>]
   * with the prompt piped on stdin (fine up to Claude Code's 10MB stdin cap).
   * --output-format json → { result, is_error, session_id, ... }. Errors go to stderr +
   * a non-zero exit, which the runner surfaces. No token counts are in the JSON, so the
   * bridge estimates them (~4 chars/token).
   */
  claude: {
    build({ model, system, prompt, webSearch }) {
      // Subscription-friendly invocation. Deliberately NO --bare: it isolates the run
      // and stops Claude Code from seeing the ~/.claude credentials that `claude` +
      // `/login` set up ("Not logged in"). The child env also has the provider API
      // keys stripped (see runBackend) so the CLI uses your subscription login, not an
      // ANTHROPIC_API_KEY.
      //
      // Three options on EVERY run, whatever the request or the configuration (a
      // prompt is whatever a caller sent: a meeting transcript, a scraped page):
      //   --safe-mode               no CLAUDE.md, skills, plugins, hooks, MCP servers
      //                             or custom agents from this machine's config;
      //   --tools=                  no built-in tools at all, so nothing in a prompt
      //                             can get Claude Code to run anything here. A web-
      //                             search request gets the read-only web tools only;
      //   --no-session-persistence  the prompt and answer are not saved as a session.
      // `--tools` is variadic: as a separate token it would swallow every following
      // argument that does not start with "-". The one-token `--flag=value` form never
      // does, so it cannot take an argument meant for something else.
      // BRIDGE_CLAUDE_ARGS cannot undo any of this: see checkClaudeExtraArgs.
      const args = [
        "-p", "--output-format", "json",
        "--safe-mode", "--no-session-persistence",
        webSearch ? "--tools=WebSearch,WebFetch" : "--tools=",
      ];
      // The effort suffix drives Claude too: current Claude Code has a first-class
      // `--effort low|medium|high|xhigh|max` (default high) that works in -p mode,
      // so "sonnet:xhigh" → `--model=sonnet --effort=xhigh`. Values outside Claude's
      // vocabulary (none/minimal/ultra are Codex-side) are stripped and ignored so an
      // invalid flag value never reaches the CLI.
      // The model and the system text come from the request, a caller's strings, so
      // each is joined to its flag in ONE token: a value such as "--settings={...}" or
      // "--resume" is then only ever that flag's value, to commander and to anything
      // that reads argv token by token, never an option of its own. (The same rule
      // BRIDGE_CLAUDE_ARGS is held to: see checkClaudeExtraArgs.)
      const { id: modelId, effort } = splitModelEffort(model);
      if (modelId) args.push(`--model=${modelId}`);
      if (effort && CLAUDE_EFFORTS.has(effort)) args.push(`--effort=${effort}`);
      if (system) args.push(`--append-system-prompt=${system}`);
      // Opt-in web search ("web_search": true in the request): only the read-only web
      // tools. One token, so the variadic flag cannot swallow anything after it.
      if (webSearch) args.push("--allowedTools=WebSearch,WebFetch");
      return { cmd: "claude", args: [...args, ...claudeExtraArgs()], stdin: prompt };
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
   *   codex exec --ephemeral --sandbox read-only --skip-git-repo-check --output-last-message <tmp>
   * (--skip-git-repo-check because the child runs from a neutral tmpdir, not a git repo.)
   * The prompt is piped on stdin; Codex writes ONLY its final message to <tmp>, which
   * the runner reads back, so agent chatter on stdout never pollutes the completion.
   * read-only sandbox means it can't modify the filesystem. Codex uses its own
   * ~/.codex/auth.json login (the child env has API keys stripped, see runBackend).
   * `codex exec` has no system-prompt flag, so system text is prepended to the
   * piped prompt (same shape as the command backend) rather than dropped.
   */
  codex: {
    build({ model, system, prompt, webSearch, codexDisable }) {
      // Fail closed: without the feature list (see codexDisables) there is no way
      // to turn Codex's tools off, so there is no run.
      if (!Array.isArray(codexDisable)) {
        throw new BridgeError("refusing to run Codex: its feature list was not read", { code: "CODEX_REFUSED", safeToExpose: true });
      }
      // randomUUID, not Date.now(): two concurrent completions starting in the
      // same millisecond must not share (and cross-read/unlink) one result file.
      const outFile = path.join(os.tmpdir(), `codex-bridge-${process.pid}-${crypto.randomUUID()}.txt`);
      // On EVERY run:
      //   --ephemeral             no session files are saved;
      //   --sandbox read-only     nothing on disk can be changed;
      //   --ignore-user-config    no ~/.codex/config.toml (its MCP servers, profiles,
      //                           providers, base URL); the login still works;
      //   --ignore-rules          no user or project execpolicy rules;
      //   --disable <feature>     for every feature but the no-tool allowlist;
      //   -c web_search="disabled" unless the request opted in to web search, which
      //                           gets the top-level --search flag (before `exec`).
      const args = [
        ...(webSearch ? ["--search"] : []),
        "exec", "--ephemeral", "--sandbox", "read-only", "--ignore-user-config", "--ignore-rules",
        "--skip-git-repo-check", "--output-last-message", outFile,
        ...(webSearch ? [] : ["-c", 'web_search="disabled"']),
        ...codexDisable.flatMap((name) => ["--disable", name]),
      ];
      const { id, effort } = splitModelEffort(model);
      // Joined to its flag in one token, like Claude's: a caller's string is only
      // ever the model's value.
      if (id) args.push(`--model=${id}`);
      // -c parses its value as TOML, the inner double quotes are required.
      if (effort) args.push("-c", `model_reasoning_effort="${effort}"`);
      const extra = codexExtraArgs();
      return {
        cmd: "codex",
        args: [...args, ...extra],
        stdin: system ? `${system}\n\n${prompt}` : prompt,
        resultFile: outFile,
      };
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
   * Apple's on-device model through the `fm` CLI (model `system`):
   *   fm respond --no-stream [-i <system text>]
   * with the prompt on stdin. The arguments are fixed: never --tool, --resume,
   * --save-transcript, --image or --schema, and nothing from configuration. A system
   * text that starts with "-" gets a leading space, so `fm` can only read it as the
   * value of -i, never as an option of its own.
   */
  apple: {
    build({ system, prompt }) {
      const args = ["respond", "--no-stream"];
      if (system) args.push("-i", system.startsWith("-") ? ` ${system}` : system);
      return { cmd: "fm", args, stdin: prompt };
    },
    parse(out) {
      return { text: out.trim() };
    },
  },

  /**
   * Universal escape hatch, and unchecked: the bridge cannot know what the command
   * does, so none of the safety options above apply to it.
   * BRIDGE_COMMAND is a quoted command template (see
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

/**
 * Flatten OpenAI `messages` into { system, prompt } the CLIs can take.
 * `system` and `developer` messages both join into the system text (modern
 * OpenAI clients send developer instructions where older ones sent system).
 * The dominant case — exactly one user turn — passes through byte-identical,
 * no label, so simple clients get exactly the prompt they sent. Multi-turn
 * history renders as a labeled transcript (User: / Assistant: / Tool:): the
 * CLIs are one-shot, so history arrives as readable context, with every turn
 * labeled symmetrically rather than only the assistant's. No trailing
 * completion cue is appended — its effect on the real CLIs is unverified.
 */
const ROLE_LABELS = { user: "User", assistant: "Assistant", tool: "Tool", function: "Tool" };
function foldMessages(messages = []) {
  const isSystem = (m) => m.role === "system" || m.role === "developer";
  const system = messages.filter(isSystem).map((m) => m.content ?? "").join("\n\n");
  const convo = messages.filter((m) => !isSystem(m));
  if (convo.length === 1 && convo[0].role === "user") {
    return { system, prompt: convo[0].content ?? "" };
  }
  const prompt = convo
    .map((m) => `${ROLE_LABELS[m.role] || m.role}: ${m.content ?? ""}`)
    .join("\n\n");
  return { system, prompt };
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
  if (m === "system") return "apple"; // Apple's on-device model, fm's own name for it
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

async function runBackend({ model, system, prompt, webSearch = false }, { signal } = {}) {
  const backendName = resolveBackendName(model);
  const backend = BACKENDS[backendName];
  if (!backend) throw new Error(`Unknown backend "${backendName}" (claude | codex | apple | command | auto)`);
  if (backendName === "apple") {
    const tokens = estimateTokens(`${system || ""}${prompt || ""}`);
    if (tokens > APPLE_CONTEXT_TOKENS) {
      throw new BridgeError(
        `The prompt is about ${tokens} tokens, more than the on-device model's ${APPLE_CONTEXT_TOKENS} tokens. ` +
          "Send a shorter prompt or use another model.",
        { code: "PROMPT_TOO_LONG", safeToExpose: true },
      );
    }
  }
  const codexDisable = backendName === "codex" ? await codexDisables() : undefined;
  const { cmd, args, stdin, resultFile } = backend.build({ model: model || DEFAULT_MODEL, system, prompt, webSearch, codexDisable });
  return spawnBackend({ backend, cmd, args, stdin, resultFile, system, prompt }, { signal });
}

function spawnBackend({ backend, cmd, args, stdin, resultFile, system, prompt }, { signal } = {}) {

  // Force the CLI onto its own login: strip provider API keys from the child env.
  const childEnv = childEnvironment();

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      return reject(new BridgeError("client disconnected before the CLI started", { code: "CLIENT_DISCONNECTED" }));
    }
    // Neutral cwd so the CLI doesn't load the current project's config files.
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], env: childEnv, cwd: os.tmpdir() });
    let out = "";
    let err = "";
    // The promise never settles at the MOMENT of a timeout, client abort, or
    // output breach — the caller's finally-block releases the concurrency slot
    // on settlement, so MAX_CONCURRENT stays a true ceiling on live child
    // processes while a kill is in flight. Settlement happens on child 'close',
    // or (fate paths only) shortly after child 'exit' if 'close' is stranded.
    let fate = null; // null | "timeout" | "aborted" | "output-limit"
    // 'close' (the settlement event) waits for the stdio pipes to DRAIN, and a
    // grandchild that inherited them can hold them open long after the direct
    // child dies — without a guard, a killed child with a pipe-holding
    // descendant would strand this promise, the concurrency slot, and the HTTP
    // response forever. So: once the direct child has EXITED with a fate
    // decided, settlement is forced shortly afterwards if 'close' never
    // arrives. Normal completions still settle on 'close' (full output capture).
    let exited = false;
    let fateSettled = false;
    let lateSettle = null;
    const settleForFate = () => {
      if (fateSettled) return;
      fateSettled = true;
      cleanup();
      if (resultFile) { try { fs.unlinkSync(resultFile); } catch { /* ignore */ } }
      const fateError = {
        "timeout": () => new BridgeError(`CLI timed out after ${TIMEOUT_MS}ms`, { code: "BACKEND_TIMEOUT", safeToExpose: true }),
        "output-limit": () => new BridgeError(
          `CLI produced more than ${MAX_PROCESS_OUTPUT_BYTES} bytes of output`,
          { code: "OUTPUT_LIMIT_EXCEEDED", safeToExpose: true },
        ),
        "aborted": () => new BridgeError("client disconnected before the CLI finished", { code: "CLIENT_DISCONNECTED" }),
      }[fate];
      reject(fateError());
    };
    const armLateSettle = () => {
      if (!fate || !exited || lateSettle) return;
      lateSettle = setTimeout(settleForFate, KILL_GRACE_MS);
      lateSettle.unref();
    };
    const timer = setTimeout(() => {
      if (fate) return; // an already-decided fate must not be relabeled a timeout
      fate = "timeout";
      killChildGracefully(child);
      armLateSettle();
    }, TIMEOUT_MS);
    const onAbort = () => {
      if (fate) return;
      fate = "aborted";
      killChildGracefully(child);
      armLateSettle();
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      if (lateSettle) clearTimeout(lateSettle);
      if (signal) signal.removeEventListener("abort", onAbort);
    };
    child.on("exit", () => {
      exited = true;
      armLateSettle();
    });

    // Raw bytes are counted BEFORE decoding (both pipes share the one ceiling);
    // StringDecoder carries multi-byte UTF-8 sequences across chunk boundaries,
    // plain string concatenation of Buffers corrupts a character split between
    // two chunks.
    const outDecoder = new StringDecoder("utf8");
    const errDecoder = new StringDecoder("utf8");
    let outputBytes = 0;
    const overOutputLimit = (d) => {
      outputBytes += d.length;
      if (fate) return true; // already dying, stop accumulating
      if (outputBytes > MAX_PROCESS_OUTPUT_BYTES) {
        fate = "output-limit";
        killChildGracefully(child);
        armLateSettle(); // data can still arrive from a descendant after the child exited
        return true;
      }
      return false;
    };
    child.stdout.on("data", (d) => {
      if (!overOutputLimit(d)) out += outDecoder.write(d);
    });
    child.stderr.on("data", (d) => {
      if (!overOutputLimit(d)) {
        err += errDecoder.write(d);
        if (err.length > STDERR_TAIL_CHARS) err = err.slice(-STDERR_TAIL_CHARS);
      }
    });
    child.on("error", (e) => {
      cleanup();
      reject(new BridgeError(`Failed to spawn "${cmd}": ${e.message}`, { code: "SPAWN_FAILURE" }));
    });
    child.on("close", (code) => {
      cleanup();
      out += outDecoder.end();
      err += errDecoder.end();
      if (fate) return settleForFate();
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
      // The Codex result file counts against the output cap too: stat-first so
      // an oversized file is rejected without ever loading it into memory.
      if (resultFile) {
        let resultSize = 0;
        try { resultSize = fs.statSync(resultFile).size; } catch { /* missing file: stdout fallback below */ }
        if (resultSize > MAX_PROCESS_OUTPUT_BYTES) {
          try { fs.unlinkSync(resultFile); } catch { /* ignore */ }
          return reject(new BridgeError(
            `CLI result file exceeded ${MAX_PROCESS_OUTPUT_BYTES} bytes`,
            { code: "OUTPUT_LIMIT_EXCEEDED", safeToExpose: true },
          ));
        }
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

// ── Event streams (`stream: true`) ──────────────────────────────────────────────
// The CLIs answer in one piece, so a stream is: 200 + text/event-stream at once, SSE
// comment heartbeats while the CLI runs, then the whole answer as OpenAI chunks: the
// role, the text as ONE content delta, a stop chunk, a usage chunk when the caller
// asked for one (stream_options.include_usage), and `data: [DONE]`. A failure after
// the headers went out is one `data: {"error":{...}}` event, then the stream ends,
// with no [DONE]. Heartbeats are SSE comments (":" lines, which every SSE parser
// skips), never the bare newline of the JSON keepalive: in an event stream that is
// an empty event.
const SSE_HEADERS = { "Content-Type": "text/event-stream", "Cache-Control": "no-store" };
const SSE_COMMENT = ": keepalive\n\n";
// The longest gap between stream heartbeats. Clients keep an event stream open on
// bytes arriving: Node's fetch gives up after 300 s of silence, Cloudflare's edge
// after about 100 s, and some clients far sooner.
const SSE_HEARTBEAT_MAX_MS = 10_000;
/** A stream's heartbeat interval: BRIDGE_KEEPALIVE_MS when that is shorter, otherwise SSE_HEARTBEAT_MAX_MS. Never off. */
function sseHeartbeatMs(keepaliveMs) {
  return keepaliveMs > 0 ? Math.min(keepaliveMs, SSE_HEARTBEAT_MAX_MS) : SSE_HEARTBEAT_MAX_MS;
}

/** The `data:` payloads of a finished completion, in order, ending with [DONE]. */
function streamFrames({ model, text, usage }) {
  const base = {
    id: `chatcmpl-bridge-${process.hrtime.bigint().toString(36)}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: model || DEFAULT_MODEL || BACKEND,
  };
  // With include_usage, OpenAI puts `usage: null` on every chunk but the last.
  const chunk = (choices) => JSON.stringify({ ...base, choices, ...(usage ? { usage: null } : {}) });
  const frames = [
    chunk([{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }]),
    chunk([{ index: 0, delta: { content: text }, finish_reason: null }]),
    chunk([{ index: 0, delta: {}, finish_reason: "stop" }]),
  ];
  if (usage) frames.push(JSON.stringify({ ...base, choices: [], usage }));
  frames.push("[DONE]");
  return frames;
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
/**
 * Heuristic: the request CLAIMS to have come through Cloudflare's edge (cf-ray /
 * cf-connecting-ip are always stamped by the edge). Any local caller can forge
 * the headers, so this is NOT authenticated tunnel detection — it steers
 * response framing (the keepalive heartbeat) and narrows browser conveniences,
 * never authentication. Forging it merely turns the heartbeat on for that
 * request, costing the forger their own real status code and nothing else.
 */
function isTunnelForwarded(req) {
  return Boolean(req.headers["cf-ray"] || req.headers["cf-connecting-ip"]);
}
function isDirectLoopback(req) {
  const ra = req.socket?.remoteAddress || "";
  const loopback = ra === "127.0.0.1" || ra === "::1" || ra === "::ffff:127.0.0.1";
  return loopback && !isTunnelForwarded(req);
}
/** Per-request heartbeat interval: "auto" heartbeats only tunnel-forwarded traffic. */
function keepaliveMsFor(req) {
  if (KEEPALIVE_MS === "auto") return isTunnelForwarded(req) ? AUTO_KEEPALIVE_MS : 0;
  return KEEPALIVE_MS;
}
let warnedKeepaliveOffOnTunnel = false;
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
// silently ignoring them, a caller that sets `tools` would otherwise get an answer
// that never called them. An explicit `null` is treated as absent throughout:
// several OpenAI SDKs serialize unset optionals as null. (`stream` is supported:
// see streamFrames.)
const UNSUPPORTED_FIELDS = ["tools", "tool_choice", "response_format", "functions"];
function unsupportedFeature(body) {
  if (body.n != null && body.n !== 1) return "n > 1";
  for (const f of UNSUPPORTED_FIELDS) if (body[f] != null) return f;
  return null;
}

// The roles the bridge knows how to fold into a CLI prompt. Anything else is
// rejected rather than silently rendered into prompt text.
const ALLOWED_ROLES = new Set(["system", "developer", "user", "assistant", "tool", "function"]);

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
      // context_window / max_output_tokens report the bridge's CONFIGURED
      // ASSUMPTIONS (caps_source tells a consumer which kind); unknown models
      // carry no figures at all.
      data: ids.map((id) => ({ id, object: "model", owned_by: BACKEND, ...modelCaps(id) })),
    });
  }

  if (req.method === "POST" && (url === "/v1/chat/completions" || url === "/chat/completions")) {
    if (!authOk(req)) return send(res, 401, { error: { message: "Unauthorized" } });
    const chunks = [];
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
      chunks.push(d);
    });
    req.on("end", async () => {
      if (bodyTooLarge) return;
      let body;
      try {
        // Concatenate as raw bytes BEFORE decoding: a chunk boundary can split a
        // multi-byte UTF-8 character, and per-chunk string coercion would corrupt it.
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch {
        return send(res, 400, { error: { message: "Invalid JSON body" } });
      }
      // A body of literal null / a string / an array parses fine but every
      // property access below would throw (an unhandled rejection, since this
      // is an async event handler) — reject non-objects up front.
      if (body === null || typeof body !== "object" || Array.isArray(body)) {
        return send(res, 400, { error: { message: "JSON body must be an object" } });
      }
      // Validate shape + reject unimplemented OpenAI features BEFORE committing a 200.
      if (body.messages !== undefined && !Array.isArray(body.messages)) {
        return send(res, 400, { error: { message: "messages must be an array" } });
      }
      if ((body.messages ?? []).some((m) => m == null || (m.content != null && typeof m.content !== "string"))) {
        return send(res, 400, { error: { message: "message content must be a string (content blocks are not supported)" } });
      }
      if ((body.messages ?? []).some((m) => !ALLOWED_ROLES.has(m.role))) {
        return send(res, 400, { error: { message: `message role must be one of: ${[...ALLOWED_ROLES].join(", ")}` } });
      }
      // A model id never starts with "-". One that does, or one that is not a string,
      // is refused before any backend sees it: the codex and command backends pass the
      // model as its own argv element, where it could read as an option.
      if (body.model != null && (typeof body.model !== "string" || body.model.startsWith("-"))) {
        return send(res, 400, { error: { message: 'model must be a string that does not start with "-"' } });
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
      //
      // That cost is only worth paying for traffic that actually crosses
      // Cloudflare, so the default ("auto") heartbeats per request: requests
      // carrying Cloudflare edge headers get the defence, direct/local requests
      // keep their real status codes (a 504 timeout stays a 504).
      //
      // An event stream (`stream: true`) always commits at once and heartbeats in
      // its own framing, SSE comments, at least every SSE_HEARTBEAT_MAX_MS: the
      // whitespace heartbeat never touches it (see streamFrames).
      const keepaliveMs = keepaliveMsFor(req);
      const stream = Boolean(body.stream);
      if (!stream && KEEPALIVE_MS === 0 && isTunnelForwarded(req) && !warnedKeepaliveOffOnTunnel) {
        warnedKeepaliveOffOnTunnel = true;
        log.warn("tunnel-forwarded request with the keepalive disabled: responses slower than ~100s will die with a Cloudflare 524 (set BRIDGE_KEEPALIVE_MS=auto)");
      }
      let beat = null;
      if (stream) {
        res.writeHead(200, SSE_HEADERS);
        res.write(SSE_COMMENT);
        beat = setInterval(() => { if (!res.writableEnded && !res.destroyed) res.write(SSE_COMMENT); }, sseHeartbeatMs(keepaliveMs));
      } else if (keepaliveMs > 0) {
        res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.write("\n");
        beat = setInterval(() => { if (!res.writableEnded && !res.destroyed) res.write("\n"); }, keepaliveMs);
      }
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
        if (keepaliveMs > 0) return res.end(JSON.stringify(obj)); // headers already sent
        return send(res, status, obj);
      };
      // A stream ends with its data events (see streamFrames), then the response ends.
      const finishStream = (frames) => {
        settled = true;
        if (beat) clearInterval(beat);
        if (res.writableEnded || res.destroyed) return;
        res.end(frames.map((frame) => `data: ${frame}\n\n`).join(""));
      };

      try {
        const webSearch = body.web_search === true;
        const { text, promptTokens, completionTokens } = await runBackend(
          { model: body.model, system, prompt, webSearch },
          { signal: ac.signal },
        );
        log.info(
          `${resolveBackendName(body.model)} ${body.model || DEFAULT_MODEL || ""}${webSearch ? " +web" : ""}${stream ? " stream" : ""} → ${text.length} chars in ${Date.now() - t0}ms`,
        );
        const response = openAiResponse({
          model: body.model,
          text,
          promptTokens: promptTokens ?? estimateTokens(system + prompt),
          completionTokens: completionTokens ?? estimateTokens(text),
        });
        if (stream) {
          // The same estimate as a buffered completion, when the caller asks for it.
          const usage = body.stream_options?.include_usage ? response.usage : null;
          return finishStream(streamFrames({ model: body.model, text, usage }));
        }
        return finish(200, response);
      } catch (e) {
        if (e.code === "CLIENT_DISCONNECTED") {
          // The socket is gone, there is nobody to answer; just record it.
          log.info(`client disconnected after ${Date.now() - t0}ms, ${resolveBackendName(body.model)} child terminated`);
          return;
        }
        // Full detail always lands in the SERVER log with a correlation id; whether the
        // CLIENT sees the raw message is governed by BRIDGE_EXPOSE_ERROR_DETAILS (raw
        // messages can reveal executable names, paths, and login state, redacted by
        // default) — except BridgeErrors marked safeToExpose, which reveal nothing
        // about the host and stay actionable for remote callers.
        const errorId = crypto.randomUUID();
        log.error(`error ${errorId}: ${e.stack || e.message}`);
        const message = EXPOSE_ERROR_DETAILS || e.safeToExpose ? e.message : "The local model backend failed";
        // A timed-out backend is a gateway timeout; every other backend failure
        // (spawn, non-zero exit, parse) is a bad gateway. With the keepalive
        // heartbeat active the status is already spent and this arrives in-body;
        // in a stream it is the one data event before the stream ends.
        // A prompt too long for the model is the caller's to fix (400, with OpenAI's
        // own code for it); a backend the bridge refuses to run is unavailable (503).
        const status = { BACKEND_TIMEOUT: 504, PROMPT_TOO_LONG: 400, CODEX_REFUSED: 503 }[e.code] ?? 502;
        const error = { error: { message, type: "bridge_backend_error", id: errorId } };
        if (e.code === "PROMPT_TOO_LONG") error.error.code = "context_length_exceeded";
        if (stream) return finishStream([JSON.stringify(error)]);
        return finish(status, error);
      } finally {
        // Settlement-scoped release: runBackend settles only after its child
        // closed, so this can never let a new spawn overlap a dying child.
        activeCompletions -= 1;
      }
    });
    return;
  }

  // ── Embeddings proxy (→ local Ollama) ──────────────────────────────────────
  // `/api/embeddings` and `/api/pull` speak Ollama's native shape, which is what a
  // client sends when its OLLAMA_BASE_URL points here (authenticating with
  // OLLAMA_API_KEY set to this bridge's BRIDGE_API_KEY). `/v1/embeddings` speaks the
  // OpenAI shape for anything else. Both are proxies: the bridge adds auth, a
  // timeout and a named error, and otherwise gets out of the way.
  if (req.method === "POST" && (url === "/api/embeddings" || url === "/api/pull")) {
    if (!authOk(req)) return send(res, 401, { error: { message: "Unauthorized" } });
    return readJsonBody(req, res, async (body) => {
      // A pull downloads a model and can take minutes; an embed is sub-second.
      const timeoutMs = url === "/api/pull" ? TIMEOUT_MS : 60_000;
      const upstream = await ollamaFetch(url, body, timeoutMs);
      if (!upstream.ok && upstream.unreachable) {
        return send(res, 502, { error: { message: upstream.message, type: "bridge_ollama_unreachable" } });
      }
      return send(res, upstream.status, upstream.body);
    });
  }

  if (req.method === "POST" && (url === "/v1/embeddings" || url === "/embeddings")) {
    if (!authOk(req)) return send(res, 401, { error: { message: "Unauthorized" } });
    return readJsonBody(req, res, async (body) => {
      const model = body.model || EMBED_MODEL;
      const inputs = Array.isArray(body.input) ? body.input : [body.input ?? ""];
      const data = [];
      for (let i = 0; i < inputs.length; i++) {
        const upstream = await ollamaFetch("/api/embeddings", { model, prompt: String(inputs[i]) }, 60_000);
        if (!upstream.ok) {
          const message = upstream.unreachable
            ? upstream.message
            : `Ollama ${upstream.status}: ${JSON.stringify(upstream.body).slice(0, 200)}`;
          return send(res, 502, { error: { message, type: "bridge_ollama_error" } });
        }
        data.push({ object: "embedding", index: i, embedding: upstream.body?.embedding ?? [] });
      }
      // Token counts are reported as 0 rather than estimated: Ollama does not return
      // them, and a fabricated number is worse than an obviously absent one.
      return send(res, 200, { object: "list", model, data, usage: { prompt_tokens: 0, total_tokens: 0 } });
    });
  }

  send(res, 404, { error: { message: `No route for ${req.method} ${url}` } });
}

/** Build (but do not bind) the bridge's HTTP server. */
function createBridgeServer() {
  return http.createServer(handleRequest);
}

// Pure pieces exported for unit tests; importing this module never starts a
// server or registers signal handlers (see the is-main guard below).
export { foldMessages, modelCaps, BACKENDS, splitModelEffort, codexDisablesFrom, checkExtraArgs, CODEX_EXTRA_OPTIONS, unsupportedFeature, createBridgeServer, BridgeError, sseHeartbeatMs };

// realpath matters: npm installs bin entries as SYMLINKS (node_modules/.bin/…),
// so argv[1] is the link while import.meta.url is the resolved file — without
// resolving, the installed binary would import as a library and exit silently.
const IS_MAIN = (() => {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
  } catch {
    return false; // argv[1] not a resolvable path → we were imported, not executed
  }
})();

// Configuration that would undo the safety options is refused at start, not on the
// first request: only for backends that can run Claude Code, since the others never
// read BRIDGE_CLAUDE_ARGS. exitCode rather than exit(): nothing has started, so the
// process ends by itself once the message is flushed.
const STARTUP_REFUSAL = (() => {
  if (!IS_MAIN) return null;
  try {
    if (BACKEND === "claude" || BACKEND === "auto") claudeExtraArgs();
    if (BACKEND === "codex" || BACKEND === "auto") codexExtraArgs();
    return null;
  } catch (e) {
    return e.message;
  }
})();
if (STARTUP_REFUSAL) {
  log.error(`refusing to start: ${STARTUP_REFUSAL}`);
  process.exitCode = 1;
}

if (IS_MAIN && !STARTUP_REFUSAL) {
  const server = createBridgeServer();

  // Friendly startup failures: EADDRINUSE is the most common first run collision
  // (something else, often another bridge, already owns the port).
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      log.error(`port ${PORT} on ${HOST} is already in use (another bridge or service?).`);
      log.error(`pick another port:  PORT=8790 npx local-cli-bridge`);
      process.exit(1);
    }
    if (err.code === "EACCES") {
      log.error(`no permission to bind ${HOST}:${PORT}. Ports below 1024 need elevated rights.`);
      process.exit(1);
    }
    throw err;
  });

server.listen(PORT, HOST, () => {
    log.info(`local-cli-bridge listening on http://${HOST}:${PORT}`);
    log.info(`backend=${BACKEND}  default-model=${DEFAULT_MODEL || "(request-supplied)"}  max-concurrent=${MAX_CONCURRENT}`);
    log.info(`OpenAI-compatible base URL: http://${HOST}:${PORT}/v1`);
  log.info(`embeddings proxy → ${OLLAMA_URL} (default embed model ${EMBED_MODEL})`);
  log.info(
    `for embeddings, point OLLAMA_BASE_URL at http://${HOST}:${PORT}` +
      (REQUIRE_KEY ? " and set OLLAMA_API_KEY to the bridge key" : ""),
  );
  });

  // Graceful shutdown: stop accepting connections, let in-flight completions drain
  // (their CLI children are killed by the runner's own timeout at worst).
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      log.info(`${sig}, shutting down`);
      server.close(() => process.exit(0));
      // Hard exit if a long completion holds the server open past a grace period.
      setTimeout(() => process.exit(0), 5_000).unref();
    });
  }
}

/**
 * Collect a JSON request body, then run the async handler.
 *
 * Malformed JSON → 400, an oversized body → 413 before it is buffered, a thrown
 * handler → 502. Same contract and the same MAX_BODY_BYTES ceiling as the chat
 * route, so an embeddings caller cannot bypass a limit the chat caller respects.
 */
function readJsonBody(req, res, handler) {
  let raw = "";
  let bytes = 0;
  let aborted = false;
  req.on("data", (d) => {
    if (aborted) return;
    bytes += d.length;
    if (bytes > MAX_BODY_BYTES) {
      aborted = true;
      send(res, 413, { error: { message: `Request body exceeds ${MAX_BODY_BYTES} bytes` } });
      req.destroy();
      return;
    }
    raw += d;
  });
  req.on("end", async () => {
    if (aborted) return;
    let body;
    try {
      body = JSON.parse(raw || "{}");
    } catch {
      return send(res, 400, { error: { message: "Invalid JSON body" } });
    }
    try {
      await handler(body);
    } catch (e) {
      log.error(`embeddings error: ${e.message}`);
      if (!res.writableEnded) {
        send(res, 502, { error: { message: e.message, type: "bridge_embeddings_error" } });
      }
    }
  });
}

/**
 * POST to the local Ollama.
 *
 * Returns `{ ok, status, body }` for any HTTP response, and
 * `{ ok: false, unreachable: true, message }` when Ollama cannot be reached at all —
 * so the 502 that reaches the caller NAMES the target URL rather than failing mutely.
 * "Is Ollama even running?" is the first question every time, and the error answers it.
 */
async function ollamaFetch(pathname, body, timeoutMs) {
  const target = `${OLLAMA_URL}${pathname}`;
  try {
    const r = await fetch(target, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await r.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text.slice(0, 500) };
    }
    return { ok: r.ok, status: r.status, body: parsed };
  } catch (e) {
    return {
      ok: false,
      unreachable: true,
      message: `Ollama unreachable at ${target} (${e.message}) — is Ollama running? Set BRIDGE_OLLAMA_URL if it listens elsewhere.`,
    };
  }
}
