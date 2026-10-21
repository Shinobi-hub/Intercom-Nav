import { LocateFixed, Navigation, Users } from 'lucide-react';
import { useLocalStore } from '../../core/store';
import { TID } from '../../core/testIds';
import { useLastAutoMode } from './cameraMemory';
import styles from './controls.module.css';
import { tapFeedback } from './feedback';

const ICON = { size: 28, strokeWidth: 2.4, 'aria-hidden': true } as const;

/**
 * Floating map buttons, positioned by the ride screen. The toggle switches between following me and
 * showing the whole group (its icon shows where it takes you); in free mode a recenter button returns
 * to whichever of the two was used last.
 */
export function MapControls() {
  const mode = useLocalStore((s) => s.ui.cameraMode);
  const setCameraMode = useLocalStore((s) => s.setCameraMode);
  const lastAuto = useLastAutoMode();
  const current = mode === 'free' ? lastAuto : mode;
  const next = current === 'follow' ? 'group' : 'follow';

  return (
    <div className={styles.controls}>
      {mode === 'free' && (
        <button
          type="button"
          className={`${styles.button} ${styles.recenter}`}
          data-testid={TID.mapRecenter}
          aria-label={lastAuto === 'group' ? 'Show the whole group again' : 'Recenter on me'}
          onClick={() => {
            tapFeedback();
            setCameraMode(lastAuto);
          }}
        >
          <LocateFixed {...ICON} />
        </button>
      )}
      <button
        type="button"
        className={styles.button}
        data-testid={TID.mapCameraToggle}
        data-mode={mode}
        aria-label={next === 'group' ? 'Show the whole group' : 'Follow me'}
        onClick={() => {
          tapFeedback();
          setCameraMode(next);
        }}
      >
        {next === 'group' ? <Users {...ICON} /> : <Navigation {...ICON} />}
      </button>
    </div>
  );
}
