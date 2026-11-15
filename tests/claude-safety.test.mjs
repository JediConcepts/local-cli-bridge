// What the bridge actually runs Claude Code with, seen from the other side:
// a recording stub stands in for `claude` (and `codex`) first on the bridge's
// PATH, so these tests check the real argv and environment a child gets
// without ever running a real CLI.
//
//   - every run has --safe-mode, --no-session-persistence and an explicit,
//     single-token tools list (empty, or WebSearch,WebFetch for web search);
//   - BRIDGE_CLAUDE_ARGS / BRIDGE_CLAUDE_ARGS_JSON that would undo that are
//     refused at start, naming the flag;
//   - ANTHROPIC_BASE_URL never reaches a child, for any backend, even with
//     BRIDGE_KEEP_ENV_KEYS=1.
import { test } from "node:test";
import assert from "node:assert/strict";
import { startBridge, startBridgeExpectingExit, makeStubBin, STUB_CLI } from "./helpers.mjs";

const KEY = "test-key-123";
const AUTH = { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` };

function complete(base, body) {
  return fetch(`${base}/v1/chat/completions`, { method: "POST", headers: AUTH, body: JSON.stringify(body) });
}

const MESSAGES = [{ role: "system", content: "Write minutes." }, { role: "user", content: "the transcript" }];

test("a claude run gets --safe-mode, --no-session-persistence and no tools, with the prompt on stdin", async () => {
  const stub = makeStubBin();
  const bridge = await startBridge({ BRIDGE_BACKEND: "claude", BRIDGE_API_KEY: KEY, ...stub.env, STUB_TEXT: "the minutes" });
  try {
    const res = await complete(bridge.base, { model: "sonnet", messages: MESSAGES });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).choices[0].message.content, "the minutes");
    const [run] = stub.records("claude");
    assert.ok(run, "the stub claude ran");
    assert.ok(run.argv.includes("--safe-mode"));
    assert.ok(run.argv.includes("--no-session-persistence"));
    assert.deepEqual(run.argv.filter((a) => a.startsWith("--tools")), ["--tools="]);
    assert.ok(!run.argv.some((a) => /allowed-?tools/i.test(a)));
    assert.equal(run.stdin, "the transcript");
    assert.ok(!run.argv.includes("the transcript"), "the prompt never goes into argv");
  } finally {
    bridge.stop();
  }
});

test("a web-search request runs claude with WebSearch and WebFetch only, and still the safety options", async () => {
  const stub = makeStubBin();
  const bridge = await startBridge({ BRIDGE_BACKEND: "claude", BRIDGE_API_KEY: KEY, ...stub.env });
  try {
    const res = await complete(bridge.base, { model: "sonnet", web_search: true, messages: MESSAGES });
    assert.equal(res.status, 200);
    const [run] = stub.records("claude");
    assert.ok(run.argv.includes("--safe-mode"));
    assert.ok(run.argv.includes("--no-session-persistence"));
    assert.deepEqual(run.argv.filter((a) => a.startsWith("--tools")), ["--tools=WebSearch,WebFetch"]);
    assert.deepEqual(run.argv.filter((a) => /allowed-?tools/i.test(a)), ["--allowedTools=WebSearch,WebFetch"]);
  } finally {
    bridge.stop();
  }
});

test("allowed BRIDGE_CLAUDE_ARGS still start the bridge and reach claude after the safety options", async () => {
  const stub = makeStubBin();
  const bridge = await startBridge({
    BRIDGE_BACKEND: "claude", BRIDGE_API_KEY: KEY, ...stub.env,
    BRIDGE_CLAUDE_ARGS: "--permission-mode dontAsk --max-turns 1",
  });
  try {
    const res = await complete(bridge.base, { model: "sonnet", messages: MESSAGES });
    assert.equal(res.status, 200);
    const [run] = stub.records("claude");
    assert.deepEqual(run.argv.slice(-4), ["--permission-mode", "dontAsk", "--max-turns", "1"]);
    assert.ok(run.argv.includes("--safe-mode") && run.argv.includes("--tools="));
  } finally {
    bridge.stop();
  }
});

for (const [variable, value, flag] of [
  ["BRIDGE_CLAUDE_ARGS", "--dangerously-skip-permissions", "--dangerously-skip-permissions"],
  ["BRIDGE_CLAUDE_ARGS", "--permission-mode dontAsk --tools Bash", "--tools"],
  ["BRIDGE_CLAUDE_ARGS", "--permission-mode bypassPermissions", "--permission-mode"],
  ["BRIDGE_CLAUDE_ARGS", "--resume 0b0c0d0e-0000-4000-8000-000000000000", "--resume"],
  ["BRIDGE_CLAUDE_ARGS_JSON", '["--mcp-config","/tmp/servers.json"]', "--mcp-config"],
  ["BRIDGE_CLAUDE_ARGS_JSON", '["--add-dir","/"]', "--add-dir"],
]) {
  test(`${variable}=${value} is refused at start, naming ${flag}`, async () => {
    const stub = makeStubBin();
    const { code, stdout, stderr } = await startBridgeExpectingExit({
      BRIDGE_BACKEND: "claude", BRIDGE_API_KEY: KEY, ...stub.env, [variable]: value,
    });
    assert.notEqual(code, 0, "the bridge must exit with a failure");
    assert.ok(!stdout.includes("listening"), "the bridge must not listen");
    assert.ok(stderr.includes(variable), `the message names the variable: ${stderr}`);
    assert.ok(stderr.includes(`"${flag}"`), `the message names the flag: ${stderr}`);
    assert.deepEqual(stub.records("claude"), [], "claude never ran");
  });
}

test("an auto bridge, which can run claude, refuses unsafe BRIDGE_CLAUDE_ARGS at start too", async () => {
  const stub = makeStubBin();
  const { code, stderr } = await startBridgeExpectingExit({
    BRIDGE_BACKEND: "auto", BRIDGE_API_KEY: KEY, ...stub.env, BRIDGE_CLAUDE_ARGS: "--continue",
  });
  assert.notEqual(code, 0);
  assert.ok(stderr.includes('"--continue"'), stderr);
});

// ── ANTHROPIC_BASE_URL ──────────────────────────────────────────────────────

const STRAY = { ANTHROPIC_BASE_URL: "http://127.0.0.1:9/not-anthropic", ANTHROPIC_API_KEY: "sk-test-dummy" };

test("ANTHROPIC_BASE_URL never reaches claude (and the API key is stripped by default)", async () => {
  const stub = makeStubBin();
  const bridge = await startBridge({ BRIDGE_BACKEND: "claude", BRIDGE_API_KEY: KEY, ...stub.env, ...STRAY });
  try {
    assert.equal((await complete(bridge.base, { model: "sonnet", messages: MESSAGES })).status, 200);
    const [run] = stub.records("claude");
    assert.ok(!run.envKeys.includes("ANTHROPIC_BASE_URL"));
    assert.ok(!run.envKeys.includes("ANTHROPIC_API_KEY"));
    assert.ok(run.envKeys.includes("STUB_RECORD_DIR"), "the rest of the environment is passed through");
  } finally {
    bridge.stop();
  }
});

test("ANTHROPIC_BASE_URL is removed even with BRIDGE_KEEP_ENV_KEYS=1, which still keeps the API key", async () => {
  const stub = makeStubBin();
  const bridge = await startBridge({
    BRIDGE_BACKEND: "claude", BRIDGE_API_KEY: KEY, ...stub.env, ...STRAY, BRIDGE_KEEP_ENV_KEYS: "1",
  });
  try {
    assert.equal((await complete(bridge.base, { model: "sonnet", messages: MESSAGES })).status, 200);
    const [run] = stub.records("claude");
    assert.ok(!run.envKeys.includes("ANTHROPIC_BASE_URL"), "ANTHROPIC_BASE_URL must never be kept");
    assert.ok(run.envKeys.includes("ANTHROPIC_API_KEY"), "BRIDGE_KEEP_ENV_KEYS=1 still keeps the keys");
  } finally {
    bridge.stop();
  }
});

test("ANTHROPIC_BASE_URL is removed for the codex and command backends too", async () => {
  const stub = makeStubBin();
  for (const env of [
    { BRIDGE_BACKEND: "codex" },
    { BRIDGE_BACKEND: "command", BRIDGE_COMMAND_JSON: JSON.stringify([process.execPath, STUB_CLI, "command"]) },
  ]) {
    stub.clear();
    const bridge = await startBridge({ BRIDGE_API_KEY: KEY, ...stub.env, ...STRAY, BRIDGE_KEEP_ENV_KEYS: "1", ...env });
    try {
      const res = await complete(bridge.base, { model: "gpt-5.5", messages: MESSAGES });
      assert.equal(res.status, 200, `${env.BRIDGE_BACKEND}: ${res.status}`);
      const name = env.BRIDGE_BACKEND;
      const [run] = stub.records(name);
      assert.ok(run, `the ${name} stub ran`);
      assert.ok(!run.envKeys.includes("ANTHROPIC_BASE_URL"), `${name} child must not get ANTHROPIC_BASE_URL`);
    } finally {
      bridge.stop();
    }
  }
});
