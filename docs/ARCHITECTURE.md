# Intercom Nav — Architecture

Group-ride companion for 4–8 motorcycle riders: live map of the group, a shared destination and
route, always-on group voice, an in-app music player that ducks when anyone talks, and SOS / break
alerts. Ships as a PWA and as a Capacitor native app (needed for screen-off operation).

## Decisions

| Topic | Decision |
|---|---|
| Client | Vite 7 + React 19 + TypeScript 5.9, Zustand 5, vite-plugin-pwa. No router library (two routes). |
| Server | Node 22+ · Fastify 5 · Socket.io 4. In-memory ride state, no database. Serves the built PWA. |
| Voice | **Both transports, switchable per ride**: LiveKit SFU (default when configured) and peer-to-peer mesh over our own Socket.io signaling. All riders in a ride always use the same transport; the leader can switch it. |
| Screen-off | **Required.** PWA first, wrapped with Capacitor 8. Android: foreground service (location + microphone) keeps GPS and voice alive with the screen off. iOS: background modes `audio` + `location`; voice-in-background must be verified on a device (WKWebView may suspend capture). |
| Navigation | **Shared destination + route.** Leader picks a destination; the server routes it (Valhalla motorcycle profile by default, OSRM/ORS/mock alternatives, straight-line fallback) and broadcasts it. Each rider sees the route line, distance remaining and ETA; turn-by-turn is out of scope. |
| Map | MapLibre GL JS 5 + OpenFreeMap vector tiles (no API key). Style URLs configurable. |
| Music | In-app player: local files (stored in IndexedDB) + CORS-enabled stream URLs, routed through the same AudioContext as voice so it can be ducked. |
| VAD | Runs locally on every stream (own mic + each remote rider) in an AudioWorklet: speech-band energy vs adaptive noise floor, wind tilt penalty, hysteresis, onset and hangover; in wind, an onset must also be voiced (pitch periodicity). |

## System

```
          Rider phones (PWA or Capacitor app)
   ┌──────────────────────────────────────┐
   │ React UI · MapLibre · audio engine   │
   │ GPS pipeline · wake lock · alerts    │
   └─────────┬──────────────────┬─────────┘
   Socket.io │                  │ WebRTC (Opus)
             ▼                  ▼
   ┌───────────────────┐  ┌──────────────────┐
   │ Node server       │  │ LiveKit SFU      │  (mesh mode: riders connect
   │ rides, locations, │  │ voice only:      │   directly to each other; the
   │ SOS, breaks,      │  │ 1 stream up,     │   Node server relays signaling)
   │ route, tokens     │  │ N−1 down         │
   └───────────────────┘  └──────────────────┘
```

Location and alerts never depend on voice. SOS is additionally mirrored over the voice transport's
data channel (`VoiceDataMessage`) and deduplicated by id, so either path can deliver it.

## Repository layout and ownership

```
packages/shared        Protocol contract: zod schemas, event maps, constants, geo math   (lead)
apps/server            Fastify + Socket.io ride server                                    (server agent)
apps/web/src/core      Stores, service interfaces, socket, controller, debug, test ids    (lead)
apps/web/src/features/map, geo, route   Map, markers, location pipeline, shared route     (map agent)
apps/web/src/features/audio, voice      Audio engine, VAD, ducking, music, transports     (audio agent)
apps/web/src/app, ui, features/alerts, dev, styles/global.css, index.html, public, vite.config.ts
                                         App shell, screens, alerts UI, PWA                (UI agent)
apps/web/src/platform, apps/web/android, apps/web/ios, apps/web/capacitor.config.ts
                                         Web + native platform adapters, Capacitor        (platform agent)
e2e/                                     Playwright multi-rider suite + audio fixtures    (e2e agent)
scripts/                                 livekit-dev (LAN-IP LiveKit), Android screen-off check
```

Rules for everyone:

- **Contracts are fixed.** `packages/shared`, `apps/web/src/core/*` (except where you own a file) and the
  exported names in each feature's `index.ts(x)` are the integration surface. If a contract is wrong or
  missing something, say so in your report instead of working around it.
