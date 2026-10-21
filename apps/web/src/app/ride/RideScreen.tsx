import type { RiderId } from '@intercom/shared';
import { formatRideCode } from '@intercom/shared';
import { useEffect } from 'react';
import { useLocalStore } from '../../core/store';
import { TID } from '../../core/testIds';
import { SosActiveBanner, SosBanner } from '../../features/alerts';
import { MapControls, MapView } from '../../features/map';
import { RouteSummary } from '../../features/route';
import { SheetHost } from '../sheets/SheetHost';
import { Dock } from './dock/Dock';
import styles from './ride.module.css';
import { useRideUi } from './rideUi';
import { TalkingStrip } from './TalkingStrip';
import { TopBar } from './TopBar';

function showRider(riderId: RiderId) {
  useRideUi.setState({ highlightRider: riderId });
  useLocalStore.getState().openSheet('riders');
}

/** Full-bleed map with the instrument chrome around it. */
export function RideScreen({ code }: { code: string }) {
  useEffect(() => {
    const previous = document.title;
    document.title = `Ride ${formatRideCode(code)} · Intercom Nav`;
    return () => {
      document.title = previous;
    };
  }, [code]);

  return (
    <main className={styles.screen} data-testid={TID.rideScreen} data-code={code}>
      <MapView className={styles.map} onRiderSelect={showRider} />
      <TopBar code={code} />
      <div className={styles.stack}>
        <SosActiveBanner />
        <SosBanner />
        <div className={styles.route}>
          <RouteSummary />
        </div>
      </div>
      <div className={styles.bottomLeft}>
        <TalkingStrip />
      </div>
      <div className={styles.mapControls}>
        <MapControls />
      </div>
      <Dock />
      <SheetHost />
    </main>
  );
}
