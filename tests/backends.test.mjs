// Unit tests for the pure pieces: message folding, backend build()/parse(),
// and model-id effort suffixes. Imported directly — the is-main guard keeps
// the module from starting a server or registering signal handlers.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.BRIDGE_ENV_FILE = "/dev/null"; // isolate from any local .env files
const { BACKENDS, foldMessages, splitModelEffort } = await import("../scripts/local-cli-bridge.mjs");

const ARG_VARS = [
  "BRIDGE_CLAUDE_ARGS", "BRIDGE_CLAUDE_ARGS_JSON",
  "BRIDGE_CODEX_ARGS", "BRIDGE_CODEX_ARGS_JSON",
  "BRIDGE_COMMAND", "BRIDGE_COMMAND_JSON",
];
afterEach(() => {
  for (const v of ARG_VARS) delete process.env[v];
});

// ── foldMessages ────────────────────────────────────────────────────────────

test("a single user turn passes through byte-identical, no label", () => {
  const { system, prompt } = foldMessages([
    { role: "system", content: "SYS" },
    { role: "user", content: "exactly this" },
  ]);
  assert.equal(system, "SYS");
  assert.equal(prompt, "exactly this");
});

test("developer messages fold into the system text alongside system messages", () => {
  const { system, prompt } = foldMessages([
    { role: "system", content: "A" },
    { role: "developer", content: "B" },
    { role: "user", content: "hi" },
  ]);
  assert.equal(system, "A\n\nB");
  assert.equal(prompt, "hi");
});

test("multi-turn history renders as a symmetric labeled transcript", () => {
  const { prompt } = foldMessages([
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi there" },
    { role: "tool", content: "42" },
    { role: "function", content: "43" },
    { role: "user", content: "continue" },
  ]);
  assert.equal(prompt, "User: hello\n\nAssistant: hi there\n\nTool: 42\n\nTool: 43\n\nUser: continue");
});

test("no trailing completion cue is appended", () => {
  const { prompt } = foldMessages([
    { role: "user", content: "a" },
    { role: "assistant", content: "b" },
    { role: "user", content: "c" },
  ]);
  assert.ok(!prompt.endsWith("Assistant:"), "trailing Assistant: cue must not be appended");
});

test("null content never stringifies into the prompt as the word null", () => {
  const single = foldMessages([{ role: "user", content: null }]);
  assert.equal(single.prompt, "");
  const multi = foldMessages([
    { role: "user", content: null },
    { role: "assistant", content: null },
  ]);
  assert.ok(!multi.prompt.includes("null"));
  const sys = foldMessages([{ role: "system", content: null }, { role: "user", content: "x" }]);
  assert.equal(sys.system, "");
});

// ── splitModelEffort ────────────────────────────────────────────────────────

test("model-id effort suffixes split only on known effort values", () => {
  assert.deepEqual(splitModelEffort("sonnet:xhigh"), { id: "sonnet", effort: "xhigh" });
  assert.deepEqual(splitModelEffort("gpt-5.6-sol:high"), { id: "gpt-5.6-sol", effort: "high" });
  assert.deepEqual(splitModelEffort("sonnet"), { id: "sonnet", effort: null });
  assert.deepEqual(splitModelEffort("weird:suffix"), { id: "weird:suffix", effort: null });
});

// ── claude backend ──────────────────────────────────────────────────────────

test("claude build: model, effort, and system flags land in argv, prompt on stdin", () => {
  const { cmd, args, stdin } = BACKENDS.claude.build({ model: "sonnet:xhigh", system: "SYS", prompt: "hello" });
  assert.equal(cmd, "claude");
  assert.deepEqual(args, ["-p", "--output-format", "json", "--model", "sonnet", "--effort", "xhigh", "--append-system-prompt", "SYS"]);
  assert.equal(stdin, "hello");
});

test("claude build: effort values outside Claude's vocabulary are stripped", () => {
  const { args } = BACKENDS.claude.build({ model: "sonnet:ultra", system: "", prompt: "p" });
  assert.ok(!args.includes("--effort"));
  assert.ok(args.includes("sonnet"));
});

