import type { RiderState } from '@intercom/shared';
import { TIMING } from '@intercom/shared';
import { AudioLines, Crown, MicOff, Volume2, VolumeX } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import { formatAgo, formatDistance, formatSpeed } from '../../core/format';
import { getServices } from '../../core/services';
import { useLocalStore, useRideStore, useSettings } from '../../core/store';
import { TID } from '../../core/testIds';
import { useRiderGap } from '../../features/route';
import { Button } from '../../ui/Button';
import { cx } from '../../ui/cx';
import { errorFeedback, tapFeedback } from '../../ui/feedback';
import { RiderAvatar } from '../../ui/RiderAvatar';
import { Slider } from '../../ui/Slider';
import { useNow } from '../../ui/useNow';
import { useRideUi } from '../ride/rideUi';
import styles from './sheets.module.css';

type Presence = 'live' | 'stale' | 'lost' | 'offline' | 'waiting';

function presenceOf(r: RiderState, serverNow: number): { state: Presence; text: string } {
  if (!r.online) return { state: 'offline', text: `Offline · seen ${formatAgo(serverNow - r.lastSeenAt)}` };
  if (r.locationAt === null) return { state: 'waiting', text: 'Online · no position yet' };
  const age = serverNow - r.locationAt;
  if (age > TIMING.riderLostMs) return { state: 'lost', text: `No position · last seen ${formatAgo(age)}` };
  if (age > TIMING.riderStaleMs) return { state: 'stale', text: `Weak signal · ${formatAgo(age)}` };
  return { state: 'live', text: 'Online' };
}

/** Volume a rider had before being muted, so unmuting restores it. */
const volumeBeforeMute = new Map<string, number>();

/** Everyone in the ride: presence, gap, who is talking, and per-rider volume. */
export function RidersSheet() {
  const riders = useRideStore((s) => s.riders);
  const selfId = useRideStore((s) => s.selfId);
  const leaderId = useRideStore((s) => s.ride?.leaderId ?? null);
  const clockOffsetMs = useRideStore((s) => s.clockOffsetMs);
  const highlight = useRideUi((s) => s.highlightRider);
  const now = useNow(1_000);

  useEffect(() => () => useRideUi.setState({ highlightRider: null }), []);

  const list = useMemo(() => {
    const rank = (r: RiderState) => (r.id === selfId ? 0 : r.id === leaderId ? 1 : r.online ? 2 : 3);
    return Object.values(riders).sort((a, b) => rank(a) - rank(b) || a.joinedAt - b.joinedAt);
  }, [riders, selfId, leaderId]);

  return (
    <ul className={styles.riders} data-testid={TID.ridersList} aria-label="Riders">
      {list.map((r) => (
        <RiderRow
          key={r.id}
          rider={r}
          isSelf={r.id === selfId}
          isLeader={r.id === leaderId}
          canLead={selfId !== null && selfId === leaderId}
          serverNow={now + clockOffsetMs}
          highlighted={highlight === r.id}
        />
      ))}
    </ul>
  );
}

interface RiderRowProps {
  rider: RiderState;
  isSelf: boolean;
  isLeader: boolean;
  /** I lead the ride, so I may hand leadership to this rider. */
  canLead: boolean;
  serverNow: number;
  highlighted: boolean;
}

function RiderRow({ rider, isSelf, isLeader, canLead, serverNow, highlighted }: RiderRowProps) {
  const row = useRef<HTMLLIElement>(null);
  const speaking = useLocalStore((s) => s.speaking[rider.id] === true);
  const units = useSettings((s) => s.units);
  const volume = useSettings((s) => s.riderVolumes[rider.id] ?? 1);
  const gap = useRiderGap(rider.id);
  const presence = presenceOf(rider, serverNow);

  useEffect(() => {
    if (highlighted) row.current?.scrollIntoView({ block: 'center' });
  }, [highlighted]);

  const details: string[] = [presence.text];
  if (!isSelf && gap) {
    const where = gap.ahead === true ? 'ahead' : gap.ahead === false ? 'behind' : 'away';
    details.push(`${formatDistance(gap.meters, units)} ${where}`);
  }
  const speed = rider.location?.spd ?? null;
  if (presence.state === 'live' && speed !== null && speed >= 1) details.push(formatSpeed(speed, units));

  const muted = volume === 0;
  function toggleMute() {
    tapFeedback();
    const { setRiderVolume } = useSettings.getState();
    if (muted) {
      setRiderVolume(rider.id, volumeBeforeMute.get(rider.id) ?? 1);
    } else {
      volumeBeforeMute.set(rider.id, volume);
      setRiderVolume(rider.id, 0);
    }
  }

  async function makeLeader() {
    const res = await getServices().controller.transferLeader(rider.id);
    if (!res.ok) {
      errorFeedback();
      useLocalStore.getState().pushToast({
        kind: 'error',
        title: `Couldn't make ${rider.name} the leader`,
        body: res.message ?? 'Try again in a moment.',
      });
    }
  }

  return (
    <li
      ref={row}
      className={cx(styles.rider, highlighted && styles.highlight)}
      data-testid={TID.riderRow(rider.id)}
      data-state={presence.state}
      data-online={rider.online}
      data-speaking={speaking}
      data-leader={isLeader}
      data-mic={rider.micMode}
    >
      <div className={styles.riderHead}>
        <RiderAvatar name={rider.name} color={rider.color} speaking={speaking} dim={presence.state !== 'live'} />
        <div className={styles.riderText}>
          <div className={styles.riderName}>
            <span className={styles.riderNameText}>{rider.name}</span>
            {isSelf && <span className={styles.tag}>You</span>}
            {isLeader && (
              <span className={cx(styles.tag, styles.leaderTag)}>
                <Crown aria-hidden="true" />
                Leader
              </span>
            )}
          </div>
          <div className={styles.riderStatus}>
            <span className={styles.presenceDot} data-state={presence.state} aria-hidden="true" />
            <span>{details.join(' · ')}</span>
          </div>
        </div>
        <div className={styles.riderFlags}>
          {speaking && <AudioLines className={styles.flagTalking} aria-label="Talking" />}
          {rider.micMode === 'off' && <MicOff className={styles.flagMicOff} aria-label="Microphone off" />}
        </div>
      </div>

      {!isSelf && (
        <div className={styles.riderControls}>
          <button
            type="button"
            className={cx(styles.iconToggle, muted && styles.iconToggleOn)}
            aria-pressed={muted}
            aria-label={muted ? `Unmute ${rider.name}` : `Mute ${rider.name}`}
            onClick={toggleMute}
          >
            {muted ? <VolumeX aria-hidden="true" /> : <Volume2 aria-hidden="true" />}
          </button>
          <Slider inline label={`${rider.name} volume`} value={volume} onChange={(v) => useSettings.getState().setRiderVolume(rider.id, v)} />
        </div>
      )}

      {canLead && !isSelf && !isLeader && (
        <Button variant="secondary" icon={Crown} className={styles.makeLeader} onClick={() => void makeLeader()}>
          Make leader
        </Button>
      )}
    </li>
  );
}
