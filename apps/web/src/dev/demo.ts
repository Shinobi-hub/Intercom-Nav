/**
 * Demo mode (?demo=...): a RideControllerApi that fakes a live ride entirely in the browser, so the
 * UI can be developed and screenshotted without a server. main.tsx only creates it when DEMO_MODE
 * (a `demo` query parameter) is set; importing this module has no side effects.
 *
 * ?demo=<flags>, comma separated:
 *   1 (or empty)  live ride around Pune, you lead, route to Khadakwasla
 *   home          stay on the home screen; Create / Join / Rejoin start the demo ride.
 *                 Join codes starting ZZ fail with ride_not_found, YY with ride_full, XX as unreachable.
 *   rejoin        offer "Rejoin" on the home screen
 *   rider         Arjun leads instead of you
 *   route         no route at first; Arjun sets one a few seconds in
 *   sos           Priya raises an SOS on load
 *   ownsos        your own SOS is active; responders arrive
 *   break         Arjun asks for a fuel stop on load
 *   toasts        one toast of each kind
 *   resume        audio gets interrupted shortly after start ("Tap to resume audio")
 *   replaced      the ride is opened on another device
 *   talking       Arjun and you talk continuously; quiet: nobody talks
 *   nomusic       nothing playing
 */
import type { BreakKind, Err, RiderState, SosAlert, VoiceMode } from '@intercom/shared';
import { normalizeRideCode, RIDER_COLORS, TIMING, uuid } from '@intercom/shared';
import { navigate, ridePath } from '../core/router';
import type { AudioEngineApi, PlatformApi, RideControllerApi, StartIntent } from '../core/services';
import type { Settings } from '../core/store';
import { useLocalStore, useRideStore, useSettings } from '../core/store';
import type { DemoRider } from './demoWorld';
import {
  ARJUN,
  DEMO_RIDERS,
  fixAt,
  GROUP_SPEED,
  KABIR,
  LOOP_PATH,
  loopRoute,
  PLACES,
  PRIYA,
  routeTo,
  SELF_ID,
  START_S,
} from './demoWorld';

export interface DemoDeps {
  audio: AudioEngineApi;
  platform: PlatformApi;
}

export const DEMO_CODE = 'PUNE42';
const BREAK_WORDS: Record<BreakKind, string> = {
  break: 'a break',
  fuel: 'a fuel stop',
  food: 'a food stop',
  restroom: 'a restroom stop',
};

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const fail = (error: Err['error'], message?: string): Err => ({ ok: false, error, message });

