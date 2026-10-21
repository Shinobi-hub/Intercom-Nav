import path from 'node:path';
import { buildServer } from './app';
import { ConfigError, configWarnings, loadConfig, REPO_ROOT } from './config';

process.setSourceMapsEnabled(true);

// The repo-root .env is optional; real environment variables take precedence over it.
try {
  process.loadEnvFile(path.join(REPO_ROOT, '.env'));
} catch {
  /* no .env */
}

let config;
try {
  config = loadConfig(process.env);
} catch (err) {
  console.error(err instanceof ConfigError ? err.message : err);
  process.exit(1);
}

const server = buildServer(config);
const { app } = server;
const log = app.log;

for (const warning of configWarnings(config, process.env)) log.warn(warning);
log.info(
  {
    voice: config.voice.livekit ? `livekit (default ${config.voice.defaultMode}) + mesh` : 'mesh only',
    routing: config.routing.provider,
    geocoder: config.geocoder.provider,
    staticDir: config.staticDir ?? 'none (web app not built)',
  },
  'configuration',
);

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) {
    log.warn({ signal }, 'second signal, exiting immediately');
    process.exit(1);
  }
  shuttingDown = true;
  log.info({ signal }, 'shutting down');
  setTimeout(() => {
    log.error('graceful shutdown timed out');
    process.exit(1);
  }, 10_000).unref();
  try {
    await server.close();
    process.exit(0);
  } catch (err) {
    log.error({ err }, 'error during shutdown');
    process.exit(1);
  }
}

process.on('SIGINT', (s) => void shutdown(s));
process.on('SIGTERM', (s) => void shutdown(s));
process.on('unhandledRejection', (err) => {
  log.fatal({ err }, 'unhandled promise rejection');
  process.exit(1);
});

try {
  await app.listen({ port: config.port, host: config.host });
} catch (err) {
  log.fatal({ err }, 'could not start the server');
  process.exit(1);
}
