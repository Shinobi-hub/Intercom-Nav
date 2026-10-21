import { useCallback } from 'react';
import type { SheetId } from '../../core/store';
import { useLocalStore } from '../../core/store';
import { MusicPanel } from '../../features/audio';
import { DestinationPanel } from '../../features/route';
import { Sheet } from '../../ui/Sheet';
import { BreakSheet } from './BreakSheet';
import { RidersSheet } from './RidersSheet';
import { SettingsSheet } from './SettingsSheet';
import { ShareSheet } from './ShareSheet';

const TITLES: Record<SheetId, string> = {
  music: 'Music',
  route: 'Route',
  riders: 'Riders',
  settings: 'Settings',
  share: 'Share ride',
  break: 'Ask for a stop',
};

/** Renders whichever sheet useLocalStore.ui.sheet names. */
export function SheetHost() {
  const sheet = useLocalStore((s) => s.ui.sheet);
  const close = useCallback(() => useLocalStore.getState().openSheet(null), []);
  if (!sheet) return null;
  return (
    <Sheet id={sheet} title={TITLES[sheet]} onClose={close}>
      <SheetContent id={sheet} onDone={close} />
    </Sheet>
  );
}

function SheetContent({ id, onDone }: { id: SheetId; onDone: () => void }) {
  switch (id) {
    case 'music':
      return <MusicPanel onDone={onDone} />;
    case 'route':
      return <DestinationPanel onDone={onDone} />;
    case 'riders':
      return <RidersSheet />;
    case 'settings':
      return <SettingsSheet />;
    case 'share':
      return <ShareSheet />;
    case 'break':
      return <BreakSheet onDone={onDone} />;
  }
}
