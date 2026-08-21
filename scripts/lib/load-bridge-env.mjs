/**
 * Tiny, zero-dependency env-file loader for the bridge scripts, so `npm run bridge`
 * and `npm run bridge:tunnel` can be run bare, with config kept in a local file instead
 * of typed inline every time.
 *
 * It loads the FIRST of these that exists (override with BRIDGE_ENV_FILE=<path>):
 *   1. .env.bridge.local   (gitignored by `.env*.local`, the recommended home)
 *   2. .env.local          (a shared app env file, if the bridge lives inside an app repo)
 *
 * SAFETY: it only imports keys matching the allowlist below (`BRIDGE_*`, `CLOUDFLARED_BIN`).
 * So even when it reads `.env.local`, it never pulls `DATABASE_URL`, `ANTHROPIC_API_KEY`,
 * or any other app secret into the bridge process, only bridge config. Inline env always
 * wins (a value already in process.env is never overwritten). Values are never logged.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "./log.mjs";

// Only these keys are ever imported from the file. Everything else in it is ignored.
const ALLOW = /^BRIDGE_[A-Z0-9_]*$|^CLOUDFLARED_BIN$/;

function parseEnv(text) {
  const out = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out.push([m[1], val]);
  }
  return out;
}

export function loadBridgeEnv() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, "..", ".."); // scripts/lib -> repo root
  const candidates = process.env.BRIDGE_ENV_FILE
    ? [process.env.BRIDGE_ENV_FILE]
    : [path.join(repoRoot, ".env.bridge.local"), path.join(repoRoot, ".env.local")];

  const file = candidates.find((f) => f && fs.existsSync(f));
  if (!file) {
    // Loudly, because the failure is otherwise invisible: the bridge starts fine and
    // serves the DEFAULT backend and model list, so a misconfigured deployment looks
    // healthy in the log and only shows up as "why is my model missing?" later. The
    // usual cause is launching a different copy of the script (these paths resolve from
    // the script's own location, NOT the cwd) or a service manager whose working
    // directory points elsewhere.
    log.warn(
      `no env file found, using built-in defaults \u2014 looked for: ${candidates.join(", ")}` +
      (process.env.BRIDGE_ENV_FILE ? " (from BRIDGE_ENV_FILE)" : "") +
      "; set BRIDGE_ENV_FILE=<path> to point at one explicitly",
    );
    return null;
  }

  let applied = 0;
  let skipped = 0;
  for (const [key, val] of parseEnv(fs.readFileSync(file, "utf8"))) {
    if (!ALLOW.test(key)) { skipped++; continue; }        // never import non-bridge keys
    if (process.env[key] !== undefined) continue;         // inline env wins
    process.env[key] = val;
    applied++;
  }
  if (applied > 0) {
    log.info(`loaded ${applied} setting(s) from ${path.basename(file)}` +
      (skipped ? ` (ignored ${skipped} non-BRIDGE_ key(s))` : ""));
  } else {
    // The file exists but changed nothing. Benign when every value is already set
    // inline (inline env wins by design), misleading otherwise, so say which it is.
    log.warn(
      `${path.basename(file)} applied 0 setting(s)` +
      (skipped ? ` (all ${skipped} key(s) ignored: not BRIDGE_*)` : " (every key already set in the environment)"),
    );
  }
  return { file: path.basename(file), applied };
}