- **No new dependencies** without asking the lead; everything planned is already installed.
- Stay inside the folders you own. Read anything.
- UI elements that tests touch use ids from `core/testIds.ts` and expose state via `data-*` attributes.
- Features register their debug hooks (`core/debug.ts`) so E2E tests can observe internals.
- Style with CSS modules (`*.module.css`) and the tokens in `styles/tokens.css`.
- `npm run typecheck` and `npm test` (Vitest) must pass for your area.

## Server

- Rides live in memory, keyed by a 6-character code from an unambiguous alphabet. A ride is deleted
  after `TIMING.rideIdleTtlMs` with nobody online.
- Riders are identified by a client-generated UUID plus a private secret (hashed server-side). Rejoining
  with the same id+secret resumes the slot; a different secret gets `rider_conflict`. A second socket for
  the same rider replaces the first (`session:replaced` to the old one).
- Disconnect ≠ leave: a disconnected rider stays in the ride as `online: false` until they leave or are
  pruned. Leadership moves after `TIMING.leaderGraceMs` offline (to the earliest-joined online rider).
- Every client payload is parsed with the zod schemas in `packages/shared`. Token-bucket rate limits per
  socket (`LIMITS`), join attempts per IP. Locations are never logged or persisted.
- Voice: `/api/config` and the join ack advertise available transports. LiveKit tokens are minted per
  rider (identity = rider id, room = `ride-<code>`, mic + data publish only). Mesh ICE servers come from
  env (static TURN credentials or coturn REST-style short-lived credentials).
- Routing and place search are proxied server-side (keys stay on the server, responses cached).
  Providers are pluggable; `mock` providers make tests deterministic and offline.

## Client architecture

`main.tsx` builds every service once and registers them (`core/services.ts`). Features talk through
service interfaces and the three Zustand stores (`core/store.ts`):

| Store | Holds | Written by |
|---|---|---|
| `useRideStore` | server mirror: ride, riders, route, SOS, breaks, connection | ride controller only |
| `useLocalStore` | `selfFix`, `gps` / `speaking`, `audio` / `voice` / `ui` | location service / audio engine / voice manager / UI |
| `useSettings` | persisted preferences | settings UI |

The **ride controller** (`core/rideController.ts`) is the orchestration layer: it owns the socket
handlers, starts and stops services, applies settings to the audio engine, and turns incoming alerts
into side effects (siren, chime, toast, TTS, vibration, native notification, map focus).

Start flow (one tap — "Start ride" — is the user gesture that unlocks audio):

1. `audio.unlock()` synchronously inside the tap handler.
2. Wake lock, audio session, native background service.
3. Socket connect → `ride:create` / `ride:join` → snapshot into `useRideStore`.
4. `location.start()`; `audio.setMicMode(settings.micMode)`; `voice.start(join.voice, selfId)`.

Reconnect: Socket.io reconnects automatically; on every `connect` after the first, the controller
re-sends `ride:join` and applies the fresh snapshot. Lifecycle resume re-acquires the wake lock,
resumes audio, restarts GPS if it died and nudges voice to reconnect.

## Location pipeline and markers

- Provider → filter (drop fixes worse than 50 m unless nothing better arrived for 20 s; drop out-of-order
  and physically impossible jumps) → light Kalman-style smoothing → heading/speed fill-in → send policy
  (`TIMING.locMinIntervalMs` / `locMinMoveM` / `locMinHeadingChangeDeg` / `locHeartbeatMs`).
- Heartbeats repeat the newest fix every `locHeartbeatMs` while it is younger than
  `TIMING.locHeartbeatMaxFixAgeMs` (30 s), so a rider whose GPS goes quiet (stopped at a light) stays
  live; others see them turn stale `riderStaleMs` after the last heartbeat, about 40 s after the last
  real fix. Receivers age markers from when an update arrived (their own clock), not from the fix time.
