# Release checklist

The automated suite runs against a fake CLI fixture, which proves the bridge's HTTP
surface and process management but **cannot** prove compatibility with the real Claude
Code and Codex CLIs (argument acceptance, signal handling, result-file behavior on
termination, current `--effort` vocabularies). A release is gated on this checklist
passing on a machine with both CLIs installed and logged in.

## 1. Automated gate

- [ ] `npm test` green on Node 18, 20, and 22 (CI covers this).
- [ ] `node --check` passes on all scripts (CI covers this).

## 2. Package gate (catches missing files, shebangs, path assumptions)

```bash
npm pack
mkdir -p /tmp/bridge-package-test && cd /tmp/bridge-package-test
npm init -y && npm install /path/to/local-cli-bridge-<version>.tgz
npx local-cli-bridge          # must start and print the listen address
npx local-cli-bridge-tunnel   # must fail CLOSED asking for BRIDGE_TUNNEL_NAME/BRIDGE_API_KEY
```

- [ ] `npx local-cli-bridge` starts from the installed tarball (not the repo checkout).
- [ ] `/v1/models` returns family caps for `sonnet` — proves
      `config/model-capability-defaults.json` shipped and resolves relative to the module.
- [ ] The tunnel launcher refuses to start without `BRIDGE_TUNNEL_NAME` + `BRIDGE_API_KEY`.

## 3. Real-CLI gate (run on a workstation with both CLIs logged in)

Claude Code backend (`BRIDGE_BACKEND=claude`):

- [ ] **Success:** a completion round-trips (`curl … -d '{"model":"sonnet",…}'`).
- [ ] **Auth failure:** log the CLI out (or set a bogus `HOME`) → request fails 502 with
      the real reason in the server log under the correlation id.
- [ ] **Cancellation:** start a long completion, Ctrl-C the client → the `claude`
      process disappears from `ps` within ~3s; the next request is not 429'd.

Codex backend (`BRIDGE_BACKEND=codex`):

- [ ] **Success:** a completion round-trips with your account's model slug.
- [ ] **System prompt:** a request with a `system` message demonstrably influences the
      answer (the text is prepended to the piped prompt — verify it is not ignored).
- [ ] **Auth failure:** as above.
- [ ] **Cancellation:** as above — also confirm no stray `codex-bridge-*.txt` files
      accumulate in the OS temp dir.

Effort suffixes (both):

- [ ] `sonnet:xhigh` and your Codex slug with `:high` are accepted by the installed CLI
      versions (vocabularies drift between CLI releases).

## 4. Remote gate (only if you use the tunnel)

- [ ] A tunnel-forwarded request slower than **100 seconds** completes (keepalive `auto`
      detects the Cloudflare headers in your arrangement — if it 524s, your proxy strips
      them; set a numeric `BRIDGE_KEEPALIVE_MS`).
- [ ] A tunnel-forwarded backend failure arrives as a 200 with an `{"error":…}` body and
      your client treats it as a failure.
- [ ] A direct local request to the same instance still gets real status codes.

## 5. Candidate follow-ups to evaluate here (not yet shipped)

- Trailing `Assistant:` completion cue on multi-turn transcripts — test whether it
  improves continuation or gets echoed by each CLI before adopting.

## 6. Ship

- [ ] `CHANGELOG.md`: replace the version's `UNRELEASED` marker with the date.
- [ ] `git tag v<version> && git push --tags` — the release workflow publishes to npm
      with provenance (requires npm Trusted Publishing configured for this repo, or an
      `NPM_TOKEN` secret).
- [ ] Verify the npm page shows the provenance badge and the new README.
