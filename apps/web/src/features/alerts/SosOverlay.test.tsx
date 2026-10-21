import type { SosAlert } from '@intercom/shared';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLocalStore, useRideStore } from '../../core/store';
import { TID } from '../../core/testIds';
import { installTestServices, resetStores, testRider } from '../../ui/testing';
import { SosBanner } from './SosBanner';
import { SosOverlay } from './SosOverlay';

const SELF = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';

function sos(id: string, riderId: string): SosAlert {
  return { id, riderId, location: { lat: 18.52, lng: 73.85, acc: 5, spd: 0, hdg: null, t: 1 }, raisedAt: Date.now(), responders: [] };
}

function seed(...alerts: SosAlert[]) {
  useRideStore.setState({
    selfId: SELF,
    riders: { [SELF]: testRider(SELF, 'Me'), [BOB]: testRider(BOB, 'Bob') },
  });
  for (const a of alerts) useRideStore.getState().upsertSos(a, 'server');
}

describe('SosOverlay visibility', () => {
  beforeEach(() => {
    installTestServices();
    resetStores();
  });
  afterEach(cleanup);

  it("shows another rider's SOS with the rider's name", () => {
    seed(sos('a', BOB));
    render(<SosOverlay />);
    const overlay = screen.getByTestId(TID.sosOverlay);
    expect(overlay.textContent).toContain('Bob');
    expect(overlay.dataset.riderId).toBe(BOB);
  });

  it('never shows my own SOS', () => {
    seed(sos('mine', SELF));
    render(<SosOverlay />);
    expect(screen.queryByTestId(TID.sosOverlay)).toBeNull();
  });

  it('hides once acknowledged, leaving the compact banner', () => {
    seed(sos('a', BOB));
    render(
      <>
        <SosOverlay />
        <SosBanner />
      </>,
    );
    expect(screen.queryByTestId(TID.sosBanner)).toBeNull();
    act(() => useLocalStore.getState().acknowledgeSos('a'));
    expect(screen.queryByTestId(TID.sosOverlay)).toBeNull();
    expect(screen.getByTestId(TID.sosBanner).textContent).toContain('Bob');
  });

  it('SILENCE and I’M COMING go to the controller', () => {
    const acknowledgeSos = vi.fn();
    const respondSos = vi.fn(async () => {});
    installTestServices({ acknowledgeSos, respondSos });
    seed(sos('a', BOB));
    render(<SosOverlay />);
    fireEvent.click(screen.getByTestId(TID.sosRespond));
    expect(respondSos).toHaveBeenCalledWith('a');
    fireEvent.click(screen.getByTestId(TID.sosSilence));
    expect(acknowledgeSos).toHaveBeenCalledWith('a');
  });

  it('disappears when the SOS is cancelled', () => {
    seed(sos('a', BOB));
    render(<SosOverlay />);
    act(() => useRideStore.getState().removeSos('a'));
    expect(screen.queryByTestId(TID.sosOverlay)).toBeNull();
  });
});
