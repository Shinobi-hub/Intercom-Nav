import { formatRideCode, isValidRideCode, RIDE_CODE_LENGTH } from '@intercom/shared';
import { ArrowRight, History, Plus } from 'lucide-react';
import { useId, useMemo, useRef, useState } from 'react';
import { navigate, ridePath } from '../../core/router';
import { getServices } from '../../core/services';
import { useRideStore, useSettings } from '../../core/store';
import { TID } from '../../core/testIds';
import { Button } from '../../ui/Button';
import { errorFeedback } from '../../ui/feedback';
import { RideCodeInput } from '../../ui/RideCodeInput';
import { Brand } from './Brand';
import { ErrorText } from './ErrorText';
import { IdentityFields } from './IdentityFields';
import styles from './start.module.css';
import { useStartRide } from './useStartRide';

const NAME_REQUIRED = 'Add your name so the group knows who is talking.';

export function HomeScreen() {
  const codeId = useId();
  const activeCode = useRideStore((s) => s.ride?.code ?? null);
  const resumable = useMemo(() => (activeCode ? null : getServices().controller.getResumableRide()), [activeCode]);
  const [code, setCode] = useState('');
  const [lookalikes, setLookalikes] = useState(false);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const { start, pending, error } = useStartRide();

  function requireName(): boolean {
    if (useSettings.getState().name.trim()) return true;
    setNameError(NAME_REQUIRED);
    errorFeedback();
    nameRef.current?.focus();
    return false;
  }

  function create() {
    if (requireName()) start('create', { kind: 'create' });
  }

  function join() {
    if (!isValidRideCode(code)) {
      setCodeError(
        code.length === 0
          ? `Enter the ${RIDE_CODE_LENGTH}-character ride code.`
          : `Ride codes have ${RIDE_CODE_LENGTH} characters. This one has ${code.length}.`,
      );
      errorFeedback();
      return;
    }
    if (requireName()) start('join', { kind: 'join', code });
  }

  function rejoin() {
    if (resumable && requireName()) start('resume', { kind: 'join', code: resumable });
  }

  const joinError = codeError ?? (error?.action === 'join' ? error.message : null);

  return (
    <main className={styles.screen}>
      <div className={styles.layout}>
        <div className={styles.intro}>
          <Brand />
          <h1 className={styles.h1}>Ride together.</h1>
          <p className={styles.lede}>Your group on one live map, open voice in every helmet, and SOS one hold away.</p>
        </div>

        {(activeCode || resumable) && (
          <div className={styles.resume}>
            {activeCode ? (
              <Button variant="ok" size="lg" block icon={ArrowRight} onClick={() => navigate(ridePath(activeCode))}>
                Back to ride {formatRideCode(activeCode)}
              </Button>
            ) : (
              <Button
                variant="ok"
                size="lg"
                block
                icon={History}
                feedback={false}
                busy={pending === 'resume'}
                disabled={pending !== null && pending !== 'resume'}
                data-testid={TID.homeResume}
                onClick={rejoin}
              >
                Rejoin {formatRideCode(resumable!)}
              </Button>
            )}
            {error?.action === 'resume' && <ErrorText>{error.message}</ErrorText>}
          </div>
        )}

        <div className={styles.panel}>
          <IdentityFields nameRef={nameRef} nameError={nameError} onNameEdited={() => setNameError(null)} />
        </div>

        <div className={styles.actions}>
          <Button
            variant="primary"
            size="lg"
            block
            icon={Plus}
            feedback={false}
            busy={pending === 'create'}
            disabled={pending !== null && pending !== 'create'}
            data-testid={TID.homeCreate}
            onClick={create}
          >
            Create ride
          </Button>
          {error?.action === 'create' && <ErrorText>{error.message}</ErrorText>}

          <div className={styles.divider}>
            <label htmlFor={codeId}>or join with a code</label>
          </div>
          <div className={styles.joinRow}>
            <RideCodeInput
              id={codeId}
              value={code}
              invalid={codeError !== null}
              testId={TID.homeJoinCode}
              onChange={(next, info) => {
                setCode(next);
                setLookalikes(info.lookalikes);
                setCodeError(null);
              }}
              onSubmit={join}
            />
            <Button
              variant="secondary"
              size="lg"
              icon={ArrowRight}
              feedback={false}
              busy={pending === 'join'}
              disabled={pending !== null && pending !== 'join'}
              data-testid={TID.homeJoinSubmit}
              className={styles.joinButton}
              onClick={join}
            >
              Join
            </Button>
          </div>
          {lookalikes && <p className={styles.hint}>Ride codes never use 0, O, 1, I or L.</p>}
          {joinError && <ErrorText>{joinError}</ErrorText>}
        </div>
      </div>
    </main>
  );
}
