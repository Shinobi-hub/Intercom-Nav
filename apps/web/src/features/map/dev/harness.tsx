// Dev harness for the map, location pipeline and shared route: /map-dev.html
// Query params: theme=day|night|auto, leader=0 (someone else leads), camera=follow|group|free,
// sheet=route (open the route sheet), headingUp=1.
import '../../../styles/tokens.css';
import '../../../styles/global.css';
import { haversineM, type Place, type RideRoute, type RiderState } from '@intercom/shared';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { installDebugGlobal } from '../../../core/debug';
import { setServices, type RideControllerApi } from '../../../core/services';
import type { AppSocket } from '../../../core/socket';
import { useLocalStore, useRideStore, useSettings, type CameraMode, type MapTheme } from '../../../core/store';
import {
  createStubAudioEngine,
  createStubController,
  createStubPlatform,
  createStubVoiceManager,
} from '../../../core/stubs';
import { createLocationService } from '../../geo';
import { DestinationPanel, RouteSummary } from '../../route';
import { MapControls, MapView } from '../index';
import { PUNE_ROUTE, PUNE_ROUTE_DISTANCE_M, PUNE_ROUTE_DURATION_S } from './puneRoute';
import { startSimulation, type SimRider } from './sim';

const params = new URLSearchParams(window.location.search);
const SELF = '0a0a0a0a-0000-4000-8000-000000000001';
const RIDERS: SimRider[] = [
  { id: '0a0a0a0a-0000-4000-8000-000000000002', name: 'Asha Patil', color: '#30D158', startM: 900, speedMps: 13, jitterM: 4, talks: true },
  { id: '0a0a0a0a-0000-4000-8000-000000000003', name: 'Rohan Mehta', color: '#BF5AF2', startM: 1_700, speedMps: 16.5, jitterM: 6 },
  { id: '0a0a0a0a-0000-4000-8000-000000000004', name: 'Kabir Singh', color: '#FF6FD8', startM: 650, speedMps: 0, jitterM: 3, sos: true },
  { id: '0a0a0a0a-0000-4000-8000-000000000005', name: 'Meera Joshi', color: '#64D2FF', startM: 300, speedMps: 11, jitterM: 5, pause: [6_000, 80_000] },
  { id: '0a0a0a0a-0000-4000-8000-000000000006', name: 'Vikram Rao', color: '#A3E635', startM: 2_300, speedMps: 19, jitterM: 3 },
];

const PLACES: Place[] = [
  { name: 'Lonavala', lat: 18.7537, lng: 73.4069, address: 'Maharashtra' },
  { name: 'Lonavala Lake', lat: 18.7302, lng: 73.3916, address: 'Lonavala, Maharashtra' },
  { name: 'Sinhagad Fort', lat: 18.3664, lng: 73.7559, address: 'Thoptewadi, Pune' },
  { name: 'Lavasa', lat: 18.4091, lng: 73.5068, address: 'Mulshi, Pune' },
  { name: 'Mulshi Dam', lat: 18.5246, lng: 73.5181, address: 'Mulshi, Pune' },
  { name: 'Shaniwar Wada', lat: 18.5195, lng: 73.8553, address: 'Kasba Peth, Pune' },
];

const route: RideRoute = {
  id: 'pune-lonavala',
  destination: PLACES[0]!,
  waypoints: [],
  geometry: PUNE_ROUTE,
  distanceM: PUNE_ROUTE_DISTANCE_M,
  durationS: PUNE_ROUTE_DURATION_S,
  provider: 'mock',
  profile: 'motorcycle',
  setBy: SELF,
  setAt: Date.now(),
};

function rider(id: string, name: string, color: string, role: RiderState['role']): RiderState {
  return { id, name, color, role, online: true, joinedAt: 0, lastSeenAt: Date.now(), location: null, locationAt: null, micMode: 'vox' };
}

