import type { RiderId } from '@intercom/shared';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { TID } from '../../core/testIds';
import { LiveMap } from './liveMap';
import styles from './map.module.css';

export interface MapViewProps {
  className?: string;
  onRiderSelect?: (riderId: RiderId) => void;
}

/** Full-bleed live map: rider markers, route line, own position. Reads everything from the stores. */
export function MapView({ className, onRiderSelect }: MapViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const selectRef = useRef(onRiderSelect);
  // Bumped when the map can't recover on its own (lost WebGL context); remounts a fresh one.
  const [generation, setGeneration] = useState(0);
  const [failure, setFailure] = useState<string | null>(null);

  useLayoutEffect(() => {
    selectRef.current = onRiderSelect;
  });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let live: LiveMap;
    try {
      live = new LiveMap({
        container,
        onRiderSelect: (id) => selectRef.current?.(id),
        onFatal: (reason) => {
          console.warn(`[map] recreating the map (${reason})`);
          setGeneration((g) => g + 1);
        },
      });
    } catch (e) {
      // No WebGL (old device, GPU blocklisted): everything but the map keeps working.
      console.error('[map] could not start', e);
      setFailure(e instanceof Error ? e.message : String(e));
      return;
    }
    return () => live.dispose();
  }, [generation]);

  const cls = [styles.map, className].filter(Boolean).join(' ');
  if (failure) {
    return (
      <div className={`${cls} ${styles.unavailable}`} data-testid={TID.map} data-ready="false" role="status">
        The map can't be shown on this device. Voice and alerts still work.
      </div>
    );
  }
  return <div key={generation} ref={containerRef} className={cls} data-testid={TID.map} />;
}
