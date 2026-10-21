/**
 * The ride controller: the app's orchestration layer. It speaks the socket protocol, mirrors server
 * state into useRideStore, starts and stops the device services, and turns what other riders do
 * (SOS, breaks, route changes, joins) into side effects: siren, chimes, toasts, speech, vibration,
 * native notifications and map focus.
 *
 * Sound rule: the UI plays the click/feedback for things the user just tapped; the controller only
 * makes noise for remote events and for confirmations that arrive later (e.g. SOS acked by the server).
 */
import type {
  BreakAlert,
  BreakKind,
  ClientToServerEvents,
  Err,
  JoinResult,
  LatLng,
  MicMode,
  Place,
  RiderAuth,
  SosAlert,
  VoiceDataMessage,
  VoiceMode,
} from '@intercom/shared';
import { formatRideCode, haversineM, normalizeRideCode, TIMING, uuid } from '@intercom/shared';
import { formatDistance } from './format';
import { navigate } from './router';
import type {
  AudioEngineApi,
  AudioSettings,
  LocationServiceApi,
  PlatformApi,
  RideControllerApi,
  StartIntent,
  Unsubscribe,
  VoiceManagerApi,
} from './services';
import { getIdentity, getLastRide, setLastRide } from './session';
import type { AppSocket } from './socket';
import { useLocalStore, useRideStore, useSettings, type Settings } from './store';

export interface RideControllerDeps {
  socket: AppSocket;
  audio: AudioEngineApi;
  voice: VoiceManagerApi;
  location: LocationServiceApi;
  platform: PlatformApi;
}

const REQUEST_TIMEOUT_MS = 8_000;
const CONNECT_TIMEOUT_MS = 12_000;
/** Breaks seen for the first time on a rejoin are still announced if they are this recent. */
const MISSED_BREAK_WINDOW_MS = 2 * 60_000;

const BREAK_LABEL: Record<BreakKind, string> = {
  break: 'a break',
  fuel: 'a fuel stop',
  food: 'a food stop',
  restroom: 'a restroom stop',
};

// Typed request helper: every client event that acks with a Result.
type AckEvent = {
  [K in keyof ClientToServerEvents]: Parameters<ClientToServerEvents[K]> extends [unknown, (r: infer R) => void]
    ? R extends { ok: boolean }
      ? K
      : never
    : never;
}[keyof ClientToServerEvents];
type PayloadOf<K extends AckEvent> = Parameters<ClientToServerEvents[K]>[0];
type ResultOf<K extends AckEvent> = Parameters<ClientToServerEvents[K]>[1] extends (r: infer R) => void ? R : never;

const fail = (error: Err['error'], message: string): Err => ({ ok: false, error, message });

function warn(...args: unknown[]): void {
  console.warn('[ride]', ...args);
}

function audioSettingsOf(s: Settings): AudioSettings {
  return {
    voiceVolume: s.voiceVolume,
    musicVolume: s.musicVolume,
    duckLevel: s.duckLevel,
    duckOnOwnVoice: s.duckOnOwnVoice,
    vadSensitivity: s.vadSensitivity,
    riderVolumes: s.riderVolumes,
    inputDeviceId: s.inputDeviceId,
    outputDeviceId: s.outputDeviceId,
  };
}

