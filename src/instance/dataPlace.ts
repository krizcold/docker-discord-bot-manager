import * as envManager from '../env/manager';
import { findAppCapabilities } from '../config/appCapabilities';
import { InstanceConfig } from '../types';

export type DataPlace = 'json' | 'outside' | null;

export function postgresBackend(inst: InstanceConfig, env: Record<string, string>): boolean {
  const companion = findAppCapabilities(inst.sourceUrl)?.companionDb;
  if (!companion) return false;
  const mode = companion.env.mode;
  return mode ? (env[mode.key] || '').trim().toLowerCase() === mode.value : true;
}

/** Where a bot with no managed database keeps its data, read as maintenanceKind reads the backend; null when the env store cannot be read. */
export function dataPlace(inst: InstanceConfig): DataPlace {
  const key = findAppCapabilities(inst.sourceUrl)?.companionDb?.env.mode?.key ?? 'DATA_BACKEND';
  let stored: { vars: Record<string, string>; undecryptable: string[]; corrupt: boolean };
  try { stored = envManager.getEnvVarsWithStatus(inst.id); } catch { return null; }
  if (stored.corrupt || stored.undecryptable.includes(key)) return null;
  return postgresBackend(inst, { ...(inst.envVars ?? {}), ...stored.vars }) ? 'outside' : 'json';
}
