/**
 * VoiceDataMessage <-> bytes for the transports' data channels. Incoming data comes from other
 * riders' devices, so it is shape-checked before anyone acts on it.
 */
import type { VoiceDataMessage } from '@intercom/shared';

/** LiveKit data topic for alerts. */
export const ALERT_TOPIC = 'alerts';

/** Mesh: both peers create this channel with negotiated id 0, so no in-band announcement is needed. */
export const ALERT_CHANNEL_ID = 0;
export const ALERT_CHANNEL_LABEL = 'alerts';

const MAX_BYTES = 16 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeData(msg: VoiceDataMessage): Uint8Array<ArrayBuffer> {
  return encoder.encode(JSON.stringify(msg));
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown, max = 200): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Parses and validates; returns null for anything that isn't a well-formed VoiceDataMessage. */
export function decodeData(data: ArrayBuffer | ArrayBufferView | string): VoiceDataMessage | null {
  let text: string;
  if (typeof data === 'string') text = data;
  else {
    // isView rather than instanceof ArrayBuffer: buffers can come from another realm (workers, iframes).
    const bytes = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
    if (bytes.byteLength > MAX_BYTES) return null;
    text = decoder.decode(bytes);
  }
  if (text.length > MAX_BYTES) return null;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(v)) return null;
  if (v.type === 'sos-cancel') {
    return isStr(v.id) && isStr(v.riderId) ? { type: 'sos-cancel', id: v.id, riderId: v.riderId } : null;
  }
  if (v.type === 'sos' && isObj(v.sos)) {
    const s = v.sos;
    if (!isStr(s.id) || !isStr(s.riderId) || !isNum(s.raisedAt) || !Array.isArray(s.responders)) return null;
    if (s.location !== null && !isLocation(s.location)) return null;
    if (!s.responders.every((r) => isObj(r) && isStr(r.riderId) && isNum(r.at))) return null;
    return { type: 'sos', sos: s as unknown as Extract<VoiceDataMessage, { type: 'sos' }>['sos'] };
  }
  return null;
}

function isLocation(v: unknown): boolean {
  return (
    isObj(v) &&
    isNum(v.lat) &&
    Math.abs(v.lat) <= 90 &&
    isNum(v.lng) &&
    Math.abs(v.lng) <= 180 &&
    isNum(v.acc) &&
    isNum(v.t) &&
    (v.spd === null || isNum(v.spd)) &&
    (v.hdg === null || isNum(v.hdg))
  );
}
