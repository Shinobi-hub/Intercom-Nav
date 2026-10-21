import { useRoute } from '../core/router';
import { useLocalStore, useRideStore } from '../core/store';
import { ResumeAudioOverlay, SosOverlay, Toasts } from '../features/alerts';
import { RideScreen } from './ride/RideScreen';
import { HomeScreen } from './start/HomeScreen';
import { JoinScreen } from './start/JoinScreen';
import { SessionReplacedScreen } from './start/SessionReplacedScreen';

/**
 * "/" is home. "/r/:code" is the ride screen when this device is in that ride, otherwise the
 * join screen for that code. Alerts render at this level so an SOS reaches the rider on any screen.
 */
export function App() {
  const route = useRoute();
  const rideCode = useRideStore((s) => s.ride?.code ?? null);
  const sessionReplaced = useLocalStore((s) => s.ui.sessionReplaced);

  let screen;
  if (route.name !== 'ride') screen = <HomeScreen />;
  else if (rideCode === route.code) screen = <RideScreen key={route.code} code={route.code} />;
  else screen = <JoinScreen key={route.code} code={route.code} />;

  return (
    <>
      {screen}
      <Toasts />
      <ResumeAudioOverlay />
      <SosOverlay />
      {sessionReplaced && <SessionReplacedScreen />}
    </>
  );
}
