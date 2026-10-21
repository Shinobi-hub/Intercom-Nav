import { ListMusic, Pause, Play } from 'lucide-react';
import { getServices } from '../../../core/services';
import { useLocalStore } from '../../../core/store';
import { TID } from '../../../core/testIds';
import { tapFeedback } from '../../../ui/feedback';
import { usePress } from '../../../ui/usePress';
import { useTrackCount } from '../useTrackCount';
import { DockKey } from './DockKey';
import styles from './dock.module.css';

const LONG_PRESS_MS = 600;

function openMusic() {
  useLocalStore.getState().openSheet('music');
}

/** Tap plays/pauses; long-press (or an empty library) opens the Music sheet. */
export function MusicButton() {
  const playing = useLocalStore((s) => s.audio.musicPlaying);
  const nowPlaying = useLocalStore((s) => s.audio.nowPlaying);
  const trackCount = useTrackCount();
  const empty = trackCount === 0 && !nowPlaying;

  const { pressing, bind } = usePress({
    holdMs: LONG_PRESS_MS,
    onPressStart: tapFeedback,
    onTap: () => {
      if (empty) {
        openMusic();
        return;
      }
      getServices()
        .audio.music.toggle()
        .catch(() =>
          useLocalStore.getState().pushToast({
            kind: 'error',
            title: "Music won't play",
            body: 'Open Music to check the track.',
          }),
        );
    },
    onHold: () => {
      getServices().platform.haptics.vibrate(30);
      openMusic();
    },
  });

  const title = nowPlaying?.title;
  const label = empty
    ? 'Music. No songs yet. Tap to add some.'
    : `${playing ? 'Pause' : 'Play'}${title ? ` ${title}` : ' music'}. Hold for the music library.`;

  return (
    <DockKey
      tone="music"
      lit={playing}
      glyph={empty ? <ListMusic /> : playing ? <Pause /> : <Play />}
      caption={title ?? 'MUSIC'}
      captionClassName={title ? styles.title : undefined}
      aria-label={label}
      data-testid={TID.dockMusic}
      data-playing={playing}
      data-pressing={pressing}
      {...bind}
    />
  );
}
