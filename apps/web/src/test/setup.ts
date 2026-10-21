/**
 * Vitest setup for apps/web.
 *
 * Node 22+ ships an experimental global `localStorage` that is unusable unless Node is started with
 * --localstorage-file, and it shadows jsdom's, so `window.localStorage` comes back undefined.
 * Install a plain in-memory Storage whenever the real one doesn't work.
 */
class MemoryStorage implements Storage {
  private data = new Map<string, string>();
  get length(): number {
    return this.data.size;
  }
  clear(): void {
    this.data.clear();
  }
  getItem(key: string): string | null {
    return this.data.has(key) ? this.data.get(key)! : null;
  }
  key(index: number): string | null {
    return [...this.data.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
  setItem(key: string, value: string): void {
    this.data.set(key, String(value));
  }
}

function usable(storage: Storage | undefined): boolean {
  try {
    if (!storage) return false;
    storage.setItem('__probe__', '1');
    storage.removeItem('__probe__');
    return true;
  } catch {
    return false;
  }
}

for (const name of ['localStorage', 'sessionStorage'] as const) {
  let current: Storage | undefined;
  try {
    current = globalThis[name];
  } catch {
    current = undefined;
  }
  if (usable(current)) continue;
  const memory = new MemoryStorage();
  Object.defineProperty(globalThis, name, { value: memory, configurable: true, writable: true });
  if (typeof window !== 'undefined' && window !== (globalThis as unknown)) {
    Object.defineProperty(window, name, { value: memory, configurable: true, writable: true });
  }
}