- Markers: each new fix starts a constant-velocity glide from the marker's *currently drawn* position to
  the new fix over the observed update interval (clamped 250–2000 ms). When the next fix is late the
  marker dead-reckons along heading at the last speed for up to `TIMING.deadReckonMaxMs`, then holds.
  Jumps over 2 km teleport. Stale after `riderStaleMs` (faded), lost after `riderLostMs` ("last seen").
  Heading interpolates the short way round. One rAF loop (≈30 fps, paused when hidden) drives all markers.
- Camera modes: follow me (optional heading-up), fit group, free (after any manual pan).

## Shared route

The leader searches (`place:search`) or drops a pin at the map center, then `route:set`. The server
computes the route from the leader's position (or a given origin) and broadcasts `route:updated`.
Clients project their own position onto the polyline for distance remaining, off-route detection
(>150 m) and ETA (`durationS × remaining / distance`), and show each rider's gap ahead/behind along the
route in the riders list.

## Audio engine

```
Signal
  Voices ─► rider gains ─► voice bus ─┬─► master ─► limiter ─► output (helmet)
  Music ──► music vol ─► duck gain ───┘
  Chimes ─► fx bus ─────────────────────► master
  Siren ──► alert gain (never ducked, bypasses master) ─────► output
  Mic ────► VOX gate ─► MediaStreamDestination ─► voice transport

Control
  VAD(mic, if duckOnOwnVoice) OR VAD(any rider) ─► duck controller ─► duck gain
    speech: ramp to duckLevel in ~TIMING.duckAttackMs
    TIMING.duckHoldMs without speech: ramp back to 1 over ~TIMING.duckReleaseMs
  SOS mode: music → 0, siren on alert bus
```

- One `AudioContext` for everything; created/resumed inside the Start tap. iOS interruptions surface as
  `contextState: 'interrupted' | 'suspended'` and the UI shows "Tap to resume audio".
- Remote WebRTC tracks are also attached to a muted `<audio>` element (Chrome outputs silence from
  `createMediaStreamSource` on remote tracks otherwise).
- Mic constraints: echo cancellation, noise suppression, auto gain on. Mic modes: `vox` (VAD-gated
  outgoing audio, default), `open`, `off` (device released so Bluetooth can return from HFP to A2DP).
- Music: `<audio>` → `MediaElementAudioSourceNode`. Media Session metadata + actions so helmet buttons
  control playback. Files persisted in IndexedDB; streams need CORS.
- Alert sounds are synthesized (no assets): two-tone siren, soft chimes, click. TTS via `speechSynthesis`.
- VAD (`dsp/vadCore.ts`, one per stream): energy, rise, tilt and hysteresis as in the Decisions table,
  plus a wind gate. Once the low band has dominated a frame without speech in the last 5 s, an onset
  must also be voiced: normalised autocorrelation of at least 0.7 at a pitch lag (70–400 Hz), measured
  on the 700–3400 Hz band decimated to ~8 kHz, and only on onset candidates. Energy alone fails here:
  the sender's noise suppression and AGC sharpen wind gusts into 20–30 dB speech-like jumps, and Opus
  DTX adds comfort-noise steps on the receiving side. Outside wind the gate is off, so words that open
  on a consonant keep their ~30 ms onset inside the 40 ms VOX look-ahead.

## Voice transports

`VoiceManager` owns one transport at a time and exposes `VoiceManagerApi`:

- **LiveKit**: `livekit-client` Room, publishes `audio.outgoingTrack` as the microphone source (DTX + RED),
  subscribes to all audio, does not call `track.attach()` (the audio engine plays everything). Data channel
  for `VoiceDataMessage`. Token refresh through `voice:token`.
- **Mesh**: one `RTCPeerConnection` per remote online rider, W3C "perfect negotiation" (polite = higher
  rider id), audio transceiver created up front so the mic track can be swapped with `replaceTrack`,
  negotiated data channel id 0 for alerts, ICE restart on failure, Opus `usedtx=1;useinbandfec=1`.
  Signals that arrive while no mesh transport is listening (during a switch from LiveKit, or before
  the mesh starts after joining) are held for 10 s and handed over when it starts (`bufferedSignaling`).
  An offer still unanswered after 5 s (doubling per retry, up to 60 s) makes the link start over with a
  fresh connection, which the peer follows through the SDP session id. Without both, a lost offer from
  the impolite peer deadlocked the pair: the polite peer's own offer is ignored as a collision.