export function createRideController(deps: RideControllerDeps): RideControllerApi & { dispose(): void } {
  const { socket, audio, voice, location, platform } = deps;
  const ride = useRideStore.getState;
  const local = useLocalStore.getState;
  const settings = useSettings.getState;

  type Phase = 'idle' | 'starting' | 'active' | 'leaving';
  let phase: Phase = 'idle';
  let code: string | null = null;
  let rejoining = false;
  let sirenOn = false;
  let sosModeOn = false;
  let breakCooldownUntil = 0;
  const sosTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Own SOS cancellations the server hasn't confirmed yet (re-sent after every rejoin). */
  const pendingCancels = new Set<string>();
  const cleanups: Unsubscribe[] = [];

  const serverNow = () => Date.now() + ride().clockOffsetMs;
  const riderName = (id: string) => ride().riders[id]?.name ?? 'A rider';
  const isSelf = (id: string) => id === ride().selfId;

  async function call<K extends AckEvent>(
    event: K,
    payload: PayloadOf<K>,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<ResultOf<K>> {
    if (!socket.connected) return fail('internal', "You're offline. Waiting for a connection.") as ResultOf<K>;
    try {
      // Socket.io's typings can't follow a generic event name through emitWithAck;
      // AckEvent / PayloadOf / ResultOf keep the call sites typed instead.
      const s = socket.timeout(timeoutMs) as unknown as { emitWithAck(ev: string, p: unknown): Promise<unknown> };
      return (await s.emitWithAck(event, payload)) as ResultOf<K>;
    } catch {
      return fail('internal', 'The ride server did not respond. Try again.') as ResultOf<K>;
    }
  }

  function riderAuth(): RiderAuth {
    const { id, secret } = getIdentity();
    const s = settings();
    return { id, secret, name: s.name.trim() || 'Rider', color: s.color };
  }

  function ensureConnected(timeoutMs = CONNECT_TIMEOUT_MS): Promise<boolean> {
    if (socket.connected) return Promise.resolve(true);
    return new Promise((resolve) => {
      const onConnect = () => done(true);
      const timer = setTimeout(() => done(false), timeoutMs);
      function done(ok: boolean) {
        clearTimeout(timer);
        socket.off('connect', onConnect);
        resolve(ok);
      }
      socket.on('connect', onConnect);
      socket.connect();
    });
  }

  async function syncClock(): Promise<void> {
    if (!socket.connected) return;
    const t0 = Date.now();
    try {
      const r = await socket.timeout(4_000).emitWithAck('time:sync', { t0 });
      ride().setClockOffset(r.serverNow - (t0 + Date.now()) / 2);
    } catch {
      /* keep the snapshot-based estimate */
    }
  }

  function distanceTo(where: LatLng | null | undefined): string | null {
    const me = local().selfFix;
    if (!me || !where) return null;
    return formatDistance(haversineM(me, where), settings().units);
  }

  // ---- SOS ------------------------------------------------------------------------------------

  /** Siren + music mute follow the store: siren while any other rider's SOS is unacknowledged. */
  function refreshSosEffects(): void {
    const { sos, selfId } = ride();
    const acked = local().ui.acknowledgedSos;
    let ownActive = false;
    let unackedOther = false;
    for (const s of Object.values(sos)) {
      if (s.riderId === selfId) ownActive = true;
      else if (!acked[s.id]) unackedOther = true;
    }
    const wantSosMode = ownActive || unackedOther;
    if (wantSosMode !== sosModeOn) {
      sosModeOn = wantSosMode;
      audio.setSosMode(wantSosMode);
    }
    if (unackedOther !== sirenOn) {
      sirenOn = unackedOther;
      if (unackedOther) audio.alerts.startSiren();
      else audio.alerts.stopSiren();
    }
  }

  /** One-off attention grab for an SOS we haven't seen before. The overlay itself is driven by the store. */
  function alertSos(sos: SosAlert): void {
    const name = riderName(sos.riderId);
    const away = distanceTo(sos.location ?? ride().riders[sos.riderId]?.location);
    platform.haptics.vibrate([600, 200, 600, 200, 600]);
    local().focusRider(sos.riderId);
    if (settings().announce) audio.alerts.announce(`SOS from ${name}${away ? `, ${away} away` : ''}`);
    if (!platform.lifecycle.isForeground()) {
      void platform.background
        .notify({
          id: `sos-${sos.id}`,
          title: `SOS from ${name}`,
          body: away ? `${away} away. Open to respond.` : 'Open to respond.',
          urgent: true,
        })
        .catch(warn);
    }
  }

  function onSosRaised(sos: SosAlert, source: 'server' | 'p2p'): void {
    const known = Boolean(ride().sos[sos.id]);
    ride().upsertSos(sos, source);
    if (!known && !isSelf(sos.riderId) && !local().ui.acknowledgedSos[sos.id]) alertSos(sos);
    refreshSosEffects();
  }

  function onSosCancelled(id: string, by: string): void {
    const s = ride().sos[id];
    clearTimeout(sosTimers.get(id));
    sosTimers.delete(id);
    pendingCancels.delete(id);
    ride().removeSos(id);
    if (s && !isSelf(s.riderId)) {
      local().pushToast({ kind: 'info', title: `${riderName(s.riderId)} cancelled the SOS`, riderId: s.riderId });
    } else if (s && by !== s.riderId) {
      local().pushToast({ kind: 'info', title: `${riderName(by)} cleared your SOS` });
    }
    refreshSosEffects();
  }

  function scheduleSosSend(id: string, delayMs: number): void {
    clearTimeout(sosTimers.get(id));
    sosTimers.set(
      id,
      setTimeout(() => void sendSos(id), delayMs),
    );
  }

  /** Delivers our own SOS: voice data channel immediately, Socket.io until the server acks. */
  async function sendSos(id: string): Promise<void> {
    sosTimers.delete(id);
    const s = ride().sos[id];
    if (!s || s.source === 'server' || phase !== 'active') return;
    const { source: _source, ...alert } = s;
    voice.sendData({ type: 'sos', sos: alert });
    const res = await call('sos:raise', { id, location: local().selfFix ?? s.location }, 5_000);
    if (!ride().sos[id]) return; // cancelled while we waited
    if (res.ok) {
      ride().upsertSos(res.sos, 'server');
      audio.alerts.chime('sent');
      local().pushToast({ kind: 'sos', title: 'SOS sent to the group', body: 'Hold Cancel on the SOS banner to call it off.' });
      return;
    }
    scheduleSosSend(id, TIMING.sosRetryMs);
  }

  async function sendCancel(id: string): Promise<void> {
    const res = await call('sos:cancel', { id });
    if (res.ok || res.error === 'not_found') pendingCancels.delete(id);
    else pendingCancels.add(id);
  }

  // ---- breaks ---------------------------------------------------------------------------------

  function notifyBreak(b: BreakAlert): void {
    const name = riderName(b.riderId);
    const what = BREAK_LABEL[b.kind];
    audio.alerts.chime('break');
    platform.haptics.vibrate(120);
    local().pushToast({ kind: 'break', title: `${name} wants ${what}`, riderId: b.riderId, ttlMs: 8_000 });
    if (settings().announce) audio.alerts.announce(`${name} wants ${what}`);
    if (!platform.lifecycle.isForeground()) {
      void platform.background
        .notify({ id: `break-${b.id}`, title: `${name} wants ${what}`, body: 'Pull over when it is safe.', urgent: false })
        .catch(warn);
    }
  }

  // ---- join / rejoin / leave ---------------------------------------------------------------------

  function applyJoin(res: JoinResult, rejoin: boolean): void {
    const knownSos = new Set(Object.keys(ride().sos));
    const knownBreaks = new Set(ride().breaks.map((b) => b.id));
    ride().applySnapshot(res.snapshot, res.selfId);
    ride().setClockOffset(res.snapshot.serverNow - Date.now());
    code = res.snapshot.code;
    setLastRide(code);

    for (const id of pendingCancels) {
      ride().removeSos(id);
      void sendCancel(id);
    }
    const { sos, breaks } = ride();
    for (const s of Object.values(sos)) {
      if (!isSelf(s.riderId) && !knownSos.has(s.id) && !local().ui.acknowledgedSos[s.id]) alertSos(s);
    }
    if (rejoin) {
      const now = serverNow();
      for (const b of breaks) {
        if (!knownBreaks.has(b.id) && !isSelf(b.riderId) && now - b.at < MISSED_BREAK_WINDOW_MS) notifyBreak(b);
      }
    }
    refreshSosEffects();
  }

  async function startServices(join: JoinResult): Promise<void> {
    const s = settings();
    audio.applySettings(audioSettingsOf(s));
    void platform.background
      .start({ title: 'Ride in progress', text: `Ride ${formatRideCode(join.snapshot.code)} · voice and location on` })
      .catch(warn);
    const gps = location.start().catch(warn);
    // Mic before voice, so the transport publishes a track straight away instead of republishing.
    await audio.setMicMode(s.micMode).catch(warn);
    if (phase !== 'active') return;
    if (local().audio.micState === 'denied') {
      local().pushToast({
        kind: 'warning',
        title: 'Microphone blocked',
        body: 'You can still hear the group. Allow the microphone to talk.',
        ttlMs: 10_000,
      });
    }
    void call('rider:update', { micMode: s.micMode });
    try {
      await voice.start(join.voice, join.selfId);
    } catch (e) {
      warn('voice start failed', e);
      local().pushToast({ kind: 'warning', title: 'Voice could not connect', body: 'Retrying in the background.' });
    }
    await gps;
    void syncClock();
  }

  async function stopServices(): Promise<void> {
    for (const t of sosTimers.values()) clearTimeout(t);
    sosTimers.clear();
    if (sirenOn) {
      sirenOn = false;
      audio.alerts.stopSiren();
    }
    if (sosModeOn) {
      sosModeOn = false;
      audio.setSosMode(false);
    }
    audio.music.pause();
    const results = await Promise.allSettled([
      voice.stop(),
      location.stop(),
      // Releases the device; deliberately not persisted to settings.
      audio.setMicMode('off'),
      platform.wakeLock.disable(),
      platform.background.stop(),
    ]);
    for (const r of results) if (r.status === 'rejected') warn('stop failed', r.reason);
  }

  function resetStores(): void {
    ride().reset();
    const l = local();
    l.setSelfFix(null);
    l.setGps({ status: 'off', accuracyM: null, lastFixAt: null, error: null });
    l.setVoice({ state: 'off', transport: null, peers: {}, error: null });
    for (const id of Object.keys(l.speaking)) l.clearSpeaking(id);
    useLocalStore.setState((st) => ({
      ui: { ...st.ui, focus: null, sheet: null, toasts: [], acknowledgedSos: {}, sessionReplaced: false, cameraMode: 'follow' },
    }));
  }

  /** Tear down after the ride disappeared under us (expired, removed, slot taken). */
  async function endLocally(message: string): Promise<void> {
    phase = 'leaving';
    await stopServices();
    socket.disconnect();
    code = null;
    setLastRide(null);
    pendingCancels.clear();
    resetStores();
    phase = 'idle';
    local().pushToast({ kind: 'warning', title: message, ttlMs: 10_000 });
    navigate('/', { replace: true });
  }

  async function rejoin(): Promise<void> {
    if (rejoining || !code) return;
    rejoining = true;
    try {
      const res = await call('ride:join', { code, rider: riderAuth() });
      if (phase !== 'active') return;
      if (res.ok) {
        applyJoin(res, true);
        ride().setConnection('connected');
        void voice.update(res.voice).catch(warn);
        void call('rider:update', { micMode: settings().micMode });
        for (const s of Object.values(ride().sos)) {
          if (s.source === 'local') void sendSos(s.id);
        }
        void syncClock();
      } else if (res.error === 'ride_not_found') {
        await endLocally('This ride has ended.');
      } else if (res.error === 'rider_conflict') {
        await endLocally('Your rider slot is in use elsewhere. Rejoin from the home screen.');
      } else {
        setTimeout(() => {
          if (socket.connected && phase === 'active') void rejoin();
        }, 2_000);
      }
    } finally {
      rejoining = false;
    }
  }

  async function leave(): Promise<void> {
    phase = 'leaving';
    await call('ride:leave', {}, 3_000);
    await stopServices();
    socket.disconnect();
    code = null;
    setLastRide(null);
    pendingCancels.clear();
    resetStores();
    phase = 'idle';
  }

  // ---- socket events --------------------------------------------------------------------------

  socket.on('connect', () => {
    if (phase === 'active') {
      ride().setConnection('connected');
      void rejoin();
    }
  });
  socket.on('disconnect', (reason) => {
    if (phase !== 'active') return;
    ride().setConnection(platform.network.isOnline() ? 'reconnecting' : 'offline');
    // Socket.io doesn't auto-reconnect after a server-side disconnect (e.g. a restart).
    if (reason === 'io server disconnect' && !local().ui.sessionReplaced) socket.connect();
  });
  socket.io.on('reconnect_attempt', () => {
    if (phase === 'active' && ride().connection !== 'offline') ride().setConnection('reconnecting');
  });

  socket.on('rider:joined', (r) => {
    const known = Boolean(ride().riders[r.id]);
    ride().upsertRider(r);
    if (known || isSelf(r.id) || phase !== 'active') return;
    audio.alerts.chime('join');
    local().pushToast({ kind: 'info', title: `${r.name} joined`, riderId: r.id, ttlMs: 4_000 });
  });
  socket.on('rider:updated', (r) => ride().upsertRider(r));
  socket.on('rider:left', ({ riderId }) => {
    if (isSelf(riderId)) {
      void endLocally('You were removed from the ride.');
      return;
    }
    const r = ride().riders[riderId];
    ride().removeRider(riderId);
    local().clearSpeaking(riderId);
    if (r) {
      audio.alerts.chime('leave');
      local().pushToast({ kind: 'info', title: `${r.name} left the ride`, ttlMs: 4_000 });
    }
  });
  socket.on('loc:relay', ({ riderId, fix, rt }) => ride().setRiderLocation(riderId, fix, rt));

  socket.on('sos:raised', (sos) => onSosRaised(sos, 'server'));
  socket.on('sos:updated', (sos) => {
    const prev = ride().sos[sos.id];
    ride().upsertSos(sos, 'server');
    if (!isSelf(sos.riderId)) return;
    const before = new Set(prev?.responders.map((r) => r.riderId) ?? []);
    for (const r of sos.responders) {
      if (before.has(r.riderId)) continue;
      const name = riderName(r.riderId);
      audio.alerts.chime('responder');
      local().pushToast({ kind: 'success', title: `${name} is coming`, riderId: r.riderId });
      if (settings().announce) audio.alerts.announce(`${name} is coming`);
    }
  });
  socket.on('sos:cancelled', ({ id, by }) => onSosCancelled(id, by));

  socket.on('break:requested', (b) => {
    const known = ride().breaks.some((x) => x.id === b.id);
    ride().addBreak(b);
    if (!known && !isSelf(b.riderId)) notifyBreak(b);
  });

  socket.on('route:updated', ({ route, by }) => {
    ride().setRoute(route);
    if (isSelf(by)) return;
    audio.alerts.chime('route');
    if (route) {
      local().pushToast({ kind: 'info', title: 'New destination', body: route.destination.name });
      if (settings().announce) audio.alerts.announce(`New destination: ${route.destination.name}`);
    } else {
      local().pushToast({ kind: 'info', title: 'Route cleared' });
    }
  });

  socket.on('leader:changed', ({ leaderId }) => {
    const previous = ride().ride?.leaderId;
    ride().setLeader(leaderId);
    if (previous === leaderId) return;
    local().pushToast({
      kind: 'info',
      title: isSelf(leaderId) ? 'You are now leading the ride' : `${riderName(leaderId)} is now leading`,
    });
  });

  socket.on('voice:mode', ({ voice: info }) => {
    const changed = ride().ride?.voiceMode !== info.mode;
    ride().setVoiceMode(info.mode);
    void voice.update(info).catch(warn);
    if (changed) {
      local().pushToast({
        kind: 'info',
        title: info.mode === 'livekit' ? 'Voice now goes through the server' : 'Voice now goes rider to rider',
      });
    }
  });

  socket.on('session:replaced', () => {
    local().setSessionReplaced(true);
    phase = 'idle';
    ride().setConnection('idle');
    void stopServices();
  });

  // ---- device services ---------------------------------------------------------------------------

  cleanups.push(
    location.onSend((fix) => {
      if (phase !== 'active') return;
      const selfId = ride().selfId;
      // The server doesn't echo our own location back; keep our entry in the mirror current.
      if (selfId) ride().setRiderLocation(selfId, fix, serverNow());
      if (socket.connected) socket.volatile.emit('loc:update', fix);
    }),
  );

  cleanups.push(
    voice.onData((from, msg: VoiceDataMessage) => {
      if (phase !== 'active' || typeof msg !== 'object' || msg === null) return;
      // Only trust alerts a rider sends about themselves.
      if (msg.type === 'sos' && msg.sos?.riderId === from && typeof msg.sos.id === 'string') onSosRaised(msg.sos, 'p2p');
      else if (msg.type === 'sos-cancel' && msg.riderId === from && ride().sos[msg.id]?.riderId === from) {
        onSosCancelled(msg.id, from);
      }
    }),
  );

  cleanups.push(
    platform.lifecycle.onResume(() => {
      if (phase !== 'active') return;
      void audio.resume();
      void platform.wakeLock.enable().catch(warn);
      const gps = local().gps.status;
      if (gps === 'off' || gps === 'error' || gps === 'unavailable') void location.start().catch(warn);
      if (!socket.connected) socket.connect();
      void syncClock();
    }),
  );

  cleanups.push(
    platform.network.onChange((online) => {
      if (phase !== 'active') return;
      if (!online) ride().setConnection('offline');
      // The socket can survive a short offline blip (the browser only froze it): just clear the status.
      else if (socket.connected) ride().setConnection('connected');
      else socket.connect();
    }),
  );

  let lastAudioSettings = '';
  const pushAudioSettings = (s: Settings) => {
    const next = audioSettingsOf(s);
    const key = JSON.stringify(next);
    if (key === lastAudioSettings) return;
    lastAudioSettings = key;
    audio.applySettings(next);
  };
  pushAudioSettings(settings());
  cleanups.push(useSettings.subscribe(pushAudioSettings));

  cleanups.push(
    useLocalStore.subscribe((st, prev) => {
      if (phase !== 'active' || st.gps.status === prev.gps.status) return;
      if (st.gps.status === 'denied') {
        local().pushToast({
          kind: 'warning',
          title: 'Location is blocked',
          body: "Other riders can't see you on the map.",
          ttlMs: 10_000,
        });
      } else if (st.gps.status === 'unavailable') {
        local().pushToast({ kind: 'warning', title: 'No GPS signal', body: 'Your position will update when it returns.' });
      }
    }),
  );

  // ---- public API -------------------------------------------------------------------------------

  return {
    async startRide(intent: StartIntent) {
      // Gesture-bound work first: nothing may be awaited before these calls (iOS audio unlock).
      const unlocked = audio.unlock().catch((e) => warn('audio unlock failed', e));
      void platform.wakeLock.enable().catch(warn);

      if (phase === 'starting' || phase === 'leaving') return fail('internal', 'Please wait a moment and try again.');
      if (phase === 'active') {
        if (intent.kind === 'join' && normalizeRideCode(intent.code) === code) return { ok: true, code };
        await leave();
      }
      phase = 'starting';
      local().setSessionReplaced(false);
      ride().setConnection('connecting');
      await unlocked;

      if (!(await ensureConnected())) {
        phase = 'idle';
        ride().setConnection('idle');
        socket.disconnect();
        return fail('internal', "Can't reach the ride server. Check your connection and try again.");
      }
      const rider = riderAuth();
      const res =
        intent.kind === 'create'
          ? await call('ride:create', { rider })
          : await call('ride:join', { code: intent.code, rider });
      if (!res.ok) {
        phase = 'idle';
        ride().setConnection('idle');
        socket.disconnect();
        return res;
      }
      phase = 'active';
      ride().setConnection('connected');
      applyJoin(res, false);
      void startServices(res);
      return { ok: true, code: res.snapshot.code };
    },

    async leaveRide() {
      if (phase === 'active' || phase === 'starting') await leave();
      navigate('/', { replace: true });
    },

    async resumeAudio() {
      const resumed = audio.resume();
      void platform.wakeLock.enable().catch(warn);
      await resumed;
    },

    async raiseSos() {
      const selfId = ride().selfId;
      if (phase !== 'active' || !selfId) return;
      if (Object.values(ride().sos).some((s) => s.riderId === selfId)) return;
      const id = uuid();
      ride().upsertSos({ id, riderId: selfId, location: local().selfFix, raisedAt: serverNow(), responders: [] }, 'local');
      platform.haptics.vibrate([200, 100, 200]);
      refreshSosEffects();
      await sendSos(id);
    },

    async cancelSos(id: string) {
      const s = ride().sos[id];
      if (!s) return;
      clearTimeout(sosTimers.get(id));
      sosTimers.delete(id);
      ride().removeSos(id);
      refreshSosEffects();
      voice.sendData({ type: 'sos-cancel', id, riderId: s.riderId });
      await sendCancel(id);
      if (pendingCancels.has(id)) {
        local().pushToast({ kind: 'warning', title: 'Cancelling SOS…', body: 'Will retry when the connection is back.' });
      }
    },

    async respondSos(id: string) {
      local().acknowledgeSos(id);
      refreshSosEffects();
      const res = await call('sos:respond', { id });
      if (res.ok) {
        ride().upsertSos(res.sos, 'server');
        local().pushToast({ kind: 'success', title: `${riderName(res.sos.riderId)} knows you're coming` });
      } else {
        local().pushToast({ kind: 'error', title: "Couldn't send your reply", body: res.message });
      }
    },

    acknowledgeSos(id: string) {
      local().acknowledgeSos(id);
      refreshSosEffects();
    },

    async requestBreak(kind: BreakKind) {
      const now = Date.now();
      if (now < breakCooldownUntil) {
        return { ok: false, error: 'cooldown', retryInMs: breakCooldownUntil - now } satisfies Err;
      }
      const res = await call('break:request', { id: uuid(), kind, location: local().selfFix });
      if (res.ok) {
        ride().addBreak(res.alert);
        breakCooldownUntil = now + TIMING.breakCooldownMs;
        return { ok: true };
      }
      if (res.error === 'cooldown') breakCooldownUntil = now + (res.retryInMs ?? 0);
      return res;
    },

    searchPlaces(q: string, near?: LatLng) {
      const fix = local().selfFix;
      const bias = near ?? (fix ? { lat: fix.lat, lng: fix.lng } : undefined);
      return call('place:search', { q, near: bias, limit: 8 }, 10_000);
    },

    async setDestination(destination: Place, waypoints?: Place[]) {
      const fix = local().selfFix;
      const res = await call(
        'route:set',
        { destination, waypoints, origin: fix ? { lat: fix.lat, lng: fix.lng } : undefined },
        15_000,
      );
      if (res.ok) ride().setRoute(res.route);
      return res;
    },

    async clearRoute() {
      const res = await call('route:clear', {});
      if (res.ok) ride().setRoute(null);
      return res;
    },

    transferLeader: (to) => call('leader:transfer', { to }),
    setVoiceMode: (mode: VoiceMode) => call('voice:setMode', { mode }),

    async setMicMode(mode: MicMode) {
      settings().update(mode === 'off' ? { micMode: mode } : { micMode: mode, liveMicMode: mode });
      if (phase !== 'active') return;
      await audio.setMicMode(mode).catch(warn);
      void call('rider:update', { micMode: mode });
    },

    async updateProfile(p) {
      const patch: Partial<Settings> = {};
      if (p.name !== undefined && p.name.trim()) patch.name = p.name.trim();
      if (p.color !== undefined) patch.color = p.color;
      if (!patch.name && !patch.color) return;
      settings().update(patch);
      if (phase !== 'active') return;
      const res = await call('rider:update', { name: patch.name, color: patch.color });
      if (res.ok) ride().upsertRider(res.rider);
    },

    getResumableRide: () => getLastRide(),

    dispose() {
      for (const c of cleanups.splice(0)) c();
      for (const t of sosTimers.values()) clearTimeout(t);
      sosTimers.clear();
    },
  };
}
