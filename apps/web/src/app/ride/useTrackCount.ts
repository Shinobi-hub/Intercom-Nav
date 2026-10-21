import { useEffect, useState } from 'react';
import { getServices } from '../../core/services';

/** Number of tracks in the music library; null until the first listing arrives. */
export function useTrackCount(): number | null {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    const { music } = getServices().audio;
    let alive = true;
    music
      .listTracks()
      .then((tracks) => alive && setCount(tracks.length))
      .catch(() => alive && setCount(0));
    const off = music.onTracksChanged((tracks) => setCount(tracks.length));
    return () => {
      alive = false;
      off();
    };
  }, []);
  return count;
}
