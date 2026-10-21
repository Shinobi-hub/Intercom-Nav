/**
 * The Vite dev server for E2E runs: the app's own config with HMR and file watching off, so a file
 * saved during a run can't hot-reload a rider's page mid-test (which wipes its ride state).
 * Restart the run to pick up code changes.
 */
import { mergeConfig } from 'vite';
import appConfig from '../apps/web/vite.config';

export default mergeConfig(appConfig, { server: { hmr: false, watch: null } });
