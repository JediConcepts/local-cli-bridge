// Unit tests for the timestamped logger. The mode is read per call rather than
// cached at import, because load-bridge-env applies the env file AFTER this module
// loads and then uses it to announce that it did — so a cached mode would make
// BRIDGE_LOG_TIME work inline but be silently ignored in .env.bridge.local.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.BRIDGE_ENV_FILE = "/dev/null";
const { log } = await import("../scripts/lib/log.mjs");

/** Capture one console stream for the duration of fn. */
function capture(stream, fn) {
  const lines = [];
  const original = console[stream];
  console[stream] = (line) => lines.push(line);
  try {
    fn();
  } finally {
    console[stream] = original;
  }
  return lines;
}

function withMode(mode, fn) {
  const previous = process.env.BRIDGE_LOG_TIME;
  if (mode === undefined) delete process.env.BRIDGE_LOG_TIME;
  else process.env.BRIDGE_LOG_TIME = mode;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.BRIDGE_LOG_TIME;
    else process.env.BRIDGE_LOG_TIME = previous;
  }
}

const HUMAN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} \[bridge] /;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[bridge] /;

test("default format is human-readable local time with milliseconds", () => {
  const [line] = withMode(undefined, () => capture("log", () => log.info("hello")));
  assert.match(line, HUMAN);
  assert.ok(line.endsWith("[bridge] hello"));
});

test("BRIDGE_LOG_TIME=human is the same as the default", () => {
  const [line] = withMode("human", () => capture("log", () => log.info("hello")));
  assert.match(line, HUMAN);
});

test("BRIDGE_LOG_TIME=iso emits UTC, for correlating with a caller's audit records", () => {
  const [line] = withMode("iso", () => capture("log", () => log.info("hello")));
  assert.match(line, ISO);
});

test("BRIDGE_LOG_TIME=off restores the bare prefix, for supervisors that stamp their own", () => {
  const [line] = withMode("off", () => capture("log", () => log.info("hello")));
  assert.equal(line, "[bridge] hello");
});

test("the mode is honoured per call, not frozen at import", () => {
  // The regression this guards: reading process.env once at module load makes
  // BRIDGE_LOG_TIME work as an inline variable but silently do nothing when set in
  // .env.bridge.local, which is where the docs tell people to put settings.
  const iso = withMode("iso", () => capture("log", () => log.info("x")))[0];
  const off = withMode("off", () => capture("log", () => log.info("x")))[0];
  assert.match(iso, ISO);
  assert.equal(off, "[bridge] x");
});

test("an unrecognised value falls back to the human format rather than failing", () => {
  const [line] = withMode("nonsense", () => capture("log", () => log.info("hello")));
  assert.match(line, HUMAN);
});

test("warn and error carry the same prefix and reach the right stream", () => {
  const warned = withMode("off", () => capture("warn", () => log.warn("careful")));
  const errored = withMode("off", () => capture("error", () => log.error("broken")));
  assert.deepEqual(warned, ["[bridge] careful"]);
  assert.deepEqual(errored, ["[bridge] broken"]);
});

test("only the first line of a multi-line message is stamped", () => {
  // Stack traces stay readable; the error id in the message ties the trace to its
  // request, so the continuation lines do not need their own timestamp.
  const [line] = withMode("human", () =>
    capture("error", () => log.error("BridgeError: boom\n    at Foo (file.mjs:1:1)")),
  );
  const [first, ...rest] = line.split("\n");
  assert.match(first, HUMAN);
  assert.deepEqual(rest, ["    at Foo (file.mjs:1:1)"]);
});
