/**
 * Auto-Update Scheduler (Legacy Redirect)
 * Now delegates to source/sourceUpdater.ts
 */

export { startSourceUpdater as startAutoUpdater, stopSourceUpdater as stopAutoUpdater } from './source/sourceUpdater';
