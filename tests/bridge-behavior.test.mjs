// Behavioral tests that need a controllable backend: the fake CLI fixture
// simulates slow, chatty, failing, and hanging CLIs so the bridge's process
// management (concurrency, timeouts, cancellation, output limits, keepalive)
// can be exercised without any real CLI installed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { startBridge, fakeCliCommand } from "./helpers.mjs";

const KEY = "test-key-123";
const AUTH = { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` };

function completionBody(content = "hi") {
  return JSON.stringify({ model: "test-model", messages: [{ role: "user", content }] });
}

test("concurrency limit: excess completions get a 429 while a slot is busy", async () => {
  const bridge = await startBridge({
    BRIDGE_BACKEND: "command",
    BRIDGE_COMMAND: fakeCliCommand("slow --ms 2000"),
    BRIDGE_API_KEY: KEY,
    BRIDGE_MAX_CONCURRENT: "1",
  });
  try {
    const first = fetch(`${bridge.base}/v1/chat/completions`, { method: "POST", headers: AUTH, body: completionBody("first") });
    await new Promise((r) => setTimeout(r, 300)); // let the first request occupy the slot
    const second = await fetch(`${bridge.base}/v1/chat/completions`, { method: "POST", headers: AUTH, body: completionBody("second") });
    assert.equal(second.status, 429);
    const refusal = await second.json();
    assert.equal(refusal.error.type, "rate_limit_error");

    const firstRes = await first;
    assert.equal(firstRes.status, 200);
    const ok = await firstRes.json();
    assert.ok(ok.choices[0].message.content.includes("first"));
  } finally {
    bridge.stop();
  }
});

test("a backend that outlives BRIDGE_TIMEOUT_MS is killed and reported as a gateway error", async () => {
  const bridge = await startBridge({
    BRIDGE_BACKEND: "command",
    BRIDGE_COMMAND: fakeCliCommand("slow --ms 30000"),
    BRIDGE_API_KEY: KEY,
    BRIDGE_TIMEOUT_MS: "500",
  });
  try {
    const res = await fetch(`${bridge.base}/v1/chat/completions`, { method: "POST", headers: AUTH, body: completionBody() });
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error.type, "bridge_backend_error");
    assert.ok(body.error.id, "error carries a correlation id");
  } finally {
    bridge.stop();
  }
});

test("BRIDGE_COMMAND quoting: a quoted argument with spaces survives, {model} substitutes everywhere", async () => {
  const bridge = await startBridge({
    BRIDGE_BACKEND: "command",
    BRIDGE_COMMAND: fakeCliCommand('echo --prefix "quoted prefix {model}+{model}: "'),
    BRIDGE_API_KEY: KEY,
  });
  try {
    const res = await fetch(`${bridge.base}/v1/chat/completions`, { method: "POST", headers: AUTH, body: completionBody("payload") });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(
      body.choices[0].message.content.startsWith("quoted prefix test-model+test-model: "),
      `quoting/substitution mangled: ${body.choices[0].message.content.slice(0, 80)}`,
    );
  } finally {
    bridge.stop();
  }
});

test("BRIDGE_COMMAND_JSON: the JSON array form is used verbatim and wins over BRIDGE_COMMAND", async () => {
  const { FAKE_CLI } = await import("./helpers.mjs");
  const bridge = await startBridge({
    BRIDGE_BACKEND: "command",
    BRIDGE_COMMAND: "this-command-does-not-exist",
    BRIDGE_COMMAND_JSON: JSON.stringify([process.execPath, FAKE_CLI, "echo", "--prefix", "json wins: "]),
    BRIDGE_API_KEY: KEY,
  });
  try {
    const res = await fetch(`${bridge.base}/v1/chat/completions`, { method: "POST", headers: AUTH, body: completionBody("payload") });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.choices[0].message.content.startsWith("json wins: "));
  } finally {
    bridge.stop();
  }
});

test("a backend that exits non-zero is a 502 with a redacted message by default", async () => {
  const bridge = await startBridge({
    BRIDGE_BACKEND: "command",
    BRIDGE_COMMAND: fakeCliCommand('fail --msg secret-path-do-not-leak'),
    BRIDGE_API_KEY: KEY,
  });
  try {
    const res = await fetch(`${bridge.base}/v1/chat/completions`, { method: "POST", headers: AUTH, body: completionBody() });
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.ok(!body.error.message.includes("secret-path-do-not-leak"), "raw backend detail is redacted by default");
  } finally {
    bridge.stop();
  }
});