- Switching: the leader sends `voice:setMode`; every client gets `voice:mode` with fresh `VoiceJoinInfo`
  and the manager tears down one transport and starts the other.

## Alerts

- **SOS**: hold 1.5 s (ring fills) → `sos:raise` with a client UUID, retried every `TIMING.sosRetryMs` until
  acked, plus an immediate copy over the voice data channel. Receivers: full-screen red overlay flashing at
  2 Hz (below the 3 Hz photosensitivity limit), siren, music muted, vibration, TTS, map focus, "I'm coming",
  "Navigate" (maps deep link), "Silence". Native + backgrounded: urgent local notification. Active until
  the raiser cancels (hold to cancel); late joiners get it from the snapshot.
- **Break**: one tap (kinds: break, fuel, food, restroom), 30 s cooldown. Toast + soft chime + optional TTS.

## UI for gloved hands

Full-bleed map. Bottom dock (side column in landscape) with four ≥76 px buttons: Mic, Music, Break, SOS.
No swipe-only gestures, no small close buttons; every action gives an earcon and haptic. Dark,
high-contrast tokens in `styles/tokens.css`. Sheets for Music, Route, Riders, Settings, Share (QR).

## Screen-off strategy

| | Android | iPhone |
|---|---|---|
| PWA, screen on | everything | everything |
| PWA, screen off | voice continues, GPS pauses | everything suspends |
| Native, screen off | foreground service keeps GPS + voice | background location works; voice needs on-device verification |

Web: Screen Wake Lock (re-acquired on resume) with a silent-video fallback, Media Session, automatic
recovery on resume. Native: `@capacitor-community/background-geolocation` for GPS, an Android
foreground service of type `location|microphone|mediaPlayback` (custom plugin), iOS `UIBackgroundModes`
`audio` + `location` and an `AVAudioSession` configured for play-and-record with Bluetooth.

Verified on the Android 15 emulator (docs/NATIVE.md): locked screen, silent or talking, and forced deep
Doze, with GPS, voice and the socket all continuing. Its WebView (124) never hid a background page, so
the WebView keep-alive (`RideWebView`) wasn't observably needed there. It stays as a safeguard for
WebView/OEM builds that hide and freeze background pages, which only real phones can confirm.

## Testing

- **Unit (Vitest)**: shared schemas and geo math; server ride logic and rate limiting; VAD on generated
  speech/wind and on two captured fixtures (the E2E wind after Chrome's capture processing, and after
  Opus/DTX through LiveKit), duck envelope timing, motion interpolation and dead reckoning, route
  projection, send policy, mesh negotiation with lost and early signals.
- **Server integration**: real Socket.io clients against an in-process server.
- **E2E (Playwright)**: separate Chromium instances per rider (fake mic fed from WAV fixtures, emulated
  geolocation + debug injection), local `livekit-server --dev`, mock routing/geocoding. Covers join,
  movement, voice in both transports, ducking timing, SOS, break, route, reconnect, late join, wind
  robustness, screenshots at phone sizes, touch-target audit. The audit measures hit areas: the
  element's box plus any `::before`/`::after` extension (map markers keep the disc as their box for
  MapLibre's anchor), a label wrapping its control is that control's hit area, and a caption next to
  its own visible control is not a target. `E2E_PROD=1` runs the suite against the production build
  served by the ride server (manifest, service worker, offline app shell).
- **Android emulator**: `scripts/android-screen-off-check.mjs` (docs/NATIVE.md): screen-off GPS
  (`adb emu geo fix`), voice continuity and Doze, driving the app's WebView through Playwright's
  Android support.
- **Manual on a real phone**: helmet Bluetooth routing, A2DP↔HFP switching, real wind, iOS background.
