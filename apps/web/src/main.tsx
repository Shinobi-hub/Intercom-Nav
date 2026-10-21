import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import './styles/global.css';
import { App } from './app/App';
import { DEMO_MODE } from './core/config';
import { installDebugGlobal } from './core/debug';
import { createRideController } from './core/rideController';
import { setServices } from './core/services';
import { createAppSocket } from './core/socket';
import { createDemoController } from './dev/demo';
import { createAudioEngine } from './features/audio';
import { createLocationService } from './features/geo';
import { createVoiceManager } from './features/voice';
import { createPlatform } from './platform';

// Composition root: every service is created once, here, and shared through the registry.
const platform = createPlatform();
const socket = createAppSocket();
const audio = createAudioEngine({ platform });
const voice = createVoiceManager({ socket, audio });
const location = createLocationService({ geo: platform.geo });
const controller = DEMO_MODE
  ? createDemoController({ audio, platform })
  : createRideController({ socket, audio, voice, location, platform });
setServices({ platform, socket, audio, voice, location, controller });
installDebugGlobal();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
