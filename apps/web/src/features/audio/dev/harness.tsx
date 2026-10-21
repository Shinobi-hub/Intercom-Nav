/**
 * Dev harness for the audio engine and voice transports (apps/web/audio-dev.html).
 *
 *   /audio-dev.html                      solo: mic, VAD, ducking, music, alerts
 *   /audio-dev.html?mesh=1&rider=A       mesh voice between two tabs (open ?rider=B in another)
 *   /audio-dev.html?lk=ws://…&token=…&rider=A   LiveKit voice with a pre-minted token
 *
 * Everything is also reachable from window.__harness for scripted checks.
 */
import type { MicMode, RiderState, VoiceJoinInfo } from '@intercom/shared';
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../../styles/tokens.css';
import '../../../styles/global.css';
import { installDebugGlobal, type VadDebugEntry } from '../../../core/debug';
import type { AudioSettings, ChimeKind, VoiceStats } from '../../../core/services';
import { setServices } from '../../../core/services';
import { createAppSocket } from '../../../core/socket';
import { useLocalStore, useRideStore } from '../../../core/store';
import { createStubController, createStubLocationService, createStubPlatform } from '../../../core/stubs';
import { broadcastSignaling, createVoiceManager } from '../../voice';
import { AudioEngine } from '../engine/audioEngine';
import { MicLevelMeter } from '../components/MicLevelMeter';
import { MusicPanel } from '../components/MusicPanel';
import { Probe, measureAlertPeaks, sirenPitchTrack, testToneFile } from './probe';
import styles from './harness.module.css';

const RIDERS = { A: '00000000-0000-4000-8000-00000000000a', B: '00000000-0000-4000-8000-00000000000b' } as const;

const params = new URLSearchParams(window.location.search);
const riderKey = params.get('rider') === 'B' ? 'B' : 'A';
const selfId = RIDERS[riderKey];
const peerId = RIDERS[riderKey === 'A' ? 'B' : 'A'];
const lkUrl = params.get('lk');
const lkToken = params.get('token');
const meshMode = params.has('mesh');
const voiceMode = lkUrl && lkToken ? 'livekit' : meshMode ? 'mesh' : null;

const platform = createStubPlatform();
const socket = createAppSocket('http://127.0.0.1:9');
const engine = new AudioEngine({ platform });
const voice = createVoiceManager({ socket, audio: engine, signaling: voiceMode === 'mesh' ? broadcastSignaling(selfId) : undefined });
setServices({ platform, socket, audio: engine, voice, location: createStubLocationService(), controller: createStubController() });
installDebugGlobal();

const rider = (id: string, name: string): RiderState => ({
  id,
  name,
  color: '#0A84FF',
  role: 'rider',
  online: true,
  joinedAt: Date.now(),
  lastSeenAt: Date.now(),
  location: null,
  locationAt: null,
  micMode: 'vox',
});

// A two-rider ride, so the mesh transport has someone to connect to and own speaking has an id.
useRideStore.setState({
  selfId,
  riders: { [RIDERS.A]: rider(RIDERS.A, 'Rider A'), [RIDERS.B]: rider(RIDERS.B, 'Rider B') },
});

let settings: AudioSettings = {
  voiceVolume: 1,
  musicVolume: 0.8,
  duckLevel: 0.3,
  duckOnOwnVoice: true,
  vadSensitivity: 0.5,
  riderVolumes: {},
  inputDeviceId: null,
  outputDeviceId: null,
};

const probe = new Probe(engine);

const joinInfo = (): VoiceJoinInfo | null =>
  voiceMode === 'livekit'
    ? { mode: 'livekit', available: ['livekit', 'mesh'], livekit: { url: lkUrl!, token: lkToken!, room: 'dev' }, iceServers: [] }
    : voiceMode === 'mesh'
      ? { mode: 'mesh', available: ['mesh'], livekit: null, iceServers: [] }
      : null;

/** The Start tap: unlock synchronously, then mic, then voice (the real controller's order). */
async function start(mode: MicMode = (params.get('mode') as MicMode | null) ?? 'vox'): Promise<void> {
  const unlocked = engine.unlock();
  engine.applySettings(settings);
  await unlocked;
  await engine.setMicMode(mode);
  const info = joinInfo();
  if (info) await voice.start(info, selfId);
}

