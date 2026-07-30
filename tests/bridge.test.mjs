// End to end smoke tests for the bridge HTTP surface. No external CLI needed:
// the `command` backend with `cat` echoes each prompt back, so the full
// request path (auth, validation, backend spawn, OpenAI response shape) is
// exercised with zero dependencies.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { startBridge } from "./helpers.mjs";

const KEY = "test-key-123";

const bridge = await startBridge({
  BRIDGE_BACKEND: "command",
  BRIDGE_COMMAND: "cat",
  BRIDGE_API_KEY: KEY,
  BRIDGE_MODELS: "echo-1",
});
const BASE = bridge.base;

after(() => bridge.stop());

function completion(body, headers = { Authorization: `Bearer ${KEY}` }) {
  return fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

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
  const res = await completion({ model: "echo-1", messages: [{ role: "user", content: "ping-pong-test" }] });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.object, "chat.completion");
  assert.ok(body.choices[0].message.content.includes("ping-pong-test"));
  assert.equal(body.choices[0].finish_reason, "stop");
  assert.ok(body.usage.total_tokens > 0);
});

test("completions with a wrong Bearer key are refused with 401", async () => {
  const res = await completion(
    { model: "echo-1", messages: [{ role: "user", content: "hi" }] },
    { Authorization: "Bearer wrong-key-999" },
  );
  assert.equal(res.status, 401);
});

test("completions with no Authorization header at all are refused with 401", async () => {
  const res = await completion({ model: "echo-1", messages: [{ role: "user", content: "hi" }] }, {});
  assert.equal(res.status, 401);
});

test("invalid JSON body is a 400, not a crash", async () => {
  const res = await completion("{not json");
  assert.equal(res.status, 400);
});

test("non-array messages is a 400", async () => {
  const res = await completion({ model: "echo-1", messages: "just a string" });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.ok(body.error.message.includes("array"));
});

test("a null message entry is a 400", async () => {
  const res = await completion({ model: "echo-1", messages: [null] });
  assert.equal(res.status, 400);
});

test("non-string message content (content blocks) is a 400", async () => {
  const res = await completion({
    model: "echo-1",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.ok(body.error.message.includes("content"));
});

test("unsupported features are rejected loudly: stream true is a 400", async () => {
  const res = await completion({ model: "echo-1", stream: true, messages: [{ role: "user", content: "hi" }] });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.ok(body.error.message.includes("stream"));
});

for (const [field, value] of [
  ["tools", [{ type: "function", function: { name: "f" } }]],
  ["tool_choice", "auto"],
  ["response_format", { type: "json_object" }],
  ["functions", [{ name: "f" }]],
]) {
  test(`unsupported field \`${field}\` is a 400 naming the field`, async () => {
    const res = await completion({ model: "echo-1", [field]: value, messages: [{ role: "user", content: "hi" }] });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(body.error.message.includes(field));
  });
}

test("n > 1 is a 400 (the bridge returns exactly one choice)", async () => {
  const res = await completion({ model: "echo-1", n: 2, messages: [{ role: "user", content: "hi" }] });
  assert.equal(res.status, 400);
});

test('stream: "true" (a truthy non-boolean) is rejected, not silently buffered', async () => {
  const res = await completion({ model: "echo-1", stream: "true", messages: [{ role: "user", content: "hi" }] });
  assert.equal(res.status, 400);
});

test("explicit nulls from SDK serializers are treated as absent, not rejected", async () => {
  const res = await completion({
    model: "echo-1",
    stream: null,
    tools: null,
    tool_choice: null,
    response_format: null,
    functions: null,
    n: null,
    messages: [{ role: "user", content: "null-tolerant" }],
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.choices[0].message.content.includes("null-tolerant"));
});

test("stream: false is accepted", async () => {
  const res = await completion({ model: "echo-1", stream: false, messages: [{ role: "user", content: "hi" }] });
  assert.equal(res.status, 200);
});

test("an unknown message role is a 400, not silent prompt text", async () => {
  const res = await completion({ model: "echo-1", messages: [{ role: "robot", content: "hi" }] });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.ok(body.error.message.includes("role"));
});

test("a message with no role at all is a 400", async () => {
  const res = await completion({ model: "echo-1", messages: [{ content: "hi" }] });
  assert.equal(res.status, 400);
});

test("developer role is accepted (folded as system-level instructions)", async () => {
  const res = await completion({
    model: "echo-1",
    messages: [{ role: "developer", content: "be terse" }, { role: "user", content: "hi" }],
  });
  assert.equal(res.status, 200);
});

test("unknown routes are a 404", async () => {
  const res = await fetch(`${BASE}/v1/nope`);
  assert.equal(res.status, 404);
});
