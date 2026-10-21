import type { Unsubscribe } from '../../core/services';

export interface Emitter<A extends unknown[]> {
  on(cb: (...args: A) => void): Unsubscribe;
  emit(...args: A): void;
  readonly size: number;
}

/**
 * Minimal listener set. Each subscription is its own entry, so subscribing the same function twice
 * needs two unsubscribes, and a throwing listener never stops the others.
 */
export function createEmitter<A extends unknown[] = []>(label = 'platform'): Emitter<A> {
  const entries = new Set<{ cb: (...args: A) => void }>();
  return {
    on(cb) {
      const entry = { cb };
      entries.add(entry);
      return () => {
        entries.delete(entry);
      };
    },
    emit(...args) {
      for (const entry of [...entries]) {
        try {
          entry.cb(...args);
        } catch (err) {
          console.error(`[${label}] listener failed`, err);
        }
      }
    },
    get size() {
      return entries.size;
    },
  };
}
