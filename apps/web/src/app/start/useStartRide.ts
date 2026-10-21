import type { Err } from '@intercom/shared';
import { formatRideCode } from '@intercom/shared';
import { useState } from 'react';
import { navigate, ridePath } from '../../core/router';
import type { StartIntent } from '../../core/services';
import { getServices } from '../../core/services';
import { errorFeedback, tapFeedback } from '../../ui/feedback';

export type StartAction = 'create' | 'join' | 'resume';

const OFFLINE = "Can't reach the ride server. Check your signal and try again.";

/** Words for a failed create/join, naming the problem and what to do next. */
export function startErrorMessage(err: Err, code?: string): string {
  const shown = code ? formatRideCode(code) : 'that code';
  switch (err.error) {
    case 'ride_not_found':
      return `No ride found for ${shown}. Check the code with your group.`;
    case 'ride_full':
      return `Ride ${shown} is full. Ask the leader to make room, or start your own ride.`;
    case 'rider_conflict':
      return 'This rider profile is already in that ride from another device.';
    case 'rate_limited':
      return 'Too many attempts. Wait a minute, then try again.';
    case 'invalid_payload':
      return 'Check your name and the ride code, then try again.';
    default:
      return err.message || OFFLINE;
  }
}

/**
 * Create/join/rejoin. `start` must be called straight from the click handler: the controller
 * unlocks audio synchronously, so nothing may be awaited before it.
 */
export function useStartRide() {
  const [pending, setPending] = useState<StartAction | null>(null);
  const [error, setError] = useState<{ action: StartAction; message: string } | null>(null);

  function start(action: StartAction, intent: StartIntent): void {
    if (pending) return;
    const result = getServices().controller.startRide(intent);
    tapFeedback();
    setPending(action);
    setError(null);
    const code = intent.kind === 'join' ? intent.code : undefined;
    result.then(
      (res) => {
        setPending(null);
        if (res.ok) {
          navigate(ridePath(res.code));
          return;
        }
        errorFeedback();
        setError({ action, message: startErrorMessage(res, code) });
      },
      () => {
        setPending(null);
        errorFeedback();
        setError({ action, message: OFFLINE });
      },
    );
  }

  return { start, pending, error, setError };
}
