import type { Server as HttpServer } from 'node:http';
import {
  SOCKET_PATH,
  type ClientToServerEvents,
  type RideCode,
  type RiderId,
  type ServerToClientEvents,
} from '@intercom/shared';
import { Server, type Socket } from 'socket.io';
import type { OriginPolicy } from '../net/originPolicy';

export interface SocketData {
  /** Set while the socket speaks for a rider in a ride. */
  code?: RideCode;
  riderId?: RiderId;
  /** Client address used for join rate limiting. */
  ip: string;
}

type InterServerEvents = Record<string, never>;
export type IoServer = Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;
export type IoSocket = Socket<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;

export interface SocketServerOptions {
  originPolicy: OriginPolicy;
  /** Behind trusted proxies the public host arrives in X-Forwarded-Host. */
  trustProxyHops: number;
}

/** Socket.io on the app's HTTP server, accepting only same-origin or allow-listed browser pages. */
export function createSocketServer(httpServer: HttpServer, opts: SocketServerOptions): IoServer {
  const publicHost = (headers: Record<string, string | string[] | undefined>): string | undefined => {
    const forwarded = opts.trustProxyHops > 0 ? headers['x-forwarded-host'] : undefined;
    const value = forwarded ?? headers.host;
    return (Array.isArray(value) ? value[0] : value)?.split(',')[0]?.trim();
  };

  return new Server(httpServer, {
    path: SOCKET_PATH,
    serveClient: false,
    pingInterval: 10_000,
    pingTimeout: 10_000,
    maxHttpBufferSize: 100_000,
    // Browsers don't apply CORS to WebSockets, so the Origin check happens here for every transport.
    allowRequest: (req, callback) => {
      callback(null, opts.originPolicy.allowsRequest(req.headers.origin, publicHost(req.headers)));
    },
    // Only adds CORS headers to cross-origin long-polling responses.
    cors: (req, callback) => {
      const origin = req.headers.origin;
      callback(null, { origin: origin !== undefined && opts.originPolicy.allowsCrossOrigin(origin) });
    },
  });
}
