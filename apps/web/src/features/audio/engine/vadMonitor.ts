/**
 * Runs a VadCore on one node of the audio graph. Two backends with the same behaviour:
 *  - AudioWorklet (normal): sample-accurate, off the main thread, also produces the VOX gate
 *    envelope at audio rate.
 *  - AnalyserNode polled at 20 Hz (fallback where AudioWorklet is missing, e.g. insecure
 *    contexts): feeds only the samples that arrived since the last poll through the same VadCore.
 */
import { VadCore } from '../dsp/vadCore';
import vadWorkletUrl from './vad.worklet.ts?worker&url';
import { VAD_PROCESSOR, type VadCommand, type VadLevels, type VadMessage, type VadProcessorOptions } from './vadProtocol';

export type VadState = VadLevels;

export interface VadMonitorOptions {
  sensitivity: number;
  onSpeaking(speaking: boolean): void;
  /** Roughly every 50 ms, plus on every transition. */
  onLevels?(state: Readonly<VadState>): void;
}

export interface VadMonitor {
  readonly state: Readonly<VadState>;
  /** Audio-rate VOX gate envelope (worklet backend only; the fallback leaves gating to the caller). */
  readonly gateOutput: AudioNode | null;
  readonly backend: 'worklet' | 'analyser';
  setSensitivity(sensitivity: number): void;
  dispose(): void;
}

const loaded = new WeakMap<BaseAudioContext, Promise<boolean>>();

/** Loads the VAD worklet module once per context. Resolves false when AudioWorklet can't be used. */
export function loadVadWorklet(ctx: BaseAudioContext): Promise<boolean> {
  let p = loaded.get(ctx);
  if (!p) {
    p =
      typeof AudioWorkletNode === 'undefined' || !ctx.audioWorklet
        ? Promise.resolve(false)
        : ctx.audioWorklet.addModule(vadWorkletUrl).then(
            () => true,
            (err: unknown) => {
              console.warn('[audio] VAD worklet failed to load, using the AnalyserNode fallback', err);
              return false;
            },
          );
    loaded.set(ctx, p);
  }
  return p;
}

const initialState = (): VadState => ({ speaking: false, levelDb: -120, floorDb: -120, onDb: -65, gate: 0 });

/**
 * `sink` must lead to the destination: Chrome only renders nodes that are pulled, so analysis
 * nodes hang off a silent gain into it.
 */
export function createVadMonitor(
  ctx: AudioContext,
  source: AudioNode,
  sink: AudioNode,
  backend: VadMonitor['backend'],
  opts: VadMonitorOptions,
): VadMonitor {
  return backend === 'worklet' ? workletMonitor(ctx, source, sink, opts) : analyserMonitor(ctx, source, sink, opts);
}

function workletMonitor(ctx: AudioContext, source: AudioNode, sink: AudioNode, opts: VadMonitorOptions): VadMonitor {
  const processorOptions: VadProcessorOptions = { sensitivity: opts.sensitivity };
  const node = new AudioWorkletNode(ctx, VAD_PROCESSOR, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    channelCount: 1,
    channelCountMode: 'explicit',
    channelInterpretation: 'speakers',
    processorOptions,
  });
  const state = initialState();
  node.port.onmessage = (e: MessageEvent<VadMessage>) => {
    const m = e.data;
    const changed = m.speaking !== state.speaking;
    state.levelDb = m.levelDb;
    state.floorDb = m.floorDb;
    state.onDb = m.onDb;
    state.gate = m.gate;
    state.speaking = m.speaking;
    if (changed) opts.onSpeaking(m.speaking);
    opts.onLevels?.(state);
  };
  source.connect(node);
  node.connect(sink);
  const send = (cmd: VadCommand) => node.port.postMessage(cmd);
  return {
    state,
    gateOutput: node,
    backend: 'worklet',
    setSensitivity: (value) => send({ type: 'sensitivity', value }),
    dispose() {
      safeDisconnect(source, node);
      node.disconnect();
      send({ type: 'dispose' });
      node.port.onmessage = null;
      node.port.close();
    },
  };
}

const POLL_MS = 50;

function analyserMonitor(ctx: AudioContext, source: AudioNode, sink: AudioNode, opts: VadMonitorOptions): VadMonitor {
  const analyser = ctx.createAnalyser();
  // Must hold more than one poll interval of audio at any sample rate (4096 = 85 ms at 48 kHz).
  analyser.fftSize = 8192;
  analyser.smoothingTimeConstant = 0;
  source.connect(analyser);
  analyser.connect(sink);
  const core = new VadCore(ctx.sampleRate, { sensitivity: opts.sensitivity });
  const buf = new Float32Array(analyser.fftSize);
  const state = initialState();
  let last = ctx.currentTime;
  let framesSinceLevel = 0;

  const onFrame = () => {
    const f = core.lastFrame;
    const changed = f.speaking !== state.speaking;
    state.levelDb = f.levelDb;
    state.floorDb = f.floorDb;
    state.onDb = f.onDb;
    state.speaking = f.speaking;
    state.gate = f.speaking ? 1 : 0;
    if (changed) opts.onSpeaking(f.speaking);
    if (changed || ++framesSinceLevel >= 5) {
      framesSinceLevel = 0;
      opts.onLevels?.(state);
    }
  };

  const timer = setInterval(() => {
    const now = ctx.currentTime;
    const fresh = Math.min(buf.length, Math.round((now - last) * ctx.sampleRate));
    last = now;
    if (fresh <= 0) return;
    analyser.getFloatTimeDomainData(buf);
    core.process(buf.subarray(buf.length - fresh), onFrame);
  }, POLL_MS);

  return {
    state,
    gateOutput: null,
    backend: 'analyser',
    setSensitivity: (s) => core.setSensitivity(s),
    dispose() {
      clearInterval(timer);
      safeDisconnect(source, analyser);
      analyser.disconnect();
    },
  };
}

function safeDisconnect(from: AudioNode, to: AudioNode): void {
  try {
    from.disconnect(to);
  } catch {
    /* already disconnected */
  }
}
