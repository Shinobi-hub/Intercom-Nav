/**
 * Break requests from the dock button and the kind picker share one state so the dock can show
 * "sent" and the cooldown whichever one sent it.
 */
import type { BreakKind, Result } from '@intercom/shared';
import { TIMING } from '@intercom/shared';
import { create } from 'zustand';
import { getServices } from '../../core/services';
import { useLocalStore } from '../../core/store';
import { errorFeedback, successFeedback } from '../../ui/feedback';

export type BreakStatus = 'idle' | 'sending' | 'sent' | 'refused';

interface BreakUi {
  status: BreakStatus;
  kind: BreakKind;
  /** Date.now() until which another request will be refused. */
  cooldownUntil: number;
  /** Date.now() until which `status` ('sent' / 'refused') is shown before falling back to the countdown. */
  statusUntil: number;
}

export const useBreakUi = create<BreakUi>()(() => ({
  status: 'idle',
  kind: 'break',
  cooldownUntil: 0,
  statusUntil: 0,
}));

const SHOW_SENT_MS = 3_000;
const SHOW_REFUSED_MS = 2_500;

export async function sendBreak(kind: BreakKind): Promise<void> {
  if (useBreakUi.getState().status === 'sending') return;
  useBreakUi.setState({ status: 'sending', kind });
  let res: Result;
  try {
    res = await getServices().controller.requestBreak(kind);
  } catch {
    res = { ok: false, error: 'internal', message: 'Check your connection and try again.' };
  }
  const now = Date.now();
  if (res.ok) {
    successFeedback('sent');
    useBreakUi.setState({ status: 'sent', kind, cooldownUntil: now + TIMING.breakCooldownMs, statusUntil: now + SHOW_SENT_MS });
  } else if (res.error === 'cooldown') {
    errorFeedback();
    useBreakUi.setState({ status: 'refused', cooldownUntil: now + (res.retryInMs ?? 0), statusUntil: now + SHOW_REFUSED_MS });
  } else {
    errorFeedback();
    useBreakUi.setState({ status: 'idle', statusUntil: 0 });
    useLocalStore.getState().pushToast({
      kind: 'error',
      title: "Stop request didn't go through",
      body: res.message ?? 'Check your connection and try again.',
    });
  }
}
