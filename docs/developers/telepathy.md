# Telepathy

> Legacy/transitional: the WebSocket Telepathy lane remains for existing pull
> screenshot parity while Gateway push and command parity are rolled out. New
> macOS receiver push setup uses Gateway HTTP (`--gateway http://...`) and
> `mac.context.push`; see `docs/developers/gateway.md`. Do not set up new
> Gateway-mode receivers with `ws://` / `--server`.

Telepathy is Panda's legacy WebSocket desktop bridge for a paired Mac.

The shape is intentionally boring:

- Panda runtime owns a localhost-only WebSocket hub
- a detached macOS receiver connects to that hub
- the receiver either responds to agent pull requests or pushes user-triggered context
- Panda stores screenshots, voice notes, and other telepathy payloads as normal artifacts
- device discovery happens through `session.agent_telepathy_devices`, not another tool

That last bit matters. We are trying to keep tool count low, so `telepathy_screenshot` stays the action tool and Postgres stays the discovery surface.

## Legacy Transport Shape

Legacy WebSocket Telepathy has two lanes:

- pull: Panda asks the device for something and gets a direct response back
- push: the device sends Panda context because you triggered it locally

Current contracts:

- pull: `screenshot.request` / `screenshot.result`
- push: `context.submit`

`context.submit` is modular on purpose. It carries typed `items[]`, so voice and screenshots are separate concepts that can travel together or alone.

Current item types:

- `audio`
- `image`
- `text`

That gives us sane long-term flexibility:

- push-to-talk voice only
- push-to-talk voice + screenshot
- future screen-only or clipboard pushes without inventing a new protocol every time

## Current Scope

Implemented now:

- `telepathy_screenshot(deviceId)`
- legacy `context.submit` push ingress for WebSocket telepathy-triggered context
- per-device durable token registry in Postgres
- `session.agent_telepathy_devices` readonly view for discovery
- screenshot artifact persistence under Panda media paths
- pushed audio and screenshot artifact persistence under Panda media paths
- macOS Swift menu bar receiver; current pushes use Gateway HTTP, while legacy WebSocket pull remains documented here
- global push-to-talk hotkeys:
  - `Ctrl+Opt+Cmd+V` for voice only
  - `Ctrl+Opt+Cmd+S` for voice + screenshot
- first-run onboarding/settings window for local config
- saved config under `~/Library/Application Support/Panda Telepathy/config.json`
- packaged `.app` bundle builder
- optional SSH tunnel supervision from the receiver app
- brief reconnect grace window before screenshot requests fail on a just-starting device
- launch-at-login toggle backed by `SMAppService.mainApp`
- bundled panda app icon
- Developer ID signing auto-pick in the bundle build script
- explicit receiver states for waiting, reconnecting, connected, and screen-recording denial
- microphone permission state and request flow in the menu bar app

Not implemented yet:

- Gateway pull-command parity
- command execution
- spoken reply
- local transcription
- notarized distribution polish
- nicer receiver diagnostics

## File Map

Panda runtime:

- `src/domain/telepathy/`
- `src/integrations/telepathy/protocol.ts`
- `src/integrations/telepathy/hub.ts`
- `src/integrations/telepathy/config.ts`
- `src/integrations/telepathy/context-media.ts`
- `src/integrations/telepathy/helpers.ts`
- `src/integrations/telepathy/screenshot-artifact.ts`
- `src/integrations/telepathy/websocket.ts`
- `src/prompts/channels/telepathy.ts`
- `src/app/runtime/telepathy-context-ingress.ts`
- `src/panda/tools/telepathy-screenshot-tool.ts`

Store shape:

- `PostgresTelepathyDeviceStore` is the concrete device registry.
- The websocket hub and `device.hello` auth path define their own narrow store
  interfaces. Do not recreate a broad `domain/telepathy/store.ts` interface for
  one Postgres adapter; registration/listing/admin methods do not belong in the
  live socket seam.

macOS receiver:

- `apps/panda-receiver-macos/Package.swift`
- `apps/panda-receiver-macos/Sources/PandaReceiverMacOS/Config.swift`
- `apps/panda-receiver-macos/Sources/PandaReceiverMacOS/ConfigStore.swift`
- `apps/panda-receiver-macos/Sources/PandaReceiverMacOS/GatewayClient.swift`
- `apps/panda-receiver-macos/Sources/PandaReceiverMacOS/GlobalHotkeyService.swift`
- `apps/panda-receiver-macos/Sources/PandaReceiverMacOS/PushToTalkController.swift`
- `apps/panda-receiver-macos/Sources/PandaReceiverMacOS/Receiver.swift`
- `apps/panda-receiver-macos/Sources/PandaReceiverMacOS/ScreenshotCaptureService.swift`
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

