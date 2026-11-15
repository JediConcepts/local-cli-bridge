// Shared test scaffolding: boot a real bridge process on a random loopback port
// with a tailored env, wait until it listens, and hand back base URL + teardown.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const SERVER = path.join(here, "..", "scripts", "local-cli-bridge.mjs");
export const FAKE_CLI = path.join(here, "fixtures", "fake-cli.mjs");
export const STUB_CLI = path.join(here, "fixtures", "stub-cli.mjs");

/**
 * A folder holding `claude` and `codex` shims that exec the recording stub
 * (fixtures/stub-cli.mjs), plus an empty folder for its records.
 *
 * `env` is what a bridge needs to find them: PATH is the shim folder and the
 * system folders only, so a missing shim fails the spawn rather than falling
 * through to a real CLI installed elsewhere on PATH. `records(name)` returns
 * the parsed record of every run of that CLI so far.
 */
export function makeStubBin() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-stub-bin-"));
  const recordDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-stub-records-"));
  const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
  for (const name of ["claude", "codex"]) {
    const shim = path.join(dir, name);
    fs.writeFileSync(shim, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(STUB_CLI)} ${name} "$@"\n`);
    fs.chmodSync(shim, 0o755);
  }
  return {
    dir,
    recordDir,
    env: { PATH: `${dir}:/usr/bin:/bin`, STUB_RECORD_DIR: recordDir },
    records(name) {
      return fs.readdirSync(recordDir)
        .filter((f) => f.startsWith(`${name}-`))
        .map((f) => JSON.parse(fs.readFileSync(path.join(recordDir, f), "utf8")));
    },
    clear() {
      for (const f of fs.readdirSync(recordDir)) fs.unlinkSync(path.join(recordDir, f));
    },
  };
}

/**
 * Start a bridge that is expected to REFUSE to start: resolves with its exit
 * code and output once it exits, or rejects if it is still running (and so
 * listening) after `timeoutMs`.
 */
export function startBridgeExpectingExit(envOverrides = {}, { timeoutMs = 5000 } = {}) {
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PORT: String(18000 + Math.floor(Math.random() * 4000)),
      HOST: "127.0.0.1",
      BRIDGE_ENV_FILE: "/dev/null",
      ...envOverrides,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      reject(new Error(`bridge was still running after ${timeoutMs}ms:\n${stdout}${stderr}`));
    }, timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/**
 * Exact-argv env value for BRIDGE_COMMAND_JSON: the fake CLI plus args,
 * immune to spaces/quotes/backslashes in the node or checkout paths.
 * Prefer this everywhere the template grammar itself isn't under test.
 */
export function fakeCliJson(...args) {
  return JSON.stringify([process.execPath, FAKE_CLI, ...args]);
}

/**
 * BRIDGE_COMMAND template running the fake CLI — deliberately exercises the
 * quoted-template grammar. The interpolated paths are double-quoted so a
 * checkout path containing spaces still tokenizes as two argv entries.
 */
export function fakeCliCommand(args = "echo") {
  return `"${process.execPath}" "${FAKE_CLI}" ${args}`.trim();
}

/**
 * Spawn a bridge with `envOverrides` on a random port (retrying on a port
 * collision, node --test runs suites in parallel). Returns { base, child, stop }.
 */
export async function startBridge(envOverrides = {}) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    const port = 18000 + Math.floor(Math.random() * 4000);
    const child = spawn(process.execPath, [SERVER], {
      env: {
        ...process.env,
        PORT: String(port),
        HOST: "127.0.0.1",
        BRIDGE_ENV_FILE: "/dev/null",
        BRIDGE_KEEPALIVE_MS: "0",
        ...envOverrides,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("bridge did not start within 5s")), 5000);
        child.stdout.on("data", (d) => {
          if (String(d).includes("listening")) { clearTimeout(timer); resolve(); }
        });
        child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`bridge exited early (${code})`)); });
      });
      return {
        base: `http://127.0.0.1:${port}`,
        child,
        stop: () => { try { child.kill("SIGKILL"); } catch { /* already gone */ } },
      };
    } catch (e) {
      lastError = e;
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }
  }
  throw lastError;
}
