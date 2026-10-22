/**
 * Existence and incident-copy helpers shared by the manager's stores. A store
 * file is absent only when lstat answers ENOENT; any other error (a permission
 * or antivirus lock, a disk error, a non-file at the path) means the store is
 * broken: it may hold data, so nothing may be written over it.
 */

import * as fs from 'fs';
import * as path from 'path';

export type StoreFileState =
  | { kind: 'absent' }
  | { kind: 'present' }
  | { kind: 'broken'; error: string };

export function storeFileState(filePath: string): StoreFileState {
  try {
    const st = fs.lstatSync(filePath);
    if (!st.isFile()) return { kind: 'broken', error: `${path.basename(filePath)} is not a regular file` };
    return { kind: 'present' };
  } catch (error: any) {
    if (error?.code === 'ENOENT') return { kind: 'absent' };
    return { kind: 'broken', error: `${path.basename(filePath)} cannot be checked (${error?.code || error?.message || error})` };
  }
}

const COPY_INFIX = '.corrupt-';

/** The incident copies kept beside a store, oldest first (basenames). */
export function listCorruptCopies(filePath: string): string[] {
  const base = path.basename(filePath) + COPY_INFIX;
  try {
    return fs.readdirSync(path.dirname(filePath)).filter(n => n.startsWith(base)).sort();
  } catch {
    return [];
  }
}

const lastIncidentCopy = new Map<string, string | null>();

/**
 * Keep a timestamped copy of a damaged store, one per incident: a copy is
 * skipped only when the newest existing one holds the same bytes, so loads
 * that run continuously do not pile up duplicates, and an earlier incident's
 * copy is never replaced or removed. Returns the copy's basename, the existing
 * identical copy's basename, or null when the bytes could not be copied.
 */
export function preserveCorruptCopy(filePath: string): string | null {
  const copy = takeCorruptCopy(filePath);
  lastIncidentCopy.set(path.resolve(filePath), copy);
  return copy;
}

function takeCorruptCopy(filePath: string): string | null {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(filePath);
  } catch {
    return null;
  }
  const copies = listCorruptCopies(filePath);
  const newest = copies[copies.length - 1];
  if (newest) {
    try {
      if (fs.readFileSync(path.join(path.dirname(filePath), newest)).equals(bytes)) return newest;
    } catch { /* unreadable copy: take a fresh one */ }
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let name = path.basename(filePath) + COPY_INFIX + stamp;
  for (let n = 1; copies.includes(name) || fs.existsSync(path.join(path.dirname(filePath), name)); n++) {
    name = `${path.basename(filePath)}${COPY_INFIX}${stamp}-${n}`;
  }
  try {
    fs.writeFileSync(path.join(path.dirname(filePath), name), bytes, { flag: 'wx', mode: 0o600 });
    return name;
  } catch {
    return null;
  }
}

/**
 * Sentence fragment naming where the damaged bytes are, true to what happened:
 * only the copy the latest failing load of this file produced is named, never
 * an earlier incident's copy of other bytes.
 */
export function corruptCopyNote(filePath: string): string {
  const copy = lastIncidentCopy.get(path.resolve(filePath));
  if (!copy) return `no copy of the current ${path.basename(filePath)} could be kept`;
  return `the damaged bytes are kept beside it as ${copy}`;
}

/** Atomic write: temp file, then rename over the target. */
export function writeFileAtomic(filePath: string, data: string, mode?: number): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, data, mode === undefined ? undefined : { mode });
  fs.renameSync(tmp, filePath);
}

/**
 * Replace a file whole (tmp plus rename) and keep the replaced file's owner,
 * so a root manager never takes a file away from the account that reads it.
 * The tmp file gets the owner and mode before the rename, so no moment leaves
 * the target root-owned. A symlinked path is written through to its target.
 * mode is the result's mode; omitted, the old file's mode carries over.
 */
export function writeFileKeepingOwner(filePath: string, data: string, mode?: number): void {
  let target = filePath;
  let before: fs.Stats | null = null;
  try {
    const link = fs.lstatSync(filePath);
    if (link.isSymbolicLink()) target = fs.realpathSync(filePath);
    before = link.isSymbolicLink() ? fs.statSync(target) : link;
  } catch { /* a new file keeps the default owner */ }
  const finalMode = mode ?? (before ? before.mode & 0o7777 : undefined);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, data, finalMode === undefined ? undefined : { mode: finalMode });
  if (before) {
    try {
      fs.chownSync(tmp, before.uid, before.gid);
    } catch (err) {
      console.warn(`[Files] Could not keep the owner ${before.uid}:${before.gid} of ${target}: ${err}`);
    }
  }
  if (finalMode !== undefined) {
    try {
      fs.chmodSync(tmp, finalMode);
    } catch (err) {
      console.warn(`[Files] Could not set mode ${finalMode.toString(8)} on ${target}: ${err}`);
    }
  }
  fs.renameSync(tmp, target);
}
