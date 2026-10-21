// Integration-test harness: an in-process server on a random port, a controllable clock and
// real socket.io-client connections.
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import {
  randomSecret,
  type ClientToServerEvents,
  type JoinResult,
  type RiderAuth,
  type ServerToClientEvents,
} from '@intercom/shared';
import { io as connectClient, type ManagerOptions, type Socket, type SocketOptions } from 'socket.io-client';
import { buildServer, type RideServer, type ServerDeps } from '../../src/app';
import { loadConfig } from '../../src/config';

export type ClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/** The value each acked event's callback receives. */
export type AckResults = {
  [K in keyof ClientToServerEvents]: Parameters<ClientToServerEvents[K]> extends [unknown, (r: infer R) => void] ? R : never;
};
type ServerEvent = keyof ServerToClientEvents;
export type EventArg<E extends ServerEvent> = Parameters<ServerToClientEvents[E]>[0];

export class FakeClock {
  t = Date.UTC(2026, 9, 19, 8, 0, 0);
  readonly now = () => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
}

export interface TestServer {
  server: RideServer;
  url: string;
  port: number;
  clock: FakeClock;
  connect(opts?: Partial<ManagerOptions & SocketOptions>): Promise<ClientSocket>;
  close(): Promise<void>;
}

const servers = new Set<TestServer>();

/** Mock routing + geocoding, silent logs and no web app unless `env` says otherwise. */
export async function startServer(env: Record<string, string> = {}, deps: ServerDeps = {}): Promise<TestServer> {
  const clock = new FakeClock();
  const config = loadConfig({
    LOG_LEVEL: 'silent',
    ROUTING_PROVIDER: 'mock',
    GEOCODER: 'mock',
    STATIC_DIR: '/nonexistent/intercom-test-static',
    ...env,
  });
  const server = buildServer(config, { now: clock.now, ...deps });
  await server.app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = server.app.server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  const sockets = new Set<ClientSocket>();

  const t: TestServer = {
    server,
    url,
    port,
    clock,
    async connect(opts = {}) {
      const socket: ClientSocket = connectClient(url, {
        path: '/socket.io',
        transports: ['websocket'],
        forceNew: true,
        reconnection: false,
        ...opts,
      });
      sockets.add(socket);
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', () => resolve());
        socket.once('connect_error', reject);
      });
      return socket;
    },
    async close() {
      servers.delete(t);
      for (const s of sockets) s.disconnect();
      await server.close();
    },
  };
  servers.add(t);
  return t;
}

/** Closes every server a test file started (use in afterEach). */
export async function closeAllServers(): Promise<void> {
  await Promise.all([...servers].map((s) => s.close()));
}

/** Emits an acked event and resolves with the ack. */
export function call<E extends keyof AckResults>(socket: ClientSocket, event: E, payload?: unknown): Promise<AckResults[E]> {
  const s = socket.timeout(5_000) as unknown as { emitWithAck(ev: string, ...args: unknown[]): Promise<unknown> };
  return (payload === undefined ? s.emitWithAck(event) : s.emitWithAck(event, payload)) as Promise<AckResults[E]>;
}

/** Narrows a Result to its ok branch, failing the test with the error otherwise. */
export function ok<T>(result: T): Extract<T, { ok: true }> {
  const r = result as { ok?: boolean };
  if (r.ok !== true) throw new Error(`expected ok, got ${JSON.stringify(result)}`);
  return result as Extract<T, { ok: true }>;
}

/** Raw emit, bypassing typings, for malformed input. */
export function emitRaw(socket: ClientSocket, event: string, ...args: unknown[]): void {
  (socket as unknown as { emit(ev: string, ...a: unknown[]): void }).emit(event, ...args);
}

export function nextEvent<E extends ServerEvent>(socket: ClientSocket, event: E, timeoutMs = 3_000): Promise<EventArg<E>> {
  return new Promise((resolve, reject) => {
    const listener = (arg: EventArg<E>) => {
      clearTimeout(timer);
      resolve(arg);
    };
    const timer = setTimeout(() => {
      (socket as unknown as { off(ev: string, fn: unknown): void }).off(event, listener);
      reject(new Error(`timed out waiting for ${event}`));
    }, timeoutMs);
    (socket as unknown as { once(ev: string, fn: unknown): void }).once(event, listener);
  });
}

/** Records every server event a socket receives. */
export function record(socket: ClientSocket) {
  const events: { event: string; arg: unknown }[] = [];
  socket.onAny((event: string, arg: unknown) => events.push({ event, arg }));
  return {
    events,
    of<E extends ServerEvent>(event: E): EventArg<E>[] {
      return events.filter((e) => e.event === event).map((e) => e.arg as EventArg<E>);
    },
    names: () => events.map((e) => e.event),
    clear: () => void events.splice(0),
  };
}

/**
 * Ordering barrier. A socket's packets are handled in order and replies on one connection arrive
 * in order, so once each socket has round-tripped a `time:sync`, everything the server emitted to
 * it before has arrived. Call with the acting socket first, then the observers.
 */
export async function flush(...sockets: ClientSocket[]): Promise<void> {
  for (const s of sockets) await call(s, 'time:sync', { t0: 0 });
}

export function newRider(name = 'Rider', color = '#0A84FF'): RiderAuth {
  return { id: randomUUID(), secret: randomSecret(), name, color };
}

export interface Member {
  socket: ClientSocket;
  auth: RiderAuth;
  join: JoinResult;
}

export async function createRide(t: TestServer, name = 'Leader', extra: Record<string, unknown> = {}): Promise<Member> {
  const socket = await t.connect();
  const auth = newRider(name);
  const join = ok(await call(socket, 'ride:create', { rider: auth, ...extra }));
  return { socket, auth, join };
}

export async function joinRide(t: TestServer, code: string, name = 'Rider', auth = newRider(name)): Promise<Member> {
  const socket = await t.connect();
  const join = ok(await call(socket, 'ride:join', { code, rider: auth }));
  return { socket, auth, join };
}

/** Leader plus `n` riders in one ride. */
export async function rideWith(t: TestServer, n: number): Promise<{ code: string; leader: Member; riders: Member[] }> {
  const leader = await createRide(t);
  const code = leader.join.snapshot.code;
  const riders: Member[] = [];
  for (let i = 0; i < n; i++) riders.push(await joinRide(t, code, `Rider ${i + 1}`));
  // Let the join broadcasts land, so tests start from a quiet state.
  await flush(leader.socket, ...riders.map((r) => r.socket));
  return { code, leader, riders };
}

export function fix(t: number, lat = 18.5204, lng = 73.8567) {
  return { lat, lng, acc: 5, spd: 12, hdg: 45, alt: 560, t };
}

export function waitForDisconnect(socket: ClientSocket, timeoutMs = 3_000): Promise<string> {
  return new Promise((resolve, reject) => {
    if (socket.disconnected) return resolve('already disconnected');
    const timer = setTimeout(() => reject(new Error('socket stayed connected')), timeoutMs);
    socket.once('disconnect', (reason) => {
      clearTimeout(timer);
      resolve(reason);
    });
  });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
