/** Store selectors for SOS alerts, split by who raised them and whether this device silenced them. */
import type { LatLng } from '@intercom/shared';
import { useMemo } from 'react';
import type { TrackedSos } from '../../core/store';
import { useLocalStore, useRideStore } from '../../core/store';

const newestFirst = (a: TrackedSos, b: TrackedSos) => b.raisedAt - a.raisedAt;

/** Other riders' SOS alerts this device hasn't silenced yet: these get the full-screen overlay. */
export function useIncomingSos(): TrackedSos[] {
  const sos = useRideStore((s) => s.sos);
  const selfId = useRideStore((s) => s.selfId);
  const acked = useLocalStore((s) => s.ui.acknowledgedSos);
  return useMemo(
    () => Object.values(sos).filter((a) => a.riderId !== selfId && !acked[a.id]).sort(newestFirst),
    [sos, selfId, acked],
  );
}

/** Other riders' SOS alerts that were silenced here but are still active: shown as banners. */
export function useSilencedSos(): TrackedSos[] {
  const sos = useRideStore((s) => s.sos);
  const selfId = useRideStore((s) => s.selfId);
  const acked = useLocalStore((s) => s.ui.acknowledgedSos);
  return useMemo(
    () => Object.values(sos).filter((a) => a.riderId !== selfId && acked[a.id]).sort(newestFirst),
    [sos, selfId, acked],
  );
}

/** This rider's own active SOS, if any. */
export function useOwnSos(): TrackedSos | null {
  const sos = useRideStore((s) => s.sos);
  const selfId = useRideStore((s) => s.selfId);
  return useMemo(() => Object.values(sos).find((a) => a.riderId === selfId) ?? null, [sos, selfId]);
}

/** Where the rider in trouble is: the SOS position, else their latest known position. */
export function useSosLocation(sos: TrackedSos): LatLng | null {
  const riderLocation = useRideStore((s) => s.riders[sos.riderId]?.location ?? null);
  return sos.location ?? riderLocation;
}
