// Behavioral tests that need a controllable backend: the fake CLI fixture
// simulates slow, chatty, failing, and hanging CLIs so the bridge's process
// management (concurrency, timeouts, cancellation, output limits, keepalive)
// can be exercised without any real CLI installed.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startBridge, fakeCliCommand, fakeCliJson } from "./helpers.mjs";

const KEY = "test-key-123";
const AUTH = { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` };

function completionBody(content = "hi") {
  return JSON.stringify({ model: "test-model", messages: [{ role: "user", content }] });
}

function markerPath() {
  return path.join(os.tmpdir(), `bridge-test-marker-${process.pid}-${Math.random().toString(36).slice(2)}`);
}

async function waitFor(check, { timeoutMs = 4000, everyMs = 50, what = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  throw new Error(`timed out waiting for ${what}`);
}

test("concurrency limit: excess completions get a 429 while a slot is busy", async () => {
  const bridge = await startBridge({
    BRIDGE_BACKEND: "command",
    BRIDGE_COMMAND_JSON: fakeCliJson("slow", "--ms", "2000"),
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

test("a backend that outlives BRIDGE_TIMEOUT_MS is killed and reported as a 504 gateway timeout", async () => {
  const bridge = await startBridge({
    BRIDGE_BACKEND: "command",
    BRIDGE_COMMAND_JSON: fakeCliJson("slow", "--ms", "30000"),
    BRIDGE_API_KEY: KEY,
    BRIDGE_TIMEOUT_MS: "500",
  });
  try {
    const res = await fetch(`${bridge.base}/v1/chat/completions`, { method: "POST", headers: AUTH, body: completionBody() });
    assert.equal(res.status, 504);
    const body = await res.json();
    assert.equal(body.error.type, "bridge_backend_error");
    assert.ok(body.error.id, "error carries a correlation id");
    assert.ok(body.error.message.includes("timed out"), "timeout message is safe to expose even with redaction on");
  } finally {
    bridge.stop();
  }
});

test("a cancelled request terminates the CLI child (SIGTERM delivered)", async () => {
  const marker = markerPath();
  const bridge = await startBridge({
    BRIDGE_BACKEND: "command",
    BRIDGE_COMMAND_JSON: fakeCliJson("hang", "--marker", marker),
    BRIDGE_API_KEY: KEY,
  });
  try {
    const ac = new AbortController();
    const doomed = fetch(`${bridge.base}/v1/chat/completions`, { method: "POST", headers: AUTH, body: completionBody(), signal: ac.signal })
      .catch(() => {}); // the abort error is expected
    await new Promise((r) => setTimeout(r, 400)); // let the child spawn and hang
    ac.abort();
    await doomed;
    await waitFor(() => fs.existsSync(marker), { what: "SIGTERM marker from the killed child" });
  } finally {
    bridge.stop();
    try { fs.unlinkSync(marker); } catch { /* not created */ }
  }
});

test("cancellation: slot is retained while the child is dying, freed after SIGKILL escalation", async () => {
  // hang-hard traps SIGTERM, so the child survives the whole 2s grace period.
  // The concurrency slot must stay occupied that entire time (child ceiling),
  // then free once SIGKILL reaps the child.
  const marker = markerPath();
  const bridge = await startBridge({
    BRIDGE_BACKEND: "command",
    BRIDGE_COMMAND_JSON: fakeCliJson("hang-hard", "--marker", marker),
    BRIDGE_API_KEY: KEY,
    BRIDGE_MAX_CONCURRENT: "1",
  });
  try {
    const ac = new AbortController();
    const doomed = fetch(`${bridge.base}/v1/chat/completions`, { method: "POST", headers: AUTH, body: completionBody(), signal: ac.signal })
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 400));
    ac.abort();
    await doomed;
    // SIGTERM arrives (marker) but is trapped — the child is alive and dying.
    await waitFor(() => fs.existsSync(marker), { what: "SIGTERM marker" });

    // Inside the grace period the slot must still be held: a new request is 429.
    const during = await fetch(`${bridge.base}/v1/chat/completions`, { method: "POST", headers: AUTH, body: completionBody() });
    assert.equal(during.status, 429, "slot released while the cancelled child was still alive");

    // After the 2s grace, SIGKILL reaps the child, runBackend settles, slot frees.
    // A new request is then ACCEPTED (it hangs by design, so a quick client-side
    // timeout distinguishes "accepted and running" from an instant 429).
    // The assertion lives OUTSIDE the try: only the deliberate client-side
    // timeout may be swallowed, never an assertion failure or a server error.
    await new Promise((r) => setTimeout(r, 2400));
    let probeStatus = null; // null = client-side timeout = accepted and running
    try {
      const probe = await fetch(`${bridge.base}/v1/chat/completions`, {
        method: "POST", headers: AUTH, body: completionBody(), signal: AbortSignal.timeout(500),
      });
      probeStatus = probe.status;
    } catch (e) {
      if (e.name !== "TimeoutError" && e.name !== "AbortError") throw e;
    }
    assert.notEqual(probeStatus, 429, "slot never freed after the child was SIGKILLed");
    // Give the bridge time to SIGKILL the probe's child too before tearing down,
    // so the test leaves no orphaned hang-hard processes behind.
    await new Promise((r) => setTimeout(r, 2600));
  } finally {
    bridge.stop();
    try { fs.unlinkSync(marker); } catch { /* not created */ }
  }
});

test("a killed child whose grandchild holds the stdio pipes cannot strand the slot", async () => {
  // 'close' waits for the pipes to drain; leaky-hang's grandchild inherits
  // them and outlives the killed child. Settlement must be forced shortly
  // after the direct child exits, well before the grandchild's 15s lifetime.
  const bridge = await startBridge({
    BRIDGE_BACKEND: "command",
    BRIDGE_COMMAND_JSON: fakeCliJson("leaky-hang"),
    BRIDGE_API_KEY: KEY,
    BRIDGE_MAX_CONCURRENT: "1",
  });
  try {
    const ac = new AbortController();
    const doomed = fetch(`${bridge.base}/v1/chat/completions`, { method: "POST", headers: AUTH, body: completionBody(), signal: ac.signal })
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 400));
    ac.abort(); // SIGTERM kills the direct child; the grandchild keeps the pipes open
    await doomed;
    await new Promise((r) => setTimeout(r, 2600)); // exit + forced-settlement grace
    let probeStatus = null; // null = client-side timeout = accepted and running
    try {
      const probe = await fetch(`${bridge.base}/v1/chat/completions`, {
        method: "POST", headers: AUTH, body: completionBody(), signal: AbortSignal.timeout(500),
      });
      probeStatus = probe.status;
    } catch (e) {
      if (e.name !== "TimeoutError" && e.name !== "AbortError") throw e;
    }
    assert.notEqual(probeStatus, 429, "slot stranded by a pipe-holding grandchild");
    await new Promise((r) => setTimeout(r, 2600)); // let the bridge reap the probe's child too
  } finally {
    bridge.stop();
  }
});

test("an output-limit breach is not relabeled a timeout while the child is dying", async () => {
  // The breach happens at ~50ms; the SIGTERM-trapping child then dies slowly
  // past BRIDGE_TIMEOUT_MS. The timeout timer must not overwrite the fate:
  // the client owes a 502 naming the output limit, not a 504 timeout.
  const bridge = await startBridge({
    BRIDGE_BACKEND: "command",
    BRIDGE_COMMAND_JSON: fakeCliJson("chatty", "--bytes", "50000", "--linger", "1"),
    BRIDGE_API_KEY: KEY,
    BRIDGE_MAX_PROCESS_OUTPUT_BYTES: "1000",
    BRIDGE_TIMEOUT_MS: "1000",
  });
  try {
    const res = await fetch(`${bridge.base}/v1/chat/completions`, { method: "POST", headers: AUTH, body: completionBody() });
    assert.equal(res.status, 502, "output-limit breach must not be mislabeled as a 504 timeout");
    const body = await res.json();
    assert.ok(body.error.message.includes("1000 bytes"), `wrong failure reason: ${body.error.message}`);
  } finally {
    bridge.stop();
  }
});

test("cancellation: slot frees promptly when the killed child exits on SIGTERM", async () => {
  const bridge = await startBridge({
    BRIDGE_BACKEND: "command",
    BRIDGE_COMMAND_JSON: fakeCliJson("slow", "--ms", "700"),
    BRIDGE_API_KEY: KEY,
    BRIDGE_MAX_CONCURRENT: "1",
  });
  try {
    const ac = new AbortController();
    const doomed = fetch(`${bridge.base}/v1/chat/completions`, { method: "POST", headers: AUTH, body: completionBody("doomed"), signal: ac.signal })
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 250));
    ac.abort(); // SIGTERM kills `slow` immediately (default signal handling)
    await doomed;
    await new Promise((r) => setTimeout(r, 400)); // child close + slot release
    const res = await fetch(`${bridge.base}/v1/chat/completions`, { method: "POST", headers: AUTH, body: completionBody("after-cancel") });
    assert.equal(res.status, 200, "slot was not released after the cancelled child closed");
    const body = await res.json();
    assert.ok(body.choices[0].message.content.includes("after-cancel"));
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

test("multibyte UTF-8 backend output survives pipe chunk boundaries intact", async () => {
  // "€" is 3 bytes; ~600KB of them guarantees 64KB pipe chunks split characters
  // mid-sequence (65536 % 3 !== 0). Naive Buffer→string concatenation corrupts
  // the split characters; StringDecoder must carry them across chunks.
  const payload = "€".repeat(200_000);
  const bridge = await startBridge({
    BRIDGE_BACKEND: "command",
    BRIDGE_COMMAND_JSON: fakeCliJson("echo"),
    BRIDGE_API_KEY: KEY,
  });
  try {
    const res = await fetch(`${bridge.base}/v1/chat/completions`, { method: "POST", headers: AUTH, body: completionBody(payload) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.choices[0].message.content, payload, "multibyte output was corrupted in transit");
  } finally {
    bridge.stop();
  }
});

test("output over BRIDGE_MAX_PROCESS_OUTPUT_BYTES kills the child and fails the request", async () => {
  const bridge = await startBridge({
    BRIDGE_BACKEND: "command",
    BRIDGE_COMMAND_JSON: fakeCliJson("chatty", "--bytes", "300000"),
    BRIDGE_API_KEY: KEY,
    BRIDGE_MAX_PROCESS_OUTPUT_BYTES: "65536",
  });
  try {
    const res = await fetch(`${bridge.base}/v1/chat/completions`, { method: "POST", headers: AUTH, body: completionBody() });
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.ok(body.error.message.includes("65536"), "output-limit message is safe to expose even with redaction on");
    // The breach must not wound the server: it still answers.
    const health = await fetch(`${bridge.base}/health`);
    assert.equal(health.status, 200);
  } finally {
    bridge.stop();
  }
});

test("stderr chatter counts against the same output ceiling", async () => {
  const bridge = await startBridge({
    BRIDGE_BACKEND: "command",
    BRIDGE_COMMAND_JSON: fakeCliJson("chatty", "--bytes", "300000", "--stream", "stderr"),
    BRIDGE_API_KEY: KEY,
    BRIDGE_MAX_PROCESS_OUTPUT_BYTES: "65536",
  });
  try {
    const res = await fetch(`${bridge.base}/v1/chat/completions`, { method: "POST", headers: AUTH, body: completionBody() });
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.ok(body.error.message.includes("bytes"));
  } finally {
    bridge.stop();
  }
});

test("forced numeric keepalive: success arrives as 200 with exactly one JSON object after heartbeat whitespace", async () => {
  const bridge = await startBridge({
    BRIDGE_BACKEND: "command",
    BRIDGE_COMMAND_JSON: fakeCliJson("slow", "--ms", "300"),
    BRIDGE_API_KEY: KEY,
    BRIDGE_KEEPALIVE_MS: "50", // several heartbeats land before the backend finishes
  });
  try {
    const res = await fetch(`${bridge.base}/v1/chat/completions`, { method: "POST", headers: AUTH, body: completionBody("beat-me") });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /^\s+\{/, "heartbeat whitespace precedes the body");
    const body = JSON.parse(text); // throws on anything but ONE valid JSON value (+ surrounding whitespace)
    assert.ok(body.choices[0].message.content.includes("beat-me"));
  } finally {
    bridge.stop();
  }
});

test("forced numeric keepalive: a late backend failure arrives IN-BODY on the committed 200", async () => {
  const bridge = await startBridge({
    BRIDGE_BACKEND: "command",
    BRIDGE_COMMAND_JSON: fakeCliJson("fail", "--msg", "boom"),
    BRIDGE_API_KEY: KEY,
    BRIDGE_KEEPALIVE_MS: "50",
  });
  try {
    const res = await fetch(`${bridge.base}/v1/chat/completions`, { method: "POST", headers: AUTH, body: completionBody() });
    assert.equal(res.status, 200, "status is already spent once the heartbeat starts");
    const text = await res.text();
    const body = JSON.parse(text);
    assert.ok(body.error, "failure is delivered as an in-body error object");
    assert.equal(body.error.type, "bridge_backend_error");
  } finally {
    bridge.stop();
  }
});

test("keepalive auto: a request claiming Cloudflare forwarding gets the heartbeat contract", async () => {
  const bridge = await startBridge({
    BRIDGE_BACKEND: "command",
    BRIDGE_COMMAND_JSON: fakeCliJson("fail", "--msg", "boom"),
    BRIDGE_API_KEY: KEY,
    BRIDGE_KEEPALIVE_MS: "auto",
  });
  try {
    const res = await fetch(`${bridge.base}/v1/chat/completions`, {
      method: "POST",
      headers: { ...AUTH, "cf-ray": "8a1b2c3d4e5f6789-LHR" }, // forged: auto is a header heuristic, not authenticated detection
      body: completionBody(),
    });
    assert.equal(res.status, 200);
    const body = JSON.parse(await res.text());
    assert.ok(body.error, "tunnel-shaped traffic gets in-body errors");
  } finally {
    bridge.stop();
  }
});

test("keepalive auto: a direct local request keeps its real error status code", async () => {
  const bridge = await startBridge({
    BRIDGE_BACKEND: "command",
    BRIDGE_COMMAND_JSON: fakeCliJson("fail", "--msg", "boom"),
    BRIDGE_API_KEY: KEY,
    BRIDGE_KEEPALIVE_MS: "auto",
  });
  try {
    const res = await fetch(`${bridge.base}/v1/chat/completions`, { method: "POST", headers: AUTH, body: completionBody() });
    assert.equal(res.status, 502, "local traffic must not pay the errors-as-200 cost");
  } finally {
    bridge.stop();
  }
});

test("a backend that exits non-zero is a 502 with a redacted message by default", async () => {
  const bridge = await startBridge({
    BRIDGE_BACKEND: "command",
    BRIDGE_COMMAND_JSON: fakeCliJson("fail", "--msg", "secret-path-do-not-leak"),
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
