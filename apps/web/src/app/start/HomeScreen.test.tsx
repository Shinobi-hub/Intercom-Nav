import { RIDER_COLORS } from '@intercom/shared';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSettings } from '../../core/store';
import { TID } from '../../core/testIds';
import { extractRideCode, formatPartialCode, hasLookalikes } from '../../ui/rideCode';
import { installTestServices, resetStores } from '../../ui/testing';
import { HomeScreen } from './HomeScreen';

describe('ride code parsing', () => {
  it('normalizes case, separators and pasted links', () => {
    expect(extractRideCode('abc-d23')).toBe('ABCD23');
    expect(extractRideCode('ABC D23')).toBe('ABCD23');
    expect(extractRideCode('https://ride.example/r/abc-d23')).toBe('ABCD23');
    expect(extractRideCode('abcd23xyz')).toBe('ABCD23');
  });

  it('drops look-alike characters and says so', () => {
    expect(extractRideCode('A0B1C')).toBe('ABC');
    expect(hasLookalikes('A0B1C')).toBe(true);
    expect(hasLookalikes('https://x/r/LOL')).toBe(false);
  });

  it('groups partial codes like full ones', () => {
    expect(formatPartialCode('ABC')).toBe('ABC');
    expect(formatPartialCode('ABCD2')).toBe('ABC-D2');
  });
});

describe('HomeScreen join', () => {
  beforeEach(() => resetStores());
  afterEach(cleanup);

  it('shows the typed code grouped and joins with the normalized code', () => {
    const startRide = vi.fn(async () => ({ ok: true as const, code: 'ABCD23' }));
    installTestServices({ startRide });
    render(<HomeScreen />);
    const input = screen.getByTestId(TID.homeJoinCode) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'abc-d23' } });
    expect(input.value).toBe('ABC-D23');
    fireEvent.click(screen.getByTestId(TID.homeJoinSubmit));
    expect(startRide).toHaveBeenCalledWith({ kind: 'join', code: 'ABCD23' });
  });

  it('refuses an incomplete code without calling the controller', () => {
    const startRide = vi.fn(async () => ({ ok: true as const, code: 'ABCD23' }));
    installTestServices({ startRide });
    render(<HomeScreen />);
    fireEvent.change(screen.getByTestId(TID.homeJoinCode), { target: { value: 'abc' } });
    fireEvent.click(screen.getByTestId(TID.homeJoinSubmit));
    expect(startRide).not.toHaveBeenCalled();
    expect(screen.getByTestId(TID.joinError).textContent).toContain('6 characters');
  });

  it('shows ride_not_found inline', async () => {
    installTestServices({ startRide: async () => ({ ok: false, error: 'ride_not_found' }) });
    render(<HomeScreen />);
    fireEvent.change(screen.getByTestId(TID.homeJoinCode), { target: { value: 'abcd23' } });
    fireEvent.click(screen.getByTestId(TID.homeJoinSubmit));
    await waitFor(() => expect(screen.getByTestId(TID.joinError).textContent).toContain('No ride found for ABC-D23'));
  });

  it('offers every rider color as a swatch and remembers the pick', () => {
    installTestServices();
    render(<HomeScreen />);
    for (const hex of RIDER_COLORS) expect(screen.getByTestId(TID.joinColor(hex))).toBeTruthy();
    const pick = RIDER_COLORS[3];
    fireEvent.click(screen.getByTestId(TID.joinColor(pick)));
    expect(useSettings.getState().color.toLowerCase()).toBe(pick.toLowerCase());
    expect(screen.getByTestId(TID.joinColor(pick)).getAttribute('aria-checked')).toBe('true');
  });

  it('creates a ride straight from the tap', () => {
    const startRide = vi.fn(async () => ({ ok: true as const, code: 'ABCD23' }));
    installTestServices({ startRide });
    render(<HomeScreen />);
    fireEvent.click(screen.getByTestId(TID.homeCreate));
    expect(startRide).toHaveBeenCalledWith({ kind: 'create' });
  });
});
