# Intercom Nav — native builds (Capacitor 8)

The app must keep GPS, group voice and alerts working with the screen off. A PWA can't (iOS
suspends everything; Android pauses GPS), so the same web app also ships as a Capacitor app.
Platform code: `apps/web/src/platform` (web + native adapters behind `PlatformApi`),
`apps/web/android`, `apps/web/ios`, `apps/web/capacitor.config.ts`.

## Build and run

Everything runs from `apps/web`. The web app reads its server from `VITE_SERVER_URL` at build time;
native builds must set it (there is no same-origin server inside the app).

| Variable | Used by | Meaning |
|---|---|---|
| `VITE_SERVER_URL` | `vite build` | Ride server origin, e.g. `https://ride.example.com`. Release builds must use https. |
| `INTERCOM_DEV_CLEARTEXT=1` | `npx cap sync` | Dev only: allows cleartext HTTP in the Android manifest and mixed content in the `https://localhost` WebView, so the emulator can reach `http://10.0.2.2:<port>`. Run `npx cap sync` **without** it before a release build so the flag is removed. |
| `JAVA_HOME`, `ANDROID_HOME` | Gradle | JDK 21 and the Android SDK (platform 36, build-tools 35). |

The bundle id `app.intercomnav` is a **placeholder**: change `appId` in `capacitor.config.ts`,
`applicationId` in `android/app/build.gradle` and the bundle identifier in Xcode to one you own.

### Android

```sh
export JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home
export ANDROID_HOME=~/Library/Android/sdk
VITE_SERVER_URL=http://10.0.2.2:8791 npm run build -w @intercom/web   # emulator → host:8791
INTERCOM_DEV_CLEARTEXT=1 npx cap sync android
(cd android && ./gradlew assembleDebug)
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

Gradle must stay on 8.x (`gradle/wrapper/gradle-wrapper.properties`, 8.14.3): Capacitor 8 uses
AGP 8.13, which fails on Gradle 9.6+. Release: set an https `VITE_SERVER_URL`, `npx cap sync
android` without the dev flag, configure signing, `./gradlew bundleRelease`.

### iOS (needs a Mac with Xcode 16+; not buildable on the dev machine this was written on)

```sh
VITE_SERVER_URL=https://ride.example.com npm run build -w @intercom/web
npx cap sync ios
npx cap open ios        # Xcode: set Team + bundle id, then Run on a device
```

- Dependencies use Swift Package Manager (no CocoaPods). `@capacitor-community/background-geolocation`
  1.2.26 only declares Capacitor 7 in its `Package.swift`, which SPM can't resolve next to
  Capacitor 8, so its single Swift file is vendored as `ios/App/App/BackgroundGeolocationPlugin.swift`
  and the npm package is left out of iOS via `ios.includePlugins` in `capacitor.config.ts`
  (**add any new plugin to that list**). Remove both once the plugin supports Capacitor 8.
- `MainViewController` (used by `SceneDelegate` and `Main.storyboard`) registers the app-local
  plugins `RideServicePlugin` and the vendored `BackgroundGeolocation`.
- iOS WKWebView treats `capacitor://localhost` as a secure origin, so a plain-HTTP dev server is
  blocked as mixed content: use an https server (or a tunnel) for device testing.
- Optional: add the *Time Sensitive Notifications* capability so SOS notifications
  (`interruptionLevel: timeSensitive`) break through Focus modes.

First run on a Mac with Xcode, end to end:

1. Expose the ride server over https, e.g. `npm run build && npm start` plus
   `cloudflared tunnel --url http://localhost:8787` (README). For LiveKit, a LiveKit Cloud project's `LIVEKIT_*`
   is the easiest option; a phone can't reach a laptop's dev server as `wss://`. Otherwise use mesh voice.
2. `VITE_SERVER_URL=https://<tunnel host> npm run build -w @intercom/web`, then in `apps/web`:
   `npx cap sync ios && npx cap open ios`.
3. In Xcode, App target → *Signing & Capabilities*: pick your Team, set a bundle id you own, and check that
   *Background Modes* lists Audio and Location updates. Build to a physical iPhone; the simulator can't
   show background audio capture.
