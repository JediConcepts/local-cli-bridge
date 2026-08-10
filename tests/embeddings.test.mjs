// The embeddings proxy. The CLI backends cannot embed, so these routes forward to a
// local Ollama — the point being that ONE tunnelled surface carries both chat and
// embeddings rather than needing a second tunnel for the second shape.
//
// A stub Ollama stands in for the real one so the suite stays hermetic; what is under
// test is the bridge's translation, auth and error naming, not Ollama itself.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startBridge } from "./helpers.mjs";

let ollama, ollamaUrl, seen;

before(async () => {
  seen = [];
  ollama = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      seen.push({ url: req.url, body });
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/embeddings") {
        if (body.model === "missing-model") {
          res.writeHead(404);
          return res.end(JSON.stringify({ error: "model 'missing-model' not found" }));
        }
        return res.end(JSON.stringify({ embedding: [0.1, 0.2, 0.3] }));
      }
      if (req.url === "/api/pull") return res.end(JSON.stringify({ status: "success" }));
      res.writeHead(404);
      res.end(JSON.stringify({ error: "no route" }));
    });
  });
  await new Promise((r) => ollama.listen(0, "127.0.0.1", r));
  ollamaUrl = `http://127.0.0.1:${ollama.address().port}`;
});

after(() => ollama?.close());

const post = (base, path, body, key) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(body),
  });

test("/v1/embeddings translates the OpenAI shape to Ollama and back", async () => {
  const b = await startBridge({ BRIDGE_OLLAMA_URL: ollamaUrl });
  try {
    const res = await post(b.base, "/v1/embeddings", { input: ["alpha", "beta"], model: "nomic-embed-text" });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.object, "list");
    assert.equal(json.data.length, 2, "one embedding per input, in order");
    assert.deepEqual(json.data[0], { object: "embedding", index: 0, embedding: [0.1, 0.2, 0.3] });
    assert.equal(json.data[1].index, 1);
    // Ollama reports no token counts, so the bridge reports zero rather than an
    // estimate — an obviously absent number beats a fabricated one.
    assert.deepEqual(json.usage, { prompt_tokens: 0, total_tokens: 0 });
  } finally {
    b.stop();
  }
});

test("a bare string input is accepted, not only an array", async () => {
  const b = await startBridge({ BRIDGE_OLLAMA_URL: ollamaUrl });
  try {
    const json = await (await post(b.base, "/v1/embeddings", { input: "alpha" })).json();
    assert.equal(json.data.length, 1);
  } finally {
    b.stop();
  }
});

test("BRIDGE_EMBED_MODEL supplies the model when a request omits one", async () => {
  const b = await startBridge({ BRIDGE_OLLAMA_URL: ollamaUrl, BRIDGE_EMBED_MODEL: "custom-embed" });
  try {
    seen.length = 0;
    const json = await (await post(b.base, "/v1/embeddings", { input: "x" })).json();
    assert.equal(json.model, "custom-embed");
    assert.equal(seen.at(-1).body.model, "custom-embed");
  } finally {
    b.stop();
  }
});

test("/api/embeddings and /api/pull pass through in Ollama's native shape", async () => {
  const b = await startBridge({ BRIDGE_OLLAMA_URL: ollamaUrl });
  try {
    const embed = await (await post(b.base, "/api/embeddings", { model: "m", prompt: "hi" })).json();
    assert.deepEqual(embed, { embedding: [0.1, 0.2, 0.3] });
    const pull = await (await post(b.base, "/api/pull", { name: "nomic-embed-text" })).json();
    assert.deepEqual(pull, { status: "success" });
  } finally {
    b.stop();
  }
});

test("an unreachable Ollama produces a 502 that names the target", async () => {
  // The first question is always "is Ollama even running?", so the error answers it
  // rather than failing mutely.
  const b = await startBridge({ BRIDGE_OLLAMA_URL: "http://127.0.0.1:1" });
  try {
    const res = await post(b.base, "/v1/embeddings", { input: "x" });
    assert.equal(res.status, 502);
    const json = await res.json();
    assert.equal(json.error.type, "bridge_ollama_error");
    assert.match(json.error.message, /Ollama unreachable at http:\/\/127\.0\.0\.1:1/);
    assert.match(json.error.message, /BRIDGE_OLLAMA_URL/, "names the setting that fixes it");
  } finally {
    b.stop();
  }
});

test("an Ollama HTTP error surfaces as a 502 carrying its response", async () => {
  const b = await startBridge({ BRIDGE_OLLAMA_URL: ollamaUrl });
  try {
    const res = await post(b.base, "/v1/embeddings", { input: "x", model: "missing-model" });
    assert.equal(res.status, 502);
    assert.match((await res.json()).error.message, /Ollama 404/);
  } finally {
    b.stop();
  }
});

test("the embeddings routes are behind the same key as everything else", async () => {
  const b = await startBridge({ BRIDGE_OLLAMA_URL: ollamaUrl, BRIDGE_API_KEY: "secret" });
  try {
    assert.equal((await post(b.base, "/v1/embeddings", { input: "x" })).status, 401);
    assert.equal((await post(b.base, "/api/embeddings", { model: "m", prompt: "x" })).status, 401);
    assert.equal((await post(b.base, "/v1/embeddings", { input: "x" }, "secret")).status, 200);
  } finally {
    b.stop();
  }
});

test("malformed JSON is a 400, not a 500", async () => {
  const b = await startBridge({ BRIDGE_OLLAMA_URL: ollamaUrl });
  try {
    const res = await fetch(`${b.base}/v1/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    assert.equal(res.status, 400);
  } finally {
    b.stop();
  }
});

test("an oversized body is refused with the same ceiling the chat route uses", async () => {
  const b = await startBridge({ BRIDGE_OLLAMA_URL: ollamaUrl, BRIDGE_MAX_BODY_BYTES: "512" });
  try {
    const res = await post(b.base, "/v1/embeddings", { input: "x".repeat(2000) });
    assert.equal(res.status, 413, "embeddings must not bypass a limit chat respects");
  } finally {
    b.stop();
  }
});
