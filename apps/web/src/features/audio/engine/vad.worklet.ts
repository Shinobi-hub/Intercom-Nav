/**
 * AudioWorkletProcessor wrapping VadCore. Loaded with audioWorklet.addModule() through Vite's
 * `?worker&url`, so it is bundled as its own ES module with its imports inlined.
 *
 * Input 0: the stream to analyse (mono; extra channels are ignored).
 * Output 0: the VOX gate envelope (0..1) at audio rate, for the mic's gate GainNode.
 * Posts a 'speaking' message on every transition and 'level' messages every ~50 ms.
 */
import { VadCore } from '../dsp/vadCore';
import { GATE_ATTACK_MS, GATE_RELEASE_MS, VAD_LEVEL_INTERVAL_MS, VAD_PROCESSOR, type VadCommand, type VadMessage, type VadProcessorOptions } from './vadProtocol';

// AudioWorkletGlobalScope members (TypeScript ships no lib for this scope).
declare const sampleRate: number;
declare const currentTime: number;
declare function registerProcessor(name: string, ctor: new (options: { processorOptions?: VadProcessorOptions }) => object): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

class VadProcessor extends AudioWorkletProcessor {
  private readonly vad: VadCore;
  private readonly attack: number;
  private readonly release: number;
  private readonly framesPerLevel: number;
  private gate = 0;
  private wasSpeaking = false;
  private frameCounter = 0;
  private alive = true;

  constructor(options: { processorOptions?: VadProcessorOptions }) {
    super();
    this.vad = new VadCore(sampleRate, { sensitivity: options.processorOptions?.sensitivity ?? 0.5 });
    this.attack = 1 - Math.exp(-1 / ((GATE_ATTACK_MS / 1000) * sampleRate));
    this.release = 1 - Math.exp(-1 / ((GATE_RELEASE_MS / 1000) * sampleRate));
    this.framesPerLevel = Math.max(1, Math.round(VAD_LEVEL_INTERVAL_MS / ((this.vad.frameSize / sampleRate) * 1000)));
    this.port.onmessage = (e: MessageEvent<VadCommand>) => {
      if (e.data.type === 'sensitivity') this.vad.setSensitivity(e.data.value);
      else if (e.data.type === 'dispose') this.alive = false;
    };
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0]?.[0];
    if (input) this.vad.process(input, this.onFrame);
    const out = outputs[0]?.[0];
    if (out) {
      // Decisions land at frame boundaries; following them per block (128 samples, ~3 ms) is
      // plenty given the lookahead delay in front of the gate.
      const target = this.vad.speaking ? 1 : 0;
      const k = target > this.gate ? this.attack : this.release;
      let g = this.gate;
      for (let i = 0; i < out.length; i++) {
        g += k * (target - g);
        out[i] = g;
      }
      this.gate = g < 1e-6 ? 0 : g;
      for (let c = 1; c < (outputs[0]?.length ?? 0); c++) outputs[0]![c]!.set(out);
    }
    return this.alive;
  }

  private readonly onFrame = (): void => {
    const f = this.vad.lastFrame;
    const changed = f.speaking !== this.wasSpeaking;
    this.wasSpeaking = f.speaking;
    if (!changed && ++this.frameCounter < this.framesPerLevel) return;
    this.frameCounter = 0;
    const msg: VadMessage = {
      type: changed ? 'speaking' : 'level',
      time: currentTime,
      levelDb: f.levelDb,
      floorDb: f.floorDb,
      onDb: f.onDb,
      speaking: f.speaking,
      gate: this.gate,
    };
    this.port.postMessage(msg);
  };
}

registerProcessor(VAD_PROCESSOR, VadProcessor);