4. Join a ride from a second device, then lock the iPhone and check, for at least 5 minutes:
   - the other rider keeps seeing it move;
   - voice works **both ways** (WKWebView capture in the background is the open question);
   - music from another app mixes with the intercom instead of stopping it;
   - an SOS from the other rider shows the urgent notification and sounds the siren.
5. Repeat with a Bluetooth helmet headset connected (HFP while the mic is live).

## How screen-off works

### Android

`background.start()` (called by the ride controller after joining) first requests every runtime
permission the ride needs in one sequence, then starts **`RideService`**, a foreground service
of type `location|microphone|mediaPlayback` with an ongoing "Ride in progress — voice & location on"
notification (tap opens the app). It claims only the types whose permissions are granted and
re-claims more after later grants. While it runs:

- **Process priority.** The app is a foreground-service process: never frozen or killed as a cached app, network
  allowed in Doze, and Android keeps the app's "while in use" location and microphone access
  with the screen off. No `ACCESS_BACKGROUND_LOCATION` is needed.
- **Partial wake lock.** The CPU keeps running between GPS fixes and audio buffers. It's released when the ride
  ends; 12 h ceiling.
- **WebView keep-alive** (`RideWebView`), a safeguard. Capacitor never pauses
  the WebView itself: `BridgeActivity.onPause` pauses timers only when the Cordova `KeepRunning`
  preference is false. Chromium, however, can derive page visibility from the WebView's *window*
  visibility (AwContents: visible = `!paused && attached && windowVisible`). With the screen off the
  page is hidden, so Blink throttles timers. On Android it also *freezes* a hidden, silent page
  after a delay (`kStopInBackground`, 5 min in older Chromium, 1 min in current). A frozen page
  runs no JS: location callbacks pile up, Socket.io and LiveKit signalling stop, the rider drops
  out. That's the known "background-geolocation stops after 5 minutes" bug. Resuming timers wouldn't
  help, so `RideWebView` overrides `onWindowVisibilityChanged` to report VISIBLE while the ride
  service runs, and restores the real value afterwards. Android still doesn't draw the invisible
  window. `MainActivity` additionally undoes any explicit `pauseTimers()`/`onPause()` during a
  ride, and sets `setMediaPlaybackRequiresUserGesture(false)` and the IMPORTANT renderer priority.
  Consequence for JS: with the screen off during a ride, `document.visibilityState` stays
  `'visible'`. Use `platform.lifecycle` (native app state) to detect background.
  **Observed on the emulator (WebView 124):** the page never became hidden, not even with the app in
  the background and no ride running, and a 7-minute locked, silent ride with the keep-alive turned
  off kept running normally (see below). So on that build the keep-alive is a no-op. It stays for
  WebView and OEM builds that do hide and freeze background pages; check on real phones.
- **Bluetooth routing** (`BluetoothRouter`). While Chromium has the device in
  `MODE_IN_COMMUNICATION` (mic live), a connected headset (LE Audio, else HFP/SCO) is made the
  communication device (`setCommunicationDevice`, API 31+; `startBluetoothSco` before). With the mic
  off (normal mode) routing is left alone so the helmet stays on A2DP for music. JS gets
  `audioRoute` events.
- **Permission serialisation** (`PermissionGate`, `RideWebChromeClient`). Android drops a second
  permission request made while one is showing. Capacitor's WebChromeClient then even grants
  `getUserMedia` without the OS permission. The ride start asks for permissions, GPS and the mic
  at once, so all requests are queued through one gate.

**Location source.** GPS comes from `@capacitor-community/background-geolocation`
(FusedLocationProvider, 1 Hz, high accuracy) on both platforms, so there is one JS code path. On Android
it runs **without** `backgroundMessage`: its own foreground service would add a second
notification and a second `location` service. `RideService`'s `location` type keeps the
app-wide while-in-use access instead. We request permission ourselves before `addWatcher`
(`requestPermissions: false`), because the plugin's own request path starts its service before the
user answers. On iOS `backgroundMessage` must be set: it is what enables
`allowsBackgroundLocationUpdates`.

### iOS

