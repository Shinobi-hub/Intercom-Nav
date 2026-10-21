import { Mic, MicOff } from 'lucide-react';
import { getServices } from '../../../core/services';
import { useLocalStore, useRideStore, useSettings } from '../../../core/store';
import { TID } from '../../../core/testIds';
import { tapFeedback } from '../../../ui/feedback';
import type { DockTone } from './DockKey';
import { DockKey } from './DockKey';

/** Mute toggle: flips between the rider's live mode (VOX or OPEN, from settings) and off. */
export function MicButton() {
  const mode = useSettings((s) => s.micMode);
  const liveMode = useSettings((s) => s.liveMicMode);
  const micState = useLocalStore((s) => s.audio.micState);
  const selfId = useRideStore((s) => s.selfId);
  const speaking = useLocalStore((s) => (selfId ? s.speaking[selfId] === true : false));

  const muted = mode === 'off';
  const blocked = !muted && (micState === 'denied' || micState === 'error');
  const caption = blocked ? 'NO MIC' : muted ? 'MUTED' : mode.toUpperCase();
  const tone: DockTone = muted || blocked ? 'mic-off' : mode === 'open' ? 'mic-open' : 'mic-vox';
  const label = muted
    ? `Microphone muted. Tap to turn on ${liveMode.toUpperCase()}.`
    : blocked
      ? 'Microphone blocked by the browser. Tap to mute.'
      : `Microphone ${caption}. Tap to mute.`;

  return (
    <DockKey
      tone={tone}
      lit={!muted && !blocked}
      glyph={muted || blocked ? <MicOff /> : <Mic />}
      caption={caption}
      aria-label={label}
      aria-pressed={!muted}
      data-testid={TID.dockMic}
      data-mode={mode}
      data-state={micState}
      data-speaking={!muted && speaking}
      onClick={() => {
        tapFeedback();
        void getServices().controller.setMicMode(muted ? liveMode : 'off');
      }}
    />
  );
}
