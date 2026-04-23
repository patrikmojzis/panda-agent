# Telepathy

Telepathy is Panda's screen bridge for a paired Mac.

The shape is intentionally boring:

- Panda runtime owns a localhost-only WebSocket hub
- a detached macOS receiver connects to that hub
- the receiver captures a screenshot on demand
- Panda stores the result as a normal artifact
- device discovery happens through `session.agent_telepathy_devices`, not another tool

That last bit matters. We are trying to keep tool count low, so `telepathy_screenshot` is the action tool and Postgres is the discovery surface.

## Current Scope

Implemented now:

- `telepathy_screenshot(deviceId)`
- per-device durable token registry in Postgres
- `session.agent_telepathy_devices` readonly view for discovery
- screenshot artifact persistence under Panda media paths
- macOS Swift menu bar receiver with connection status, kill switch, and test screenshot
- first-run onboarding/settings window for local config
- saved config under `~/Library/Application Support/Panda Telepathy/config.json`
- packaged `.app` bundle builder
- optional SSH tunnel supervision from the receiver app
- brief reconnect grace window before screenshot requests fail on a just-starting device
- launch-at-login toggle backed by `SMAppService.mainApp`
- bundled panda app icon
- Developer ID signing auto-pick in the bundle build script
- explicit receiver states for waiting, reconnecting, connected, and screen-recording denial

Not implemented yet:

- command execution
- notarized distribution polish
- nicer receiver diagnostics

## File Map

Panda runtime:

- `src/domain/telepathy/`
- `src/integrations/telepathy/protocol.ts`
- `src/integrations/telepathy/hub.ts`
- `src/panda/tools/telepathy-screenshot-tool.ts`

macOS receiver:

- `apps/panda-receiver-macos/Package.swift`
- `apps/panda-receiver-macos/Sources/PandaReceiverMacOS/Config.swift`
- `apps/panda-receiver-macos/Sources/PandaReceiverMacOS/ConfigStore.swift`
- `apps/panda-receiver-macos/Sources/PandaReceiverMacOS/Receiver.swift`
- `apps/panda-receiver-macos/Sources/PandaReceiverMacOS/TunnelSupervisor.swift`
- `apps/panda-receiver-macos/Sources/PandaReceiverMacOS/LaunchAtLogin.swift`
- `apps/panda-receiver-macos/Sources/PandaReceiverMacOS/SettingsWindow.swift`
- `apps/panda-receiver-macos/Sources/PandaReceiverMacOS/MenuBarApp.swift`
- `apps/panda-receiver-macos/Sources/PandaReceiverMacOS/main.swift`
- `scripts/build-panda-receiver-app.sh`

## Runtime Env

Set these where Panda runs:

```bash
TELEPATHY_ENABLED=true
TELEPATHY_PORT=8787
TELEPATHY_HOST=0.0.0.0
TELEPATHY_PATH=/telepathy
```

For the Docker stack, set both `TELEPATHY_ENABLED=true` and `TELEPATHY_PORT=8787`.
`TELEPATHY_ENABLED=true` is optional only in simpler local setups where you already set `TELEPATHY_PORT`.
If neither is set, Panda does not start the telepathy hub and does not expose `telepathy_screenshot`.
Use `127.0.0.1` only for local non-Docker runs.

## Pairing

Generate or rotate a device token with the CLI:

```bash
pnpm exec tsx src/app/cli.ts telepathy register local-mac \
  --agent panda \
  --label "Local Mac" \
  --db-url postgresql://localhost/panda
```

That prints a fresh token. Paste it into Panda Telepathy settings.

Useful management commands:

```bash
pnpm exec tsx src/app/cli.ts telepathy list --agent panda --db-url postgresql://localhost/panda
pnpm exec tsx src/app/cli.ts telepathy disable local-mac --agent panda --db-url postgresql://localhost/panda
pnpm exec tsx src/app/cli.ts telepathy enable local-mac --agent panda --db-url postgresql://localhost/panda
```

## Device Discovery

The agent should inspect connected Macs through SQL:

```sql
SELECT device_id, label, connected, enabled
FROM session.agent_telepathy_devices
ORDER BY device_id;
```

That view is agent-scoped. It only shows devices registered for the current agent.

## Receiver Run

Build:

```bash
swift build --package-path apps/panda-receiver-macos
```

Run:

