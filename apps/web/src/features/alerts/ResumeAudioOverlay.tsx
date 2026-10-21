import { Volume2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { getServices } from '../../core/services';
import { useLocalStore, useRideStore } from '../../core/store';
import { TID } from '../../core/testIds';
import styles from './ResumeAudioOverlay.module.css';

/**
 * iOS suspends the AudioContext on calls, Siri and some app switches, and only a tap may resume it.
 * Shown during a ride once audio has run at least once and then stopped.
 */
export function ResumeAudioOverlay() {
  const contextState = useLocalStore((s) => s.audio.contextState);
  const inRide = useRideStore((s) => s.ride !== null);
  const [hasRun, setHasRun] = useState(contextState === 'running');

  useEffect(() => {
    if (contextState === 'running') setHasRun(true);
  }, [contextState]);

  const stopped = contextState === 'suspended' || contextState === 'interrupted';
  if (!inRide || !hasRun || !stopped) return null;

  return createPortal(
    <div className={styles.root}>
      <button
        type="button"
        className={styles.button}
        data-testid={TID.resumeAudio}
        onClick={() => {
          // Straight into the controller: resuming must happen inside this tap.
          void getServices().controller.resumeAudio();
          getServices().platform.haptics.vibrate(12);
        }}
      >
        <span className={styles.icon} aria-hidden="true">
          <Volume2 />
        </span>
        <span className={styles.title}>Tap to resume audio</span>
        <span className={styles.body}>The phone paused sound. Voice, music and alerts are silent until you tap.</span>
      </button>
    </div>,
    document.body,
  );
}
