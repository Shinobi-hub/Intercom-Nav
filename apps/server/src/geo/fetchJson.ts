export const USER_AGENT = 'IntercomNav/0.1';

export type FetchFn = typeof fetch;

/**
 * A routing / geocoding provider failed. Messages never include request URLs or bodies, which
 * carry riders' coordinates.
 */
export class ProviderError extends Error {
  override name = 'ProviderError';
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface JsonRequest {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
}

export async function fetchJson(fetchFn: FetchFn, url: string, req: JsonRequest): Promise<unknown> {
  const headers: Record<string, string> = { 'user-agent': USER_AGENT, accept: 'application/json', ...req.headers };
  if (req.body !== undefined) headers['content-type'] = 'application/json';
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: req.method ?? 'GET',
      headers,
      body: req.body === undefined ? undefined : JSON.stringify(req.body),
      signal: AbortSignal.timeout(req.timeoutMs),
    });
  } catch (err) {
    throw new ProviderError(isTimeout(err) ? `timed out after ${req.timeoutMs} ms` : 'request failed');
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new ProviderError(`HTTP ${res.status}`, res.status);
  }
  try {
    return await res.json();
  } catch (err) {
    throw new ProviderError(isTimeout(err) ? `timed out after ${req.timeoutMs} ms` : 'invalid JSON response');
  }
}

function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
}
