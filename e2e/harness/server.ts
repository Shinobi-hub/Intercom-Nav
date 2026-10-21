/** Static server for the harness page plus a LiveKit token minter (HS256 JWT, no SDK needed). */
import { createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIVEKIT_API_KEY, LIVEKIT_API_SECRET, REPO_ROOT } from '../helpers/env';

const HARNESS_DIR = dirname(fileURLToPath(import.meta.url));
export const LIVEKIT_UMD = join(REPO_ROOT, 'node_modules', 'livekit-client', 'dist', 'livekit-client.umd.js');

const FILES: Record<string, { path: string; type: string }> = {
  '/': { path: join(HARNESS_DIR, 'smoke.html'), type: 'text/html; charset=utf-8' },
  '/vendor/livekit-client.umd.js': { path: LIVEKIT_UMD, type: 'text/javascript; charset=utf-8' },
};

export interface HarnessServer {
  url: string;
  close(): Promise<void>;
}

/** Serves the harness page on 127.0.0.1 (a secure context for getUserMedia) on a free port. */
export async function startHarnessServer(): Promise<HarnessServer> {
  const server = createServer((req, res) => {
    const file = FILES[new URL(req.url ?? '/', 'http://x').pathname];
    if (!file || !existsSync(file.path)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': file.type, 'cache-control': 'no-store' }).end(readFileSync(file.path));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const b64url = (data: string | Buffer) => Buffer.from(data).toString('base64url');

/** LiveKit access token: may join `room`, publish microphone audio and data, subscribe. */
export function livekitToken(identity: string, room: string, ttlS = 600): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(
    JSON.stringify({
      iss: LIVEKIT_API_KEY,
      sub: identity,
      name: identity,
      nbf: now - 10,
      exp: now + ttlS,
      video: { room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true },
    }),
  );
  const signature = b64url(createHmac('sha256', LIVEKIT_API_SECRET).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${signature}`;
}
