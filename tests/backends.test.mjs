// Unit tests for the pure pieces: message folding, backend build()/parse(),
// and model-id effort suffixes. Imported directly — the is-main guard keeps
// the module from starting a server or registering signal handlers.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

process.env.BRIDGE_ENV_FILE = "/dev/null"; // isolate from any local .env files
const { BACKENDS, foldMessages, splitModelEffort, codexDisablesFrom, checkExtraArgs, CODEX_EXTRA_OPTIONS } = await import("../scripts/local-cli-bridge.mjs");

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
  assert.deepEqual(args, [
    "-p", "--output-format", "json", "--safe-mode", "--no-session-persistence", "--tools=",
    "--model=sonnet", "--effort=xhigh", "--append-system-prompt=SYS",
  ]);
  assert.equal(stdin, "hello");
});

test("claude build: effort values outside Claude's vocabulary are stripped", () => {
  const { args } = BACKENDS.claude.build({ model: "sonnet:ultra", system: "", prompt: "p" });
  assert.ok(!args.some((a) => a.startsWith("--effort")));
  assert.ok(args.includes("--model=sonnet"));
});

// A request's model and system text are a caller's strings. Joined to their flag
// in one token, a value that looks like an option ("--settings={...}", "--resume")
// is only ever that flag's value, to commander and to anything that reads argv
// token by token. So the option names in argv never depend on a request.
test("claude build: a request's model and system text never stand as their own argv element", () => {
  const fixed = ["-p", "--output-format", "json", "--safe-mode", "--no-session-persistence", "--tools="];
  const settings = '--settings={"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:1"}}';
  for (const [model, system, expected] of [
    ['--settings={"env":{"X":"1"}}', "", ['--model=--settings={"env":{"X":"1"}}']],
    ["--setting-sources=user,project,local", "", ["--model=--setting-sources=user,project,local"]],
    ["--resume:high", "", ["--model=--resume", "--effort=high"]],
    ["-r", "", ["--model=-r"]],
    ["sonnet", "--mcp-config", ["--model=sonnet", "--append-system-prompt=--mcp-config"]],
    ["sonnet", settings, ["--model=sonnet", `--append-system-prompt=${settings}`]],
    ["sonnet", "- be brief\n--resume", ["--model=sonnet", "--append-system-prompt=- be brief\n--resume"]],
  ]) {
    const { args } = BACKENDS.claude.build({ model, system, prompt: "p" });
    assert.deepEqual(args, [...fixed, ...expected], JSON.stringify({ model, system }));
  }
});

test("claude build: quoted BRIDGE_CLAUDE_ARGS survive as single argv entries", () => {
  process.env.BRIDGE_CLAUDE_ARGS = '--permission-mode dontAsk --append-system-prompt "be very brief"';
  const { args } = BACKENDS.claude.build({ model: "sonnet", system: "", prompt: "p" });
  assert.deepEqual(args.slice(-4), ["--permission-mode", "dontAsk", "--append-system-prompt", "be very brief"]);
});

test("claude build: BRIDGE_CLAUDE_ARGS_JSON wins over BRIDGE_CLAUDE_ARGS", () => {
  process.env.BRIDGE_CLAUDE_ARGS = "--ignored entirely";
  process.env.BRIDGE_CLAUDE_ARGS_JSON = '["--fallback-model","a b"]';
  const { args } = BACKENDS.claude.build({ model: "sonnet", system: "", prompt: "p" });
  assert.deepEqual(args.slice(-2), ["--fallback-model", "a b"]);
});

// ── claude backend: the safety options on every run ─────────────────────────

test("claude build: every run has --safe-mode, --no-session-persistence and an empty tools list", () => {
  for (const request of [
    { model: "sonnet", system: "", prompt: "p" },
    { model: "", system: "SYS", prompt: "p" },
    { model: "opus:max", system: "SYS", prompt: "p" },
  ]) {
    const { args } = BACKENDS.claude.build(request);
    assert.equal(args.filter((a) => a === "--safe-mode").length, 1, "--safe-mode exactly once");
    assert.equal(args.filter((a) => a === "--no-session-persistence").length, 1, "--no-session-persistence exactly once");
    assert.deepEqual(args.filter((a) => a.startsWith("--tools")), ["--tools="], "one empty tools list");
    assert.ok(!args.some((a) => /allowed-?tools/i.test(a)), "no allowed tools on a normal request");
  }
});

