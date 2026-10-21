/** Ride-screen UI state that no other feature needs: the More menu and the rider picked on the map. */
import type { RiderId } from '@intercom/shared';
import { create } from 'zustand';

interface RideUi {
  menuOpen: boolean;
  /** Rider to scroll to and highlight when the Riders sheet opens. */
  highlightRider: RiderId | null;
}

export const useRideUi = create<RideUi>()(() => ({ menuOpen: false, highlightRider: null }));

export const setMenuOpen = (menuOpen: boolean) => useRideUi.setState({ menuOpen });
