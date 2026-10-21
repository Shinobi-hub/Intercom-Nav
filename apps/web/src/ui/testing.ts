/** Test helpers for UI component tests: inert services with an overridable controller, clean stores. */
import type { RiderState } from '@intercom/shared';
import type { RideControllerApi, Services } from '../core/services';
import { setServices } from '../core/services';
import { DEFAULT_SETTINGS, useLocalStore, useRideStore, useSettings } from '../core/store';
import {
  createStubAudioEngine,
  createStubController,
  createStubLocationService,
  createStubPlatform,
  createStubVoiceManager,
} from '../core/stubs';

export function installTestServices(controller: Partial<RideControllerApi> = {}): Services {
  const services: Services = {
    platform: createStubPlatform(),
    socket: {} as Services['socket'],
    audio: createStubAudioEngine(),
    voice: createStubVoiceManager(),
    location: createStubLocationService(),
    controller: { ...createStubController(), ...controller },
  };
  setServices(services);
  return services;
}

export function resetStores(): void {
  useRideStore.getState().reset();
  useLocalStore.getState().reset();
  useSettings.setState({ ...DEFAULT_SETTINGS, name: 'Tester' });
}

export function testRider(id: string, name: string, extra: Partial<RiderState> = {}): RiderState {
  return {
    id,
    name,
    color: '#0A84FF',
    role: 'rider',
    online: true,
    joinedAt: 1,
    lastSeenAt: Date.now(),
    location: null,
    locationAt: null,
    micMode: 'vox',
    ...extra,
  };
}