`UIBackgroundModes` `audio` + `location`. Location updates keep the app process running. The audio
session keeps playback and capture going: `RideServicePlugin` sets `.playAndRecord` with
`.allowBluetooth`, `.allowBluetoothA2DP`, `.defaultToSpeaker` and `.mixWithOthers` while the mic is live,
`.playback` + `.mixWithOthers` when it's off, and re-applies after interruptions. Mixing keeps a
music or navigation app from killing the intercom, and the intercom from killing them.
`audioSession.setMode()` drives this, also through `navigator.audioSession` where WebKit has it.

## Permissions and background modes

| Android permission | Why |
|---|---|
| `INTERNET` | Ride server, LiveKit, map tiles |
| `ACCESS_NETWORK_STATE` | Lets the WebView keep `navigator.onLine` / online-offline events accurate (reconnects) |
| `ACCESS_FINE_LOCATION`, `ACCESS_COARSE_LOCATION` (runtime) | Your position on the group map; "approximate" still works, less precisely |
| `RECORD_AUDIO` (runtime) | Group voice |
| `MODIFY_AUDIO_SETTINGS` | WebRTC communication mode and Bluetooth routing |
| `FOREGROUND_SERVICE` + `_LOCATION`, `_MICROPHONE`, `_MEDIA_PLAYBACK` | The ride service and its three types (Android 14 requires one per type) |
| `POST_NOTIFICATIONS` (runtime, 13+) | Ride notification, SOS and break alerts |
| `WAKE_LOCK` | Partial wake lock during a ride |
| `VIBRATE` | Haptics and alert vibration |
| `BLUETOOTH_CONNECT` (runtime, 12+) | Route audio to the helmet headset; `BLUETOOTH` (≤ Android 11) for SCO |

`SCHEDULE_EXACT_ALARM` and `RECEIVE_BOOT_COMPLETED`, merged in by local-notifications for
scheduled notifications, are removed (unused; exact alarms are Play-policy restricted).
Notification channels: `ride` (low, silent, ongoing), `sos` (high: sound, vibration, heads-up,
public on the lock screen), `alerts` (default). Battery: OEM battery savers (Samsung, Xiaomi, …)
may still kill the service. Riders should set the app's battery usage to *Unrestricted*.

| iOS key | Why |
|---|---|
| `NSMicrophoneUsageDescription` | Group voice |
| `NSLocationWhenInUseUsageDescription`, `NSLocationAlwaysAndWhenInUseUsageDescription` | Map position; the plugin asks for "Always" so updates continue while locked |
| `UIBackgroundModes: audio` | Voice and alert sounds while locked |
| `UIBackgroundModes: location` | GPS while locked (blue status-bar indicator) |

## Verified on the Android emulator

AVD `intercom-pixel`: Android 15 (API 35, google_apis arm64), Android System WebView 124.0.6367.219,
headless (`emulator -avd intercom-pixel -no-window -no-snapshot-load`). Checked on 2026-10-21 with
`scripts/android-screen-off-check.mjs`:

1. A desktop Chromium rider (fake microphone) creates a ride, and the debug app on the emulator joins it.
2. The emulator app is driven through its WebView with Playwright's Android support (`_android`).
   `connectOverCDP` doesn't work with an Android WebView.
3. Both riders' voice comes up on LiveKit.
4. The emulator is locked, screen off, the way a phone in a pocket is. The emulator image ships with the
   lock screen disabled and the activity would otherwise stay resumed, so the script enables it for the
   run.
5. While the screen is off, `adb emu geo fix` moves the emulator rider 20 m every 2 s.
6. The desktop samples what it sees every second.

| Run | Screen off | Result |
|---|---|---|
| Talking (desktop mic plays speech), not locked (activity stays resumed) | 150 s | PASS: 74 fixes, 1,465 m on the desktop map, longest gap between updates 3.1 s, marker always live, voice connected; 288 KB of voice reached the emulator, 21 KB (DTX) left it |
| Silent ride, locked (activity `STOPPED`) | 150 s | PASS: longest update gap 3.0 s, every page probe answered, voice connected both ways; mic capture kept going through the `microphone` service type |
| Forced deep Doze (`dumpsys deviceidle force-idle deep`, battery unplugged), not locked | 90 s | PASS: still `IDLE` at the end; positions every ~3 s; voice flowing |
| Negative control: keep-alive off (`RideService.start({ keepAlive: false })`), locked, talking | 150 s | Kept running: positions every ~3 s, 288 KB of voice in |
| Negative control: keep-alive off, locked, silent | 420 s | Kept running, page `visible` throughout: WebView 124 doesn't hide or freeze the page (see above) |

