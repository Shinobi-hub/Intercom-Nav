import { useLocalStore } from '../../../core/store';
import { TID } from '../../../core/testIds';
import { cx } from '../../../ui/cx';
import { useMicMeter } from '../engine/meterStore';
import styles from './MicLevelMeter.module.css';

/** Scale of the bar, dBFS. Speech sits around -35..-15; mic hiss around -70. */
const MIN_DB = -80;
const MAX_DB = -10;
const toFraction = (db: number | null) => (db === null ? 0 : Math.min(1, Math.max(0, (db - MIN_DB) / (MAX_DB - MIN_DB))));

/**
 * Live mic level (speech band) with the VAD's current talk threshold marked and a speaking light,
 * so riders can tune sensitivity against their actual wind and engine noise.
 */
export function MicLevelMeter() {
  const micState = useLocalStore((s) => s.audio.micState);
  const { levelDb, onDb, speaking, error } = useMicMeter();
  const live = micState === 'live' && levelDb !== null;
  const level = toFraction(live ? levelDb : null);
  const threshold = toFraction(live ? onDb : null);

  const status = live
    ? speaking
      ? 'Talking'
      : 'Listening'
    : micState === 'denied'
      ? 'Microphone blocked'
      : micState === 'requesting'
        ? 'Starting microphone…'
        : micState === 'error'
          ? (error ?? 'Microphone problem')
          : 'Microphone off';

  return (
    <div className={cx(styles.meter, live && styles.live, speaking && live && styles.speaking)} data-testid={TID.micLevelMeter} data-speaking={live && speaking} data-state={micState}>
      <div className={styles.head}>
        <span className={styles.light} aria-hidden="true" />
        <span className={styles.status} aria-live="polite">
          {status}
        </span>
        <span className={styles.value}>{live ? `${Math.round(levelDb)} dB` : ''}</span>
      </div>
      <div
        className={styles.track}
        role="meter"
        aria-label="Microphone level"
        aria-valuemin={MIN_DB}
        aria-valuemax={MAX_DB}
        aria-valuenow={live ? Math.round(levelDb) : MIN_DB}
        aria-valuetext={live ? `${Math.round(levelDb)} dB, talk threshold ${Math.round(onDb ?? MIN_DB)} dB` : status}
      >
        <span className={styles.fill} style={{ transform: `scaleX(${level})` }} />
        {live && <span className={styles.threshold} style={{ left: `${threshold * 100}%` }} title="Talk threshold" />}
      </div>
      <div className={styles.legend} aria-hidden="true">
        <span>Quiet</span>
        <span className={styles.legendMark}>▲ talk threshold</span>
        <span>Loud</span>
      </div>
    </div>
  );
}
