// End to end smoke tests for the bridge HTTP surface. No external CLI needed:
// the `command` backend with `cat` echoes each prompt back, so the full
// request path (auth, validation, backend spawn, OpenAI response shape) is
// exercised with zero dependencies.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const PORT = 18000 + Math.floor(Math.random() * 2000);
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = "test-key-123";

const child = spawn(process.execPath, ["scripts/local-cli-bridge.mjs"], {
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: "127.0.0.1",
    BRIDGE_BACKEND: "command",
    BRIDGE_COMMAND: "cat",
    BRIDGE_API_KEY: KEY,
    BRIDGE_KEEPALIVE_MS: "0",
    BRIDGE_MODELS: "echo-1",
    BRIDGE_ENV_FILE: "/dev/null",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("bridge did not start within 5s")), 5000);
  child.stdout.on("data", (d) => {
    if (String(d).includes("listening")) { clearTimeout(timer); resolve(); }
  });
  child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`bridge exited early (${code})`)); });
});

after(() => child.kill("SIGKILL"));

test("GET /health from loopback needs no auth and reports the backend", async () => {
  const res = await fetch(`${BASE}/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.backend, "command");
  assert.deepEqual(body.models, ["echo-1"]);
});

test("GET /v1/models advertises models with capability figures and provenance", async () => {
  const res = await fetch(`${BASE}/v1/models`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.object, "list");
  assert.equal(body.data[0].id, "echo-1");
  assert.ok(Number.isInteger(body.data[0].context_window));
  assert.ok(["override", "default", "unknown"].includes(body.data[0].caps_source));
});

test("POST /v1/chat/completions round trips through the command backend", async () => {
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: "echo-1", messages: [{ role: "user", content: "ping-pong-test" }] }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.object, "chat.completion");
  assert.ok(body.choices[0].message.content.includes("ping-pong-test"));
  assert.equal(body.choices[0].finish_reason, "stop");
  assert.ok(body.usage.total_tokens > 0);
});

test("completions with a wrong Bearer key are refused with 401", async () => {
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer wrong-key-999" },
    body: JSON.stringify({ model: "echo-1", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(res.status, 401);
});

test("invalid JSON body is a 400, not a crash", async () => {
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: "{not json",
  });
  assert.equal(res.status, 400);
});

test("unsupported features are rejected loudly: stream true is a 400", async () => {
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: "echo-1", stream: true, messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.ok(body.error.message.includes("stream"));
});