The APK, the ride server on :8791 (`LIVEKIT_URL` at the host's LAN IP, `CORS_ORIGINS=https://localhost`)
and a Vite front end for the desktop rider come first:

```sh
export JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home ANDROID_HOME=~/Library/Android/sdk
export PATH="$ANDROID_HOME/platform-tools:$PATH"
npm run livekit:dev                                                    # terminal 1
PORT=8791 HOST=127.0.0.1 ROUTING_PROVIDER=mock GEOCODER=mock DEFAULT_VOICE_MODE=livekit \
  LIVEKIT_URL="ws://$(ipconfig getifaddr en0):7880" LIVEKIT_API_KEY=devkey LIVEKIT_API_SECRET=secret \
  CORS_ORIGINS=https://localhost npx tsx apps/server/src/index.ts       # terminal 2
(cd apps/web && INTERCOM_SERVER_URL=http://127.0.0.1:8791 \
  npx vite --config ../../e2e/vite.e2e.config.ts --host 127.0.0.1 --port 5181)   # terminal 3
VITE_SERVER_URL=http://10.0.2.2:8791 npm run build -w @intercom/web
(cd apps/web && INTERCOM_DEV_CLEARTEXT=1 npx cap sync android && cd android && ./gradlew assembleDebug)
$ANDROID_HOME/emulator/emulator -avd intercom-pixel -no-window -no-snapshot-load &
adb install -r apps/web/android/app/build/outputs/apk/debug/app-debug.apk
for p in ACCESS_FINE_LOCATION ACCESS_COARSE_LOCATION RECORD_AUDIO POST_NOTIFICATIONS BLUETOOTH_CONNECT; do
  adb shell pm grant app.intercomnav android.permission.$p; done
DESKTOP_URL=http://127.0.0.1:5181/ node scripts/android-screen-off-check.mjs 150   # SILENT=1, DOZE=1, NO_KEEPALIVE=1
```

Afterwards, run `npx cap sync android` again **without** `INTERCOM_DEV_CLEARTEXT`, and stop LiveKit,
because it listens on the LAN.

## Still needs a real device

- **iOS everything**: build in Xcode, then on a locked iPhone check that WKWebView keeps
  *capturing* and playing WebRTC voice in the background (WebKit may suspend capture), that
  WebKit doesn't override the AVAudioSession options, and the vendored geolocation plugin.
- **Bluetooth helmet routing** on Android (no Bluetooth audio in the emulator): HFP/LE Audio
  selection, A2DP ↔ HFP switching when the mic mode changes, reconnects mid-ride.
- Real-world battery drain and OEM battery savers; long rides (> 1 h) with the screen off.
- **Whether the WebView keep-alive is needed.** On a few phones (Samsung, Xiaomi, Pixel), run a locked,
  silent ride for 10+ minutes with `RideService.start({ ..., keepAlive: false })`. If the rider stays
  live, that WebView doesn't freeze background pages either.
- **Real wind.** The VAD's wind gate is tuned on synthetic wind, both raw and after Chrome's capture
  processing and Opus. Record a helmet mic at speed: the riders' music must not duck and VOX must
  not open on it, while speech in wind still gets through.
- Background voice end-to-end with the real ride server and LiveKit.

## Debug probe

With `?debug=1` or `localStorage['intercom:debug'] = '1'`, `window.__intercomPlatform` exposes
`start({ background, tickMs })`, `stop()` and `report()`. It starts GPS (and the ride service) and
logs every fix plus a periodic tick to the console. Capacitor forwards that to logcat (`Capacitor/Console`).
`RideService.start({ ..., keepAlive: false })` (via `Capacitor.Plugins.RideService`) runs the
service without the WebView keep-alive, to check whether a device's WebView needs it. WebView 124 on
the emulator doesn't: it never froze the page.
