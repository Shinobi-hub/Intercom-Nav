/**
 * data-testid values shared by the UI and the Playwright suite. Add new ids here rather than
 * inlining strings, and keep existing ones stable.
 *
 * State is exposed through data attributes on these elements:
 *   dock-mic        data-mode="vox|open|off"  data-state=<MicState>
 *   dock-music      data-playing="true|false"
 *   dock-break      data-state="idle|sending|sent|refused"  (refused: the server's group cooldown)
 *   dock-sos        data-active="true|false"   (own SOS active)
 *   rider-marker-*  data-state="live|stale|lost" data-speaking="true|false" data-sos="true|false"
 *   toast           data-kind=<Toast.kind>
 *   connection-status data-state=<ConnectionState>;  voice-status data-state=<VoiceState> data-transport
 *
 * Other contract points the E2E suite relies on:
 *   - join-color-<hex> swatches (one per RIDER_COLORS entry) are on both the home and the join screen.
 *   - Leader-only route controls (dest-search-input, dest-result-*, dest-use-center, dest-clear) are
 *     not rendered for other riders; their route sheet shows dest-current and a note instead.
 *   - Spoken announcements (SOS, breaks) go through window.speechSynthesis on every platform.
 */
export const TID = {
  // home + join
  homeCreate: 'home-create',
  homeJoinCode: 'home-join-code',
  homeJoinSubmit: 'home-join-submit',
  homeResume: 'home-resume',
  joinName: 'join-name',
  joinColor: (hex: string) => `join-color-${hex.replace('#', '').toLowerCase()}`,
  joinStart: 'join-start',
  joinError: 'join-error',

  // ride screen chrome
  rideScreen: 'ride-screen',
  rideCode: 'ride-code',
  connectionStatus: 'connection-status',
  voiceStatus: 'voice-status',
  gpsStatus: 'gps-status',
  riderCount: 'rider-count',

  // dock
  dockMic: 'dock-mic',
  dockMusic: 'dock-music',
  dockBreak: 'dock-break',
  dockSos: 'dock-sos',
  dockMore: 'dock-more',

  // alerts
  sosActiveBanner: 'sos-active-banner',
  sosCancel: 'sos-cancel',
  sosResponders: 'sos-responders',
  sosOverlay: 'sos-overlay',
  sosRespond: 'sos-respond',
  sosSilence: 'sos-silence',
  sosNavigate: 'sos-navigate',
  sosBanner: 'sos-banner',
  breakKind: (kind: string) => `break-kind-${kind}`,
  toast: 'toast',
  resumeAudio: 'resume-audio',
  sessionReplaced: 'session-replaced',

  // sheets
  sheet: (id: string) => `sheet-${id}`,
  sheetClose: 'sheet-close',
  menuItem: (id: string) => `menu-${id}`,
  settingsMicMode: (mode: string) => `settings-mic-${mode}`,
  settingsDuckLevel: 'settings-duck-level',
  settingsDuckOwnVoice: 'settings-duck-own-voice',
  settingsSensitivity: 'settings-sensitivity',
  settingsVoiceMode: (mode: string) => `settings-voice-${mode}`,
  settingsAnnounce: 'settings-announce',
  settingsUnits: 'settings-units',
  settingsLeave: 'settings-leave',
  ridersList: 'riders-list',
  riderRow: (id: string) => `rider-row-${id}`,
  shareQr: 'share-qr',
  shareLink: 'share-link',

  // map feature
  map: 'map',
  mapMarker: (id: string) => `rider-marker-${id}`,
  mapCameraToggle: 'map-camera-toggle',
  mapRecenter: 'map-recenter',
  routeSummary: 'route-summary',
  destSearchInput: 'dest-search-input',
  destResult: (i: number) => `dest-result-${i}`,
  destUseCenter: 'dest-use-center',
  destClear: 'dest-clear',
  destCurrent: 'dest-current',

  // audio feature
  musicFileInput: 'music-file-input',
  musicPlayPause: 'music-play-pause',
  musicNext: 'music-next',
  musicPrev: 'music-prev',
  musicStreamUrl: 'music-stream-url',
  musicStreamAdd: 'music-stream-add',
  musicTrack: (id: string) => `music-track-${id}`,
  micLevelMeter: 'mic-level-meter',
} as const;