```bash
apps/panda-receiver-macos/.build/arm64-apple-macosx/debug/panda-receiver-macos \
  --server ws://127.0.0.1:8787/telepathy \
  --agent panda \
  --device-id local-mac \
  --token 'paste-token-here' \
  --label "Local Mac"
```

Running the binary launches a menu bar app. The menu shows:

- current connection state
- device label and id
- screen recording permission state
- a `Capture Enabled` kill switch
- `Take Test Screenshot`
- `Settings…`
- `Open At Login`
- `Reveal Saved Config`
- quit

For real day-to-day use, prefer the packaged app in `/Applications`.
The raw debug binary is for development, smoke tests, and swearing at Apple.

If no saved config exists, the app opens a settings window on launch instead of failing.

On macOS 14 and newer, the receiver uses `ScreenCaptureKit` to capture the primary display, which fixes fullscreen Spaces. On macOS 13, it falls back to `/usr/sbin/screencapture`.

If you leave the SSH tunnel fields empty, the receiver connects directly to the server URL.

If you set an SSH host, the receiver owns the tunnel itself and connects through `ssh -L`. That is the real deployment lane when Panda stays closed from the public internet.

Useful tunnel flags:

```bash
--ssh-host clankerino
--ssh-user patrik
--ssh-port 22
--tunnel-local-port 43190
--no-ssh-tunnel
```

Tunnel mode expects key-based SSH auth. The app forces `BatchMode=yes`, so it fails fast instead of hanging on an invisible password prompt.

## App Bundle

Build the `.app` bundle:

```bash
scripts/build-panda-receiver-app.sh
```

That produces:

```text
dist/panda-telepathy-macos/Panda Telepathy.app
```

The script prefers a `Developer ID Application: ...` identity when one exists. Until the bundle is notarized, `spctl` will still reject it. That is normal.

For local login-item testing, install it into `/Applications`:

```bash
cp -R "dist/panda-telepathy-macos/Panda Telepathy.app" "/Applications/Panda Telepathy.app"
```

First-time setup from Terminal:

```bash
"/Applications/Panda Telepathy.app/Contents/MacOS/panda-receiver-macos" \
  --server ws://127.0.0.1:8787/telepathy \
  --agent panda \
  --device-id local-mac \
  --token 'paste-token-here' \
  --label "Local Mac" \
  --save-config
```

After that, the installed app can relaunch with no CLI args and load the saved config automatically.

Useful management commands:

```bash
"/Applications/Panda Telepathy.app/Contents/MacOS/panda-receiver-macos" --print-config-path
"/Applications/Panda Telepathy.app/Contents/MacOS/panda-receiver-macos" --launch-at-login status
"/Applications/Panda Telepathy.app/Contents/MacOS/panda-receiver-macos" --launch-at-login enable
"/Applications/Panda Telepathy.app/Contents/MacOS/panda-receiver-macos" --launch-at-login disable
```

## SSH Tunnel Example

```bash
"/Applications/Panda Telepathy.app/Contents/MacOS/panda-receiver-macos" \
  --server ws://127.0.0.1:8787/telepathy \
  --agent panda \
  --device-id home-mac \
  --token 'paste-token-here' \
  --label "Home Mac" \
  --ssh-host clankerino \
  --ssh-user patrik \
  --save-config
```

That makes the app own a local forward that looks like this in spirit:

```bash
ssh -NT -L 127.0.0.1:43190:127.0.0.1:8787 patrik@clankerino
```

The WebSocket then connects to the forwarded local port instead of talking to Panda directly.

## Local Verification

I verified the secured flow locally with:

- `panda telepathy register ...`
- Panda querying `session.agent_telepathy_devices`
- `telepathy_screenshot("local-mac")`
- a real screenshot artifact saved at:

```text
/Users/patrikmojzis/.panda/agents/panda/media/telepathy/2b3c56d5-08b0-4870-8c92-bbf783d41f9e/local-mac/1776883391138-1e538f7d-9582-4c41-ac00-90f5772346cb.jpg
```

One smoke-harness gotcha: `--reuse-db` can reuse old thread history, so stale tool errors can poison the `--forbid-tool-error` assertion even when the latest telepathy run succeeded. The telepathy path itself worked.

## Next Steps

If this graduates from prototype status, the next sane moves are:

1. improve receiver diagnostics so reconnect failures say what actually broke
2. wire the real server deployment once you are ready to touch `clankerino`
3. notarize the app bundle once the packaging lane stops moving
4. keep remote commands out until auth and device management stop looking prototype-y
