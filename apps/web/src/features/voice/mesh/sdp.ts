/**
 * SDP helpers for mesh voice.
 *
 * Opus fmtp parameters in an SDP describe what its *sender wants to receive*, so the copy of our
 * description we send to a peer is where we ask that peer's encoder for DTX (no packets during
 * silence: most of a ride), in-band FEC (rides through cellular packet loss) and a voice-sized
 * bitrate. Our local description is left untouched.
 */

export const OPUS_FMTP: Readonly<Record<string, string>> = {
  usedtx: '1',
  useinbandfec: '1',
  maxaveragebitrate: '32000',
  stereo: '0',
};

/** Returns `sdp` with every Opus payload's fmtp line carrying `params` (added or overridden). */
export function mungeOpus(sdp: string, params: Readonly<Record<string, string>> = OPUS_FMTP): string {
  const eol = sdp.includes('\r\n') ? '\r\n' : '\n';
  const lines = sdp.split(/\r?\n/);
  const opus = new Set<string>();
  for (const line of lines) {
    const m = /^a=rtpmap:(\d+) opus\/48000/i.exec(line);
    if (m) opus.add(m[1]!);
  }
  if (opus.size === 0) return sdp;

  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const fmtp = /^a=fmtp:(\d+) (.*)$/.exec(line);
    if (fmtp && opus.has(fmtp[1]!)) {
      seen.add(fmtp[1]!);
      out.push(`a=fmtp:${fmtp[1]} ${mergeParams(fmtp[2]!, params)}`);
      continue;
    }
    out.push(line);
    const rtpmap = /^a=rtpmap:(\d+) opus\/48000/i.exec(line);
    if (rtpmap && !hasFmtp(lines, rtpmap[1]!)) out.push(`a=fmtp:${rtpmap[1]} ${mergeParams('', params)}`);
  }
  return out.join(eol);
}

function hasFmtp(lines: string[], pt: string): boolean {
  return lines.some((l) => l.startsWith(`a=fmtp:${pt} `));
}

function mergeParams(existing: string, params: Readonly<Record<string, string>>): string {
  const merged = new Map<string, string>();
  for (const part of existing.split(';')) {
    const [k, ...v] = part.split('=');
    const key = k?.trim();
    if (key) merged.set(key, v.join('=').trim());
  }
  for (const [k, v] of Object.entries(params)) merged.set(k, v);
  return [...merged].map(([k, v]) => (v === '' ? k : `${k}=${v}`)).join(';');
}

/**
 * Session id from the o= line. It is fixed for the life of an RTCPeerConnection, so a new value
 * from the same rider means they started over with a fresh connection (reload, recovery).
 */
export function sessionIdOf(sdp: string): string | null {
  const m = /^o=\S+ (\S+) /m.exec(sdp);
  return m ? m[1]! : null;
}
