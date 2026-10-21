import { MonitorSmartphone, Smartphone } from 'lucide-react';
import { useId } from 'react';
import { createPortal } from 'react-dom';
import { navigate } from '../../core/router';
import { getServices } from '../../core/services';
import { useLocalStore, useRideStore } from '../../core/store';
import { TID } from '../../core/testIds';
import { Button } from '../../ui/Button';
import { ErrorText } from './ErrorText';
import styles from './start.module.css';
import { useStartRide } from './useStartRide';

/** This rider id was opened on another tab or device; this copy is inert until "Use here". */
export function SessionReplacedScreen() {
  const titleId = useId();
  const rideCode = useRideStore((s) => s.ride?.code ?? null);
  const { start, pending, error } = useStartRide();

  function takeOver() {
    const code = rideCode ?? getServices().controller.getResumableRide();
    if (!code) {
      useLocalStore.getState().setSessionReplaced(false);
      navigate('/');
      return;
    }
    start('resume', { kind: 'join', code });
  }

  return createPortal(
    <div className={styles.blocker} role="alertdialog" aria-modal="true" aria-labelledby={titleId} data-testid={TID.sessionReplaced}>
      <div className={styles.blockerCard}>
        <span className={styles.blockerIcon} aria-hidden="true">
          <MonitorSmartphone />
        </span>
        <h1 id={titleId} className={styles.h2}>
          Open on another device
        </h1>
        <p className={styles.lede}>
          This ride is running in another tab or on another phone, so voice and location are paused here.
        </p>
        <Button
          variant="primary"
          size="lg"
          block
          icon={Smartphone}
          feedback={false}
          busy={pending !== null}
          onClick={takeOver}
        >
          Use here
        </Button>
        {error && <ErrorText>{error.message}</ErrorText>}
      </div>
    </div>,
    document.body,
  );
}
