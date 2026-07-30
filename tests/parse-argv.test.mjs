// Unit tests for the limited argv parser: quoting fidelity without shell semantics.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCommandArgs, argsFromEnv } from "../scripts/lib/parse-argv.mjs";

test("plain whitespace-separated words parse exactly like the old split", () => {
  assert.deepEqual(parseCommandArgs("ollama run llama3"), ["ollama", "run", "llama3"]);
  assert.deepEqual(parseCommandArgs("  spaced   out  "), ["spaced", "out"]);
  assert.deepEqual(parseCommandArgs(""), []);
  assert.deepEqual(parseCommandArgs("   "), []);
});

test("double quotes keep spaces inside one argument", () => {
  assert.deepEqual(
    parseCommandArgs('my-cli --system "be very concise" --model {model}'),
    ["my-cli", "--system", "be very concise", "--model", "{model}"],
  );
});

test("single quotes are literal, no escape processing inside", () => {
  assert.deepEqual(parseCommandArgs("cli 'a \\n b'"), ["cli", "a \\n b"]);
});

test('escaped quote and backslash inside double quotes', () => {
  assert.deepEqual(parseCommandArgs('cli "say \\"hi\\"" "back\\\\slash"'), ["cli", 'say "hi"', "back\\slash"]);
});

test("backslash outside quotes escapes the next character", () => {
  assert.deepEqual(parseCommandArgs("cli a\\ b"), ["cli", "a b"]);
});

test("empty quoted arguments are preserved, not dropped", () => {
  assert.deepEqual(parseCommandArgs('cli "" \'\' after'), ["cli", "", "", "after"]);
});

test("quotes concatenate with adjacent text into one token", () => {
  assert.deepEqual(parseCommandArgs('cli --opt="a b"'), ["cli", "--opt=a b"]);
});

test("unbalanced quotes and trailing backslash fail loudly", () => {
  assert.throws(() => parseCommandArgs('cli "unclosed'), /Unbalanced double quote/);
  assert.throws(() => parseCommandArgs("cli 'unclosed"), /Unbalanced single quote/);
  assert.throws(() => parseCommandArgs("cli trailing\\"), /Trailing backslash/);
});

test("argsFromEnv: JSON form takes precedence over the template form", () => {
  assert.deepEqual(
    argsFromEnv({ json: '["a","b c"]', text: "ignored entirely", label: "X_JSON" }),
    ["a", "b c"],
  );
});

test("argsFromEnv: falls back to the parsed template when JSON is unset", () => {
  assert.deepEqual(argsFromEnv({ json: undefined, text: 'a "b c"', label: "X_JSON" }), ["a", "b c"]);
  assert.deepEqual(argsFromEnv({ json: "", text: "a", label: "X_JSON" }), ["a"]);
  assert.deepEqual(argsFromEnv({ json: undefined, text: undefined, label: "X_JSON" }), []);
});

test("argsFromEnv: invalid JSON or non-string elements fail loudly", () => {
  assert.throws(() => argsFromEnv({ json: "[not json", text: "", label: "X_JSON" }), /X_JSON is not valid JSON/);
  assert.throws(() => argsFromEnv({ json: '{"a":1}', text: "", label: "X_JSON" }), /JSON array of strings/);
  assert.throws(() => argsFromEnv({ json: "[1,2]", text: "", label: "X_JSON" }), /JSON array of strings/);
});
