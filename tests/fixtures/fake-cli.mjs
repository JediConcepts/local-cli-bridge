#!/usr/bin/env node
// Controllable stand-in for a real CLI backend, driven entirely by argv so the
// bridge's `command` backend can exercise failure modes no real CLI reproduces
// on demand (slow runs, runaway output, hangs that ignore SIGTERM).
//
//   node fake-cli.mjs [mode] [options]
//
// Modes:
//   echo   (default)  read stdin, write it back to stdout, exit 0
//   slow              read stdin, wait --ms, then echo, exit 0
//   chatty            write --bytes of "x" to stdout, exit 0
//   fail              write --msg to stderr, exit 1
//   hang              never exit; a SIGTERM writes --marker (if set) and exits 0
//   hang-hard         never exit; SIGTERM is trapped and IGNORED (writes --marker),
//                     only SIGKILL ends it — proves the bridge's kill escalation
//   leaky-hang        spawns a grandchild that INHERITS our stdout/stderr pipes,
//                     then hangs; killing us leaves the pipes held open, so the
//                     bridge's 'close' for us cannot fire until the grandchild
//                     exits (it self-terminates after 15s as an orphan net)
// Options:
//   --ms N        delay for `slow` (default 1000)
//   --bytes N     stdout size for `chatty` (default 1024)
//   --linger 1    chatty: after writing, trap SIGTERM and hang (SIGKILL only)
//   --msg S       stderr text for `fail` (default "fake-cli failure")
//   --marker P    file path written when SIGTERM arrives (hang / hang-hard)
//   --prefix S    text prepended to the echo output (quoting round-trip check)

import fs from "node:fs";
import { spawn } from "node:child_process";

const argv = process.argv.slice(2);
const mode = argv[0] && !argv[0].startsWith("--") ? argv[0] : "echo";
const opts = {};
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith("--")) opts[argv[i].slice(2)] = argv[i + 1];
}

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8"); // decode across chunk boundaries, no split-character corruption
    process.stdin.on("data", (d) => (data += d));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

// Awaiting each write's flush callback matters: process.exit() discards any
// output still queued on the pipe, silently truncating large payloads.
function flushWrite(stream, data) {
  return new Promise((r) => stream.write(data, r));
}

async function writeBytes(n, stream = process.stdout) {
  const block = "x".repeat(65536);
  let left = n;
  while (left > 0) {
    const piece = left >= block.length ? block : "x".repeat(left);
    left -= piece.length;
    await flushWrite(stream, piece);
  }
}

if (mode === "hang" || mode === "hang-hard") {
  process.on("SIGTERM", () => {
    if (opts.marker) {
      try { fs.writeFileSync(opts.marker, "sigterm"); } catch { /* best effort */ }
    }
    if (mode === "hang") process.exit(0);
    // hang-hard: swallow the signal and keep running; only SIGKILL ends us.
  });
  readStdin(); // drain stdin so the bridge's write never blocks
  setInterval(() => {}, 60_000); // keep the event loop alive forever
} else if (mode === "leaky-hang") {
  spawn(process.execPath, ["-e", "setTimeout(()=>{},15000)"], { stdio: ["ignore", "inherit", "inherit"] });
  readStdin(); // drain stdin so the bridge's write never blocks
  setInterval(() => {}, 60_000); // hang until killed; SIGTERM ends us (default), not the grandchild
} else if (mode === "chatty") {
  await readStdin();
  await writeBytes(Number(opts.bytes ?? 1024), opts.stream === "stderr" ? process.stderr : process.stdout);
  if (opts.linger === "1") {
    process.on("SIGTERM", () => {}); // keep dying slowly: only SIGKILL ends us
    setInterval(() => {}, 60_000);
  } else {
    process.exit(0);
  }
} else if (mode === "fail") {
  await readStdin();
  await flushWrite(process.stderr, String(opts.msg ?? "fake-cli failure") + "\n");
  process.exit(1);
} else {
  // echo / slow
  const input = await readStdin();
  if (mode === "slow") await new Promise((r) => setTimeout(r, Number(opts.ms ?? 1000)));
  await flushWrite(process.stdout, (opts.prefix ?? "") + input);
  process.exit(0);
}
