/** One remote rider's voice in the mix: element workaround, source, volume, VAD. */
import type { RiderId } from '@intercom/shared';
import type { AudioGraph } from './graph';
import { glide } from './graph';
import { createVadMonitor, type VadMonitor } from './vadMonitor';

export class RemoteVoice {
  readonly stream: MediaStream;
  /**
   * Chrome feeds a remote WebRTC track into Web Audio only while a media element is also playing
   * it; the element is muted so it doesn't double the sound.
   */
  readonly element: HTMLAudioElement;
  private readonly source: MediaStreamAudioSourceNode;
  private readonly gain: GainNode;
  private vad: VadMonitor | null = null;
  speaking = false;

  constructor(
    private readonly graph: AudioGraph,
    readonly riderId: RiderId,
    readonly track: MediaStreamTrack,
    volume: number,
  ) {
    this.stream = new MediaStream([track]);
    const el = document.createElement('audio');
    el.muted = true;
    el.autoplay = true;
    el.setAttribute('playsinline', '');
    el.srcObject = this.stream;
    void el.play().catch(() => {
      /* muted autoplay is allowed; if not, the source still works once the page is unlocked */
    });
    this.element = el;
    this.source = graph.ctx.createMediaStreamSource(this.stream);
    this.gain = graph.ctx.createGain();
    this.gain.gain.value = volume;
    this.source.connect(this.gain).connect(graph.voiceBus);
  }

  get vadState() {
    return this.vad?.state ?? null;
  }

  /** Starts voice activity detection once the engine knows which VAD backend it has. */
  attachVad(backend: VadMonitor['backend'], sensitivity: number, onSpeaking: (speaking: boolean) => void): void {
    if (this.vad) return;
    this.vad = createVadMonitor(this.graph.ctx, this.source, this.graph.analysisSink, backend, {
      sensitivity,
      onSpeaking: (s) => {
        this.speaking = s;
        onSpeaking(s);
      },
    });
  }

  setVolume(volume: number): void {
    glide(this.gain.gain, volume, this.graph.ctx);
  }

  setSensitivity(sensitivity: number): void {
    this.vad?.setSensitivity(sensitivity);
  }

  dispose(): void {
    this.vad?.dispose();
    this.vad = null;
    this.source.disconnect();
    this.gain.disconnect();
    this.element.pause();
    this.element.srcObject = null;
    this.speaking = false;
  }
}
