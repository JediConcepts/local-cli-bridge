#!/usr/bin/env node
// Stand-in for the `claude` and `codex` CLIs (and a `command` backend) that
// records exactly how the bridge ran it, then answers the way the real CLI's
// output parser expects. The tests put a `claude` / `codex` shim that execs
// this script first on the bridge's PATH, so the real CLIs are never run.
//
//   node stub-cli.mjs <claude|codex|command> [the argv the bridge passed...]
//
// When STUB_RECORD_DIR is set, each run writes <dir>/<name>-<pid>.json with
//   { name, argv, envKeys, stdin }
// envKeys holds only the NAMES of the child's environment variables: the
// tests need to know what was removed, and recording values could copy a
// real secret from the test runner's environment into a file.
//
// Behaviour, from the environment:
//   STUB_MODE    ok (default) | slow | fail | hang
//   STUB_MS      delay before answering in `slow` (default 1000)
//   STUB_TEXT    the answer (default "stub answer")
//   STUB_MARKER  file written when SIGTERM arrives in `hang`; <marker>.ready is
//                written once the SIGTERM handler is in place, so a test can
//                wait for that instead of guessing how long start-up takes
//
// Output per name:
//   claude   {"type":"result","is_error":false,"result":<text>} on stdout;
//            `fail` prints {"is_error":true,"result":<text>} and exits 1
//   codex    writes <text> to the --output-last-message file
//   command  writes <text> to stdout

import fs from "node:fs";
import path from "node:path";

const [name = "command", ...argv] = process.argv.slice(2);
const mode = process.env.STUB_MODE || "ok";
const text = process.env.STUB_TEXT ?? "stub answer";

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => (data += d));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

function flushWrite(stream, data) {
  return new Promise((r) => stream.write(data, r));
}

// In `hang`, catch SIGTERM before anything else: a signal that arrived while
// stdin was still being read would otherwise end the process by the default
// action, with no marker, and look like a bridge that never sent it.
if (mode === "hang") {
  process.on("SIGTERM", () => {
    if (process.env.STUB_MARKER) {
      try { fs.writeFileSync(process.env.STUB_MARKER, "sigterm"); } catch { /* best effort */ }
    }
    process.exit(0);
  });
  if (process.env.STUB_MARKER) fs.writeFileSync(`${process.env.STUB_MARKER}.ready`, String(process.pid));
}

// `codex features list` is read by the bridge before a Codex run, with no
// prompt. STUB_FEATURES is the table to print (the real CLI's layout: name,
// stage, effective state); STUB_FEATURES_MODE=fail makes the listing fail.
// The run is recorded as "codexfeatures" so it never counts as a `codex` run.
if (name === "codex" && argv[0] === "features" && argv[1] === "list") {
  if (process.env.STUB_RECORD_DIR) {
    const record = { name: "codexfeatures", argv, envKeys: Object.keys(process.env).sort(), stdin: "" };
    fs.writeFileSync(path.join(process.env.STUB_RECORD_DIR, `codexfeatures-${process.pid}.json`), JSON.stringify(record));
  }
  if (process.env.STUB_FEATURES_MODE === "fail") {
    await flushWrite(process.stderr, "Error: could not load features\n");
    process.exit(1);
  }
  // STUB_FEATURES_FILE, when set, is read on every call, so a test can change the
  // table between two requests (a Codex upgrade while the bridge runs).
  const fromFile = process.env.STUB_FEATURES_FILE ? fs.readFileSync(process.env.STUB_FEATURES_FILE, "utf8") : undefined;
  const table = fromFile ?? process.env.STUB_FEATURES ?? [
    "shell_tool                               stable             true",
    "unified_exec                             stable             true",
    "apps                                     stable             true",
    "plugins                                  stable             true",
    "hooks                                    stable             true",
    "computer_use                             stable             true",
    "image_generation                         stable             true",
    "chronicle                                under development  false",
    "collaboration_modes                      removed            true",
    "enable_request_compression               stable             true",
    "unbounded_connection_retries             stable             true",
  ].join("\n");
  await flushWrite(process.stdout, `${table}\n`);
  process.exit(0);
}

const stdin = await readStdin();

if (process.env.STUB_RECORD_DIR) {
  const record = { name, argv, envKeys: Object.keys(process.env).sort(), stdin };
  fs.writeFileSync(path.join(process.env.STUB_RECORD_DIR, `${name}-${process.pid}.json`), JSON.stringify(record));
}

if (mode === "hang") {
  setInterval(() => {}, 60_000);
} else {
  if (mode === "slow") await new Promise((r) => setTimeout(r, Number(process.env.STUB_MS ?? 1000)));
  if (name === "claude") {
    const failed = mode === "fail";
    await flushWrite(process.stdout, JSON.stringify({ type: "result", is_error: failed, result: text, session_id: "stub" }));
    process.exit(failed ? 1 : 0);
  } else if (name === "codex") {
    const i = argv.indexOf("--output-last-message");
    if (i >= 0 && argv[i + 1]) fs.writeFileSync(argv[i + 1], text);
    process.exit(mode === "fail" ? 1 : 0);
  } else {
    if (mode === "fail") {
      await flushWrite(process.stderr, `${text}\n`);
      process.exit(1);
    }
    await flushWrite(process.stdout, text);
    process.exit(0);
  }
}
