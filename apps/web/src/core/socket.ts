import type { ClientToServerEvents, ServerToClientEvents } from '@intercom/shared';
import { SOCKET_PATH } from '@intercom/shared';
import { io, type Socket } from 'socket.io-client';
import { SERVER_URL } from './config';

export type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export function createAppSocket(url: string = SERVER_URL): AppSocket {
  return io(url, {
    path: SOCKET_PATH,
    // WebSocket first; long-polling only as a fallback for hostile networks.
    transports: ['websocket', 'polling'],
    autoConnect: false,
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 5_000,
    randomizationFactor: 0.3,
    timeout: 10_000,
  });
}
