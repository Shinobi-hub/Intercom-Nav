/**
 * How mesh peers exchange SDP and ICE candidates. Production goes through the ride server
 * (`rtc:signal`, relayed only to the addressed rider); the dev harness uses a BroadcastChannel
 * between tabs and tests an in-memory hub.
 */
import type { RiderId, RtcSignalData } from '@intercom/shared';
import type { AppSocket } from '../../../core/socket';
import type { Unsubscribe } from '../../../core/services';

export interface SignalingChannel {
  send(to: RiderId, data: RtcSignalData): void;
  onSignal(cb: (from: RiderId, data: RtcSignalData) => void): Unsubscribe;
  /** The signaling path came back after an outage (e.g. a socket reconnect). */
  onReconnect?(cb: () => void): Unsubscribe;
}

export function socketSignaling(socket: AppSocket): SignalingChannel {
  return {
    send(to, data) {
      // Buffered signals would arrive stale after an outage; peers that need it renegotiate on reconnect.
      if (socket.connected) socket.emit('rtc:signal', { to, data });
    },
    onSignal(cb) {
      const handler = (p: { from: RiderId; data: RtcSignalData }) => cb(p.from, p.data);
      socket.on('rtc:signal', handler);
      return () => socket.off('rtc:signal', handler);
    },
    onReconnect(cb) {
      // The mesh starts after the ride is joined, so every later 'connect' is a reconnect.
      const handler = () => cb();
      socket.on('connect', handler);
      return () => socket.off('connect', handler);
    },
  };
}

/**
 * Listens for the whole session and keeps signals that arrive while no mesh transport is listening
 * (during a switch from LiveKit, or before our mesh starts after joining), then hands them to the next
 * listener, so another rider's early offer isn't lost. Only signals younger than maxAgeMs are handed
 * over: older ones describe connections their sender has already given up on.
 */
export function bufferedSignaling(inner: SignalingChannel, maxAgeMs = 10_000, maxHeld = 200): SignalingChannel & { close(): void } {
  const listeners = new Set<(from: RiderId, data: RtcSignalData) => void>();
  let held: { from: RiderId; data: RtcSignalData; at: number }[] = [];
  const off = inner.onSignal((from, data) => {
    if (listeners.size > 0) {
      for (const cb of [...listeners]) cb(from, data);
      return;
    }
    held.push({ from, data, at: Date.now() });
    if (held.length > maxHeld) held.shift();
  });
  return {
    send: (to, data) => inner.send(to, data),
    onSignal(cb) {
      listeners.add(cb);
      const since = Date.now() - maxAgeMs;
      const replay = held.filter((h) => h.at >= since);
      held = [];
      for (const h of replay) cb(h.from, h.data);
      return () => {
        listeners.delete(cb);
      };
    },
    ...(inner.onReconnect && { onReconnect: (cb: () => void) => inner.onReconnect!(cb) }),
    close: () => {
      off();
      held = [];
    },
  };
}

interface Envelope {
  from: RiderId;
  to: RiderId;
  data: RtcSignalData;
}

const isEnvelope = (v: unknown): v is Envelope =>
  typeof v === 'object' && v !== null && typeof (v as Envelope).from === 'string' && typeof (v as Envelope).to === 'string';

/** Same-browser signaling between tabs (dev harness). */
export function broadcastSignaling(selfId: RiderId, channelName = 'intercom-mesh-dev'): SignalingChannel & { close(): void } {
  const bc = new BroadcastChannel(channelName);
  return {
    send: (to, data) => bc.postMessage({ from: selfId, to, data } satisfies Envelope),
    onSignal(cb) {
      const handler = (e: MessageEvent) => {
        if (isEnvelope(e.data) && e.data.to === selfId) cb(e.data.from, e.data.data);
      };
      bc.addEventListener('message', handler);
      return () => bc.removeEventListener('message', handler);
    },
    close: () => bc.close(),
  };
}

/** In-process signaling for tests: asynchronous delivery, optional per-message delay. */
export function createSignalingHub(delay: () => number = () => 0) {
  const inboxes = new Map<RiderId, Set<(from: RiderId, data: RtcSignalData) => void>>();
  const reconnects = new Map<RiderId, Set<() => void>>();
  let sent = 0;
  return {
    get sent() {
      return sent;
    },
    channel(selfId: RiderId): SignalingChannel {
      return {
        send(to, data) {
          sent++;
          const copy = JSON.parse(JSON.stringify(data)) as RtcSignalData;
          setTimeout(() => {
            for (const cb of inboxes.get(to) ?? []) cb(selfId, copy);
          }, delay());
        },
        onSignal(cb) {
          const set = inboxes.get(selfId) ?? new Set();
          inboxes.set(selfId, set);
          set.add(cb);
          return () => set.delete(cb);
        },
        onReconnect(cb) {
          const set = reconnects.get(selfId) ?? new Set();
          reconnects.set(selfId, set);
          set.add(cb);
          return () => set.delete(cb);
        },
      };
    },
    /** Simulates a signaling reconnect for one rider. */
    reconnect(riderId: RiderId) {
      for (const cb of reconnects.get(riderId) ?? []) cb();
    },
  };
}
