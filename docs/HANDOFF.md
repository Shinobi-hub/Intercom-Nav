# Handoff: Intercom Nav

You are continuing **Intercom Nav**, a group motorcycle-ride app, in this repo (npm workspaces; quote the
checkout path if it contains spaces).
The app is integrated, verified end to end (unit, E2E in dev and production, Android emulator) and documented;
see "Current state". What's left needs real hardware ("Open items"). Do not rebuild anything that works.

## Working rules (credits are limited)

- **Work alone. Do not spawn subagents.** Six parallel agents repeatedly exhausted the account's session limit.
- Read selectively: `docs/ARCHITECTURE.md` first, then only the files the current step needs. Prefer
  `grep -n` and line ranges over whole-file reads of large files.
- Keep command output short (`| tail -n 40`, `grep -E "FAIL|Error|✘"`). Iterate on one failing spec at a time
  (`--grep`), not the whole suite.
- Screenshots are expensive. Take them only to confirm a specific visual fix, a handful in total.
- Fix root causes in the owning module. Don't loosen a test unless the test's assumption is wrong, and say so when you do.
- Not a git repo. Don't commit unless the user asks.
- Stop every process you start (dev servers, LiveKit, emulator) before finishing.

## What the app does

4–8 riders join a ride by a 6-character code or link.

**Map and route**
- A live map shows every rider, with markers gliding smoothly between GPS fixes.
- The leader sets a shared destination. The server routes it (Valhalla motorcycle profile; mock provider in tests), and everyone sees the route, distance and ETA.

**Voice and music**
- Group voice uses either a LiveKit SFU or a peer-to-peer mesh; the leader can switch it per ride.
- Music in the in-app player ducks to 30% whenever anyone talks. Voice activity detection runs locally on the mic and on each remote stream, in an AudioWorklet, and is tuned against wind noise.

**Alerts**
- SOS: hold for 1.5 s to send. Every other rider gets a siren that is never ducked, a flashing overlay, directions, and an "I'm coming" button.
- Break requests: a toast, a chime and an optional spoken announcement.

**Screen-off**
- Handled by the Capacitor Android app: a foreground service of type location + microphone, plus Bluetooth headset routing.
- The iOS project is written but can't be compiled here.

The full design is in `docs/ARCHITECTURE.md`: decisions, protocol delivery rules, audio graph, stores and services, and testing.

## Current state (finished 2026-10-21)

The remaining-work list from the previous handoff is complete. Everything below was verified at the end of the session.

- `npm run typecheck` reports 0 errors in every workspace.
- `npx vitest run` passes: 50 files, 522 tests, plus 6 opt-in live-provider tests skipped.
- E2E (23 tests in 13 specs):
  - Dev servers: 22 passed. The production-only PWA spec is skipped there by design.
  - `E2E_PROD=1` (production build): 23/23 passed, including manifest, service worker and offline app shell.
- Android: the debug APK builds, and the screen-off check passes on the emulator: locked or not, silent or talking, and in forced deep Doze. Results and commands are in `docs/NATIVE.md`.
- iOS can't be compiled here; `docs/NATIVE.md` has the Xcode build steps and an on-device checklist.

### What changed in this session

| Area | Change |
|---|---|
| LiveKit dev | `npm run livekit:dev` → `scripts/livekit-dev.mjs` works out the LAN IPv4 at start (or uses `NODE_IP`) and advertises it. With `127.0.0.1`, ICE failed after network changes. |
| VAD (`features/audio/dsp/vadCore.ts`) | Wind gate. In wind (low band dominating a non-speech frame in the last 5 s), an onset must also be voiced (pitch periodicity ≥ 0.7). Cause: Chrome's noise suppression and AGC turn gusts into speech-like jumps, and Opus DTX adds comfort-noise steps, so the old VAD read 7% (sender) and 32% (receiver) of wind as speech. Outside wind nothing changed. New captured fixtures: `wind-captured.wav` and `wind-received.wav`. |
| Mesh (`features/voice/mesh`) | Fixed an intermittent deadlock on switching to mesh. A rider still tearing down LiveKit dropped the leader's offer, and the impolite side then ignored the other's offer. Signals are now held until the mesh starts (`bufferedSignaling` in `VoiceManager`), and an unanswered offer rebuilds the link (5 s, backing off to 60 s). A link that isn't connected after 10 s also starts over: Chrome sometimes wedges ICE gathering after a glare rollback (seen as 1 in 12 runs, caught with instrumented E2E). |
| Shared timing | `TIMING.locHeartbeatMaxFixAgeMs` (30 s) replaces the geo-local value; `HEARTBEAT_MAX_FIX_AGE_MS` is kept as an alias. |
| Test contract | Added the `settings-duck-own-voice` id. The `testIds.ts` header now documents `dock-break` states, leader-only `dest-*` controls, `join-color-*` swatches and `speechSynthesis`. |
| Specs and helpers whose assumptions were wrong | These were corrected; no assertions were loosened. **route**: picking a destination closes the sheet itself; non-leader controls are asserted absent. **Touch-target audit**: measures real hit areas (`::after` extensions, wrapping labels) and ignores captions of visible controls. **location**: also pins the heartbeat window, where stale is about 40 s after the last real fix. |
| New tests | Controller offline recovery. VAD captured fixtures and the wind gate. Mesh lost and early offers, and `bufferedSignaling`. Colour swatches. |
| Android check | `scripts/android-screen-off-check.mjs` drives the app's WebView with Playwright's `_android` API; `connectOverCDP` fails on WebView. |

## Open items (need hardware)

1. **iOS**: build in Xcode, then verify background voice capture on a locked iPhone (checklist in `docs/NATIVE.md`).
2. **Real Android phones**:
   - Bluetooth helmet routing, real wind recorded at speed, and battery/OEM savers.
   - Whether the WebView keep-alive is needed. WebView 124 on the emulator never hid background pages, so the keep-alive was a no-op there, and the negative control kept passing.
3. The E2E audio specs are timing-sensitive. Don't run CPU-heavy jobs (Gradle, the emulator) during a run.

## Environment

- macOS Apple Silicon. Node 26, npm 12. TypeScript 5.9, Vite 7, Vitest 4, React 19, Zustand 5, MapLibre GL 5, livekit-client 2.23, Socket.io 4.8, Fastify 5, Capacitor 8, Playwright 1.64 (Chromium 1248 installed).
- Installed tools:
  - `livekit-server` 1.13 (Homebrew)
  - JDK 21 (`openjdk@21`)
  - Android SDK (platforms 35/36, build-tools 35, emulator, image android-35 google_apis arm64)
  - `ffmpeg`, `say`, `afconvert`
- **No Xcode / CocoaPods**: iOS cannot be built here.
- Handy commands:
  - `npm run dev`: server on :8787 + web on :5173.
  - `npx vitest run --project web src/features/audio`: one area's tests.
  - Demo UI with no server: http://localhost:5173/?demo=1.