test("claude build: a web-search request gets WebSearch and WebFetch as its only tools", () => {
  const { args } = BACKENDS.claude.build({ model: "sonnet", system: "SYS", prompt: "p", webSearch: true });
  assert.ok(args.includes("--safe-mode"));
  assert.ok(args.includes("--no-session-persistence"));
  assert.deepEqual(args.filter((a) => a.startsWith("--tools")), ["--tools=WebSearch,WebFetch"]);
  assert.deepEqual(args.filter((a) => /allowed-?tools/i.test(a)), ["--allowedTools=WebSearch,WebFetch"]);
});

test("claude build: the variadic tool flags are single tokens, so they cannot swallow a later argument", () => {
  // `--tools <tools...>` and `--allowedTools <tools...>` are variadic in Claude
  // Code's parser: a separate-token form consumes every following argument that
  // does not start with "-". The `--flag=value` form never does.
  process.env.BRIDGE_CLAUDE_ARGS = "--model sonnet";
  for (const webSearch of [false, true]) {
    const { args } = BACKENDS.claude.build({ model: "opus", system: "SYS", prompt: "p", webSearch });
    for (const bare of ["--tools", "--allowedTools", "--allowed-tools"]) {
      assert.ok(!args.includes(bare), `${bare} must not be a separate token`);
    }
  }
});

test("claude build: the prompt goes on stdin, never into argv", () => {
  const { args, stdin } = BACKENDS.claude.build({ model: "sonnet", system: "", prompt: "a spoken sentence" });
  assert.equal(stdin, "a spoken sentence");
  assert.ok(!args.includes("a spoken sentence"));
});

// ── BRIDGE_CLAUDE_ARGS cannot undo the safety options ──────────────────────

test("BRIDGE_CLAUDE_ARGS that would give Claude Code tools, undo the options or resume a session are refused, naming the flag", () => {
  const refused = [
    ["--tools", "Bash"], ["--tools=Bash"], ["--tools=default"], ["--tools", ""],
    ["--allowedTools", "Bash"], ["--allowedTools=Bash"], ["--allowed-tools", "Bash"], ["--allowed-tools=Bash"],
    ["--dangerously-skip-permissions"], ["--allow-dangerously-skip-permissions"],
    ["--permission-mode", "bypassPermissions"], ["--permission-mode=bypassPermissions"],
    ["--permission-mode", "acceptEdits"], ["--permission-mode", "auto"],
    ["--mcp-config", "/tmp/mcp.json"], ["--mcp-config={}"], ["--add-dir", "/"], ["--add-dir=/"],
    ["--settings", "{}"], ["--plugin-dir", "/tmp/p"], ["--agents", "{}"],
    ["--resume", "abc"], ["-r", "abc"], ["--continue"], ["-c"], ["--session-id", "0b0c0d0e-0000-4000-8000-000000000000"],
    ["--fork-session"], ["--from-pr", "1"], ["--teleport"],
    ["--session-persistence"], ["--no-safe-mode"], ["--debug"], ["--debug-file", "/tmp/d"],
    ["-pc"], ["--"], ["a-bare-argument"],
  ];
  for (const extra of refused) {
    process.env.BRIDGE_CLAUDE_ARGS_JSON = JSON.stringify(extra);
    assert.throws(
      () => BACKENDS.claude.build({ model: "sonnet", system: "", prompt: "p" }),
      (e) => e.message.includes("BRIDGE_CLAUDE_ARGS_JSON") && e.message.includes(`"${extra[0].split("=")[0]}"`),
      `extra args ${JSON.stringify(extra)} must be refused, naming the flag`,
    );
  }
});

