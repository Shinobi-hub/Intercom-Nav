import { LIMITS, type Place } from '@intercom/shared';
import { useEffect, useRef, useState } from 'react';
import { getServices } from '../../core/services';
import { useLocalStore } from '../../core/store';
import { describeRouteError } from './errors';

export const SEARCH_DEBOUNCE_MS = 400;

export type PlaceSearch =
  | { status: 'idle' }
  /** Typed something, but fewer characters than a search needs. */
  | { status: 'short' }
  /** `results` are the previous query's, kept on screen until the new ones arrive. */
  | { status: 'searching'; results: Place[] }
  | { status: 'done'; results: Place[] }
  | { status: 'error'; message: string };

/** Debounced place search biased to my position. Only the latest query's answer is ever shown. */
export function usePlaceSearch(query: string): PlaceSearch {
  const [state, setState] = useState<PlaceSearch>({ status: 'idle' });
  const latest = useRef(0);

  useEffect(() => {
    const q = query.trim().slice(0, LIMITS.placeQueryMax);
    const id = ++latest.current;
    if (q.length < LIMITS.placeQueryMin) {
      setState({ status: q ? 'short' : 'idle' });
      return;
    }
    setState((prev) => ({ status: 'searching', results: 'results' in prev ? prev.results : [] }));
    const timer = setTimeout(async () => {
      const fix = useLocalStore.getState().selfFix;
      const near = fix ? { lat: fix.lat, lng: fix.lng } : undefined;
      let next: PlaceSearch;
      try {
        const res = await getServices().controller.searchPlaces(q, near);
        next = res.ok
          ? { status: 'done', results: res.results }
          : { status: 'error', message: describeRouteError(res, 'Search failed. Try again.') };
      } catch {
        next = { status: 'error', message: 'Search failed. Try again.' };
      }
      if (id === latest.current) setState(next);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  return state;
}
