/**
 * Typed view of the app's test contract. Types come straight from the app (type-only imports, erased
 * at runtime), so `tsc -p e2e` breaks when the contract changes instead of tests drifting silently.
 *
 *  - window.__intercom: apps/web/src/core/debug.ts
 *  - state() snapshot:  apps/web/src/core/store.ts (snapshotState strips functions but is typed loosely,
 *                       so the shape is restated here from the store's exported types)
 *  - data-testid:       apps/web/src/core/testIds.ts (imported as a value: it has no dependencies)
 */
import type { BreakAlert, LocationFix, RideRoute, RiderId, RiderState } from '@intercom/shared';
import type { AudioDebug, DebugSections, GeoDebug, MapDebug, MapMarkerDebug, VadDebugEntry, VoiceDebug } from '../../apps/web/src/core/debug';
import type { PeerStats, VoiceStats } from '../../apps/web/src/core/services';
import type {
  AudioInfo,
  ConnectionState,
  GpsInfo,
  RideInfo,
  Settings,
  Toast,
  TrackedSos,
  UiInfo,
  VoiceInfo,
} from '../../apps/web/src/core/store';

export { TID } from '../../apps/web/src/core/testIds';

export type { AudioDebug, DebugSections, GeoDebug, MapDebug, MapMarkerDebug, PeerStats, Settings, Toast, TrackedSos, VadDebugEntry, VoiceDebug, VoiceStats };

/** useRideStore state as returned by `__intercom.state().ride`. */
export interface RideSnapshotState {
  connection: ConnectionState;
  clockOffsetMs: number;
  ride: RideInfo | null;
  selfId: RiderId | null;
  riders: Record<RiderId, RiderState>;
  route: RideRoute | null;
  sos: Record<string, TrackedSos>;
  breaks: BreakAlert[];
}

/** useLocalStore state as returned by `__intercom.state().local`. */
export interface LocalSnapshotState {
  selfFix: LocationFix | null;
  gps: GpsInfo;
  speaking: Record<RiderId, boolean>;
  voice: VoiceInfo;
  audio: AudioInfo;
  ui: UiInfo;
}

export interface AppSnapshot {
  ride: RideSnapshotState;
  local: LocalSnapshotState;
  settings: Settings;
}

export type DebugSectionName = keyof DebugSections;