test("claude build: quoted BRIDGE_CLAUDE_ARGS survive as single argv entries", () => {
  process.env.BRIDGE_CLAUDE_ARGS = '--permission-mode dontAsk --add-dir "/tmp/with space"';
  const { args } = BACKENDS.claude.build({ model: "sonnet", system: "", prompt: "p" });
  assert.deepEqual(args.slice(-4), ["--permission-mode", "dontAsk", "--add-dir", "/tmp/with space"]);
});

test("claude build: BRIDGE_CLAUDE_ARGS_JSON wins over BRIDGE_CLAUDE_ARGS", () => {
  process.env.BRIDGE_CLAUDE_ARGS = "--ignored entirely";
  process.env.BRIDGE_CLAUDE_ARGS_JSON = '["--exact","a b"]';
  const { args } = BACKENDS.claude.build({ model: "sonnet", system: "", prompt: "p" });
  assert.deepEqual(args.slice(-2), ["--exact", "a b"]);
});

test("claude parse: result text, is_error, and non-string results", () => {
  assert.deepEqual(BACKENDS.claude.parse('{"result":"hi","is_error":false}'), { text: "hi" });
  assert.throws(() => BACKENDS.claude.parse('{"result":"Not logged in","is_error":true}'), /Not logged in/);
  assert.deepEqual(BACKENDS.claude.parse('{"result":{"a":1}}'), { text: '{"a":1}' });
});

// ── codex backend ───────────────────────────────────────────────────────────

test("codex build: system text is prepended to the piped prompt, not dropped", () => {
  const { cmd, args, stdin, resultFile } = BACKENDS.codex.build({ model: "gpt-5.5", system: "SYS", prompt: "hello" });
  assert.equal(cmd, "codex");
  assert.equal(stdin, "SYS\n\nhello");
  assert.ok(resultFile, "codex writes its answer to a result file");
  assert.deepEqual(args.slice(0, 5), ["exec", "--ephemeral", "--sandbox", "read-only", "--skip-git-repo-check"]);
  assert.ok(args.includes("--output-last-message"));
  assert.deepEqual(args.slice(-2), ["--model", "gpt-5.5"]);
});

test("codex build: no system means the prompt is piped unchanged", () => {
  const { stdin } = BACKENDS.codex.build({ model: "gpt-5.5", system: "", prompt: "bare" });
  assert.equal(stdin, "bare");
});

test("codex build: effort suffix becomes a TOML -c override with inner quotes", () => {
  const { args } = BACKENDS.codex.build({ model: "gpt-5.6-sol:high", system: "", prompt: "p" });
  const i = args.indexOf("-c");
  assert.ok(i > 0);
  assert.equal(args[i + 1], 'model_reasoning_effort="high"');
  assert.ok(args.includes("gpt-5.6-sol"));
});

test("codex parse: clean result-file content is returned as-is", () => {
  assert.deepEqual(BACKENDS.codex.parse("The answer.\n"), { text: "The answer." });
});

test("codex parse: transcript fallback extracts the final message before the tokens footer", () => {
  const transcript = "[2026-07-30] OpenAI Codex v0.x\nworkdir: /tmp\ncodex\nThe answer is 42.\ntokens used\n1234\n";
  assert.deepEqual(BACKENDS.codex.parse(transcript), { text: "The answer is 42." });
});

// ── command backend ─────────────────────────────────────────────────────────

test("command build: quoted template with repeated {model} tokens", () => {
  process.env.BRIDGE_COMMAND = 'mycli --model {model} --tag "{model} run"';
  const { cmd, args, stdin } = BACKENDS.command.build({ model: "m1", system: "SYS", prompt: "hello" });
  assert.equal(cmd, "mycli");
  assert.deepEqual(args, ["--model", "m1", "--tag", "m1 run"]);
  assert.equal(stdin, "SYS\n\nhello");
});

test("command build: BRIDGE_COMMAND_JSON wins and is used verbatim", () => {
  process.env.BRIDGE_COMMAND = "ignored";
  process.env.BRIDGE_COMMAND_JSON = '["exact-cli","a b","{model}"]';
  const { cmd, args } = BACKENDS.command.build({ model: "m1", system: "", prompt: "p" });
  assert.equal(cmd, "exact-cli");
  assert.deepEqual(args, ["a b", "m1"]);
});

test("command build: fails loudly when neither template variable is set", () => {
  assert.throws(() => BACKENDS.command.build({ model: "m", system: "", prompt: "p" }), /BRIDGE_COMMAND/);
});
