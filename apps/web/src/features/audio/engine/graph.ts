/**
 * The engine's node graph (docs/ARCHITECTURE.md, "Audio engine"):
 *
 *   voices ─► rider gains ─► voiceBus ─► voiceVolume ─┐
 *   music <audio> ─► musicVolume ─► duck ─────────────┼─► master ─► limiter ─► destination
 *   chimes ─► fxBus ──────────────────────────────────┘
 *   siren ─► alertGain ─────────────────────────────────────────────────────► destination
 *   mic ─► micIn ─► voxDelay ─► voxGate ─► micOut (MediaStreamDestination) ─► voice transport
 *                └► own VAD (its gate envelope drives voxGate.gain in VOX mode)
 */

/**
 * The mic path is delayed by this much so the VOX gate (driven by the VAD, which needs ~30 ms to
 * be sure) opens just before the first syllable reaches it instead of clipping it.
 */
export const VOX_LOOKAHEAD_S = 0.04;

export const LIMITER = { threshold: -4, knee: 0, ratio: 20, attack: 0.003, release: 0.25 } as const;

export interface AudioGraph {
  ctx: AudioContext;
  master: GainNode;
  limiter: DynamicsCompressorNode;
  voiceBus: GainNode;
  voiceVolume: GainNode;
  musicSource: MediaElementAudioSourceNode;
  musicVolume: GainNode;
  duck: GainNode;
  fxBus: GainNode;
  alertGain: GainNode;
  /** Silent path to the destination that keeps analysis-only nodes rendering. */
  analysisSink: GainNode;
  micIn: GainNode;
  voxDelay: DelayNode;
  voxGate: GainNode;
  micOut: MediaStreamAudioDestinationNode;
}

export function buildGraph(ctx: AudioContext, musicElement: HTMLAudioElement, levels: { voiceVolume: number; musicVolume: number }): AudioGraph {
  const gain = (value: number) => {
    const g = ctx.createGain();
    g.gain.value = value;
    return g;
  };

  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = LIMITER.threshold;
  limiter.knee.value = LIMITER.knee;
  limiter.ratio.value = LIMITER.ratio;
  limiter.attack.value = LIMITER.attack;
  limiter.release.value = LIMITER.release;
  const master = gain(1);
  master.connect(limiter).connect(ctx.destination);

  const voiceBus = gain(1);
  const voiceVolume = gain(levels.voiceVolume);
  voiceBus.connect(voiceVolume).connect(master);

  const musicSource = ctx.createMediaElementSource(musicElement);
  const musicVolume = gain(levels.musicVolume);
  const duck = gain(1);
  musicSource.connect(musicVolume).connect(duck).connect(master);

  const fxBus = gain(0.9);
  fxBus.connect(master);

  const alertGain = gain(1);
  alertGain.connect(ctx.destination);

  const analysisSink = gain(0);
  analysisSink.connect(ctx.destination);

  const micIn = gain(1);
  micIn.channelCount = 1;
  micIn.channelCountMode = 'explicit';
  const voxDelay = ctx.createDelay(0.25);
  voxDelay.delayTime.value = VOX_LOOKAHEAD_S;
  const voxGate = gain(0);
  // Mono, so transports treat it as a voice track (LiveKit only enables DTX/RED for mono).
  const micOut = ctx.createMediaStreamDestination();
  micOut.channelCount = 1;
  micOut.channelCountMode = 'explicit';
  micIn.connect(voxDelay).connect(voxGate).connect(micOut);

  return {
    ctx,
    master,
    limiter,
    voiceBus,
    voiceVolume,
    musicSource,
    musicVolume,
    duck,
    fxBus,
    alertGain,
    analysisSink,
    micIn,
    voxDelay,
    voxGate,
    micOut,
  };
}

/** Moves a param toward `value` without zipper noise; cancels whatever was scheduled. */
export function glide(param: AudioParam, value: number, ctx: BaseAudioContext, timeConstantS = 0.03): void {
  const t = ctx.currentTime;
  param.cancelScheduledValues(t);
  if (timeConstantS <= 0) param.setValueAtTime(value, t);
  else param.setTargetAtTime(value, t, timeConstantS);
}