export function parseDemoFlags(search: string): Set<string> {
  const raw = new URLSearchParams(search).get('demo') ?? '';
  return new Set(
    raw
      .split(',')
      .map((f) => f.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** A controller that fakes a live ride (moving riders, alerts) entirely in the browser. */
export function createDemoController({ audio, platform }: DemoDeps): RideControllerApi {
  const flags = parseDemoFlags(window.location.search);
  const ride = useRideStore.getState;
  const local = useLocalStore.getState;
  const settings = useSettings.getState;

  let timers: Array<ReturnType<typeof setTimeout>> = [];
  let ticker: ReturnType<typeof setInterval> | undefined;
  let startedAt = 0;
  let breakCooldownUntil = 0;
  let sirenOn = false;
  let sosModeOn = false;

  const later = (ms: number, fn: () => void) => {
    timers.push(setTimeout(fn, ms));
  };
  const name = (id: string) => ride().riders[id]?.name ?? 'A rider';
  const elapsedS = () => (Date.now() - startedAt) / 1000;
  const selfS = () => START_S + GROUP_SPEED * elapsedS();

  function riderS(r: DemoRider): number {
    return selfS() + r.offset + r.sway * Math.sin((2 * Math.PI * elapsedS()) / 90 + r.phase);
  }

  function riderSpeed(r: DemoRider): number {
    return GROUP_SPEED + r.sway * ((2 * Math.PI) / 90) * Math.cos((2 * Math.PI * elapsedS()) / 90 + r.phase);
  }

  // ---- simulation ------------------------------------------------------------------------------

  function tick(): void {
    const now = Date.now();
    const cycle = elapsedS() % 120;
    for (const r of DEMO_RIDERS) {
      if (!r.online) continue;
      if (r.dropout && cycle >= r.dropout[0] && cycle < r.dropout[1]) continue;
      ride().setRiderLocation(r.id, fixAt(LOOP_PATH, riderS(r), riderSpeed(r), 6), now);
    }
    const accuracy = 4 + Math.round(Math.abs(Math.sin(now / 7_000)) * 4);
    const mine = fixAt(LOOP_PATH, selfS(), GROUP_SPEED, accuracy);
    local().setSelfFix(mine);
    local().setGps({ status: 'active', accuracyM: accuracy, lastFixAt: now, error: null });
    ride().setRiderLocation(SELF_ID, mine, now);
    if (settings().micMode !== 'off') {
      const talking = local().speaking[SELF_ID] === true;
      local().setAudio({ micLevelDb: talking ? -18 - Math.random() * 6 : -52 + Math.random() * 6 });
    }
  }

  function scheduleTalk(): void {
    if (flags.has('quiet') || flags.has('talking')) return;
    later(2_000 + Math.random() * 3_500, () => {
      const candidates = DEMO_RIDERS.filter((r) => r.online && r.micMode !== 'off').map((r) => r.id);
      if (settings().micMode !== 'off' && Math.random() < 0.25) candidates.push(SELF_ID);
      const id = candidates[Math.floor(Math.random() * candidates.length)];
      if (id) {
        local().setSpeaking(id, true);
        later(1_200 + Math.random() * 3_000, () => local().setSpeaking(id, false));
      }
      scheduleTalk();
    });
  }

  function seed(code: string): void {
    const now = Date.now();
    const s = settings();
    const leaderId = flags.has('rider') || flags.has('route') ? ARJUN : SELF_ID;
    const palette = RIDER_COLORS.filter((c) => c.toLowerCase() !== s.color.toLowerCase());
    const riders: RiderState[] = [
      {
        id: SELF_ID,
        name: s.name.trim() || 'Aarav',
        color: s.color,
        role: leaderId === SELF_ID ? 'leader' : 'rider',
        online: true,
        joinedAt: now - 42 * 60_000,
        lastSeenAt: now,
        location: null,
        locationAt: null,
        micMode: s.micMode,
      },
      ...DEMO_RIDERS.map((r, i): RiderState => {
        const lastSeen = r.online ? now : now - 4 * 60_000;
        return {
          id: r.id,
          name: r.name,
          color: palette[i % palette.length]!,
          role: r.id === leaderId ? 'leader' : 'rider',
          online: r.online,
          joinedAt: now - (45 - i) * 60_000,
          lastSeenAt: lastSeen,
          location: r.online ? null : { ...fixAt(LOOP_PATH, START_S + r.offset, 0, 12), t: lastSeen },
          locationAt: r.online ? null : lastSeen,
          micMode: r.micMode,
        };
      }),
    ];
    ride().applySnapshot(
      {
        code,
        createdAt: now - 45 * 60_000,
        leaderId,
        voiceMode: 'livekit',
        maxRiders: 8,
        riders,
        route: flags.has('route') ? null : loopRoute(leaderId),
        activeSos: [],
        recentBreaks: [],
        serverNow: now,
      },
      SELF_ID,
    );
    ride().setClockOffset(0);
    ride().setConnection('connected');
    local().setVoice({
      state: 'connected',
      transport: 'livekit',
      peers: Object.fromEntries(DEMO_RIDERS.filter((r) => r.online).map((r) => [r.id, 'connected' as const])),
      error: null,
    });
    const playing = !flags.has('nomusic');
    local().setAudio({
      contextState: 'running',
      micState: s.micMode === 'off' ? 'off' : 'live',
      micLevelDb: s.micMode === 'off' ? null : -50,
      musicPlaying: playing,
      nowPlaying: playing ? { id: 'demo-track', title: 'Western Ghats Drive' } : null,
      error: null,
    });
  }

  function startWorld(code: string): void {
    stopWorld();
    startedAt = Date.now();
    seed(code);
    tick();
    ticker = setInterval(tick, 1_000);
    if (flags.has('talking')) {
      local().setSpeaking(ARJUN, true);
      if (settings().micMode !== 'off') local().setSpeaking(SELF_ID, true);
    }
    scheduleTalk();
  }

  function stopWorld(): void {
    clearInterval(ticker);
    ticker = undefined;
    for (const t of timers) clearTimeout(t);
    timers = [];
    if (sirenOn) audio.alerts.stopSiren();
    if (sosModeOn) audio.setSosMode(false);
    sirenOn = false;
    sosModeOn = false;
  }

  function resetStores(): void {
    ride().reset();
    const l = local();
    l.setSelfFix(null);
    l.setGps({ status: 'off', accuracyM: null, lastFixAt: null, error: null });
    l.setVoice({ state: 'off', transport: null, peers: {}, error: null });
    l.setAudio({ micState: 'off', micLevelDb: null, musicPlaying: false, nowPlaying: null });
    for (const id of Object.keys(l.speaking)) l.clearSpeaking(id);
    useLocalStore.setState((st) => ({
      ui: { ...st.ui, focus: null, sheet: null, toasts: [], acknowledgedSos: {}, sessionReplaced: false },
    }));
  }

  // ---- alert side effects (what the real controller does for remote events) ---------------------

  function refreshSosEffects(): void {
    const { sos, selfId } = ride();
    const acked = local().ui.acknowledgedSos;
    let own = false;
    let unacked = false;
    for (const s of Object.values(sos)) {
      if (s.riderId === selfId) own = true;
      else if (!acked[s.id]) unacked = true;
    }
    if (own || unacked) {
      if (!sosModeOn) audio.setSosMode(true);
    } else if (sosModeOn) {
      audio.setSosMode(false);
    }
    sosModeOn = own || unacked;
    if (unacked !== sirenOn) {
      if (unacked) audio.alerts.startSiren();
      else audio.alerts.stopSiren();
      sirenOn = unacked;
    }
  }

  function remoteSos(riderId: string, responders: SosAlert['responders'] = []): void {
    const sos: SosAlert = {
      id: uuid(),
      riderId,
      location: ride().riders[riderId]?.location ?? null,
      raisedAt: Date.now() - 14_000,
      responders,
    };
    ride().upsertSos(sos, 'server');
    platform.haptics.vibrate([600, 200, 600, 200, 600]);
    local().focusRider(riderId);
    if (settings().announce) audio.alerts.announce(`SOS from ${name(riderId)}`);
    refreshSosEffects();
  }

  function remoteBreak(riderId: string, kind: BreakKind): void {
    const words = BREAK_WORDS[kind];
    ride().addBreak({ id: uuid(), riderId, kind, location: ride().riders[riderId]?.location ?? null, at: Date.now() });
    audio.alerts.chime('break');
    platform.haptics.vibrate(120);
    local().pushToast({ kind: 'break', title: `${name(riderId)} wants ${words}`, riderId, ttlMs: 8_000 });
    if (settings().announce) audio.alerts.announce(`${name(riderId)} wants ${words}`);
  }

  function responderArrives(sosId: string, riderId: string): void {
    const s = ride().sos[sosId];
    if (!s || s.responders.some((r) => r.riderId === riderId)) return;
    ride().upsertSos({ ...s, responders: [...s.responders, { riderId, at: Date.now() }] }, 'server');
    audio.alerts.chime('responder');
    local().pushToast({ kind: 'success', title: `${name(riderId)} is coming`, riderId });
  }

  function applyScenarios(): void {
    if (flags.has('sos')) later(400, () => remoteSos(PRIYA, [{ riderId: KABIR, at: Date.now() - 5_000 }]));
    if (flags.has('break')) later(500, () => remoteBreak(ARJUN, 'fuel'));
    if (flags.has('route')) {
      later(2_500, () => {
        ride().setRoute(loopRoute(ARJUN));
        audio.alerts.chime('route');
        local().pushToast({ kind: 'info', title: 'New destination', body: 'Khadakwasla Dam' });
      });
    }
    if (flags.has('ownsos')) {
      const id = uuid();
      ride().upsertSos(
        {
          id,
          riderId: SELF_ID,
          location: local().selfFix,
          raisedAt: Date.now() - 30_000,
          responders: [{ riderId: ARJUN, at: Date.now() - 12_000 }],
        },
        'server',
      );
      refreshSosEffects();
      later(4_000, () => responderArrives(id, PRIYA));
    }
    if (flags.has('toasts')) {
      later(200, () => {
        local().pushToast({ kind: 'info', title: 'Kabir joined', riderId: KABIR, ttlMs: 0 });
        local().pushToast({ kind: 'success', title: 'Priya is coming', riderId: PRIYA, ttlMs: 0 });
        local().pushToast({ kind: 'warning', title: 'No GPS signal', body: 'Your position will update when it returns.', ttlMs: 0 });
        local().pushToast({ kind: 'break', title: 'Arjun wants a fuel stop', riderId: ARJUN, ttlMs: 0 });
      });
    }
    if (flags.has('resume')) later(800, () => local().setAudio({ contextState: 'interrupted' }));
    if (flags.has('replaced')) {
      later(600, () => {
        local().setSessionReplaced(true);
        ride().setConnection('idle');
      });
    }
  }

  // Auto-start unless we're demoing the home screen. Runs before React mounts, so the first
  // render already shows the ride; the query string is kept so a reload stays in demo mode.
  if (!flags.has('home')) {
    startWorld(DEMO_CODE);
    window.history.replaceState(null, '', ridePath(DEMO_CODE) + window.location.search);
    applyScenarios();
  }

  // ---- RideControllerApi -------------------------------------------------------------------------

  async function startRide(intent: StartIntent) {
    void audio.unlock().catch(() => {});
    const code = intent.kind === 'create' ? DEMO_CODE : normalizeRideCode(intent.code);
    if (ride().ride?.code === code && ticker !== undefined) {
      local().setSessionReplaced(false);
      ride().setConnection('connected');
      return { ok: true as const, code };
    }
    ride().setConnection('connecting');
    await wait(700);
    if (intent.kind === 'join') {
      const failure = code.startsWith('ZZ')
        ? fail('ride_not_found', 'No such ride.')
        : code.startsWith('YY')
          ? fail('ride_full', 'This ride is full.')
          : code.startsWith('XX')
            ? fail('internal', "Can't reach the ride server. Check your connection and try again.")
            : null;
      if (failure) {
        ride().setConnection(ride().ride ? 'connected' : 'idle');
        return failure;
      }
    }
    local().setSessionReplaced(false);
    startWorld(code);
    applyScenarios();
    return { ok: true as const, code };
  }

  return {
    startRide,

    async leaveRide() {
      stopWorld();
      resetStores();
      navigate('/', { replace: true });
    },

    async resumeAudio() {
      void audio.resume().catch(() => false);
      local().setAudio({ contextState: 'running' });
    },

    async raiseSos() {
      if (Object.values(ride().sos).some((s) => s.riderId === SELF_ID)) return;
      const id = uuid();
      ride().upsertSos({ id, riderId: SELF_ID, location: local().selfFix, raisedAt: Date.now(), responders: [] }, 'local');
      platform.haptics.vibrate([200, 100, 200]);
      refreshSosEffects();
      later(900, () => {
        const s = ride().sos[id];
        if (!s) return;
        ride().upsertSos(s, 'server');
        audio.alerts.chime('sent');
        local().pushToast({ kind: 'sos', title: 'SOS sent to the group', body: 'Hold Cancel on the SOS banner to call it off.' });
      });
      later(4_000, () => responderArrives(id, ARJUN));
      later(8_000, () => responderArrives(id, KABIR));
    },

    async cancelSos(id: string) {
      ride().removeSos(id);
      refreshSosEffects();
    },

    async respondSos(id: string) {
      local().acknowledgeSos(id);
      const s = ride().sos[id];
      if (s && !s.responders.some((r) => r.riderId === SELF_ID)) {
        ride().upsertSos({ ...s, responders: [...s.responders, { riderId: SELF_ID, at: Date.now() }] }, 'server');
        local().pushToast({ kind: 'success', title: `${name(s.riderId)} knows you're coming` });
      }
      refreshSosEffects();
    },

    acknowledgeSos(id: string) {
      local().acknowledgeSos(id);
      refreshSosEffects();
    },

    async requestBreak(kind: BreakKind) {
      const now = Date.now();
      if (now < breakCooldownUntil) return { ok: false, error: 'cooldown', retryInMs: breakCooldownUntil - now };
      await wait(250);
      ride().addBreak({ id: uuid(), riderId: SELF_ID, kind, location: local().selfFix, at: Date.now() });
      breakCooldownUntil = now + TIMING.breakCooldownMs;
      return { ok: true };
    },

    async searchPlaces(q: string) {
      await wait(250);
      const needle = q.trim().toLowerCase();
      const results = PLACES.filter(
        (p) => p.name.toLowerCase().includes(needle) || (p.address ?? '').toLowerCase().includes(needle),
      );
      return { ok: true, results: results.slice(0, 8) };
    },

    async setDestination(destination) {
      await wait(500);
      const from = local().selfFix ?? PLACES[PLACES.length - 1]!;
      const route = routeTo(from, destination, SELF_ID);
      ride().setRoute(route);
      return { ok: true, route };
    },

    async clearRoute() {
      ride().setRoute(null);
      return { ok: true };
    },

    async transferLeader(to: string) {
      if (!ride().riders[to]) return fail('not_found');
      ride().setLeader(to);
      local().pushToast({ kind: 'info', title: `${name(to)} is now leading` });
      return { ok: true };
    },

    async setVoiceMode(mode: VoiceMode) {
      ride().setVoiceMode(mode);
      local().setVoice({ state: 'connecting', transport: mode });
      later(900, () => local().setVoice({ state: 'connected' }));
      local().pushToast({
        kind: 'info',
        title: mode === 'livekit' ? 'Voice now goes through the server' : 'Voice now goes rider to rider',
      });
      return { ok: true };
    },

    async setMicMode(mode) {
      settings().update(mode === 'off' ? { micMode: mode } : { micMode: mode, liveMicMode: mode });
      local().setAudio({ micState: mode === 'off' ? 'off' : 'live', micLevelDb: mode === 'off' ? null : -50 });
      if (mode === 'off') local().setSpeaking(SELF_ID, false);
      const self = ride().riders[SELF_ID];
      if (self) ride().upsertRider({ ...self, micMode: mode });
    },

    async updateProfile(p) {
      const patch: Partial<Settings> = {};
      if (p.name?.trim()) patch.name = p.name.trim();
      if (p.color) patch.color = p.color;
      settings().update(patch);
      const self = ride().riders[SELF_ID];
      if (self) ride().upsertRider({ ...self, ...patch });
    },

    getResumableRide: () => (flags.has('rejoin') ? DEMO_CODE : null),
  };
}
