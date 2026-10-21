import { Check, FolderPlus, Link2, Music2, Pause, Play, Radio, SkipBack, SkipForward, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { MusicTrack } from '../../../core/services';
import { getServices } from '../../../core/services';
import { useLocalStore } from '../../../core/store';
import { TID } from '../../../core/testIds';
import { Button } from '../../../ui/Button';
import { cx } from '../../../ui/cx';
import { tapFeedback } from '../../../ui/feedback';
import styles from './MusicPanel.module.css';

/** The playlist, kept in sync with the player. */
function useTracks(): MusicTrack[] | null {
  const [tracks, setTracks] = useState<MusicTrack[] | null>(null);
  useEffect(() => {
    const { music } = getServices().audio;
    let alive = true;
    music
      .listTracks()
      .then((t) => alive && setTracks(t))
      .catch(() => alive && setTracks([]));
    const off = music.onTracksChanged(setTracks);
    return () => {
      alive = false;
      off();
    };
  }, []);
  return tracks;
}

const formatSize = (bytes?: number) =>
  bytes === undefined ? '' : bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} kB`;

/** Content of the Music sheet: transport, add files / stream URL, playlist. Built for gloves. */
export function MusicPanel({ onDone }: { onDone: () => void }) {
  const tracks = useTracks();
  const playing = useLocalStore((s) => s.audio.musicPlaying);
  const nowPlaying = useLocalStore((s) => s.audio.nowPlaying);
  const playerError = useLocalStore((s) => s.audio.error);
  const [busy, setBusy] = useState<'files' | 'stream' | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [url, setUrl] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const music = () => getServices().audio.music;
  const error = localError ?? playerError;
  const hasTracks = (tracks?.length ?? 0) > 0;

  const run = (action: () => Promise<unknown>) => {
    setLocalError(null);
    action().catch((e: unknown) => setLocalError(e instanceof Error ? e.message : String(e)));
  };

  async function onFiles(list: FileList | null) {
    const files = list ? [...list] : [];
    if (fileInput.current) fileInput.current.value = '';
    if (!files.length) return;
    setBusy('files');
    setLocalError(null);
    try {
      const added = await music().addFiles(files);
      // First music on a fresh device: start it, that's why they added it.
      if (added.length && !playing && !nowPlaying) await music().play(added[0]!.id);
    } catch (e) {
      setLocalError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function onAddStream(e: FormEvent) {
    e.preventDefault();
    if (!url.trim() || busy) return;
    setBusy('stream');
    setLocalError(null);
    try {
      await music().addStream(url);
      setUrl('');
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className={styles.panel}>
      <section className={styles.player} aria-label="Player">
        <div className={styles.now} aria-live="polite">
          <span className={styles.nowLabel}>{playing ? 'Playing' : nowPlaying ? 'Paused' : 'Nothing playing'}</span>
          <span className={styles.nowTitle}>{nowPlaying?.title ?? (hasTracks ? 'Tap play to start' : 'Add some music below')}</span>
        </div>
        <div className={styles.transport}>
          <button
            type="button"
            className={styles.transportKey}
            data-testid={TID.musicPrev}
            aria-label="Previous track"
            disabled={!hasTracks}
            onClick={() => {
              tapFeedback();
              run(() => music().previous());
            }}
          >
            <SkipBack aria-hidden="true" />
          </button>
          <button
            type="button"
            className={cx(styles.transportKey, styles.playKey)}
            data-testid={TID.musicPlayPause}
            data-playing={playing}
            aria-label={playing ? 'Pause' : 'Play'}
            disabled={!hasTracks}
            onClick={() => {
              // No await before toggle(): the tap must reach the AudioContext as a user gesture.
              run(() => music().toggle());
              tapFeedback();
            }}
          >
            {playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
          </button>
          <button
            type="button"
            className={styles.transportKey}
            data-testid={TID.musicNext}
            aria-label="Next track"
            disabled={!hasTracks}
            onClick={() => {
              tapFeedback();
              run(() => music().next());
            }}
          >
            <SkipForward aria-hidden="true" />
          </button>
        </div>
      </section>

      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      <section className={styles.add} aria-label="Add music">
        <input
          ref={fileInput}
          className={styles.hiddenInput}
          type="file"
          accept="audio/*"
          multiple
          tabIndex={-1}
          data-testid={TID.musicFileInput}
          onChange={(e) => void onFiles(e.currentTarget.files)}
        />
        <Button variant="primary" size="lg" icon={FolderPlus} block busy={busy === 'files'} onClick={() => fileInput.current?.click()}>
          Add music files
        </Button>
        <form className={styles.streamForm} onSubmit={(e) => void onAddStream(e)}>
          <label className={styles.streamLabel}>
            <Link2 aria-hidden="true" className={styles.streamIcon} />
            <input
              className={styles.streamInput}
              type="url"
              inputMode="url"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              placeholder="Stream URL (https://…)"
              aria-label="Stream URL"
              value={url}
              data-testid={TID.musicStreamUrl}
              onChange={(e) => setUrl(e.currentTarget.value)}
            />
          </label>
          <Button type="submit" variant="secondary" busy={busy === 'stream'} disabled={!url.trim()} data-testid={TID.musicStreamAdd}>
            Add
          </Button>
        </form>
      </section>

      <section aria-label="Playlist">
        {tracks === null ? null : tracks.length === 0 ? (
          <p className={styles.empty}>No music yet. Files you add stay on this phone, so they play without signal.</p>
        ) : (
          <ul className={styles.list}>
            {tracks.map((t) => (
              <TrackRow key={t.id} track={t} current={nowPlaying?.id === t.id} playing={playing && nowPlaying?.id === t.id} onPlay={() => run(() => music().play(t.id))} onRemove={() => run(() => music().removeTrack(t.id))} />
            ))}
          </ul>
        )}
      </section>

      <Button variant="ghost" block onClick={onDone}>
        Done
      </Button>
    </div>
  );
}

const CONFIRM_WINDOW_MS = 4_000;

function TrackRow({
  track,
  current,
  playing,
  onPlay,
  onRemove,
}: {
  track: MusicTrack;
  current: boolean;
  playing: boolean;
  onPlay: () => void;
  onRemove: () => void;
}) {
  // Two taps to delete: a gloved brush shouldn't cost someone their playlist.
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), CONFIRM_WINDOW_MS);
    return () => clearTimeout(t);
  }, [armed]);
  const Icon = track.kind === 'stream' ? Radio : Music2;
  return (
    <li className={cx(styles.row, current && styles.current)} data-testid={TID.musicTrack(track.id)} data-current={current} data-playing={playing}>
      <button
        type="button"
        className={styles.rowMain}
        aria-label={`Play ${track.title}`}
        aria-current={current || undefined}
        onClick={() => {
          onPlay();
          tapFeedback();
        }}
      >
        <Icon aria-hidden="true" className={styles.rowIcon} />
        <span className={styles.rowText}>
          <span className={styles.rowTitle}>{track.title}</span>
          <span className={styles.rowMeta}>{track.kind === 'stream' ? 'Stream' : formatSize(track.sizeBytes)}</span>
        </span>
        {playing && <span className={styles.eq} aria-hidden="true" />}
      </button>
      <button
        type="button"
        className={cx(styles.remove, armed && styles.removeArmed)}
        aria-label={armed ? `Confirm removing ${track.title}` : `Remove ${track.title}`}
        onClick={() => {
          tapFeedback();
          if (armed) onRemove();
          else setArmed(true);
        }}
      >
        {armed ? <Check aria-hidden="true" /> : <Trash2 aria-hidden="true" />}
      </button>
    </li>
  );
}
