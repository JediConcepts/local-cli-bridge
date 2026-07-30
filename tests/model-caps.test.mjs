// Unit tests for the capability catalogue: config-file defaults, operator
// overrides (longest-key precedence), and honest "unknown" reporting.
// Runs in its own file so BRIDGE_MODEL_CAPS is set before the module import
// freezes the override table.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.BRIDGE_ENV_FILE = "/dev/null";
process.env.BRIDGE_MODEL_CAPS = "gpt=111000:22000,gpt-5.6=999000:99000";
const { modelCaps } = await import("../scripts/local-cli-bridge.mjs");

test("overrides match longest key first, so 'gpt' cannot swallow 'gpt-5.6'", () => {
  assert.deepEqual(modelCaps("gpt-5.6-sol"), {
    context_window: 999000,
    max_output_tokens: 99000,
    caps_source: "override",
  });
});

test("a shorter override still applies where no longer key matches", () => {
  assert.deepEqual(modelCaps("gpt-5.5"), {
    context_window: 111000,
    max_output_tokens: 22000,
    caps_source: "override",
  });
});

test("caps matching sees through the :effort suffix", () => {
  assert.equal(modelCaps("gpt-5.6-sol:high").context_window, 999000);
});

test("family defaults come from config/model-capability-defaults.json", () => {
  assert.deepEqual(modelCaps("claude-sonnet-4-5"), {
    context_window: 200000,
    max_output_tokens: 64000,
    caps_source: "default",
  });
  assert.deepEqual(modelCaps("opus"), {
    context_window: 200000,
    max_output_tokens: 32000,
    caps_source: "default",
  });
});

test("an unknown model reports caps_source only — no invented figures", () => {
  assert.deepEqual(modelCaps("mystery-model-9000"), { caps_source: "unknown" });
});