test("BRIDGE_CLAUDE_ARGS: a refused flag hidden after allowed ones, or in a value's place, is still refused", () => {
  for (const extra of [
    ["--max-turns", "1", "--dangerously-skip-permissions"],
    ["--model", "--dangerously-skip-permissions"],
    ["--disallowedTools", "Bash", "--tools=Bash"],
  ]) {
    process.env.BRIDGE_CLAUDE_ARGS_JSON = JSON.stringify(extra);
    assert.throws(() => BACKENDS.claude.build({ model: "sonnet", system: "", prompt: "p" }), /BRIDGE_CLAUDE_ARGS_JSON/);
  }
});

test("BRIDGE_CLAUDE_ARGS (the quoted form) is checked the same way, naming that variable", () => {
  process.env.BRIDGE_CLAUDE_ARGS = "--permission-mode dontAsk --dangerously-skip-permissions";
  assert.throws(
    () => BACKENDS.claude.build({ model: "sonnet", system: "", prompt: "p" }),
    (e) => /BRIDGE_CLAUDE_ARGS\b/.test(e.message) && !e.message.includes("_JSON") && e.message.includes("--dangerously-skip-permissions"),
  );
});

test("BRIDGE_CLAUDE_ARGS: options that only shape or narrow the run are accepted", () => {
  for (const extra of [
    ["--permission-mode", "dontAsk", "--max-turns", "1"],
    ["--permission-mode=plan"], ["--permission-mode", "default"], ["--permission-mode", "manual"],
    ["--model", "opus"], ["--fallback-model", "sonnet"], ["--effort", "low"],
    ["--append-system-prompt", "be very brief"], ["--system-prompt=You write minutes."],
    ["--max-budget-usd", "1"],
    ["--disallowedTools", "Bash", "Edit"], ["--disallowed-tools=Bash"],
    ["--strict-mcp-config", "--disable-slash-commands", "--no-chrome"],
  ]) {
    process.env.BRIDGE_CLAUDE_ARGS_JSON = JSON.stringify(extra);
    const { args } = BACKENDS.claude.build({ model: "sonnet", system: "", prompt: "p" });
    assert.deepEqual(args.slice(-extra.length), extra, `extra args ${JSON.stringify(extra)} must pass through`);
  }
});

test("BRIDGE_CLAUDE_ARGS: an option missing its value is refused", () => {
  for (const extra of [["--model"], ["--permission-mode"], ["--disallowedTools"]]) {
    process.env.BRIDGE_CLAUDE_ARGS_JSON = JSON.stringify(extra);
    assert.throws(() => BACKENDS.claude.build({ model: "sonnet", system: "", prompt: "p" }), /value/);
  }
});

test("claude parse: result text, is_error, and non-string results", () => {
  assert.deepEqual(BACKENDS.claude.parse('{"result":"hi","is_error":false}'), { text: "hi" });
  assert.throws(() => BACKENDS.claude.parse('{"result":"Not logged in","is_error":true}'), /Not logged in/);
  assert.deepEqual(BACKENDS.claude.parse('{"result":{"a":1}}'), { text: '{"a":1}' });
});

// ── codex backend ───────────────────────────────────────────────────────────

