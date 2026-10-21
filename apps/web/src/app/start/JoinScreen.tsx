import { formatRideCode } from '@intercom/shared';
import { LogIn } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { navigate } from '../../core/router';
import { getServices } from '../../core/services';
import { useRideStore, useSettings } from '../../core/store';
import { TID } from '../../core/testIds';
import { Button } from '../../ui/Button';
import { errorFeedback } from '../../ui/feedback';
import { Brand } from './Brand';
import { ErrorText } from './ErrorText';
import { IdentityFields } from './IdentityFields';
import styles from './start.module.css';
import { useStartRide } from './useStartRide';

/** A shared link (/r/:code) opened on a device that isn't in that ride yet. */
export function JoinScreen({ code }: { code: string }) {
  const activeCode = useRideStore((s) => s.ride?.code ?? null);
  const rejoining = useMemo(() => getServices().controller.getResumableRide() === code, [code]);
  const [nameError, setNameError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const { start, pending, error } = useStartRide();

  function join() {
    if (!useSettings.getState().name.trim()) {
      setNameError('Add your name so the group knows who is talking.');
      errorFeedback();
      nameRef.current?.focus();
      return;
    }
    start('join', { kind: 'join', code });
  }

  return (
    <main className={styles.screen}>
      <div className={styles.layout}>
        <div className={styles.intro}>
          <Brand />
          <h1 className={styles.h1}>{rejoining ? 'Rejoin your ride' : 'Join the ride'}</h1>
          <div className={styles.plate} aria-label={`Ride code ${formatRideCode(code)}`}>
            {formatRideCode(code)}
          </div>
          <p className={styles.lede}>
            {rejoining
              ? 'Tap below to reconnect voice and location.'
              : 'Riders in this group see your name and color on the map and hear you in their helmets.'}
          </p>
          {activeCode && activeCode !== code && (
            <p className={styles.hint}>Joining leaves your current ride, {formatRideCode(activeCode)}.</p>
          )}
        </div>

        <div className={styles.panel}>
          <IdentityFields nameRef={nameRef} nameError={nameError} onNameEdited={() => setNameError(null)} />
        </div>

        <div className={styles.actions}>
          <Button
            variant="primary"
            size="lg"
            block
            icon={LogIn}
            feedback={false}
            busy={pending !== null}
            data-testid={TID.joinStart}
            onClick={join}
          >
            {rejoining ? 'Rejoin ride' : 'Join ride'}
          </Button>
          {error && <ErrorText>{error.message}</ErrorText>}
          <Button variant="ghost" block onClick={() => navigate('/')}>
            Not now
          </Button>
        </div>
      </div>
    </main>
  );
}
