# paseo-bridge-pi

Start `pi` in a terminal and have that live session automatically appear in
[Paseo](https://paseo.sh) — readable and steerable from your phone — while the
TUI stays fully usable at your desk. No changes to Paseo required.

This fork targets **Pi 1.5.0 + Paseo 0.15.3** and retains the upstream
[caesay/paseo-bridge-pi](https://github.com/caesay/paseo-bridge-pi) attribution.

## Install

1. Install the pi extension:

   ```
   pi install git:github.com/hiimjako/paseo-bridge-pi
   ```

2. Inside pi, set up the Paseo side (points Paseo's pi provider at the bridge
   shim):

   ```
   /paseo-bridge install
   ```

3. Restart the Paseo daemon (`paseo restart`, or restart the desktop app).

Existing custom provider commands are deliberately not overwritten. Preserve any
fixed launcher/session-directory arguments when deliberately configuring the shim;
set `PI_REAL_BIN` to the original launcher. Do not remove an existing override
just to bypass this check.

Every new terminal pi session now shows up in Paseo automatically
(auto-connect is on by default). Make sure the `paseo` CLI is reachable:
either on `PATH`, or set `PASEO_CLI` to its full path (the desktop app
bundles it at `.../Paseo/resources/bin/paseo.cmd` on Windows).

## Slash commands

| Command | Effect |
|---|---|
| `/paseo-bridge install` | Register the shim as Paseo's pi provider command (`$PASEO_HOME/config.json`, default `~/.paseo/config.json`). |
| `/paseo-bridge uninstall` | Remove the shim registration (only if it points at this package). |
| `/paseo-bridge auto on\|off` | Whether new TUI sessions connect to Paseo automatically (default: on). |
| `/paseo-bridge connect` | Connect the current session to Paseo now. |
| `/paseo-bridge disconnect` | Stop bridging the current session. |
| `/paseo-bridge status` | Show shim / auto-connect / session state. |

## What you get

- Terminal sessions appear in Paseo within seconds, with live streaming
  tokens; prompts sent from the app run in the TUI (which stays usable).
- Model and effort changes sync both ways.
- After your first message, a session title is generated with the current
  model and applied to the Paseo agent, the workspace (prefixed `[TUI]`), and
  pi's session list.
- Closing the TUI mid-conversation leaves a helpful error in Paseo with the
  exact `pi --session <id>` command to resume, and Paseo's Fork keeps working.
- Reopening a session in a terminal reattaches the existing Paseo agent
  instead of creating a duplicate.

## How it works

Two components:

1. **Extension** (`extension/index.ts`) — loaded by every terminal pi. On
   session start it opens a named pipe (Windows) / unix socket keyed on the
   session file path, speaks pi's RPC JSONL dialect over it, and registers the
   session with the Paseo daemon via `paseo import`. It also keeps Paseo's
   view in sync (model/effort/titles) using the supported authenticated Paseo client.
2. **Shim** (`shim/pi-paseo-shim.js`) — configured as Paseo's pi provider
   command. Terminal adoption leaves a persistent ownership record keyed by the
   canonical session path. The shim attaches only to a live terminal owner. A
   missing/unreachable socket, timeout, malformed ownership record, or live native
   owner fails closed: it never unlinks an unknown/live socket and never launches
   a second Pi for an adopted session. Unadopted/Paseo-native sessions still launch
   real Pi with unchanged arguments. Native resumed processes also claim ownership.

**An adopted session requires its terminal TUI to remain open.** After closing it,
reopen it explicitly with `pi --session <file-or-id>`; Paseo cannot take over that
file automatically. Disconnect also retains adoption. A clean close records a
released owner; a crashed owner is recoverable only when its PID is positively
absent. PID reuse, permission errors, and interrupted ownership guards fail closed
and may require manual investigation. Keep the ownership metadata: deleting it
removes the adoption guarantee.

Persistent ownership/adoption metadata lives beside the canonical session file in
`.paseo-bridge/<hash>/` (private `0700` directories, `0600` records). Unix owner-only
sockets alone live under `/tmp/pi-paseo-<uid>`; runtime cleanup/reboot does not erase
terminal adoption. Windows uses a named pipe.
Neither depends on terminal/daemon `HOME` or `XDG_RUNTIME_DIR`. Symlinked session
paths resolve to the same rendezvous. Existing runtime directories must be private
and user-owned. This trusts other processes running as the same OS user; it is not
an independent authentication boundary. It cannot protect arbitrary uninstrumented
Pi processes or manual concurrent session-file edits. Windows behavior is not
covered by the Unix socket tests.

State sync defaults to the selected `PASEO_HOME` (otherwise `~/.paseo`) instance's
`paseo.pid` listener, not a guessed loopback address. The native client completes
its authenticated handshake before requests. It supports `PASEO_PASSWORD` and
native local credentials, reread on each new connection; a local token is used
only when the target matches that home's instance listener. Explicit hosts,
including forwarders, need their own valid authentication if not an exact match.
Password, relay, and network protections are not changed. Subsequent sync operations
open fresh connections, allowing daemon restarts without retaining stale credentials.

## Uninstall

Inside pi:

```
/paseo-bridge uninstall
pi remove git:github.com/hiimjako/paseo-bridge-pi
```

Then restart the Paseo daemon.

## Development install

Working from a checkout instead of a pi package:

```
git clone https://github.com/hiimjako/paseo-bridge-pi
cd paseo-bridge-pi
npm install
npm run dev-install    # registers the checkout's extension path + shim
```

`npm run dev-uninstall` reverses it. Both registrations reference the
checkout by absolute path, so re-run it if you move the checkout. This is
for development only — the supported install is the pi package flow above.

After updating the extension, run `/reload` in each terminal Pi session when idle.
Restarting Paseo alone does not reload a terminal-owned bridge.

## Environment variables

| Variable | Effect |
|---|---|
| `PI_PASEO_BRIDGE=off` | Disable the extension entirely. |
| `PI_PASEO_BRIDGE_NO_IMPORT=1` | Open the bridge pipe but skip `paseo import` (session won't auto-appear). |
| `PI_PASEO_BRIDGE_NO_TITLE=1` | Skip LLM title generation after the first user message. |
| `PI_PASEO_BRIDGE_DEBUG=1` | Log to `~/.pi/paseo-bridge/debug.log`. |
| `PI_PASEO_BRIDGE_FORCE=1` | Activate even when pi is not in TUI mode (testing only). |
| `PASEO_CLI` | Path to the paseo CLI used for registration. |
| `PASEO_HOME` | Select the Paseo instance home for registration/config and sync (default `~/.paseo`). |
| `PASEO_HOST` | Explicit Paseo target for registration and native-client sync. |
| `PASEO_PASSWORD` | Password for the selected daemon, when required. |
| `PI_REAL_BIN` | Shim: path to the real pi binary (or its `cli.js`). |

## Known limitations (v1)

- With the generic `ask_user` extension's `ask-user:request/resolved` events,
  attached sessions also offer native Paseo choices and “Write my own answer…”
  input. The PC popup stays usable; the first completed answer wins. Attachment
  does not detect phone presence. Disconnect leaves the PC fallback available;
  questions are not replayed after daemon restarts. Card cleanup is best effort.
  Requires an event-enabled `ask_user` version; older versions and other
  extension UI dialogs remain TUI-only.
- Attached sessions cannot expose `clear_queue` through Pi's extension API. The
  standard Pi unknown-command response lets Paseo use its abort compatibility
  fallback; queued steering and follow-up messages are not cleared.
- Timeline rewind from Paseo is rejected for terminal-attached sessions
  (use Fork instead).
- Paseo's MCP tool injection (`pi-mcp-adapter`) does not apply to adopted
  sessions.
- Pi extension hooks do not expose runtime auto-retry notifications. The bridge
  nevertheless keeps Paseo active until `agent_settled`, across retries and queued
  continuations, and preserves the settled abort flag.
- Title generation sends up to 4,000 characters of the first user message to the
  selected model through Pi's model registry; disable with `PI_PASEO_BRIDGE_NO_TITLE`.
- Opt-in debug logging is not rotated. Do not enable it for long-running use.

## Verification

- During a remote-driven turn, exactly one process (the TUI) has the session
  `.jsonl` open for writing.
- With the shim installed but no terminal session running, launching a pi
  agent from Paseo behaves exactly as stock.

Run focused local checks with Node 22: `npm test`. Tests use temporary synthetic
sessions, Unix sockets/subprocesses, and an authenticated local test WebSocket
endpoint, without model requests or real user configuration.
