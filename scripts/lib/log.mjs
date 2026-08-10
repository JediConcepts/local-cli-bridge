/**
 * Timestamped console output for the bridge.
 *
 * Every line the bridge prints already carried a `[bridge]` marker; this adds the
 * time in front of it, because without one the output cannot be correlated with
 * anything else. A bridge request takes seconds to minutes (it spawns a CLI), runs
 * up to `BRIDGE_MAX_CONCURRENT` at a time, and is usually being read alongside the
 * logs of whatever called it — so "which of these lines belongs to the request that
 * just failed?" is the normal question, and an unstamped log cannot answer it.
 *
 *   YYYY-MM-DD HH:MM:SS.mmm [bridge] message
 *
 * Local time, no `T` or `Z`: this is read by a person watching a terminal.
 * Milliseconds are kept because up to `BRIDGE_MAX_CONCURRENT` requests run at once
 * and their lines interleave — at second resolution two events in the same second
 * cannot be ordered, which is exactly when ordering is being asked for.
 *
 *   BRIDGE_LOG_TIME=human   2026-08-10 11:48:16.688   (default)
 *   BRIDGE_LOG_TIME=iso     2026-08-10T10:48:16.688Z  — UTC, millisecond precision
 *   BRIDGE_LOG_TIME=off     no timestamp              — for supervisors that add
 *                                                       their own (systemd, pm2,
 *                                                       Docker, CI)
 *
 * `iso` exists for machine correlation rather than reading: it matches the
 * `timestamp` field callers use in usage and audit records (ai-execution-router's
 * `UsageRecord` and `AttemptRecord` both emit `new Date().toISOString()`), so a
 * bridge line and the caller's record of the same call line up without converting
 * between a local clock and UTC.
 *
 * Only the first line of a multi-line message is stamped. Stack traces stay
 * readable that way, and the error id already in the message is what ties the
 * trace back to its request.
 */

/**
 * Read per call, not once at import.
 *
 * `load-bridge-env` applies `.env.bridge.local` *after* this module is loaded — and
 * it imports this module to announce that it did. Caching the mode at import time
 * would therefore make `BRIDGE_LOG_TIME` work from an inline variable but be
 * silently ignored in the env file, which is where the docs tell people to put
 * settings. The cost is one env lookup per line.
 */
function mode() {
  return (process.env.BRIDGE_LOG_TIME ?? "human").trim().toLowerCase();
}

const pad = (n, width = 2) => String(n).padStart(width, "0");

function stamp() {
  const m = mode();
  if (m === "off") return "";
  const now = new Date();
  if (m === "iso") return `${now.toISOString()} `;
  // Local time — the bridge runs on the machine whose clock the reader is looking at.
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}` +
    `.${pad(now.getMilliseconds(), 3)} `
  );
}

function prefix(message) {
  return `${stamp()}[bridge] ${message}`;
}

export const log = {
  info: (message) => console.log(prefix(message)),
  warn: (message) => console.warn(prefix(message)),
  error: (message) => console.error(prefix(message)),
};