function updateSettings(patch: Partial<AudioSettings>): void {
  settings = { ...settings, ...patch };
  engine.applySettings(settings);
}

const harness = {
  engine,
  voice,
  probe,
  selfId,
  peerId,
  start,
  updateSettings,
  setMicMode: (m: MicMode) => engine.setMicMode(m),
  addTestTone: () => engine.music.addFiles([testToneFile()]),
  measureAlertPeaks,
  sirenPitchTrack,
  stats: () => voice.getStats(),
};
declare global {
  interface Window {
    __harness?: typeof harness;
  }
}
window.__harness = harness;

// ---- UI -------------------------------------------------------------------------------------------

function usePoll<T>(read: () => T, ms: number): T {
  const [v, setV] = useState(read);
  useEffect(() => {
    const t = setInterval(() => setV(read()), ms);
    return () => clearInterval(t);
  }, [read, ms]);
  return v;
}

const readVad = () => window.__intercom?.audio?.vad() ?? {};
const readGains = () => {
  const a = window.__intercom?.audio;
  return a ? { duck: a.duckGain(), music: a.musicGain(), gate: a.voxGate(), ctx: a.contextState(), out: a.outgoingTrackState() } : null;
};

function VadMeters() {
  const vad = usePoll(readVad, 80);
  const entries = Object.entries(vad) as [string, VadDebugEntry][];
  if (!entries.length) return <p className={styles.dim}>No VAD running yet.</p>;
  return (
    <div className={styles.meters}>
      {entries.map(([id, v]) => (
        <div key={id} className={styles.meterRow} data-vad={id === selfId ? 'self' : id} data-speaking={v.speaking}>
          <span className={styles.lamp} data-on={v.speaking} />
          <span className={styles.meterName}>{id === 'self' ? 'self (mic)' : id === peerId ? `rider ${riderKey === 'A' ? 'B' : 'A'}` : id.slice(0, 8)}</span>
          <span className={styles.bar}>
            <span style={{ width: `${Math.max(0, Math.min(100, ((v.levelDb + 80) / 70) * 100))}%` }} />
          </span>
          <span className={styles.num}>{v.levelDb.toFixed(0)} dB</span>
          <span className={styles.num}>floor {v.floorDb.toFixed(0)}</span>
        </div>
      ))}
    </div>
  );
}

function Gains() {
  const g = usePoll(readGains, 50);
  if (!g) return null;
  return (
    <div className={styles.readouts}>
      <span>context <b>{g.ctx}</b></span>
      <span>duck gain <b data-testid="duck-gain">{g.duck.toFixed(3)}</b></span>
      <span>music gain <b>{g.music.toFixed(3)}</b></span>
      <span>vox gate <b>{g.gate.toFixed(2)}</b></span>
      <span>outgoing <b>{g.out}</b></span>
    </div>
  );
}

function VoicePanel() {
  const v = useLocalStore((s) => s.voice);
  const [stats, setStats] = useState<VoiceStats | null>(null);
  useEffect(() => {
    const t = setInterval(() => void voice.getStats().then(setStats), 1_000);
    return () => clearInterval(t);
  }, []);
  if (!voiceMode) return <p className={styles.dim}>Solo mode. Add ?mesh=1&amp;rider=A (and B in another tab) or ?lk=…&amp;token=… for voice.</p>;
  return (
    <div className={styles.readouts}>
      <span>
        {v.transport ?? voiceMode} <b data-testid="voice-state">{v.state}</b>
      </span>
      {Object.entries(v.peers).map(([id, s]) => (
        <span key={id}>
          peer {id === peerId ? (riderKey === 'A' ? 'B' : 'A') : id.slice(0, 8)} <b>{s}</b>
        </span>
      ))}
      {stats && (
        <span>
          sent <b>{(stats.bytesSent / 1e3).toFixed(1)} kB</b> · received{' '}
          <b>{(Object.values(stats.peers).reduce((n, p) => n + p.bytesReceived, 0) / 1e3).toFixed(1)} kB</b>
        </span>
      )}
      {v.error && <span className={styles.err}>{v.error}</span>}
    </div>
  );
}

