import { Ellipsis } from 'lucide-react';
import { useCallback } from 'react';
import { TID } from '../../../core/testIds';
import { tapFeedback } from '../../../ui/feedback';
import { setMenuOpen, useRideUi } from '../rideUi';
import { BreakButton } from './BreakButton';
import styles from './dock.module.css';
import { DockKey } from './DockKey';
import { MicButton } from './MicButton';
import { MoreMenu } from './MoreMenu';
import { MusicButton } from './MusicButton';
import { SosButton } from './SosButton';

/** The control strip: bottom edge in portrait, right edge in landscape. */
export function Dock() {
  const menuOpen = useRideUi((s) => s.menuOpen);
  const closeMenu = useCallback(() => setMenuOpen(false), []);

  return (
    <nav className={styles.dock} aria-label="Ride controls">
      <MicButton />
      <MusicButton />
      <BreakButton />
      <SosButton />
      <DockKey
        tone="neutral"
        lit={menuOpen}
        className={styles.more}
        glyph={<Ellipsis />}
        caption="MORE"
        aria-label="More: route, riders, music, settings, share"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        data-testid={TID.dockMore}
        onClick={() => {
          tapFeedback();
          setMenuOpen(!menuOpen);
        }}
      />
      {menuOpen && <MoreMenu onClose={closeMenu} />}
    </nav>
  );
}
