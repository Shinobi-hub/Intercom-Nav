/**
 * Inert implementations of every service. Used as placeholders until a feature lands, and by unit
 * tests that need a service but don't care what it does.
 */
import type { Err } from '@intercom/shared';
import type {
  AlertSoundsApi,
  AudioEngineApi,
  LocationServiceApi,
  MusicPlayerApi,
  PlatformApi,
  RideControllerApi,
  VoiceManagerApi,
} from './services';

const noop = () => {};
const asyncNoop = async () => {};
const unsub = () => noop;
const notReady: Err = { ok: false, error: 'unavailable', message: 'not implemented yet' };

export function createStubPlatform(): PlatformApi {
  return {
    kind: 'web',
    isNative: false,
    geo: { start: asyncNoop, stop: asyncNoop },
    wakeLock: { enable: asyncNoop, disable: asyncNoop, active: false },
    lifecycle: { onResume: unsub, onPause: unsub, isForeground: () => true },
    haptics: { vibrate: noop },
    audioSession: { setMode: noop },
    background: { supported: false, start: asyncNoop, stop: asyncNoop, notify: asyncNoop },
    network: { isOnline: () => true, onChange: unsub },
    openExternal: (url) => void window.open(url, '_blank', 'noopener'),
    share: async () => false,
  };
}

export function createStubMusicPlayer(): MusicPlayerApi {
  return {
    listTracks: async () => [],
    addFiles: async () => [],
    addStream: async () => {
      throw new Error('music player not implemented yet');
    },
    removeTrack: asyncNoop,
    play: asyncNoop,
    pause: noop,
    toggle: asyncNoop,
    next: asyncNoop,
    previous: asyncNoop,
    onTracksChanged: unsub,
  };
}

export function createStubAlertSounds(): AlertSoundsApi {
  return { startSiren: noop, stopSiren: noop, chime: noop, click: noop, announce: noop };
}

export function createStubAudioEngine(): AudioEngineApi {
  return {
    unlock: asyncNoop,
    resume: async () => true,
    setMicMode: asyncNoop,
    outgoingTrack: null,
    onOutgoingTrackChange: unsub,
    addRemoteTrack: noop,
    removeRemoteTrack: noop,
    applySettings: noop,
    setSosMode: noop,
    listDevices: async () => ({ inputs: [], outputs: [], canSelectOutput: false }),
    music: createStubMusicPlayer(),
    alerts: createStubAlertSounds(),
    dispose: asyncNoop,
  };
}

export function createStubVoiceManager(): VoiceManagerApi {
  return {
    start: asyncNoop,
    update: asyncNoop,
    stop: asyncNoop,
    sendData: noop,
    onData: unsub,
    getStats: async () => ({ transport: null, bytesSent: 0, peers: {} }),
  };
}

export function createStubLocationService(): LocationServiceApi {
  return { start: asyncNoop, stop: asyncNoop, onFix: unsub, onSend: unsub, inject: noop };
}

export function createStubController(): RideControllerApi {
  return {
    startRide: async () => notReady,
    leaveRide: asyncNoop,
    resumeAudio: asyncNoop,
    raiseSos: asyncNoop,
    cancelSos: asyncNoop,
    respondSos: asyncNoop,
    acknowledgeSos: noop,
    requestBreak: async () => notReady,
    searchPlaces: async () => notReady,
    setDestination: async () => notReady,
    clearRoute: async () => notReady,
    transferLeader: async () => notReady,
    setVoiceMode: async () => notReady,
    setMicMode: asyncNoop,
    updateProfile: asyncNoop,
    getResumableRide: () => null,
  };
}
