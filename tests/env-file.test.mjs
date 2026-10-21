// Unit tests for the env-file loader's diagnostics.
//
// The behaviour under test is a warning, not a value, because the failure it guards
// against is invisible: when no env file is found the bridge still starts, still logs
// a healthy-looking banner, and silently serves the DEFAULT backend and model list.
// A deployment can run that way for days. These tests pin the warning so it cannot
// regress back to a silent `return null`.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { loadBridgeEnv } = await import("../scripts/lib/load-bridge-env.mjs");

/** Capture console.warn/log for the duration of fn. */
function capture(fn) {
  const warns = [];
  const infos = [];
  const ow = console.warn;
  const ol = console.log;
  console.warn = (line) => warns.push(line);
  console.log = (line) => infos.push(line);
  try {
    fn();
  } finally {
    console.warn = ow;
    console.log = ol;
  }
  return { warns, infos };
}

/** Run fn with BRIDGE_ENV_FILE pointed at `file`, restoring the environment after. */
function withEnvFile(file, fn) {
  const previousPath = process.env.BRIDGE_ENV_FILE;
  const snapshot = { ...process.env };
  process.env.BRIDGE_ENV_FILE = file;
  try {
    return fn();
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in snapshot)) delete process.env[key];
    }
    Object.assign(process.env, snapshot);
    if (previousPath === undefined) delete process.env.BRIDGE_ENV_FILE;
    else process.env.BRIDGE_ENV_FILE = previousPath;
  }
}

function tmpFile(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-env-test-"));
  const file = path.join(dir, ".env.bridge.local");
  fs.writeFileSync(file, contents);
  return file;
}

test("a missing env file warns and names the paths it tried", () => {
  const missing = path.join(os.tmpdir(), "definitely-not-here", ".env.bridge.local");
  const { warns } = capture(() => {
    const result = withEnvFile(missing, () => loadBridgeEnv());
    assert.equal(result, null, "still returns null so defaults apply");
  });
  assert.equal(warns.length, 1, "exactly one warning, not a silent return");
  assert.match(warns[0], /no env file found/);
  assert.ok(warns[0].includes(missing), "the warning names the path it looked for");
});

test("settings from a readable file are applied and announced", () => {
  const file = tmpFile("BRIDGE_BACKEND=auto\nBRIDGE_TIMEOUT_MS=1234\n");
  const { warns, infos } = capture(() => {
    const result = withEnvFile(file, () => {
      delete process.env.BRIDGE_BACKEND;
      delete process.env.BRIDGE_TIMEOUT_MS;
      const r = loadBridgeEnv();
      assert.equal(process.env.BRIDGE_BACKEND, "auto");
      return r;
    });
    assert.equal(result.applied, 2);
  });
  assert.equal(warns.length, 0, "a working config warns about nothing");
  assert.match(infos[0], /loaded 2 setting\(s\)/);
});

test("a file whose keys are all already set inline warns that it changed nothing", () => {
  const file = tmpFile("BRIDGE_BACKEND=auto\n");
  const { warns } = capture(() => {
    withEnvFile(file, () => {
      process.env.BRIDGE_BACKEND = "claude"; // inline wins by design
      loadBridgeEnv();
    });
  });
  assert.equal(warns.length, 1);
  assert.match(warns[0], /applied 0 setting\(s\)/);
  assert.match(warns[0], /already set in the environment/);
});

test("a file holding no BRIDGE_ keys warns that every key was ignored", () => {
  const file = tmpFile("DATABASE_URL=postgres://x\nANTHROPIC_API_KEY=sk-leak\n");
  const { warns } = capture(() => {
    withEnvFile(file, () => loadBridgeEnv());
  });
  assert.equal(warns.length, 1);
  assert.match(warns[0], /applied 0 setting\(s\)/);
  assert.match(warns[0], /all 2 key\(s\) ignored/);
  // The allowlist is a safety property: an app secret in the file must never reach
  // the bridge process, and must never be echoed into the log.
  assert.equal(process.env.ANTHROPIC_API_KEY, undefined);
  assert.ok(!warns[0].includes("sk-leak"));
});