## Legacy WebSocket Pairing

For current Gateway Mac pushes, register a Gateway device token instead (see `docs/developers/gateway.md`). The commands below are only for legacy WebSocket Telepathy pairing and old receiver builds.

Generate or rotate a legacy Telepathy device token with the CLI:

```bash
pnpm exec tsx src/app/cli.ts telepathy register local-mac \
  --agent panda \
  --label "Local Mac" \
  --db-url postgresql://localhost/panda
```

That prints a fresh legacy token. Paste it only into old WebSocket Telepathy settings; Gateway-mode settings expect a Gateway device token.

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

Current Gateway push setup uses HTTP and rejects WebSocket URLs:

```bash
apps/panda-receiver-macos/.build/arm64-apple-macosx/debug/panda-receiver-macos \
  --gateway http://127.0.0.1:8094 \
  --agent panda \
  --device-id local-mac \
  --token 'paste-gateway-device-token-here' \
  --label "Local Mac"
```

Legacy WebSocket receiver builds used this shape for pull screenshots:

```bash
apps/panda-receiver-macos/.build/arm64-apple-macosx/debug/panda-receiver-macos \
  --server ws://127.0.0.1:8787/telepathy \
  --agent panda \
  --device-id local-mac \
  --token 'paste-legacy-telepathy-token-here' \
  --label "Local Mac"
```

Running the binary launches a menu bar app. The menu shows:

- current connection state
- device label and id
- screen recording permission state
- microphone permission state
- push-to-talk status
- shortcut summary
- a `Gateway Enabled` kill switch
- `Request Microphone Access`
- `Take Test Screenshot`
- `Send Clipboard Text`
- `Send Screenshot Now`
- `Settings…`
- `Open At Login`
- `Reveal Saved Config`
- quit

For real day-to-day use, prefer the packaged app in `/Applications`.
The raw debug binary is for development, smoke tests, and swearing at Apple.

If no saved config exists, the app opens a settings window on launch instead of failing.

On macOS 14 and newer, the receiver uses `ScreenCaptureKit` to capture the primary display, which fixes fullscreen Spaces. On macOS 13, it falls back to `/usr/sbin/screencapture`.

Push-to-talk uses `AVAudioRecorder` and the app bundle now declares `NSMicrophoneUsageDescription`, so the packaged app can request mic access cleanly instead of dying in a ditch.

If you leave the SSH tunnel fields empty, the receiver connects directly to the Gateway URL.

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

The bundle also includes `NSMicrophoneUsageDescription`, because without that push-to-talk is just decorative fiction.

For local login-item testing, install it into `/Applications`:

```bash
cp -R "dist/panda-telepathy-macos/Panda Telepathy.app" "/Applications/Panda Telepathy.app"
```

First-time setup from Terminal:

```bash
"/Applications/Panda Telepathy.app/Contents/MacOS/panda-receiver-macos" \
  --gateway http://127.0.0.1:8094 \
  --agent panda \
  --device-id local-mac \
  --token 'paste-gateway-device-token-here' \
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
  --gateway http://127.0.0.1:8094 \
  --agent panda \
  --device-id home-mac \
  --token 'paste-gateway-device-token-here' \
  --label "Home Mac" \
  --ssh-host clankerino \
  --ssh-user patrik \
  --save-config
```

That makes the app own a local forward that looks like this in spirit:

```bash
ssh -NT -L 127.0.0.1:43190:127.0.0.1:8094 patrik@clankerino
```

The Gateway HTTP client then talks to the forwarded local port instead of exposing Panda publicly.

## Push-To-Talk

The first push feature is intentionally simple:

- hold `Ctrl+Opt+Cmd+V` to record a voice note
- hold `Ctrl+Opt+Cmd+S` to record a voice note and attach a fresh screenshot
- release the keys to stop recording and send the context

In Gateway mode, push-to-talk uploads `audio/m4a` plus an optional `image/jpeg` screenshot through `/v2/attachments`, then posts one `mac.context.push` event through `/v2/events`.

That means Panda can:

- use `whisper` on audio attachment paths
- use `view_media` on screenshot attachment paths
- answer with real desktop context instead of guessing what "this" means

The Gateway push lane is event-based. It does not replace `telepathy_screenshot(deviceId)` yet.
It sits next to it:

- pull: Panda asks the device for a screenshot
- push: the device sends Panda user-triggered context

## Local Verification

Gateway PR1 manual verification should cover Gateway setup, `mac.context.push` allow-listing, push-to-talk voice-only, voice+screenshot, `Send Clipboard Text`, and `Send Screenshot Now`.

Legacy WebSocket verification used:

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
