import * as fs from 'fs';
import { getDeploymentMode } from '../casaos/detector';

export const PRIVATE_FILE_MODE = 0o600;
export const PRIVATE_DIR_MODE = 0o700;

/**
 * Write a file only the manager's user can read. The mode option applies only
 * when the file is created, so a file already there is tightened as well.
 */
export function writePrivateFile(filePath: string, data: string): void {
  fs.writeFileSync(filePath, data, { mode: PRIVATE_FILE_MODE });
  try {
    fs.chmodSync(filePath, PRIVATE_FILE_MODE);
  } catch (err) {
    console.warn(`[Files] Could not restrict ${filePath} to mode 600: ${err}`);
  }
}

/** mkdir -p whose created levels and target are private to the manager's user. */
export function ensurePrivateDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true, mode: PRIVATE_DIR_MODE });
  try {
    fs.chmodSync(dirPath, PRIVATE_DIR_MODE);
  } catch (err) {
    console.warn(`[Files] Could not restrict ${dirPath} to mode 700: ${err}`);
  }
}

/**
 * The boot warning for a data root other local accounts can enter, or null.
 * A Windows host path carries no POSIX mode (Docker Desktop reports 777 for
 * every bind), so it is never warned about.
 */
export function dataRootModeWarning(
  dataDir: string,
  mode: number,
  hostDataDir: string | undefined,
  platform: NodeJS.Platform,
): string | null {
  if (platform === 'win32') return null;
  if (hostDataDir && /^[A-Za-z]:[\\/]/.test(hostDataDir)) return null;
  if ((mode & 0o077) === 0) return null;
  const shown = hostDataDir || dataDir;
  return `[Init] Warning: the data directory ${shown} can be read by other local accounts on this host (mode ${(mode & 0o777).toString(8)}). It holds bot tokens, composes and database dumps. Restrict it on the host with: chmod 700 ${shown}`;
}

/**
 * Boot check of the data root. Under CasaOS the platform owns the AppData tree
 * and its modes, so only the manager's own data root is checked.
 */
export async function warnOnOpenDataRoot(
  dataDir = process.env.DATA_DIR || '/data/data',
  hostDataDir = process.env.HOST_DATA_DIR,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (await getDeploymentMode() === 'casaos') return;
  try {
    const warning = dataRootModeWarning(dataDir, fs.statSync(dataDir).mode, hostDataDir, platform);
    if (warning) console.warn(warning);
  } catch (err: any) {
    console.warn(`[Init] Could not check the data directory's mode: ${err?.message || err}`);
  }
}