/** Pretends to be the ride server for search and route requests. */
function harnessController(): RideControllerApi {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  return {
    ...createStubController(),
    async searchPlaces(q, near) {
      await wait(250);
      const needle = q.trim().toLowerCase();
      const results = PLACES.filter((p) => p.name.toLowerCase().includes(needle));
      if (near) results.sort((a, b) => haversineM(near, a) - haversineM(near, b));
      return { ok: true, results };
    },
    async setDestination(destination) {
      await wait(600);
      const me = useLocalStore.getState().selfFix;
      if (!me) return { ok: false, error: 'no_origin' };
      const isLonavala = destination.name === 'Lonavala';
      const distanceM = isLonavala ? PUNE_ROUTE_DISTANCE_M : haversineM(me, destination);
      const next: RideRoute = {
        ...route,
        id: `route-${Date.now()}`,
        destination,
        geometry: isLonavala ? PUNE_ROUTE : [[me.lng, me.lat], [destination.lng, destination.lat]],
        distanceM,
        durationS: isLonavala ? PUNE_ROUTE_DURATION_S : distanceM / 14,
        profile: isLonavala ? 'motorcycle' : 'straight',
        setAt: Date.now(),
      };
      useRideStore.getState().setRoute(next);
      return { ok: true, route: next };
    },
    async clearRoute() {
      await wait(300);
      useRideStore.getState().setRoute(null);
      return { ok: true };
    },
  };
}

function seedRide() {
  const leaderId = params.get('leader') === '0' ? RIDERS[0]!.id : SELF;
  const riders = [rider(SELF, 'Shubham Dutta', '#0A84FF', 'rider'), ...RIDERS.map((r) => rider(r.id, r.name, r.color, 'rider'))].map(
    (r) => ({ ...r, role: r.id === leaderId ? ('leader' as const) : ('rider' as const) }),
  );
  useRideStore.getState().applySnapshot(
    {
      code: 'PNQ7KX',
      createdAt: Date.now(),
      leaderId,
      voiceMode: 'mesh',
      maxRiders: 8,
      riders,
      route,
      activeSos: RIDERS.filter((r) => r.sos).map((r) => ({
        id: `sos-${r.id}`,
        riderId: r.id,
        location: null,
        raisedAt: Date.now(),
        responders: [],
      })),
      recentBreaks: [],
      serverNow: Date.now(),
    },
    SELF,
  );
  useSettings.getState().update({
    name: 'Shubham Dutta',
    color: '#0A84FF',
    mapTheme: (params.get('theme') as MapTheme | null) ?? 'day',
    headingUp: params.get('headingUp') === '1',
  });
  useLocalStore.getState().setCameraMode((params.get('camera') as CameraMode | null) ?? 'follow');
  if (params.get('sheet') === 'route') useLocalStore.getState().openSheet('route');
}

function Harness() {
  const sheet = useLocalStore((s) => s.ui.sheet);
  const close = () => useLocalStore.getState().openSheet(null);
  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      <MapView onRiderSelect={(id) => useLocalStore.getState().focusRider(id)} />
      <div style={{ position: 'absolute', top: 'calc(var(--safe-top) + 12px)', left: 12, right: 12, display: 'flex', justifyContent: 'center', pointerEvents: 'none' }}>
        <div style={{ pointerEvents: 'auto', maxWidth: '100%' }}>
          <RouteSummary />
        </div>
      </div>
      <div style={{ position: 'absolute', right: 16, bottom: 'calc(var(--safe-bottom) + 24px)', zIndex: 10 }}>
        <MapControls />
      </div>
      {sheet === 'route' && (
        <div
          role="dialog"
          aria-label="Route"
          style={{ position: 'absolute', left: 0, right: 0, bottom: 0, maxHeight: '75%', overflow: 'auto', zIndex: 50, background: 'var(--surface)', borderRadius: '24px 24px 0 0', padding: 20, boxShadow: '0 -8px 30px rgba(0,0,0,.5)' }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <h2 style={{ margin: 0, fontSize: 'var(--fs-xl)' }}>Route</h2>
            <button type="button" onClick={close} style={{ minWidth: 56, minHeight: 56, borderRadius: 28, border: 0, background: 'var(--surface-3)', fontWeight: 750 }}>
              Close
            </button>
          </div>
          <DestinationPanel onDone={close} />
        </div>
      )}
    </div>
  );
}

const location = createLocationService({ geo: { start: async () => {}, stop: async () => {} } });
setServices({
  platform: createStubPlatform(),
  socket: {} as AppSocket,
  audio: createStubAudioEngine(),
  voice: createStubVoiceManager(),
  location,
  controller: harnessController(),
});
installDebugGlobal();
seedRide();
void location.start();
startSimulation({ riders: RIDERS, self: { id: SELF, startM: 1_200, speedMps: 14, jitterM: 3 }, location });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Harness />
  </StrictMode>,
);
