// A LIMITED, portable argument-string parser, not a shell. It supports quoted
// arguments and backslash escaping so operators can write
//   BRIDGE_COMMAND='my-cli --system "be very concise" --model {model}'
// and get the argv they expect. It deliberately performs NO shell semantics:
// no variable/tilde expansion, no command substitution, no globbing, no
// platform-specific quoting rules — the parsed argv is handed to spawn()
// without any shell. For argv that needs to be exact byte-for-byte (embedded
// quotes, values indistinguishable from the grammar), use the *_JSON env
// variables (argsFromEnv below), which take a JSON array of strings.
//
// Grammar:
//   • tokens split on unquoted whitespace
//   • '...'  literal, no escapes inside
//   • "..."  \" and \\ are escapes, every other character (incl. \) is literal
//   • \x outside quotes escapes x (so `a\ b` is one token)
//   • ""/'' produce an empty argument (preserved, not dropped)
//   • an unbalanced quote or trailing backslash throws, a typo'd template must
//     fail loudly at build time, not run a mangled CLI invocation

export function parseCommandArgs(input) {
  const s = String(input ?? "");
  const args = [];
  let current = "";
  let hasToken = false;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "'") {
      const end = s.indexOf("'", i + 1);
      if (end < 0) throw new Error(`Unbalanced single quote in command template: ${s}`);
      current += s.slice(i + 1, end);
      hasToken = true;
      i = end + 1;
    } else if (c === '"') {
      hasToken = true;
      i += 1;
      let closed = false;
      while (i < s.length) {
        const d = s[i];
        if (d === "\\" && (s[i + 1] === '"' || s[i + 1] === "\\")) {
          current += s[i + 1];
          i += 2;
        } else if (d === '"') {
          closed = true;
          i += 1;
          break;
        } else {
          current += d;
          i += 1;
        }
      }
      if (!closed) throw new Error(`Unbalanced double quote in command template: ${s}`);
    } else if (c === "\\") {
      if (i + 1 >= s.length) throw new Error(`Trailing backslash in command template: ${s}`);
      current += s[i + 1];
      hasToken = true;
      i += 2;
    } else if (/\s/.test(c)) {
      if (hasToken) {
        args.push(current);
        current = "";
        hasToken = false;
      }
      i += 1;
    } else {
      current += c;
      hasToken = true;
      i += 1;
    }
  }
  if (hasToken) args.push(current);
  return args;
}

/**
 * Resolve an argv from a pair of env vars: `json` (a JSON array of strings,
 * the exact/deterministic form) takes precedence over `text` (the quoted
 * template form, parsed by parseCommandArgs). `label` names the JSON var in
 * error messages.
 */
export function argsFromEnv({ json, text, label }) {
  if (json !== undefined && json !== "") {
    let parsed;
    try {
      parsed = JSON.parse(json);
    } catch (e) {
      throw new Error(`${label} is not valid JSON: ${e.message}`);
    }
    if (!Array.isArray(parsed) || parsed.some((x) => typeof x !== "string")) {
      throw new Error(`${label} must be a JSON array of strings`);
    }
    return parsed;
  }
  return parseCommandArgs(text || "");
}
