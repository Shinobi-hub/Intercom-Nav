import path from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/** Files that must be revalidated on every load, or clients would keep running an old build. */
const NO_CACHE_FILES = new Set(['index.html', 'sw.js', 'manifest.webmanifest', 'manifest.json']);

export function cacheControlFor(relativePath: string): string | null {
  const rel = relativePath.split(path.sep).join('/');
  if (NO_CACHE_FILES.has(rel)) return 'no-cache';
  // Vite content-hashes everything it emits into assets/.
  if (rel.startsWith('assets/')) return 'public, max-age=31536000, immutable';
  return null;
}

/** Browser navigations to client-side routes; API, socket and asset requests must 404 instead. */
export function wantsSpaFallback(req: Pick<FastifyRequest, 'method' | 'url' | 'headers'>): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const pathname = req.url.split('?')[0] ?? '';
  if (/^\/(api|socket\.io)(\/|$)/.test(pathname)) return false;
  return (req.headers.accept ?? '').includes('text/html');
}

/**
 * Serves the built web app with an SPA fallback, or explains that it isn't built.
 * Also owns the not-found handler, so it must be registered after the API routes.
 */
export function registerStatic(app: FastifyInstance, staticDir: string | null): void {
  if (staticDir) {
    app.register(fastifyStatic, {
      root: staticDir,
      wildcard: true,
      setHeaders: (reply: FastifyReply, filePath: string) => {
        const value = cacheControlFor(path.relative(staticDir, filePath));
        if (value) reply.header('cache-control', value);
      },
    });
  }

  app.setNotFoundHandler((req, reply) => {
    if (wantsSpaFallback(req)) {
      if (staticDir) return reply.header('cache-control', 'no-cache').sendFile('index.html');
      return reply
        .code(404)
        .type('text/plain; charset=utf-8')
        .send('Intercom Nav ride server is running, but the web app is not built (npm run build -w @intercom/web).');
    }
    return reply.code(404).send({ ok: false, error: 'not_found', message: `${req.method} ${req.url.split('?')[0]} not found` });
  });
}
