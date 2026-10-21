import type { Place, RideRoute, RideSnapshot, RiderState } from '@intercom/shared';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setServices, type RideControllerApi } from '../../core/services';
import type { AppSocket } from '../../core/socket';
import { useLocalStore, useRideStore, useSettings } from '../../core/store';
import {
  createStubAudioEngine,
  createStubController,
  createStubLocationService,
  createStubPlatform,
  createStubVoiceManager,
} from '../../core/stubs';
import { TID } from '../../core/testIds';
import { provideMapCenter } from '../map/mapCenter';
import { DestinationPanel } from './DestinationPanel';
import { RouteSummary } from './RouteSummary';

const ME = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const START = { lat: 18.52, lng: 73.85 };
const DEST: Place = { name: 'Lonavala', lat: 18.52, lng: 73.95, address: 'Maharashtra' };

const ROUTE: RideRoute = {
  id: 'route-1',
  destination: DEST,
  waypoints: [],
  geometry: [
    [START.lng, START.lat],
    [DEST.lng, DEST.lat],
  ],
  distanceM: 10_000,
  durationS: 1_200,
  provider: 'mock',
  profile: 'motorcycle',
  setBy: ME,
  setAt: 0,
};

function rider(id: string, role: 'leader' | 'rider'): RiderState {
  return { id, name: id === ME ? 'Me' : 'Asha', color: '#0A84FF', role, online: true, joinedAt: 0, lastSeenAt: 0, location: null, locationAt: null, micMode: 'vox' };
}

function seed(leaderId: string, route: RideRoute | null = ROUTE) {
  const snapshot: RideSnapshot = {
    code: 'ABCDEF',
    createdAt: 0,
    leaderId,
    voiceMode: 'mesh',
    maxRiders: 8,
    riders: [rider(ME, leaderId === ME ? 'leader' : 'rider'), rider(OTHER, leaderId === OTHER ? 'leader' : 'rider')],
    route,
    activeSos: [],
    recentBreaks: [],
    serverNow: 0,
  };
  useRideStore.getState().applySnapshot(snapshot, ME);
}

/** Me, `east` meters east of the start (on the route line), `north` meters off it. */
function placeMe(east: number, north = 0) {
  const lng = START.lng + east / (111_195 * Math.cos((START.lat * Math.PI) / 180));
  const lat = START.lat + north / 111_195;
  useLocalStore.getState().setSelfFix({ lat, lng, acc: 5, spd: 10, hdg: 90, t: Date.now() });
}

let controller: RideControllerApi;

beforeEach(() => {
  useRideStore.getState().reset();
  useLocalStore.getState().reset();
  useSettings.getState().update({ units: 'metric' });
  controller = {
    ...createStubController(),
    searchPlaces: vi.fn(async () => ({ ok: true as const, results: [DEST, { name: 'Lonavala Lake', lat: 18.73, lng: 73.39 }] })),
    setDestination: vi.fn(async () => ({ ok: true as const, route: ROUTE })),
    clearRoute: vi.fn(async () => ({ ok: true as const })),
  };
  setServices({
    platform: createStubPlatform(),
    socket: {} as AppSocket,
    audio: createStubAudioEngine(),
    voice: createStubVoiceManager(),
    location: createStubLocationService(),
    controller,
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('RouteSummary', () => {
  it('renders nothing without a route', () => {
    seed(ME, null);
    const { container } = render(<RouteSummary />);
    expect(container.innerHTML).toBe('');
  });

  it('shows remaining distance, time and ETA, and opens the route sheet', () => {
    seed(ME);
    placeMe(4_000, 40);
    render(<RouteSummary />);
    const pill = screen.getByTestId(TID.routeSummary);
    expect(pill.textContent).toMatch(/^Lonavala · 6\.2 km · 12 min · ETA \d{1,2}:\d{2}/);
    expect(pill.dataset.offRoute).toBe('false');
    fireEvent.click(pill);
    expect(useLocalStore.getState().ui.sheet).toBe('route');
  });

  it('reads "Off route" with the straight-line distance when far from the line', () => {
    seed(ME);
    placeMe(4_000, 2_000);
    render(<RouteSummary />);
    const pill = screen.getByTestId(TID.routeSummary);
    expect(pill.textContent).toBe('Off route · 6.8 km straight');
    expect(pill.dataset.offRoute).toBe('true');
  });

  it('falls back to the route totals without a GPS fix, in the chosen units', () => {
    seed(ME);
    useSettings.getState().update({ units: 'imperial' });
    render(<RouteSummary />);
    expect(screen.getByTestId(TID.routeSummary).textContent).toMatch(/^Lonavala · 6\.2 mi · 20 min · ETA/);
  });
});

describe('DestinationPanel', () => {
  it('is read-only for riders who are not leading', () => {
    seed(OTHER);
    render(<DestinationPanel onDone={vi.fn()} />);
    expect(screen.getByTestId(TID.destCurrent).textContent).toContain('Lonavala');
    expect(screen.queryByTestId(TID.destSearchInput)).toBeNull();
    expect(screen.queryByTestId(TID.destClear)).toBeNull();
    expect(screen.getByText('Only the ride leader can change the destination.')).toBeTruthy();
  });

  it('searches near me after a 400 ms pause, then sets the picked place and closes', async () => {
    vi.useFakeTimers();
    seed(ME, null);
    placeMe(0);
    const onDone = vi.fn();
    render(<DestinationPanel onDone={onDone} />);
    const input = screen.getByTestId(TID.destSearchInput);
    fireEvent.change(input, { target: { value: 'l' } });
    expect(screen.getByText('Type at least 2 letters.')).toBeTruthy();
    fireEvent.change(input, { target: { value: 'lo' } });
    fireEvent.change(input, { target: { value: 'lon' } });
    await act(() => vi.advanceTimersByTimeAsync(399));
    expect(controller.searchPlaces).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(controller.searchPlaces).toHaveBeenCalledTimes(1);
    expect(controller.searchPlaces).toHaveBeenCalledWith('lon', { lat: START.lat, lng: START.lng });

    fireEvent.click(screen.getByTestId(TID.destResult(1)));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(controller.setDestination).toHaveBeenCalledWith({ name: 'Lonavala Lake', lat: 18.73, lng: 73.39 });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('shows why setting the destination failed and stays open', async () => {
    seed(ME, null);
    vi.mocked(controller.setDestination).mockResolvedValueOnce({ ok: false, error: 'no_origin' });
    const onDone = vi.fn();
    const unprovide = provideMapCenter(() => ({ lat: 18.123456, lng: 73.654321 }));
    render(<DestinationPanel onDone={onDone} />);
    await act(async () => fireEvent.click(screen.getByTestId(TID.destUseCenter)));
    expect(controller.setDestination).toHaveBeenCalledWith({
      name: 'Map pin',
      lat: 18.12346,
      lng: 73.65432,
      address: '18.12346, 73.65432',
    });
    expect(screen.getByRole('alert').textContent).toBe('Waiting for your GPS position. Try again in a moment.');
    expect(onDone).not.toHaveBeenCalled();
    unprovide();
  });

  it('lets the leader clear the current destination', async () => {
    seed(ME);
    render(<DestinationPanel onDone={vi.fn()} />);
    expect(screen.getByTestId(TID.destCurrent).textContent).toContain('10 km');
    await act(async () => fireEvent.click(screen.getByTestId(TID.destClear)));
    expect(controller.clearRoute).toHaveBeenCalledTimes(1);
  });
});
