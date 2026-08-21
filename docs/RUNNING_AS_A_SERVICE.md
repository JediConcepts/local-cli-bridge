# Running the bridge as a service

[Quick start](../README.md#quick-start) runs the bridge in the foreground, which is right
for trying it out and wrong for anything else: the moment the terminal closes, the process
dies. That matters most for the setup this project exists to enable — a
[named tunnel](./REMOTE_BRIDGE.md) pointing at `127.0.0.1:8787`. A tunnel whose origin is a
foreground process in somebody's terminal is a remote endpoint that disappears when a laptop
lid closes.

This page covers running it under a per-user service manager so it starts at login, restarts
after a crash, and logs somewhere durable.

> **Per-user, not system-wide.** The bridge spawns a CLI (`claude`, `codex`) that is
> authenticated **as you**, reading credentials from your home directory. Run it as a system
> daemon under `root` or a service account and those credentials are not there. Every recipe
> below is deliberately a *user* service.

---

## Three rules that apply on every platform

Service managers are a much more hostile environment than your shell, and they fail quietly.
These three account for nearly every "it works when I run it by hand" report.

### 1. Which copy of the script you launch decides which config loads

`.env.bridge.local` is resolved **from the script's own location**, not from the working
directory:

```js
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");   // scripts/lib -> repo root
```

So `/opt/local-cli-bridge/scripts/local-cli-bridge.mjs` always reads
`/opt/local-cli-bridge/.env.bridge.local`, from any cwd. Point a service at a *different
checkout* — an old clone, a copy under a different name — and it will find no env file, fall
back to the built-in defaults (`backend=claude`, models `opus,sonnet,haiku`), and start
looking perfectly healthy.

Since v0.3.1 that case warns:

```
[bridge] no env file found, using built-in defaults — looked for: /path/.env.bridge.local, /path/.env.local
```

If you see it in your service log, the service is running a copy you did not mean. Set
`BRIDGE_ENV_FILE=<absolute path>` to bind the config explicitly regardless of layout.

### 2. Service managers inherit no PATH and source no shell rc

Your `.bashrc`/`.zshrc` never runs. Consequences:

- `node` is not on PATH. Use an **absolute interpreter path**, or resolve one (see rule 3).
- **The backend CLI is not on PATH either.** The bridge spawns `claude` / `codex` by name,
  so the service's `PATH` must contain them — commonly `~/.local/bin` for `claude` and a
  Node version manager's bin directory for `codex`. A bridge that starts fine and fails
  every completion with a spawn error is almost always this.

### 3. Version managers are invisible, and pinning a version is a trap

`nvm`, `fnm`, and `volta` work by rewriting `PATH` in an interactive shell. A service sees
none of it, so the obvious fix is to hardcode the full path:

```
/home/you/.nvm/versions/node/v22.22.2/bin/node    # works today, breaks on upgrade
```

The next `nvm install` moves the default and the service dies at every restart, throttled and
silent. Resolve it at start time instead. For nvm:

```sh
export NVM_DIR="$HOME/.nvm"
. "$NVM_DIR/nvm.sh" --no-use          # loads nvm without switching versions
NODE="$(nvm which default)"           # follows the `default` alias, incl. bare majors
```

This costs about 150 ms once per start. There is a second-order trap: **nvm installs global
CLIs per Node version**, so `codex` installed under v22 is not on PATH under v20. Derive the
CLI directory from the resolved interpreter rather than writing it out:

```sh
export PATH="$(dirname "$NODE"):$HOME/.local/bin:$PATH"
```

---

## macOS — launchd

Save as `~/Library/LaunchAgents/com.example.local-cli-bridge.plist`. Replace
`/ABSOLUTE/PATH/TO/local-cli-bridge` and `/ABSOLUTE/PATH/TO/HOME`; launchd does **not** expand
`~` or environment variables in `WorkingDirectory` or the `Standard*Path` keys.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.example.local-cli-bridge</string>

    <!-- Resolve Node via nvm at every start (rule 3) and put the matching CLI bin
         dir on PATH. Falls back to PATH's node when nvm is not installed. -->
    <key>ProgramArguments</key>
    <array>
        <string>/bin/sh</string>
        <string>-c</string>
        <string>export NVM_DIR="$HOME/.nvm"; NODE=""; if [ -s "$NVM_DIR/nvm.sh" ]; then . "$NVM_DIR/nvm.sh" --no-use >/dev/null 2>&amp;1; NODE="$(nvm which default 2>/dev/null)"; fi; [ -x "$NODE" ] || NODE="$(command -v node)"; [ -x "$NODE" ] || { echo "[bridge] no node found" >&amp;2; exit 78; }; export PATH="$(dirname "$NODE"):$HOME/.local/bin:$PATH"; exec "$NODE" scripts/local-cli-bridge.mjs</string>
    </array>

    <!-- Selects which copy of the script runs, and therefore which env file (rule 1). -->
    <key>WorkingDirectory</key>
    <string>/ABSOLUTE/PATH/TO/local-cli-bridge</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/ABSOLUTE/PATH/TO/HOME/.local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
        <key>HOME</key>
        <string>/ABSOLUTE/PATH/TO/HOME</string>
    </dict>

    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>30</integer>
    <key>StandardOutPath</key>
    <string>/ABSOLUTE/PATH/TO/HOME/Library/Logs/local-cli-bridge.log</string>
    <key>StandardErrorPath</key>
    <string>/ABSOLUTE/PATH/TO/HOME/Library/Logs/local-cli-bridge.log</string>
</dict>
</plist>
```

`plutil -lint <file>` before loading. XML requires `&` escaped as `&amp;`, which bites on the
`2>&1` and `>&2` inside the shell one-liner.

```sh
TARGET="gui/$(id -u)/com.example.local-cli-bridge"

launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.example.local-cli-bridge.plist
launchctl kickstart -k "$TARGET"      # restart (also the way to reload config)
launchctl bootout "$TARGET"           # stop
launchctl print "$TARGET" | grep -E "state|pid|last exit code"
```

> **`launchctl stop` does not stop a `KeepAlive` job.** Neither does `kill`. launchd revives
> the process within a second and you get the same service back under a new PID. `bootout`
> unloads the job and is the only real stop; `kickstart -k` is the correct restart.

Reading `launchctl list | grep local-cli-bridge`: first column is the PID (`-` means not
running), second is the **last exit code**. A `-` with a non-zero code is a crash loop —
retried every `ThrottleInterval` seconds.

---

## Linux — systemd (user unit)

Save as `~/.config/systemd/user/local-cli-bridge.service`. `%h` expands to your home
directory, so the only literal path needed is the checkout.

```ini
[Unit]
Description=Local CLI Bridge (OpenAI-compatible shim over a locally authenticated CLI)
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/ABSOLUTE/PATH/TO/local-cli-bridge

# Rules 2 and 3: resolve Node via nvm, put the matching CLI bin dir on PATH.
ExecStart=/bin/sh -c 'export NVM_DIR="$HOME/.nvm"; \
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" --no-use >/dev/null 2>&1; \
  NODE="$(nvm which default 2>/dev/null)"; [ -x "$NODE" ] || NODE="$(command -v node)"; \
  export PATH="$(dirname "$NODE"):$HOME/.local/bin:$PATH"; \
  exec "$NODE" scripts/local-cli-bridge.mjs'

Restart=always
RestartSec=30
StandardOutput=append:%h/.local/state/local-cli-bridge.log
StandardError=append:%h/.local/state/local-cli-bridge.log

[Install]
WantedBy=default.target
```

```sh
mkdir -p ~/.local/state
systemctl --user daemon-reload
systemctl --user enable --now local-cli-bridge
systemctl --user restart local-cli-bridge
systemctl --user stop local-cli-bridge
systemctl --user status local-cli-bridge
journalctl --user -u local-cli-bridge -f
```

> **Headless boxes need lingering.** By default a user manager stops when your last session
> ends, which kills the bridge when you log out of SSH — exactly the machine you most want it
> on. Enable it once:
>
> ```sh
> sudo loginctl enable-linger "$USER"
> ```

If your distro ships an ancient systemd without `append:`, drop the `Standard*` lines and read
the journal instead.

---

## Windows

There is no per-user service manager equivalent to launchd or `systemd --user`, and the
constraints above land harder: a Windows *service* runs in a non-interactive session, whereas
the backend CLI needs **your** interactive-user credentials. So the recommended answer is not
a service at all.

| Approach | Verdict |
| --- | --- |
| **Task Scheduler**, trigger *At log on*, "Run only when user is logged on" | **Recommended.** Runs as you, so CLI auth resolves. Set *If the task fails, restart every 1 minute* for crash recovery. |
| **NSSM** / **WinSW** (wrap `node` as a real service) | Works, but runs in session 0 as `LocalSystem` unless you configure it to run as your account **with a stored password**. Pick this only if the machine must serve while logged out. |
| `sc.exe create` directly | Not viable — `node.exe` is not a service binary and will be killed for not responding to the SCM. |
| **WSL2** + the systemd recipe above | Cleanest if your CLIs are installed inside WSL. Note WSL's `localhost` forwarding to Windows and that the tunnel must run on the same side as the bridge. |

Windows notes, in the same order as the three rules:

1. Set **Start in** to the checkout directory, or pass `BRIDGE_ENV_FILE` as an absolute path.
2. Task Scheduler gives you the user's environment only if you set *Start in*; still prefer
   absolute paths in the action.
3. **nvm-windows works differently from nvm** — it swaps a `%NVM_SYMLINK%` junction (commonly
   `C:\Program Files\nodejs`) rather than rewriting PATH per shell. That junction path is
   stable across version switches, so on Windows pointing at it *is* the dynamic answer:
   `C:\Program Files\nodejs\node.exe`. There is no `nvm which default` equivalent.

A minimal registration:

```powershell
$action  = New-ScheduledTaskAction -Execute "C:\Program Files\nodejs\node.exe" `
             -Argument "scripts\local-cli-bridge.mjs" `
             -WorkingDirectory "C:\path\to\local-cli-bridge"
$trigger = New-ScheduledTaskTrigger -AtLogOn
$set     = New-ScheduledTaskSettingsSet -RestartInterval (New-TimeSpan -Minutes 1) -RestartCount 3
Register-ScheduledTask -TaskName "local-cli-bridge" -Action $action -Trigger $trigger -Settings $set
```

Task Scheduler does not capture stdout. Redirect inside the action (`cmd /c ... >> log 2>&1`)
if you want a log file.

---

## Verify it, don't assume it

A bridge on the wrong config starts cleanly and looks healthy, so check the things that
actually differ:

```sh
# 1. the loader found your env file — NOT "no env file found"
grep -E "setting\(s\)|no env file found" <logfile> | tail -1

# 2. the advertised model list is yours, not the built-in default
curl -s localhost:8787/v1/models -H "Authorization: Bearer $BRIDGE_API_KEY"

# 3. a real completion per backend, proving PATH reaches each CLI (rule 2)
curl -s localhost:8787/v1/chat/completions -H "Authorization: Bearer $BRIDGE_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"haiku","messages":[{"role":"user","content":"reply with exactly: OK"}]}'

# 4. it survives death
kill -9 <pid> && sleep 35 && <status command>     # a new PID must appear
```

Step 4 is worth doing once. `KeepAlive` / `Restart=always` are easy to get subtly wrong, and
the failure only shows up the first time the process dies unattended.

## See also

- [LOCAL_BRIDGE.md](./LOCAL_BRIDGE.md) — settings reference
- [REMOTE_BRIDGE.md](./REMOTE_BRIDGE.md) — tunnel and Access in front of the service
- [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) — symptom table
