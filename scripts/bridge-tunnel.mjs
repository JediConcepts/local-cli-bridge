#!/usr/bin/env node
/**
 * One command to expose the local model bridge to a remote application over a NAMED
 * Cloudflare Tunnel behind Cloudflare Access:
 *
 *     npm run bridge:tunnel
 *
 * It starts two processes and shuts both down together:
 *   1. the bridge (scripts/local-cli-bridge.mjs), bound to 127.0.0.1 with a Bearer key;
 *   2. `cloudflared tunnel run <name>`, the named tunnel whose ingress points at the bridge.
 *
 * The three security layers (all required for a request to reach a CLI):
 *   • Cloudflare Access service token , enforced at Cloudflare's edge
 *   • the bridge Bearer key           , BRIDGE_API_KEY, checked by the bridge
 *   • loopback binding                , the bridge only listens on 127.0.0.1; the ONLY
 *                                        way in is through the tunnel
 *
 * Prerequisites (one-time, done with the Cloudflare dashboard + cloudflared,
 * llm.example.com stands in for your bridge hostname throughout):
 *   • `cloudflared tunnel create <name>` and a DNS route for llm.example.com
 *   • ~/.cloudflared/config.yml ingress: llm.example.com → http://127.0.0.1:<PORT>
 *   • a Cloudflare Access application over llm.example.com with a service-token policy
 * See docs/REMOTE_BRIDGE.md for the full walkthrough.
 *
 * Use this ONLY for a DEDICATED bridge tunnel. If you already run `cloudflared` for another
 * hostname, do NOT use this, add llm.example.com as an extra ingress rule on that existing
 * tunnel and just run `npm run bridge` (see Arrangement A in docs/REMOTE_BRIDGE.md). Starting
 * a second connector for the same tunnel with a partial ingress makes Cloudflare 404 the
 * hostname it round-robins to the wrong connector.
 *
 * Env:
 *   BRIDGE_TUNNEL_NAME    (required) the named/dedicated tunnel to run
 *   BRIDGE_TUNNEL_CONFIG  path to that tunnel's config.yml, REQUIRED when a default
 *                          ~/.cloudflared/config.yml already exists for another tunnel, so
 *                          `cloudflared` runs the right one instead of colliding. `~` expands.
 *   BRIDGE_API_KEY        (required) Bearer key the bridge requires
 *   PORT                  (default 8787) loopback port the bridge listens on
 *   BRIDGE_BACKEND        (default auto) claude | codex | auto | command
 *   BRIDGE_MODELS         (default opus,sonnet,haiku,gpt-5.5) advertised model ids
 *   CLOUDFLARED_BIN       (default cloudflared) path to the cloudflared binary
 *
 * This launcher never prints the Bearer key or any Cloudflare secret.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { loadBridgeEnv } from "./lib/load-bridge-env.mjs";

// Pull BRIDGE_* config from .env.bridge.local / .env.local (allowlisted) before reading it.
loadBridgeEnv();

const here = path.dirname(fileURLToPath(import.meta.url));
const tunnelName = process.env.BRIDGE_TUNNEL_NAME;
const tunnelConfig = process.env.BRIDGE_TUNNEL_CONFIG;
const port = process.env.PORT || process.env.BRIDGE_PORT || "8787";
const backend = process.env.BRIDGE_BACKEND || "auto";
const models = process.env.BRIDGE_MODELS || "opus,sonnet,haiku,gpt-5.5";
const cloudflaredBin = process.env.CLOUDFLARED_BIN || "cloudflared";

/** Expand a leading `~/`, this launcher isn't run through a shell. */
const expandTilde = (p) => (p && p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p);

if (!tunnelName) {
  console.error("[bridge:tunnel] BRIDGE_TUNNEL_NAME is required (the dedicated Cloudflare tunnel to run).");
  console.error("[bridge:tunnel] Already run cloudflared for another hostname? Use `npm run bridge` instead,");
  console.error("[bridge:tunnel] see Arrangement A in docs/REMOTE_BRIDGE.md.");
  process.exit(1);
}
if (!process.env.BRIDGE_API_KEY) {
  // Fail CLOSED: exposing an unkeyed bridge through a tunnel means anyone who clears
  // (or misconfigures) Cloudflare Access gets an open door to the CLIs. A key-less
  // bridge is allowed only for explicitly-local use via `npm run bridge`.
  console.error("[bridge:tunnel] BRIDGE_API_KEY is required when exposing the bridge through a tunnel.");
  console.error("[bridge:tunnel] Set a strong random Bearer key, or run `npm run bridge` for loopback-only use.");
  process.exit(1);
}

const children = [];
let shuttingDown = false;

function start(label, cmd, cmdArgs, extraEnv) {
  const child = spawn(cmd, cmdArgs, { env: { ...process.env, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] });
  const prefix = (line) => line.split("\n").filter(Boolean).map((l) => `[${label}] ${l}`).join("\n");
  child.stdout.on("data", (d) => process.stdout.write(prefix(d.toString()) + "\n"));
  child.stderr.on("data", (d) => process.stderr.write(prefix(d.toString()) + "\n"));
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    console.error(`[bridge:tunnel] ${label} exited (code=${code} signal=${signal}), shutting down the other process.`);
    shutdown(code ?? 1);
  });
  child.on("error", (err) => {
    console.error(`[bridge:tunnel] failed to start ${label}: ${err.message}`);
    if (label === "cloudflared") console.error("[bridge:tunnel]   Is cloudflared installed and on PATH? https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/");
    shutdown(1);
  });
  children.push(child);
  return child;
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) {
    try { c.kill("SIGTERM"); } catch { /* already gone */ }
  }
  setTimeout(() => process.exit(code), 500);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

console.log(`[bridge:tunnel] starting bridge on 127.0.0.1:${port} (backend=${backend}) + tunnel "${tunnelName}"`);

// 1. Bridge, always loopback, with the advertised models. BRIDGE_API_KEY passes through.
//    Keepalive defaults to "auto" (not a forced interval): the bridge heartbeats
//    Cloudflare-forwarded requests to defeat the edge's ~100s 524, while direct
//    local requests to the same instance keep their real status codes.
start("bridge", process.execPath, [path.join(here, "local-cli-bridge.mjs")], {
  HOST: "127.0.0.1",
  PORT: port,
  BRIDGE_BACKEND: backend,
  BRIDGE_MODELS: models,
  BRIDGE_KEEPALIVE_MS: process.env.BRIDGE_KEEPALIVE_MS || "auto",
});

// 2. Named tunnel, pass --config when given so a dedicated tunnel doesn't collide with an
//    existing default ~/.cloudflared/config.yml. cloudflared reads credentials + ingress from it.
const tunnelArgs = ["tunnel", ...(tunnelConfig ? ["--config", expandTilde(tunnelConfig)] : []), "run", tunnelName];
start("cloudflared", cloudflaredBin, tunnelArgs);
