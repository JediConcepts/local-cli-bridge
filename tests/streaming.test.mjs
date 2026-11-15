// `stream: true` on /v1/chat/completions: an OpenAI-style event stream.
//
// The bridge commits 200 + text/event-stream at once, sends SSE comment
// heartbeats while the CLI runs, and when it finishes sends a role chunk, the
// text as one content chunk, a stop chunk (and a usage chunk when asked) and
// `data: [DONE]`. A failure after the headers went out is a `data: {"error":…}`
// event, then the stream ends. Everything else about a completion (auth,
// validation, concurrency, timeout, cancellation) is unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startBridge, makeStubBin, fakeCliJson } from "./helpers.mjs";

process.env.BRIDGE_ENV_FILE = "/dev/null";
const { sseHeartbeatMs } = await import("../scripts/local-cli-bridge.mjs");

const KEY = "test-key-123";
const AUTH = { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` };
const MESSAGES = [{ role: "system", content: "Write minutes." }, { role: "user", content: "the transcript" }];

function post(base, body, { headers = {}, signal, route = "/v1/chat/completions" } = {}) {
  return fetch(`${base}${route}`, { method: "POST", headers: { ...AUTH, ...headers }, body: JSON.stringify(body), signal });
}

/**
 * Parse an event stream strictly: every event is one or more lines that are
 * either a comment (":…") or a `data: ` line, and events are separated by
 * exactly one blank line. A bare newline anywhere (the tunnel keepalive's
 * whitespace) makes an empty event and fails the parse.
 */
function parseSse(text) {
  assert.ok(text.endsWith("\n\n"), `stream must end on an event boundary: ${JSON.stringify(text.slice(-40))}`);
  const events = text.slice(0, -2).split("\n\n");
  const items = [];
  for (const event of events) {
    assert.ok(event.length > 0, `empty event in the stream: ${JSON.stringify(text.slice(0, 200))}`);
    for (const line of event.split("\n")) {
      if (line.startsWith(":")) items.push({ comment: line });
      else if (line.startsWith("data: ")) items.push({ data: line.slice(6) });
      else assert.fail(`not an SSE comment or data line: ${JSON.stringify(line)}`);
    }
  }
  const data = items.filter((i) => "data" in i).map((i) => i.data);
  const commentsBeforeData = items.findIndex((i) => "data" in i);
  return {
    items,
    data,
    comments: items.filter((i) => "comment" in i).length,
    commentsBeforeData: commentsBeforeData === -1 ? items.length : commentsBeforeData,
    json: data.filter((d) => d !== "[DONE]").map((d) => JSON.parse(d)),
  };
}

async function waitForFile(file, ms, message) {
  const deadline = Date.now() + ms;
  while (!fs.existsSync(file) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  assert.ok(fs.existsSync(file), message);
}

async function claudeBridge(env = {}) {
  const stub = makeStubBin();
  const bridge = await startBridge({ BRIDGE_BACKEND: "claude", BRIDGE_API_KEY: KEY, ...stub.env, ...env });
  return { ...bridge, stub };
}

test("stream: true answers 200 text/event-stream: role, the text, stop, then [DONE]", async () => {
  const bridge = await claudeBridge({ STUB_TEXT: "SUMMARY:\nThe minutes.\n" });
  try {
    const res = await post(bridge.base, { model: "sonnet", stream: true, messages: MESSAGES });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /^text\/event-stream/);
    const sse = parseSse(await res.text());
    assert.equal(sse.data.at(-1), "[DONE]", "the stream ends with data: [DONE]");
    assert.equal(sse.data.filter((d) => d === "[DONE]").length, 1);
    const chunks = sse.json;
    assert.ok(chunks.length >= 3);
    for (const c of chunks) {
      assert.equal(c.object, "chat.completion.chunk");
      assert.equal(c.id, chunks[0].id, "every chunk carries the same id");
      assert.equal(c.model, "sonnet");
      assert.equal(c.usage, undefined, "no usage unless stream_options.include_usage");
    }
    assert.equal(chunks[0].choices[0].delta.role, "assistant", "the first chunk carries the role");
    const text = chunks.map((c) => c.choices[0]?.delta?.content ?? "").join("");
    assert.equal(text, "SUMMARY:\nThe minutes.\n");
    const last = chunks.at(-1);
    assert.equal(last.choices[0].finish_reason, "stop");
    assert.deepEqual(last.choices[0].delta, {});
    assert.equal(chunks.filter((c) => c.choices[0]?.finish_reason).length, 1, "exactly one finish reason");
  } finally {
    bridge.stop();
  }
});

test("the /chat/completions alias streams too, and a truthy non-boolean stream value streams", async () => {
  const bridge = await claudeBridge({ STUB_TEXT: "alias" });
  try {
    for (const [route, stream] of [["/chat/completions", true], ["/v1/chat/completions", "true"], ["/v1/chat/completions", 1]]) {
      const res = await post(bridge.base, { model: "sonnet", stream, messages: MESSAGES }, { route });
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type"), /^text\/event-stream/, `${route} stream=${JSON.stringify(stream)}`);
      const sse = parseSse(await res.text());
      assert.equal(sse.data.at(-1), "[DONE]");
    }
  } finally {
    bridge.stop();
  }
});

test("falsy stream values keep the single JSON completion", async () => {
  const bridge = await claudeBridge({ STUB_TEXT: "buffered" });
  try {
    for (const stream of [false, null, 0, undefined]) {
      const res = await post(bridge.base, { model: "sonnet", stream, messages: MESSAGES });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), "application/json", `stream=${stream}`);
      assert.ok(res.headers.get("content-length"), "a buffered body keeps its Content-Length");
      assert.equal((await res.json()).choices[0].message.content, "buffered");
    }
  } finally {
    bridge.stop();
  }
});

test("the event-stream headers arrive straight away, before the CLI finishes", async () => {
  const bridge = await claudeBridge({ STUB_MODE: "slow", STUB_MS: "1500" });
  try {
    const t0 = Date.now();
    const res = await post(bridge.base, { model: "sonnet", stream: true, messages: MESSAGES });
    const headersAfter = Date.now() - t0;
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /^text\/event-stream/);
    assert.ok(headersAfter < 1000, `headers took ${headersAfter}ms; they must not wait for the CLI`);
    const sse = parseSse(await res.text());
    assert.ok(Date.now() - t0 >= 1400, "the body still waits for the CLI");
    assert.equal(sse.data.at(-1), "[DONE]");
  } finally {
    bridge.stop();
  }
});

test("SSE comment heartbeats are sent while the CLI runs", async () => {
  const bridge = await claudeBridge({ STUB_MODE: "slow", STUB_MS: "700", BRIDGE_KEEPALIVE_MS: "50" });
  try {
    const res = await post(bridge.base, { model: "sonnet", stream: true, messages: MESSAGES });
    const sse = parseSse(await res.text());
    assert.ok(sse.commentsBeforeData >= 5, `only ${sse.commentsBeforeData} heartbeats before the answer`);
    assert.equal(sse.data.at(-1), "[DONE]");
  } finally {
    bridge.stop();
  }
});

test("the stream heartbeat interval is never longer than 15 s, whatever BRIDGE_KEEPALIVE_MS says", () => {
  for (const keepaliveMs of [0, 20_000, 60_000, 900_000]) {
    const ms = sseHeartbeatMs(keepaliveMs);
    assert.ok(ms > 0 && ms <= 15_000, `keepalive ${keepaliveMs} gave a ${ms}ms stream heartbeat`);
  }
  assert.equal(sseHeartbeatMs(50), 50, "a shorter keepalive is used as is");
});

test("with the keepalive off (the default for local calls) a long run still heartbeats within 15 s", async () => {
  // startBridge sets BRIDGE_KEEPALIVE_MS=0, so this is the stream's own default interval.
  const bridge = await claudeBridge({ STUB_MODE: "slow", STUB_MS: "11000" });
  try {
    const res = await post(bridge.base, { model: "sonnet", stream: true, messages: MESSAGES });
    const sse = parseSse(await res.text());
    // One comment as the stream opens, at least one more during the 11 s run.
    assert.ok(sse.commentsBeforeData >= 2, `only ${sse.commentsBeforeData} heartbeats in an 11 s run`);
  } finally {
    bridge.stop();
  }
});

test("stream_options.include_usage adds a usage chunk with the same estimate as a buffered completion", async () => {
  const bridge = await claudeBridge({ STUB_TEXT: "a reply long enough to count more than one token" });
  try {
    const buffered = await (await post(bridge.base, { model: "sonnet", messages: MESSAGES })).json();
    const res = await post(bridge.base, { model: "sonnet", stream: true, stream_options: { include_usage: true }, messages: MESSAGES });
    const { json } = parseSse(await res.text());
    const usageChunk = json.at(-1);
    assert.deepEqual(usageChunk.choices, [], "the usage chunk has no choices");
    assert.deepEqual(usageChunk.usage, buffered.usage);
    for (const c of json.slice(0, -1)) assert.equal(c.usage, null, "the other chunks carry usage: null");
    assert.equal(json.at(-2).choices[0].finish_reason, "stop", "the stop chunk comes before the usage chunk");
  } finally {
    bridge.stop();
  }
});

test("a failure after the headers is one data error event, redacted by default, and the stream ends without [DONE]", async () => {
  const bridge = await claudeBridge({ STUB_MODE: "fail", STUB_TEXT: "secret-detail-do-not-leak" });
  try {
    const res = await post(bridge.base, { model: "sonnet", stream: true, messages: MESSAGES });
    assert.equal(res.status, 200, "the status is spent once the stream has started");
    const text = await res.text();
    const sse = parseSse(text);
    assert.ok(!sse.data.includes("[DONE]"), "a failed stream must not end with [DONE]");
    assert.equal(sse.json.length, 1, "nothing but the error event");
    const [event] = sse.json;
    assert.equal(event.error.type, "bridge_backend_error");
    assert.equal(event.error.message, "The local model backend failed");
    assert.ok(event.error.id, "the error carries its correlation id");
    assert.equal(event.choices, undefined, "no content chunk on failure");
    assert.ok(!text.includes("secret-detail-do-not-leak"));
  } finally {
    bridge.stop();
  }
});

test("with BRIDGE_EXPOSE_ERROR_DETAILS=1 the stream's error event carries the backend's message", async () => {
  const bridge = await claudeBridge({ STUB_MODE: "fail", STUB_TEXT: "Not logged in", BRIDGE_EXPOSE_ERROR_DETAILS: "1" });
  try {
    const res = await post(bridge.base, { model: "sonnet", stream: true, messages: MESSAGES });
    const [event] = parseSse(await res.text()).json;
    assert.ok(event.error.message.includes("Not logged in"), event.error.message);
  } finally {
    bridge.stop();
  }
});

test("BRIDGE_TIMEOUT_MS applies to a stream: the child is killed and a timeout error event ends it", async () => {
  const bridge = await claudeBridge({ STUB_MODE: "slow", STUB_MS: "30000", BRIDGE_TIMEOUT_MS: "500" });
  try {
    const res = await post(bridge.base, { model: "sonnet", stream: true, messages: MESSAGES });
    const sse = parseSse(await res.text());
    assert.ok(!sse.data.includes("[DONE]"));
    const [event] = sse.json;
    assert.ok(event.error.message.includes("timed out"), event.error.message);
  } finally {
    bridge.stop();
  }
});

test("a client that disconnects from a stream has its CLI child killed", async () => {
  const marker = path.join(os.tmpdir(), `bridge-stream-marker-${process.pid}-${Math.random().toString(36).slice(2)}`);
  const bridge = await claudeBridge({ STUB_MODE: "hang", STUB_MARKER: marker });
  try {
    const ac = new AbortController();
    const res = await post(bridge.base, { model: "sonnet", stream: true, messages: MESSAGES }, { signal: ac.signal });
    assert.equal(res.status, 200);
    // Wait until the child is running with its SIGTERM handler in place, not a
    // fixed time: under load, Node start-up alone can take longer than any guess.
    await waitForFile(`${marker}.ready`, 15_000, "the stub child never started");
    ac.abort();
    await waitForFile(marker, 4000, "the hanging child never got SIGTERM");
  } finally {
    bridge.stop();
    // A child the bridge failed to end would hang for ever: end it here (its pid
    // is in the ready file). With the marker written, it has already exited.
    if (!fs.existsSync(marker)) {
      try { process.kill(Number(fs.readFileSync(`${marker}.ready`, "utf8")), "SIGKILL"); } catch { /* never started, or gone */ }
    }
    for (const f of [marker, `${marker}.ready`]) try { fs.unlinkSync(f); } catch { /* not created */ }
  }
});

test("the concurrency limit answers a stream with a real 429 before any event stream starts", async () => {
  const bridge = await claudeBridge({ STUB_MODE: "slow", STUB_MS: "1500", BRIDGE_MAX_CONCURRENT: "1" });
  try {
    const first = post(bridge.base, { model: "sonnet", stream: true, messages: MESSAGES });
    await new Promise((r) => setTimeout(r, 300));
    const second = await post(bridge.base, { model: "sonnet", stream: true, messages: MESSAGES });
    assert.equal(second.status, 429);
    assert.equal(second.headers.get("content-type"), "application/json");
    assert.equal((await second.json()).error.type, "rate_limit_error");
    const sse = parseSse(await (await first).text());
    assert.equal(sse.data.at(-1), "[DONE]");
  } finally {
    bridge.stop();
  }
});

test("with stream: true every other unsupported feature is still a 400 naming it", async () => {
  const bridge = await claudeBridge();
  try {
    for (const [extra, named] of [
      [{ tools: [{ type: "function", function: { name: "f" } }] }, "tools"],
      [{ tool_choice: "auto" }, "tool_choice"],
      [{ functions: [{ name: "f" }] }, "functions"],
      [{ response_format: { type: "json_object" } }, "response_format"],
      [{ n: 2 }, "n > 1"],
    ]) {
      const res = await post(bridge.base, { model: "sonnet", stream: true, messages: MESSAGES, ...extra });
      assert.equal(res.status, 400, JSON.stringify(extra));
      assert.ok((await res.json()).error.message.includes(named));
    }
    const blocks = await post(bridge.base, { model: "sonnet", stream: true, messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] });
    assert.equal(blocks.status, 400);
    assert.deepEqual(bridge.stub.records("claude"), [], "no CLI ran for a rejected request");
  } finally {
    bridge.stop();
  }
});

test("the tunnel keepalive never writes bare whitespace into an event stream", async () => {
  for (const keepalive of ["50", "auto"]) {
    const bridge = await claudeBridge({ STUB_MODE: "slow", STUB_MS: "400", BRIDGE_KEEPALIVE_MS: keepalive });
    try {
      for (const headers of [{}, { "cf-ray": "8a1b2c3d4e5f6789-LHR" }]) {
        const res = await post(bridge.base, { model: "sonnet", stream: true, messages: MESSAGES }, { headers });
        assert.match(res.headers.get("content-type"), /^text\/event-stream/);
        const text = await res.text();
        assert.ok(text.startsWith(":"), `the stream opens with an SSE comment, not whitespace: ${JSON.stringify(text.slice(0, 20))}`);
        const sse = parseSse(text); // fails on any bare newline
        assert.equal(sse.data.at(-1), "[DONE]");
      }
    } finally {
      bridge.stop();
    }
  }
});

test("a stream through the command backend carries the CLI's text unchanged", async () => {
  const bridge = await startBridge({
    BRIDGE_BACKEND: "command", BRIDGE_COMMAND_JSON: fakeCliJson("echo"), BRIDGE_API_KEY: KEY,
  });
  try {
    const payload = "€ multibyte ✓ and a\nsecond line";
    const res = await post(bridge.base, { model: "m", stream: true, messages: [{ role: "user", content: payload }] });
    const { json } = parseSse(await res.text());
    assert.equal(json.map((c) => c.choices[0]?.delta?.content ?? "").join(""), payload);
  } finally {
    bridge.stop();
  }
});
