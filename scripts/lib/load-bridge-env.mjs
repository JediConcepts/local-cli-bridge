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
  if (!file) return null;

  let applied = 0;
  let skipped = 0;
  for (const [key, val] of parseEnv(fs.readFileSync(file, "utf8"))) {
    if (!ALLOW.test(key)) { skipped++; continue; }        // never import non-bridge keys
    if (process.env[key] !== undefined) continue;         // inline env wins
    process.env[key] = val;
    applied++;
  }
  if (applied > 0) {
    console.log(`[bridge] loaded ${applied} setting(s) from ${path.basename(file)}` +
      (skipped ? ` (ignored ${skipped} non-BRIDGE_ key(s))` : ""));
  }
  return { file: path.basename(file), applied };
}
