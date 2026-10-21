/** Paths and metadata of the generated audio fixtures (see fixtures/generate.mjs). */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AUDIO_DIR } from './env';

/** What a rider's fake microphone plays (looped by Chrome). */
export type FakeMic = 'speech' | 'silence' | 'wind' | 'tone';

const MIC_FILES: Record<FakeMic, string> = {
  speech: 'speech-loop.wav',
  silence: 'silence.wav',
  wind: 'wind.wav',
  tone: 'tone.wav',
};

export function micFile(mic: FakeMic): string {
  return join(AUDIO_DIR, MIC_FILES[mic]);
}

export const MUSIC_FILE = join(AUDIO_DIR, 'music.wav');

export interface SpeechSidecar {
  file: string;
  sampleRate: number;
  /** The fake mic loops the file, so the speech window repeats every cycle. */
  cycleMs: number;
  speech: { startMs: number; endMs: number; durationMs: number; text: string; voice: string; rateWpm: number };
  windowsMs: [number, number][];
  voicedSegmentsMs: [number, number][];
  longestPauseMs: number;
}

let sidecar: SpeechSidecar | null = null;

export function speechSidecar(): SpeechSidecar {
  sidecar ??= JSON.parse(readFileSync(join(AUDIO_DIR, 'speech-loop.json'), 'utf8')) as SpeechSidecar;
  return sidecar;
}
