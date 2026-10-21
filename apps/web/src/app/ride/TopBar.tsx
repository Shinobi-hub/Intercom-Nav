import { formatRideCode } from '@intercom/shared';
import type { LucideIcon } from 'lucide-react';
import {
  AudioLines,
  AudioLinesOff,
  LocateFixed,
  LocateOff,
  QrCode,
  RefreshCw,
  Users,
  Wifi,
  WifiOff,
} from 'lucide-react';
import type { ConnectionState, GpsInfo, VoiceInfo } from '../../core/store';
import { useLocalStore, useRideStore, useSettings } from '../../core/store';
import { TID } from '../../core/testIds';
import { tapFeedback } from '../../ui/feedback';
import styles from './ride.module.css';

type Tone = 'ok' | 'warn' | 'bad' | 'off';

interface Lamp {
  tone: Tone;
  icon: LucideIcon;
  caption: string;
  label: string;
}

function connectionLamp(state: ConnectionState): Lamp {
  switch (state) {
    case 'connected':
      return { tone: 'ok', icon: Wifi, caption: 'NET', label: 'Connected to the ride server' };
    case 'connecting':
      return { tone: 'warn', icon: RefreshCw, caption: 'NET', label: 'Connecting to the ride server' };
    case 'reconnecting':
      return { tone: 'warn', icon: RefreshCw, caption: 'NET', label: 'Reconnecting to the ride server' };
    case 'offline':
      return { tone: 'bad', icon: WifiOff, caption: 'NET', label: 'Offline: no connection to the ride server' };
    default:
      return { tone: 'off', icon: WifiOff, caption: 'NET', label: 'Not connected' };
  }
}

function voiceLamp(voice: VoiceInfo): Lamp {
  const via = voice.transport === 'mesh' ? 'rider to rider' : 'through the server';
  switch (voice.state) {
    case 'connected':
      return { tone: 'ok', icon: AudioLines, caption: 'VOICE', label: `Voice connected, ${via}` };
    case 'connecting':
    case 'reconnecting':
      return { tone: 'warn', icon: RefreshCw, caption: 'VOICE', label: 'Voice connecting' };
    case 'failed':
      return { tone: 'bad', icon: AudioLinesOff, caption: 'VOICE', label: 'Voice failed, retrying' };
    default:
      return { tone: 'off', icon: AudioLinesOff, caption: 'VOICE', label: 'Voice off' };
  }
}

function gpsLamp(gps: GpsInfo, imperial: boolean): Lamp {
  if (gps.status === 'active') {
    const acc = gps.accuracyM;
    if (acc === null) return { tone: 'ok', icon: LocateFixed, caption: 'GPS', label: 'GPS active' };
    const shown = imperial ? `±${Math.round(acc * 3.28084)}ft` : `±${Math.round(acc)}m`;
    const tone: Tone = acc <= 20 ? 'ok' : acc <= 60 ? 'warn' : 'bad';
    return { tone, icon: LocateFixed, caption: shown, label: `GPS accurate to ${shown.slice(1)}` };
  }
  switch (gps.status) {
    case 'starting':
      return { tone: 'warn', icon: LocateFixed, caption: 'GPS', label: 'Finding your position' };
    case 'denied':
      return { tone: 'bad', icon: LocateOff, caption: 'GPS', label: 'Location permission denied' };
    case 'unavailable':
    case 'error':
      return { tone: 'bad', icon: LocateOff, caption: 'GPS', label: 'No GPS signal' };
    default:
      return { tone: 'off', icon: LocateOff, caption: 'GPS', label: 'GPS off' };
  }
}

function Telltale({ lamp, testId, ...data }: { lamp: Lamp; testId: string } & Record<`data-${string}`, string>) {
  const Icon = lamp.icon;
  return (
    <div className={styles.telltale} role="img" aria-label={lamp.label} title={lamp.label} data-tone={lamp.tone} data-testid={testId} {...data}>
      <Icon className={styles.telltaleIcon} aria-hidden="true" />
      <span className={styles.telltaleCaption}>{lamp.caption}</span>
    </div>
  );
}

function openSheet(id: 'share' | 'riders') {
  tapFeedback();
  useLocalStore.getState().openSheet(id);
}

/** Ride code (opens Share), status telltales, and the rider count (opens Riders). */
export function TopBar({ code }: { code: string }) {
  const connection = useRideStore((s) => s.connection);
  const online = useRideStore((s) => Object.values(s.riders).filter((r) => r.online).length);
  const total = useRideStore((s) => Object.keys(s.riders).length);
  const voice = useLocalStore((s) => s.voice);
  const gps = useLocalStore((s) => s.gps);
  const shareOpen = useLocalStore((s) => s.ui.sheet === 'share');
  const imperial = useSettings((s) => s.units === 'imperial');
  const formatted = formatRideCode(code);

  return (
    <header className={styles.topbar}>
      <button
        type="button"
        className={styles.code}
        // While the Share sheet shows the code large, that display owns the test id (ids stay unique).
        data-testid={shareOpen ? undefined : TID.rideCode}
        data-code={code}
        aria-label={`Ride code ${formatted}. Share the ride.`}
        onClick={() => openSheet('share')}
      >
        <span className={styles.codeText}>{formatted}</span>
        <QrCode className={styles.codeIcon} aria-hidden="true" />
      </button>

      <div className={styles.telltales} role="group" aria-label="Status">
        <Telltale lamp={connectionLamp(connection)} testId={TID.connectionStatus} data-state={connection} />
        <Telltale
          lamp={voiceLamp(voice)}
          testId={TID.voiceStatus}
          data-state={voice.state}
          data-transport={voice.transport ?? 'none'}
        />
        <Telltale
          lamp={gpsLamp(gps, imperial)}
          testId={TID.gpsStatus}
          data-state={gps.status}
          data-accuracy={gps.accuracyM === null ? '' : String(Math.round(gps.accuracyM))}
        />
      </div>

      <button
        type="button"
        className={styles.count}
        data-testid={TID.riderCount}
        data-count={online}
        data-total={total}
        aria-label={`${online} of ${total} riders online. Show riders.`}
        onClick={() => openSheet('riders')}
      >
        <Users className={styles.countIcon} aria-hidden="true" />
        <span className={styles.countValue}>{online}</span>
      </button>
    </header>
  );
}
