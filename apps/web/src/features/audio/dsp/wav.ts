/** Minimal PCM WAV codec (16-bit integer and 32-bit float), for fixtures and generated test tracks. */

export interface PcmAudio {
  sampleRate: number;
  /** One Float32Array per channel, samples in -1..1. */
  channels: Float32Array[];
}

const ascii = (v: DataView, at: number) =>
  String.fromCharCode(v.getUint8(at), v.getUint8(at + 1), v.getUint8(at + 2), v.getUint8(at + 3));

export function decodeWav(input: ArrayBuffer | Uint8Array): PcmAudio {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (v.byteLength < 12 || ascii(v, 0) !== 'RIFF' || ascii(v, 8) !== 'WAVE') throw new Error('not a RIFF/WAVE file');
  let fmt: { format: number; channels: number; sampleRate: number; bits: number } | null = null;
  // Walk the chunks: encoders add LIST/FLLR/fact chunks before the data.
  for (let off = 12; off + 8 <= v.byteLength; ) {
    const id = ascii(v, off);
    const size = v.getUint32(off + 4, true);
    const body = off + 8;
    if (id === 'fmt ') {
      fmt = {
        format: v.getUint16(body, true),
        channels: v.getUint16(body + 2, true),
        sampleRate: v.getUint32(body + 4, true),
        bits: v.getUint16(body + 14, true),
      };
      // WAVE_FORMAT_EXTENSIBLE: the real format code is the first field of the sub-format GUID.
      if (fmt.format === 0xfffe && size >= 26) fmt.format = v.getUint16(body + 24, true);
    } else if (id === 'data') {
      if (!fmt) throw new Error('data chunk before fmt chunk');
      return { sampleRate: fmt.sampleRate, channels: readSamples(v, body, Math.min(size, v.byteLength - body), fmt) };
    }
    off = body + size + (size & 1);
  }
  throw new Error('no data chunk');
}

function readSamples(
  v: DataView,
  at: number,
  size: number,
  fmt: { format: number; channels: number; bits: number },
): Float32Array[] {
  const isPcm16 = fmt.format === 1 && fmt.bits === 16;
  const isFloat32 = fmt.format === 3 && fmt.bits === 32;
  if (!isPcm16 && !isFloat32) throw new Error(`unsupported WAV format ${fmt.format}/${fmt.bits}-bit`);
  const width = fmt.bits / 8;
  const frames = Math.floor(size / (width * fmt.channels));
  const out = Array.from({ length: fmt.channels }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < fmt.channels; c++) {
      const p = at + (i * fmt.channels + c) * width;
      out[c]![i] = isPcm16 ? v.getInt16(p, true) / 32768 : v.getFloat32(p, true);
    }
  }
  return out;
}

/** Mono 16-bit PCM WAV. */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(44 + samples.length * 2);
  const v = new DataView(out.buffer);
  const tag = (at: number, s: string) => {
    for (let i = 0; i < 4; i++) v.setUint8(at + i, s.charCodeAt(i));
  };
  tag(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  tag(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    v.setInt16(44 + i * 2, Math.round(s < 0 ? s * 32768 : s * 32767), true);
  }
  return out;
}

/** Decodes a `data:...;base64,` URL (what Vite's `?inline` asset import returns). */
export function bytesFromDataUrl(url: string): Uint8Array {
  const comma = url.indexOf(',');
  if (!url.startsWith('data:') || comma < 0) throw new Error('not a data URL');
  const bin = atob(url.slice(comma + 1));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
