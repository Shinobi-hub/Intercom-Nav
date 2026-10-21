// Test helpers for code that takes an injectable fetch.
import { readFileSync } from 'node:fs';
import type { FetchFn } from '../../src/geo/fetchJson';

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  signal: AbortSignal | null;
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** A fetch stand-in that records every request and answers with `respond`. */
export function fakeFetch(respond: (req: RecordedRequest) => Response | Promise<Response>) {
  const requests: RecordedRequest[] = [];
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const req: RecordedRequest = {
      url: String(input),
      method: init.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      signal: init.signal ?? null,
    };
    requests.push(req);
    return respond(req);
  }) as FetchFn;
  return { fetch, requests };
}

/** A fetch that only settles when its signal aborts, to exercise timeouts. */
export const hangingFetch: FetchFn = (_input, init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
  });

export function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));
}