const CHIME_KINDS: ChimeKind[] = ['break', 'join', 'leave', 'sent', 'route', 'responder', 'error'];

function Harness() {
  const [started, setStarted] = useState(false);
  const [mode, setMode] = useState<MicMode>((params.get('mode') as MicMode | null) ?? 'vox');
  const [sens, setSens] = useState(settings.vadSensitivity);
  const [duck, setDuck] = useState(settings.duckLevel);
  const [ownDuck, setOwnDuck] = useState(settings.duckOnOwnVoice);
  const siren = useLocalStore((s) => s.audio.sirenActive);
  const micState = useLocalStore((s) => s.audio.micState);
  const [peaks, setPeaks] = useState<Record<string, number> | null>(null);

  return (
    <main className={styles.page}>
      <h1>
        Audio harness <span className={styles.dim}>· rider {riderKey} · {voiceMode ?? 'solo'}</span>
      </h1>
      <section className={styles.card}>
        <button
          className={styles.primary}
          data-testid="harness-start"
          disabled={started}
          onClick={() => {
            setStarted(true);
            void start(mode);
          }}
        >
          {started ? 'Running' : 'Start audio'}
        </button>
        <span className={styles.dim}>mic: {micState}</span>
        <Gains />
      </section>

      <section className={styles.card}>
        <h2>Mic</h2>
        <div className={styles.row}>
          {(['vox', 'open', 'off'] as const).map((m) => (
            <button
              key={m}
              data-testid={`harness-mic-${m}`}
              className={m === mode ? styles.on : undefined}
              onClick={() => {
                setMode(m);
                if (started) void engine.setMicMode(m);
              }}
            >
              {m}
            </button>
          ))}
        </div>
        <label className={styles.slider}>
          Sensitivity {sens.toFixed(2)}
          <input type="range" min={0} max={1} step={0.05} value={sens} onChange={(e) => (setSens(+e.target.value), updateSettings({ vadSensitivity: +e.target.value }))} />
        </label>
        <label className={styles.slider}>
          Duck level {duck.toFixed(2)}
          <input type="range" min={0} max={1} step={0.05} value={duck} onChange={(e) => (setDuck(+e.target.value), updateSettings({ duckLevel: +e.target.value }))} />
        </label>
        <label>
          <input type="checkbox" checked={ownDuck} onChange={(e) => (setOwnDuck(e.target.checked), updateSettings({ duckOnOwnVoice: e.target.checked }))} /> Duck music on my own voice
        </label>
        <MicLevelMeter />
      </section>

      <section className={styles.card}>
        <h2>VADs</h2>
        <VadMeters />
      </section>

      <section className={styles.card}>
        <h2>Voice</h2>
        <VoicePanel />
      </section>

      <section className={styles.card}>
        <h2>Alerts</h2>
        <div className={styles.row}>
          <button className={siren ? styles.danger : undefined} onClick={() => (siren ? engine.alerts.stopSiren() : engine.alerts.startSiren())}>
            {siren ? 'Stop siren' : 'Siren'}
          </button>
          {CHIME_KINDS.map((k) => (
            <button key={k} onClick={() => engine.alerts.chime(k)}>
              {k}
            </button>
          ))}
          <button onClick={() => engine.alerts.click()}>click</button>
          <button onClick={() => engine.alerts.announce('Alex wants a fuel stop')}>announce</button>
          <button onClick={() => engine.alerts.announce('SOS from Alex, 2 kilometres away')}>urgent</button>
          <button onClick={() => void measureAlertPeaks().then(setPeaks)}>measure peaks</button>
          <button onClick={() => engine.setSosMode(true)}>SOS mode on</button>
          <button onClick={() => engine.setSosMode(false)}>SOS mode off</button>
        </div>
        {peaks && <pre className={styles.pre}>{JSON.stringify(peaks)}</pre>}
      </section>

      <section className={styles.card}>
        <h2>Music</h2>
        <div className={styles.row}>
          <button data-testid="harness-test-tone" onClick={() => void harness.addTestTone()}>
            Add test tone track
          </button>
        </div>
        <MusicPanel onDone={() => {}} />
      </section>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Harness />
  </StrictMode>,
);