test("codex build: system text is prepended to the piped prompt, not dropped", () => {
  const { cmd, args, stdin, resultFile } = BACKENDS.codex.build({ model: "gpt-5.5", system: "SYS", prompt: "hello", codexDisable: [] });
  assert.equal(cmd, "codex");
  assert.equal(stdin, "SYS\n\nhello");
  assert.ok(resultFile, "codex writes its answer to a result file");
  assert.deepEqual(args.slice(0, 7), ["exec", "--ephemeral", "--sandbox", "read-only", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check"]);
  assert.ok(args.includes("--output-last-message"));
  assert.deepEqual(args.slice(-1), ["--model=gpt-5.5"]);
});

test("codex build: concurrent builds get distinct result files", () => {
  const a = BACKENDS.codex.build({ model: "gpt-5.5", system: "", prompt: "p", codexDisable: [] });
  const b = BACKENDS.codex.build({ model: "gpt-5.5", system: "", prompt: "p", codexDisable: [] });
  assert.notEqual(a.resultFile, b.resultFile, "same-millisecond completions must not share a result file");
});

test("codex build: no system means the prompt is piped unchanged", () => {
  const { stdin } = BACKENDS.codex.build({ model: "gpt-5.5", system: "", prompt: "bare", codexDisable: [] });
  assert.equal(stdin, "bare");
});

test("codex build: effort suffix becomes a TOML -c override with inner quotes", () => {
  const { args } = BACKENDS.codex.build({ model: "gpt-5.6-sol:high", system: "", prompt: "p", codexDisable: [] });
  const i = args.lastIndexOf("-c");
  assert.ok(i > 0);
  assert.equal(args[i + 1], 'model_reasoning_effort="high"');
  assert.ok(args.includes("--model=gpt-5.6-sol"));
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

// ── opt-in web search ───────────────────────────────────────────────────────

test("web search is off unless the request asks for it", () => {
  assert.ok(!BACKENDS.claude.build({ model: "sonnet", system: "", prompt: "p" }).args.some((a) => a.includes("allowedTools")));
  assert.ok(!BACKENDS.codex.build({ model: "gpt-5.5", system: "", prompt: "p", codexDisable: [] }).args.includes("--search"));
});

test("claude build: webSearch allows only the read-only web tools, as one argv entry", () => {
  const { args } = BACKENDS.claude.build({ model: "sonnet", system: "SYS", prompt: "p", webSearch: true });
  assert.ok(args.includes("--allowedTools=WebSearch,WebFetch"));
  assert.equal(args.filter((a) => a.includes("allowedTools")).length, 1);
});

test("codex build: webSearch puts the top-level --search flag before exec", () => {
  const { args } = BACKENDS.codex.build({ model: "gpt-5.5", system: "", prompt: "p", codexDisable: [], webSearch: true });
  assert.deepEqual(args.slice(0, 2), ["--search", "exec"]);
});

// ── codex: the feature list and the fail-closed rule ─────────────────────────

test("codex build: refuses to build a run without the feature list", () => {
  assert.throws(() => BACKENDS.codex.build({ model: "gpt-5.5", system: "", prompt: "p" }), /refusing to run Codex/);
});

test("codex build: every listed feature becomes a --disable pair", () => {
  const { args } = BACKENDS.codex.build({ model: "gpt-5.5", system: "", prompt: "p", codexDisable: ["shell_tool", "apps"] });
  const i = args.indexOf("--disable");
  assert.deepEqual(args.slice(i, i + 4), ["--disable", "shell_tool", "--disable", "apps"]);
});

test("codexDisablesFrom: disables every feature but the allowlisted ones, enabled, off or removed", () => {
  const listing = [
    "shell_tool                               stable             true",
    "chronicle                                under development  false",
    "collaboration_modes                      removed            true",
    "guardianv2.thread_context                under development  true",
    "enable_request_compression               stable             true",
  ].join("\n");
  assert.deepEqual(codexDisablesFrom(listing), ["shell_tool", "chronicle", "collaboration_modes", "guardianv2.thread_context"]);
});

test("codexDisablesFrom: an empty or unexpected listing throws rather than disabling nothing", () => {
  assert.throws(() => codexDisablesFrom(""), /empty/);
  assert.throws(() => codexDisablesFrom("Usage: codex features list"), /unexpected line/);
});

test("checkExtraArgs: -c accepts only the output settings, as plain words", () => {
  const ok = (t) => checkExtraArgs(t, "X", CODEX_EXTRA_OPTIONS, "codex");
  assert.doesNotThrow(() => ok(["-c", 'model_reasoning_effort="high"', "--model=gpt-5.5", "-m", "o3"]));
  assert.throws(() => ok(["-c", "model_verbosity=[1]"]), /plain word/);
  assert.throws(() => ok(["-c", 'mcp_servers.x.command="sh"']), /plain word|only/);
  assert.throws(() => ok(["-c", "model_provider=oss"]), /only model_reasoning_effort/);
});
