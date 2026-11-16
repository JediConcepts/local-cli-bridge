// What the bridge runs Codex and Apple's on-device model with, seen from the
// other side: recording stubs stand in for `codex` (including its
// `features list`) and `fm` first on the bridge's PATH, so these tests check
// the real argv and environment a child gets without running a real CLI.
//
//   - every Codex run is ephemeral, read-only, ignores the user's config and
//     rules, has web search off unless asked for, and has --disable for every
//     feature that is not on the bridge's short no-tool allowlist;
//   - the feature list is read with no prompt, and if it cannot be read the
//     bridge refuses to run Codex and says why;
//   - BRIDGE_CODEX_ARGS / BRIDGE_CODEX_ARGS_JSON are an allowlist, checked at start;
//   - variables that point Codex at another host never reach a child;
//   - model `system` runs `fm respond --no-stream` with fixed arguments, and a
//     prompt too long for it is refused, naming the limit;
//   - streaming works for both.
import { test } from "node:test";
import assert from "node:assert/strict";
import { startBridge, startBridgeExpectingExit, makeStubBin } from "./helpers.mjs";

const KEY = "test-key-123";
const AUTH = { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` };
const MESSAGES = [{ role: "system", content: "Write minutes." }, { role: "user", content: "the transcript" }];

function complete(base, body) {
  return fetch(`${base}/v1/chat/completions`, { method: "POST", headers: AUTH, body: JSON.stringify(body) });
}

/** The values of every `--disable <feature>` pair in argv. */
function disabled(argv) {
  const out = [];
  argv.forEach((a, i) => { if (a === "--disable") out.push(argv[i + 1]); });
  return out.sort();
}

// The stub's default feature table (tests/fixtures/stub-cli.mjs) holds seven
// tool features that are on, one that is off, one removed, and two on the
// bridge's allowlist.
const EXPECTED_DISABLED = [
  "apps", "chronicle", "computer_use", "hooks", "image_generation", "plugins", "shell_tool", "unified_exec",
].sort();

// ── Codex: no tools, nothing saved, no user settings ───────────────────────────

test("a codex run is ephemeral, read-only, ignores user config and rules, and disables every tool feature", async () => {
  const stub = makeStubBin();
  const bridge = await startBridge({ BRIDGE_BACKEND: "codex", BRIDGE_API_KEY: KEY, ...stub.env, STUB_TEXT: "the minutes" });
  try {
    const res = await complete(bridge.base, { model: "gpt-5.5", messages: MESSAGES });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).choices[0].message.content, "the minutes");
    const [run] = stub.records("codex");
    assert.ok(run, "the stub codex ran");
    const a = run.argv;
    assert.equal(a[0], "exec", "no top-level flag before exec without web search");
    for (const flag of ["--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check"]) {
      assert.ok(a.includes(flag), `${flag} is passed`);
    }
    assert.equal(a[a.indexOf("--sandbox") + 1], "read-only");
    assert.deepEqual(a.filter((x) => x.startsWith("--sandbox")), ["--sandbox"]);
    assert.equal(a[a.indexOf("-c") + 1], 'web_search="disabled"', "web search is off unless asked for");
    assert.deepEqual(disabled(a), EXPECTED_DISABLED);
    assert.ok(a.includes("--model=gpt-5.5"), "the model is joined to its flag");
    assert.ok(!a.includes("--search"));
    assert.equal(run.stdin, "Write minutes.\n\nthe transcript");
    assert.ok(!a.includes("the transcript"), "the prompt never goes into argv");
    const [features] = stub.records("codexfeatures");
    assert.ok(features, "the feature list was read");
    assert.deepEqual(features.argv, ["features", "list"]);
  } finally {
    bridge.stop();
  }
});

test("the feature list is read once and reused for later runs", async () => {
  const stub = makeStubBin();
  const bridge = await startBridge({ BRIDGE_BACKEND: "codex", BRIDGE_API_KEY: KEY, ...stub.env });
  try {
    for (let i = 0; i < 2; i++) assert.equal((await complete(bridge.base, { model: "gpt-5.5", messages: MESSAGES })).status, 200);
    assert.equal(stub.records("codex").length, 2);
    assert.equal(stub.records("codexfeatures").length, 1);
    for (const run of stub.records("codex")) assert.deepEqual(disabled(run.argv), EXPECTED_DISABLED);
  } finally {
    bridge.stop();
  }
});

test("a web-search codex run gets --search before exec and still every safety option", async () => {
  const stub = makeStubBin();
  const bridge = await startBridge({ BRIDGE_BACKEND: "codex", BRIDGE_API_KEY: KEY, ...stub.env });
  try {
    const res = await complete(bridge.base, { model: "gpt-5.5", web_search: true, messages: MESSAGES });
    assert.equal(res.status, 200);
    const [run] = stub.records("codex");
    assert.deepEqual(run.argv.slice(0, 2), ["--search", "exec"]);
    assert.ok(!run.argv.some((x) => x.startsWith("web_search=")), "web search is not also turned off");
    for (const flag of ["--ephemeral", "--ignore-user-config", "--ignore-rules"]) assert.ok(run.argv.includes(flag));
    assert.deepEqual(disabled(run.argv), EXPECTED_DISABLED);
  } finally {
    bridge.stop();
  }
});

for (const [label, env] of [
  ["the feature list fails", { STUB_FEATURES_MODE: "fail" }],
  ["the feature list is empty", { STUB_FEATURES: "" }],
  ["the feature list cannot be parsed", { STUB_FEATURES: "Features:\nsomething unexpected here" }],
]) {
  test(`codex is refused, saying why, when ${label}`, async () => {
    const stub = makeStubBin();
    const bridge = await startBridge({ BRIDGE_BACKEND: "codex", BRIDGE_API_KEY: KEY, ...stub.env, ...env });
    try {
      const res = await complete(bridge.base, { model: "gpt-5.5", messages: MESSAGES });
      assert.equal(res.status, 503);
      const { error } = await res.json();
      assert.match(error.message, /refusing to run Codex/);
      assert.match(error.message, /feature list/);
      assert.equal(stub.records("codex").length, 0, "codex never ran with a prompt");
    } finally {
      bridge.stop();
    }
  });
}

test("a failed feature list is tried again on the next request, not cached", async () => {
  const stub = makeStubBin();
  const bridge = await startBridge({ BRIDGE_BACKEND: "codex", BRIDGE_API_KEY: KEY, ...stub.env, STUB_FEATURES_MODE: "fail" });
  try {
    assert.equal((await complete(bridge.base, { model: "gpt-5.5", messages: MESSAGES })).status, 503);
    assert.equal((await complete(bridge.base, { model: "gpt-5.5", messages: MESSAGES })).status, 503);
    assert.equal(stub.records("codexfeatures").length, 2);
  } finally {
    bridge.stop();
  }
});

// ── BRIDGE_CODEX_ARGS: an allowlist ────────────────────────────────────────────

test("allowed BRIDGE_CODEX_ARGS start the bridge and reach codex after the safety options", async () => {
  const stub = makeStubBin();
  const bridge = await startBridge({
    BRIDGE_BACKEND: "codex", BRIDGE_API_KEY: KEY, ...stub.env,
    BRIDGE_CODEX_ARGS: "--disable fast_mode -c model_verbosity=low --color never",
  });
  try {
    assert.equal((await complete(bridge.base, { model: "gpt-5.5", messages: MESSAGES })).status, 200);
    const [run] = stub.records("codex");
    assert.deepEqual(run.argv.slice(-6), ["--disable", "fast_mode", "-c", "model_verbosity=low", "--color", "never"]);
    assert.ok(run.argv.includes("--ignore-user-config") && run.argv.includes("--ephemeral"));
  } finally {
    bridge.stop();
  }
});

for (const [variable, value, flag] of [
  ["BRIDGE_CODEX_ARGS", "--enable shell_tool", "--enable"],
  ["BRIDGE_CODEX_ARGS", "--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-approvals-and-sandbox"],
  ["BRIDGE_CODEX_ARGS", "--add-dir /", "--add-dir"],
  ["BRIDGE_CODEX_ARGS", "--sandbox danger-full-access", "--sandbox"],
  ["BRIDGE_CODEX_ARGS", "--profile work", "--profile"],
  ["BRIDGE_CODEX_ARGS", "--oss", "--oss"],
  ["BRIDGE_CODEX_ARGS", "-s danger-full-access", "-s"],
  ["BRIDGE_CODEX_ARGS", "--full-auto", "--full-auto"],
  ["BRIDGE_CODEX_ARGS", '-c sandbox_mode="danger-full-access"', "-c"],
  ["BRIDGE_CODEX_ARGS", "-c openai_base_url=https://example.invalid", "-c"],
  ["BRIDGE_CODEX_ARGS", "--config=features.shell_tool=true", "--config"],
  ["BRIDGE_CODEX_ARGS", "resume --last", "resume"],
  ["BRIDGE_CODEX_ARGS_JSON", JSON.stringify(["--color", "never", "--enable=apps"]), "--enable"],
]) {
  test(`${variable}=${value} is refused at start, naming ${flag}`, async () => {
    const stub = makeStubBin();
    const { code, stderr } = await startBridgeExpectingExit({
      BRIDGE_BACKEND: "codex", BRIDGE_API_KEY: KEY, ...stub.env, [variable]: value,
    });
    assert.equal(code, 1);
    assert.match(stderr, /refusing to start/);
    assert.ok(stderr.includes(variable), `names ${variable}`);
    assert.ok(stderr.includes(flag), `names ${flag}`);
  });
}

test("a bad BRIDGE_CODEX_ARGS is refused at start in auto mode too", async () => {
  const { code, stderr } = await startBridgeExpectingExit({ BRIDGE_BACKEND: "auto", BRIDGE_CODEX_ARGS: "--enable apps" });
  assert.equal(code, 1);
  assert.match(stderr, /BRIDGE_CODEX_ARGS/);
});

// ── Codex's endpoint ───────────────────────────────────────────────────────────

const REDIRECTS = ["OPENAI_BASE_URL", "OPENAI_API_BASE", "CODEX_EXEC_SERVER_URL", "CODEX_URL"];

test("variables that would point Codex at another host never reach it, even with BRIDGE_KEEP_ENV_KEYS=1", async () => {
  const stub = makeStubBin();
  const planted = Object.fromEntries(REDIRECTS.map((k) => [k, "http://127.0.0.1:9/elsewhere"]));
  const bridge = await startBridge({
    BRIDGE_BACKEND: "codex", BRIDGE_API_KEY: KEY, ...stub.env, ...planted, BRIDGE_KEEP_ENV_KEYS: "1",
  });
  try {
    assert.equal((await complete(bridge.base, { model: "gpt-5.5", messages: MESSAGES })).status, 200);
    for (const record of [...stub.records("codex"), ...stub.records("codexfeatures")]) {
      for (const k of REDIRECTS) assert.ok(!record.envKeys.includes(k), `${k} removed from ${record.name}`);
    }
  } finally {
    bridge.stop();
  }
});

// ── Apple's on-device model, model `system` ────────────────────────────────────

for (const [label, env] of [
  ["auto mode", { BRIDGE_BACKEND: "auto" }],
  ["BRIDGE_BACKEND=apple", { BRIDGE_BACKEND: "apple" }],
]) {
  test(`model system runs fm respond with fixed arguments in ${label}, with no BRIDGE_COMMAND`, async () => {
    const stub = makeStubBin();
    const bridge = await startBridge({ ...env, BRIDGE_API_KEY: KEY, ...stub.env, STUB_TEXT: "on-device answer" });
    try {
      const res = await complete(bridge.base, { model: "system", messages: MESSAGES });
      assert.equal(res.status, 200);
      assert.equal((await res.json()).choices[0].message.content, "on-device answer");
      const [run] = stub.records("fm");
      assert.ok(run, "the stub fm ran");
      assert.deepEqual(run.argv, ["respond", "--no-stream", "-i", "Write minutes."]);
      assert.equal(run.stdin, "the transcript");
      assert.equal(stub.records("claude").length + stub.records("codex").length, 0);
    } finally {
      bridge.stop();
    }
  });
}

test("model system without system text gets no -i at all", async () => {
  const stub = makeStubBin();
  const bridge = await startBridge({ BRIDGE_BACKEND: "auto", BRIDGE_API_KEY: KEY, ...stub.env });
  try {
    const res = await complete(bridge.base, { model: "system", messages: [{ role: "user", content: "hi" }] });
    assert.equal(res.status, 200);
    assert.deepEqual(stub.records("fm")[0].argv, ["respond", "--no-stream"]);
  } finally {
    bridge.stop();
  }
});

test("system text that looks like an fm option is never read as one", async () => {
  const stub = makeStubBin();
  const bridge = await startBridge({ BRIDGE_BACKEND: "auto", BRIDGE_API_KEY: KEY, ...stub.env });
  try {
    const messages = [{ role: "system", content: "--tool ocr" }, { role: "user", content: "hi" }];
    assert.equal((await complete(bridge.base, { model: "system", messages })).status, 200);
    const { argv } = stub.records("fm")[0];
    assert.equal(argv.length, 4);
    assert.ok(!argv.slice(3).some((x) => x.startsWith("-")), "the -i value does not start with -");
    assert.ok(!argv.some((x) => /^--?(tool|resume|save-transcript|image|stream)\b/.test(x)));
  } finally {
    bridge.stop();
  }
});

test("a web-search request to model system still gets no tool", async () => {
  const stub = makeStubBin();
  const bridge = await startBridge({ BRIDGE_BACKEND: "auto", BRIDGE_API_KEY: KEY, ...stub.env });
  try {
    assert.equal((await complete(bridge.base, { model: "system", web_search: true, messages: MESSAGES })).status, 200);
    assert.deepEqual(stub.records("fm")[0].argv, ["respond", "--no-stream", "-i", "Write minutes."]);
  } finally {
    bridge.stop();
  }
});

test("a prompt too long for the on-device model is refused with the limit named, and fm never runs", async () => {
  const stub = makeStubBin();
  const bridge = await startBridge({ BRIDGE_BACKEND: "auto", BRIDGE_API_KEY: KEY, ...stub.env, BRIDGE_APPLE_CONTEXT_TOKENS: "100" });
  try {
    const res = await complete(bridge.base, { model: "system", messages: [{ role: "user", content: "x".repeat(2000) }] });
    assert.equal(res.status, 400);
    const { error } = await res.json();
    assert.match(error.message, /100 tokens/);
    assert.equal(error.code, "context_length_exceeded");
    assert.equal(stub.records("fm").length, 0);
  } finally {
    bridge.stop();
  }
});

test("the default on-device limit is 4096 tokens", async () => {
  const stub = makeStubBin();
  const bridge = await startBridge({ BRIDGE_BACKEND: "auto", BRIDGE_API_KEY: KEY, ...stub.env });
  try {
    const res = await complete(bridge.base, { model: "system", messages: [{ role: "user", content: "x".repeat(40_000) }] });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error.message, /4096 tokens/);
  } finally {
    bridge.stop();
  }
});

test("redirect variables never reach fm either", async () => {
  const stub = makeStubBin();
  const planted = Object.fromEntries([...REDIRECTS, "ANTHROPIC_BASE_URL"].map((k) => [k, "http://127.0.0.1:9/x"]));
  const bridge = await startBridge({ BRIDGE_BACKEND: "auto", BRIDGE_API_KEY: KEY, ...stub.env, ...planted });
  try {
    assert.equal((await complete(bridge.base, { model: "system", messages: MESSAGES })).status, 200);
    const [run] = stub.records("fm");
    for (const k of [...REDIRECTS, "ANTHROPIC_BASE_URL"]) assert.ok(!run.envKeys.includes(k), `${k} removed`);
  } finally {
    bridge.stop();
  }
});

// ── Streaming covers both ──────────────────────────────────────────────────────

for (const [backend, model] of [["codex", "gpt-5.5"], ["auto", "system"]]) {
  test(`a streamed ${model} completion arrives as an event stream ending in [DONE]`, async () => {
    const stub = makeStubBin();
    const bridge = await startBridge({ BRIDGE_BACKEND: backend, BRIDGE_API_KEY: KEY, ...stub.env, STUB_TEXT: "streamed words" });
    try {
      const res = await complete(bridge.base, { model, stream: true, messages: MESSAGES });
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type"), /text\/event-stream/);
      const body = await res.text();
      const frames = body.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6));
      assert.equal(frames.at(-1), "[DONE]");
      const content = frames.slice(0, -1).map((f) => JSON.parse(f).choices[0].delta.content ?? "").join("");
      assert.equal(content, "streamed words");
    } finally {
      bridge.stop();
    }
  });
}

test("a streamed codex request whose feature list fails ends with an error frame", async () => {
  const stub = makeStubBin();
  const bridge = await startBridge({ BRIDGE_BACKEND: "codex", BRIDGE_API_KEY: KEY, ...stub.env, STUB_FEATURES_MODE: "fail" });
  try {
    const res = await complete(bridge.base, { model: "gpt-5.5", stream: true, messages: MESSAGES });
    const body = await res.text();
    assert.match(body, /refusing to run Codex/);
    assert.equal(stub.records("codex").length, 0);
  } finally {
    bridge.stop();
  }
});
