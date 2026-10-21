/** Pulls the numbers VoiceStats needs out of a WebRTC stats report. */
import type { PeerStats } from '../../core/services';
import type { PeerState } from '../../core/store';

type Stat = Record<string, unknown> & { type: string; id: string };

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function each(report: RTCStatsReport | undefined | null, cb: (s: Stat) => void): void {
  report?.forEach((s: Stat) => cb(s));
}

/** Inbound audio of one remote rider. Several inbound streams (mesh with two m-lines) are summed. */
export function inboundAudio(report: RTCStatsReport | undefined | null, state: PeerState): PeerStats {
  const out: PeerStats = { state, bytesReceived: 0, packetsLost: 0, jitterMs: null, rttMs: null, audioLevel: null };
  let selectedPair: string | null = null;
  const pairs = new Map<string, Stat>();
  each(report, (s) => {
    if (s.type === 'inbound-rtp' && (s.kind === 'audio' || s.mediaType === 'audio')) {
      out.bytesReceived += num(s.bytesReceived) ?? 0;
      out.packetsLost += Math.max(0, num(s.packetsLost) ?? 0);
      const jitter = num(s.jitter);
      if (jitter !== null) out.jitterMs = Math.max(out.jitterMs ?? 0, jitter * 1000);
      const level = num(s.audioLevel);
      if (level !== null) out.audioLevel = Math.max(out.audioLevel ?? 0, level);
    } else if (s.type === 'transport' && typeof s.selectedCandidatePairId === 'string') {
      selectedPair = s.selectedCandidatePairId;
    } else if (s.type === 'candidate-pair') {
      pairs.set(s.id, s);
    }
  });
  const pair = (selectedPair && pairs.get(selectedPair)) || [...pairs.values()].find((p) => p.nominated && p.state === 'succeeded');
  const rtt = num(pair?.currentRoundTripTime);
  if (rtt !== null) out.rttMs = rtt * 1000;
  return out;
}

/** Bytes sent on outbound audio streams in the report. */
export function outboundAudioBytes(report: RTCStatsReport | undefined | null): number {
  let bytes = 0;
  each(report, (s) => {
    if (s.type === 'outbound-rtp' && (s.kind === 'audio' || s.mediaType === 'audio')) bytes += num(s.bytesSent) ?? 0;
  });
  return bytes;
}
