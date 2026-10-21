import { AudioLines } from 'lucide-react';
import { useMemo } from 'react';
import { useLocalStore, useRideStore } from '../../core/store';
import { RiderAvatar } from '../../ui/RiderAvatar';
import styles from './ride.module.css';

const MAX_SHOWN = 3;

/** Who is talking right now. Hidden while the channel is quiet. */
export function TalkingStrip() {
  const speaking = useLocalStore((s) => s.speaking);
  const riders = useRideStore((s) => s.riders);
  const selfId = useRideStore((s) => s.selfId);

  const talkers = useMemo(
    () =>
      Object.keys(speaking)
        .filter((id) => speaking[id] && riders[id])
        .sort((a, b) => riders[a]!.joinedAt - riders[b]!.joinedAt),
    [speaking, riders],
  );
  if (talkers.length === 0) return null;

  const names = talkers.map((id) => (id === selfId ? 'You' : riders[id]!.name));
  return (
    <div className={styles.talking} role="status" aria-label={`Talking: ${names.join(', ')}`}>
      <AudioLines className={styles.talkingIcon} aria-hidden="true" />
      {talkers.slice(0, MAX_SHOWN).map((id, i) => (
        <span key={id} className={styles.talker} data-rider-id={id}>
          <RiderAvatar name={riders[id]!.name} color={riders[id]!.color} size="sm" />
          <span className={styles.talkerName}>{names[i]}</span>
        </span>
      ))}
      {talkers.length > MAX_SHOWN && <span className={styles.talkerMore}>+{talkers.length - MAX_SHOWN}</span>}
    </div>
  );
}
