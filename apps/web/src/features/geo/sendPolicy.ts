import { angleDiffDeg, haversineM, TIMING, type LocationFix } from '@intercom/shared';

export interface SendPolicyOptions {
  /** Never send more often than this. */
  minIntervalMs: number;
  /** Movement since the last send that triggers a send. */
  minMoveM: number;
  /** Heading change since the last send that triggers a send, only while moving. */
  minHeadingChangeDeg: number;
  /** Send at least this often while fixes keep coming. */
  heartbeatMs: number;
  /** "Moving" means at least this fast. */
  movingSpeedMps: number;
}

export const DEFAULT_SEND_POLICY: SendPolicyOptions = {
  minIntervalMs: TIMING.locMinIntervalMs,
  minMoveM: TIMING.locMinMoveM,
  minHeadingChangeDeg: TIMING.locMinHeadingChangeDeg,
  heartbeatMs: TIMING.locHeartbeatMs,
  movingSpeedMps: 1.5,
};

export interface SentRecord {
  fix: LocationFix;
  /** Local clock (Date.now()) at the time it was sent. */
  at: number;
}

const isMoving = (fix: LocationFix, o: SendPolicyOptions) => (fix.spd ?? 0) >= o.movingSpeedMps;

/** Whether an accepted fix should go to the server, given what was sent last and the local time. */
export function shouldSend(
  fix: LocationFix,
  last: SentRecord | null,
  now: number,
  o: SendPolicyOptions = DEFAULT_SEND_POLICY,
): boolean {
  if (!last) return true;
  const elapsed = now - last.at;
  if (elapsed < o.minIntervalMs) return false;
  if (elapsed >= o.heartbeatMs) return true;
  if (haversineM(last.fix, fix) >= o.minMoveM) return true;

  const moving = isMoving(fix, o);
  // Starting or stopping: receivers dead-reckon on the last speed they got, so tell them promptly.
  if (moving !== isMoving(last.fix, o)) return true;
  if (moving && fix.hdg !== null) {
    if (last.fix.hdg === null) return true;
    if (Math.abs(angleDiffDeg(last.fix.hdg, fix.hdg)) >= o.minHeadingChangeDeg) return true;
  }
  return false;
}
