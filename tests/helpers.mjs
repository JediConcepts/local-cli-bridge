// Shared test scaffolding: boot a real bridge process on a random loopback port
// with a tailored env, wait until it listens, and hand back base URL + teardown.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const SERVER = path.join(here, "..", "scripts", "local-cli-bridge.mjs");
export const FAKE_CLI = path.join(here, "fixtures", "fake-cli.mjs");

/** BRIDGE_COMMAND template that runs the fake CLI fixture with the given args. */
export function fakeCliCommand(args = "echo") {
  return `${process.execPath} ${FAKE_CLI} ${args}`.trim();
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
