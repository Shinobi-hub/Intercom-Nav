# Intercom Nav

Group-ride companion for motorcycle riders (4–8 per ride):

- **Live map** of the whole group, with smooth marker motion between GPS fixes
- **Shared destination**: the leader picks it, everyone sees the route, distance and ETA
- **Group voice**: LiveKit SFU or peer-to-peer mesh, switchable per ride
- **Music that ducks** to 30% whenever anyone talks, then ramps back
- **SOS**: hold to send; every other rider gets a siren, a flashing screen and directions to you
- **Break requests** with a soft chime and an optional spoken announcement in the helmet
- **Screen-off support** via the native Android app (iOS project included, needs Xcode)

Design and decisions: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Native builds: [docs/NATIVE.md](docs/NATIVE.md).

## Requirements

- Node 22+ (developed on Node 26) and npm
- For voice through LiveKit locally: `brew install livekit`
- For the Android app: JDK 21 and the Android SDK (see docs/NATIVE.md)

## Run it locally

```sh
npm install
cp .env.example .env        # defaults work for local development
npm run livekit:dev         # terminal 1: LiveKit dev server on :7880, advertising your LAN IP
npm run dev                 # terminal 2: ride server on :8787 + web app on :5173
```

Open http://localhost:5173, create a ride, and join it from a second browser window (or a private window) using the code or link.
Microphone and GPS need a secure context: `localhost` counts, but phones on your network need HTTPS (see below).

Without LiveKit running, unset the `LIVEKIT_*` variables and rides use mesh voice. The LiveKit dev server
listens on your LAN (so the Android emulator and other machines can reach its media ports): stop it when
you're done.

### Trying it on phones

Browsers only allow the mic and GPS over HTTPS. The quickest path is a tunnel to the ride server serving the production build:

```sh
npm run build && npm start            # serves the PWA + socket on :8787
cloudflared tunnel --url http://localhost:8787
```

The local LiveKit dev server isn't reachable from phones on cellular, so either switch the ride to mesh voice (Settings → Voice) on the same Wi-Fi, or point `LIVEKIT_*` at a LiveKit Cloud project.

## Tests

```sh
npm run typecheck           # all workspaces
npm test                    # Vitest: shared, server (unit + Socket.io integration), web
npm run test:e2e            # Playwright: multi-rider scenarios (needs `npm run livekit:dev`)
npx playwright test -c e2e --grep @mesh       # one area: tags @livekit, @mesh, @slow
E2E_PROD=1 npm run test:e2e                   # the same against the production build (PWA, service worker, offline shell)
```

The Android screen-off check (emulator, `scripts/android-screen-off-check.mjs`) is described in
[docs/NATIVE.md](docs/NATIVE.md#verified-on-the-android-emulator).

The E2E suite launches one Chromium per simulated rider, feeds each a fake microphone from WAV fixtures (speech, wind, silence) and scripted GPS routes, and checks voice, ducking timing, SOS, breaks, routing, reconnects and touch-target sizes.

## Production

- Serve the ride server behind HTTPS (it serves the built PWA and Socket.io on one port).
- Voice: a LiveKit Cloud project (or self-hosted LiveKit) via `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`. Mesh mode on cellular needs a TURN server (`TURN_*`).
- Routing defaults to the public Valhalla instance (motorcycle profile) and Photon for place search; both are fair-use community services, so use your own instances or a keyed provider for real traffic.

## Layout

```
packages/shared   protocol contract shared by client and server (zod schemas, event types)
apps/server       Fastify + Socket.io ride server
apps/web          React PWA (also the Capacitor native app: android/, ios/)
e2e               Playwright multi-rider suite
docs              architecture and native build notes
scripts           livekit:dev launcher, Android screen-off check
```
