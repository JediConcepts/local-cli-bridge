// End to end with a real streaming client: meetingbox's minutes writer
// (writer.mjs, which calls ai-execution-router's complete() with streaming on)
// against a bridge whose `claude` is the recording stub.
//
// Opt-in, because it needs that client installed: set MEETINGBOX_MINUTES_DIR to
// a copy of meetingbox's minutes/ folder in which `npm ci` has installed
// ai-execution-router. Nothing here uses the network once it is installed.
//
//   MEETINGBOX_MINUTES_DIR=/path/to/minutes node --test tests/meetingbox.test.mjs
//
// writer.mjs is run as meetingbox runs it: an empty environment, one JSON
// object on stdin, one on stdout.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { startBridge, makeStubBin } from "./helpers.mjs";

const MINUTES = process.env.MEETINGBOX_MINUTES_DIR || "";
const WRITER = MINUTES && path.join(MINUTES, "writer.mjs");
const ready = WRITER && fs.existsSync(WRITER) && fs.existsSync(path.join(MINUTES, "node_modules", "ai-execution-router"));
const skip = ready ? false : "set MEETINGBOX_MINUTES_DIR to a meetingbox minutes/ folder with ai-execution-router installed";

const MINUTES_TEXT = "SUMMARY:\nThe stub wrote these minutes.\n\nDECISIONS:\nNone\n\nACTIONS:\nNone\n\nOPEN QUESTIONS:\nNone\n";

function writer(command, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WRITER, command], { env: {}, cwd: MINUTES, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("exit", (code) => {
      let output = null;
      try { output = JSON.parse(stdout); } catch { /* left null */ }
      resolve({ code, output, stderr });
    });
    child.stdin.end(JSON.stringify(input));
  });
}

function completeInput(base, extra = {}) {
  return {
    kind: "standard",
    address: `${base}/v1`,
    model: "sonnet",
    system: "Write the minutes of this meeting.",
    user: "Me: shall we ship it?\nThem: yes, on Friday.",
    timeoutMs: 120_000,
    maxTokens: 4096,
    ...extra,
  };
}

async function bridgeWithStub(env = {}) {
  const stub = makeStubBin();
  const bridge = await startBridge({
    BRIDGE_BACKEND: "claude",
    ...stub.env,
    STUB_TEXT: MINUTES_TEXT,
    // A stray setting that must not follow the transcript into Claude Code.
    ANTHROPIC_BASE_URL: "http://127.0.0.1:9/not-anthropic",
    ...env,
  });
  return { ...bridge, stub };
}

test("writer list: the bridge's models", { skip }, async () => {
  const bridge = await bridgeWithStub();
  try {
    const { code, output } = await writer("list", { kind: "standard", address: `${bridge.base}/v1` });
    assert.equal(code, 0);
    assert.deepEqual(output, { models: ["opus", "sonnet", "haiku"] });
  } finally {
    bridge.stop();
  }
});

test("writer complete: the stub's minutes come back, and claude ran with all five safeguards", { skip }, async () => {
  const bridge = await bridgeWithStub();
  try {
    const { code, output } = await writer("complete", completeInput(bridge.base));
    assert.equal(code, 0);
    assert.equal(output.error, undefined, `writer failed: ${JSON.stringify(output)}`);
    assert.equal(output.text, MINUTES_TEXT);
    assert.equal(output.finishReason, "stop");
    assert.ok(Number.isInteger(output.inputTokens) && output.inputTokens > 0, "the estimated usage reached the writer");
    const [run] = bridge.stub.records("claude");
    assert.ok(run.argv.includes("--safe-mode"));
    assert.deepEqual(run.argv.filter((a) => a.startsWith("--tools")), ["--tools="]);
    assert.ok(run.argv.includes("--no-session-persistence"));
    assert.ok(!run.envKeys.includes("ANTHROPIC_BASE_URL"));
    assert.equal(run.stdin, "Me: shall we ship it?\nThem: yes, on Friday.");
  } finally {
    bridge.stop();
  }
});

test("writer complete with a key: the Bearer is checked and the minutes come back", { skip }, async () => {
  const key = "a-bridge-key-of-some-length";
  const bridge = await bridgeWithStub({ BRIDGE_API_KEY: key });
  try {
    const listed = await writer("list", { kind: "standard", address: `${bridge.base}/v1`, key });
    assert.deepEqual(listed.output, { models: ["opus", "sonnet", "haiku"] });
    const ok = await writer("complete", completeInput(bridge.base, { key }));
    assert.equal(ok.output.text, MINUTES_TEXT);
    const wrong = await writer("complete", completeInput(bridge.base, { key: "not-the-bridge-key-at-all" }));
    assert.equal(wrong.output.text, undefined);
    assert.equal(wrong.output.error.type, "refused");
  } finally {
    bridge.stop();
  }
});

test("writer complete: a long run kept open by heartbeats still returns the minutes", { skip }, async () => {
  const bridge = await bridgeWithStub({ STUB_MODE: "slow", STUB_MS: "4000", BRIDGE_KEEPALIVE_MS: "100" });
  try {
    const t0 = Date.now();
    const { output } = await writer("complete", completeInput(bridge.base));
    assert.ok(Date.now() - t0 >= 3900);
    assert.equal(output.error, undefined, `writer failed: ${JSON.stringify(output)}`);
    assert.equal(output.text, MINUTES_TEXT);
  } finally {
    bridge.stop();
  }
});

test("writer complete: a failure mid-stream is a failure, not minutes", { skip }, async () => {
  const bridge = await bridgeWithStub({ STUB_MODE: "fail", STUB_TEXT: "Not logged in" });
  try {
    const { code, output } = await writer("complete", completeInput(bridge.base));
    assert.equal(code, 0, "the writer answers a failed request with an error object");
    assert.equal(output.text, undefined, `minutes from a failed run: ${JSON.stringify(output)}`);
    assert.ok(output.error, "an error object");
    assert.equal(output.error.sent, true, "the transcript was sent");
  } finally {
    bridge.stop();
  }
});

test("writer complete: a CLI timeout mid-stream is a failure, not minutes", { skip }, async () => {
  const bridge = await bridgeWithStub({ STUB_MODE: "slow", STUB_MS: "30000", BRIDGE_TIMEOUT_MS: "800", BRIDGE_KEEPALIVE_MS: "100" });
  try {
    const { output } = await writer("complete", completeInput(bridge.base));
    assert.equal(output.text, undefined, `minutes from a timed-out run: ${JSON.stringify(output)}`);
    assert.ok(output.error);
  } finally {
    bridge.stop();
  }
});
