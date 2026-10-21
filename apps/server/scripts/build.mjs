// Bundles the server into dist/index.js. Workspace packages (@intercom/shared ships TypeScript
// source) are bundled in; real npm dependencies stay external and load from node_modules.
import { readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const external = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies })
  .filter((name) => !name.startsWith('@intercom/'))
  .flatMap((name) => [name, `${name}/*`]);

rmSync(new URL('../dist', import.meta.url), { recursive: true, force: true });

await build({
  absWorkingDir: root,
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  external,
  logLevel: 'info',
});
