/**
 * Per-bot Console + Files backend.
 *
 * Interactive terminal: spawns `docker exec -it <container> <shell>` via the docker
 * CLI and bridges its stdio to the browser over the existing /ws WebSocket
 * (multiplexed as terminal:* messages). Using the CLI (not the raw Engine socket)
 * keeps it cross-platform - it works on the Windows Docker Desktop named pipe too.
 *
 * File operations: against the bot's running container they run scoped `docker exec`
 * commands (argv arrays, never a shell string, so paths cannot inject). The
 * "persistent data (host)" scope operates on the bot's data dir with Node fs, which
 * the manager has mounted either way: /DATA/AppData/<app> in CasaOS mode, its own
 * data dir in plain docker mode.
 *
 * Everything is scoped per bot: the target container is validated to belong to the
 * bot's compose project, and host-folder access is jailed to that bot's data dir.
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { WebSocket } from 'ws';
import { getBot } from '../docker/containerManager';
import { getDataPath } from '../git/repoManager';
import { getDeploymentMode } from '../casaos/detector';
import { grantToApp, grantFd } from '../templates/pcsProcessing';

const DATA_ROOT = process.env.DATA_ROOT || '/DATA';

const MAX_FILE_BYTES = 1024 * 1024;        // 1 MB read/edit cap
const EXEC_TIMEOUT_MS = 15000;

// ─── Container resolution / validation ──────────────────────────────────────

function spawnCapture(
  cmd: string,
  args: string[],
  opts: { input?: Buffer; timeoutMs?: number } = {}
): Promise<{ stdout: Buffer; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { windowsHide: true });
    const out: Buffer[] = [];
    let err = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, opts.timeoutMs || EXEC_TIMEOUT_MS);
    child.stdout.on('data', (d) => out.push(d as Buffer));
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', () => { clearTimeout(timer); resolve({ stdout: Buffer.concat(out), stderr: err || 'spawn failed', code: 1 }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ stdout: Buffer.concat(out), stderr: err, code: code == null ? 1 : code }); });
    if (opts.input) { child.stdin.write(opts.input); }
    child.stdin.end();
  });
}

export interface BotContainer { name: string; state: string }

export async function getBotContainers(appName: string): Promise<BotContainer[]> {
  const { stdout } = await spawnCapture('docker', [
    'ps', '-a',
    '--filter', `label=com.docker.compose.project=${appName}`,
    '--format', '{{.Names}}\t{{.State}}',
  ]);
  return stdout.toString('utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => { const [name, state] = l.split('\t'); return { name, state: state || 'unknown' }; });
}

// ─── Filesystem scope resolution ────────────────────────────────────────────

type FsTarget =
  | { kind: 'container'; container: string; base: string; jail: boolean }
  | { kind: 'local'; base: string; jail: boolean };

type ContainerTarget = Extract<FsTarget, { kind: 'container' }>;

/**
 * Resolve where file/exec ops run.
 * target === 'host' -> the bot's persistent data, read and written locally:
 * /DATA/AppData/<app> in CasaOS mode, the bot's own data dir in docker mode. Both
 * are mounted into the manager, so neither needs a platform container to reach.
 * Otherwise target is a container name validated to belong to the bot.
 */
async function resolveTarget(botId: string, target: string): Promise<FsTarget | { error: string }> {
  const bot = getBot(botId);
  if (!bot) return { error: 'Bot not found' };
  const appName = bot.sanitizedName;

  if (target === 'host') {
    const mode = await getDeploymentMode();
    const base = mode === 'casaos' ? `${DATA_ROOT}/AppData/${appName}` : getDataPath(botId);
    // The dev rig's DATA_DIR may be relative and in the platform separator;
    // everything below compares absolute posix strings.
    return { kind: 'local', base: toPosix(path.resolve(base)), jail: true };
  }

  const containers = await getBotContainers(appName);
  if (!containers.some((c) => c.name === target)) {
    return { error: 'Container does not belong to this bot' };
  }
  return { kind: 'container', container: target, base: '/', jail: false };
}

const MAX_SYMLINK_HOPS = 40;

// Paths are compared with forward slashes throughout. resolveAbs builds with
// path.posix while realpathSync answers in the platform separator, so on Windows
// the two would never match and every in-scope path would be refused. Node
// accepts forward slashes on Windows, so normalising is enough there. ONLY
// there: on Linux a backslash is an ordinary filename character, and rewriting
// it would split a single entry the bot named `logs\archive` into two components
// the walk never finds, while the kernel still sees the one symlink.
const toPosix = process.platform === 'win32'
  ? (p: string) => p.replace(/\\/g, '/')
  : (p: string) => p;

function pathInside(realBase: string, p: string): boolean {
  const a = toPosix(realBase);
  const b = toPosix(p);
  return b === a || b.startsWith(a + '/');
}

/**
 * Where an OPEN fd actually points. This is the only race-free answer: the fd
 * pins the inode, so a component swapped after the path check cannot redirect
 * it. /proc is Linux-only, which is where the manager runs; the native Windows
 * dev rig falls back to resolving the path again, which is best effort.
 */
function fdRealPath(fd: number, fallback: string): string | null {
  try { return fs.readlinkSync(`/proc/self/fd/${fd}`); } catch { /* not Linux */ }
  try { return fs.realpathSync(fallback); } catch { return null; }
}

/**
 * The scope root as a resolved string, or null when its parent does not exist.
 * Resolved from the PARENT plus the leaf name, never from the base entry itself:
 * in docker mode the bot can own that entry, and a base that is a symlink would
 * otherwise move the whole jail to wherever the link points. The parent is the
 * manager's own directory, which the bot cannot rename or replace.
 */
function resolvedBase(base: string): string | null {
  const root = base.replace(/\/+$/, '');
  try {
    const parent = toPosix(fs.realpathSync(path.posix.dirname(root))).replace(/\/+$/, '');
    return `${parent}/${path.posix.basename(root)}`;   // parent '/' becomes '' so no '//'
  } catch { return null; }
}

/**
 * Confirm a jailed LOCAL path is still inside the scope once symlinks are
 * resolved. The lexical check alone is not enough: the bot owns its own data
 * dir, so it can plant a symlink, and the manager resolves it as root with the
 * docker socket and the registry mounted.
 *
 * Walks component by component and follows every symlink it meets, INCLUDING
 * one whose target does not exist yet. realpathSync cannot be used for this:
 * it throws ENOENT on a dangling link, so treating that as "nothing to resolve"
 * would approve the path while the write follows the link and CREATES the file
 * outside the scope. A component that simply does not exist is fine, it gets
 * created where it stands.
 *
 * Delete and rename act on the entry itself (rm and rename(2) never follow a
 * final symlink), so for them the last component is judged where it sits, not
 * where it points: an outward link the bot planted must stay removable.
 *
 * This is a FAST REJECT, not the boundary: the kernel re-walks the same string
 * on the syscall that follows, so the operations below re-check what they are
 * actually holding once they hold an fd.
 */
function realpathContained(base: string, abs: string, followLast = true): boolean {
  // Same parent-derived root as resolvedBase, for the same reason.
  const realBase = resolvedBase(base);
  if (realBase === null) {
    // The scope's parent does not exist (a bot that has never been built).
    // Nothing can have been planted inside it, and the lexical check upstream
    // already holds, so let the operation run and report its own honest ENOENT
    // instead of claiming the path is out of scope.
    return true;
  }
  const inside = (p: string) => p === realBase || p.startsWith(realBase + '/');

  const root = toPosix(base).replace(/\/+$/, '');
  const posixAbs = toPosix(abs);
  // Callers run the lexical check first; refuse rather than mis-slice if that
  // ever stops being true.
  if (posixAbs !== root && !posixAbs.startsWith(root + '/')) return false;
  const rest = posixAbs === root ? '' : posixAbs.slice(root.length + 1);
  const queue = rest ? rest.split('/').filter(Boolean) : [];

  let current = realBase;
  let hops = 0;
  while (queue.length) {
    const comp = queue.shift() as string;
    if (comp === '.') continue;
    // Only the destination decides. A link may legitimately climb out of the
    // scope and come straight back into it, which the kernel resolves inside.
    if (comp === '..') { current = path.posix.dirname(current); continue; }
    const candidate = path.posix.join(current, comp);
    let st: fs.Stats;
    try { st = fs.lstatSync(candidate); } catch { current = candidate; continue; }
    if (!st.isSymbolicLink()) { current = candidate; continue; }
    if (!followLast && queue.length === 0) { current = candidate; continue; }

    if (++hops > MAX_SYMLINK_HOPS) return false;
    let target: string;
    try { target = toPosix(fs.readlinkSync(candidate)); } catch { return false; }
    // An absolute target restarts at its root, a relative one continues from
    // the link's own directory (which is `current`). Either way its components
    // go back through this same loop, so a chain of links is followed too.
    const drive = target.match(/^([A-Za-z]:)\//);
    if (drive) { current = drive[1]; target = target.slice(drive[1].length); }
    else if (target.startsWith('/')) current = '/';
    queue.unshift(...target.split('/').filter(Boolean));
  }
  return inside(current);
}

// Resolve a user path against the target, enforcing the jail for host scope.
// Accepts an absolute path (must stay within base when jailed) or a path
// relative to base. Returns null if it escapes the jail.
function resolveAbs(t: FsTarget, reqPath: string, followLast = true): string | null {
  // On the Windows rig a host-scope drive path is absolute whether it arrives
  // as 'C:/x', typed with backslashes, or framed by the UI as '/C:/x' (it
  // prefixes every path it echoes back with '/'). Only there and only for the
  // host scope: on Linux and inside a container 'C:' and '\\' are ordinary
  // name characters.
  let req = reqPath;
  let driveAbs = false;
  if (t.kind === 'local' && process.platform === 'win32') {
    req = toPosix(req).replace(/^\/(?=[A-Za-z]:(\/|$))/, '');
    driveAbs = /^[A-Za-z]:(\/|$)/.test(req);
  }
  let abs: string;
  if (!req) {
    abs = t.base;
  } else if (req.startsWith('/') || driveAbs) {
    abs = path.posix.normalize(req);
  } else {
    abs = path.posix.normalize(path.posix.join(t.base, req));
  }
  // normalize keeps a trailing slash, which would otherwise read as a
  // different path from the scope root and slip past the delete guard.
  abs = abs.replace(/\/+$/, '') || '/';
  if (t.jail) {
    const root = t.base.replace(/\/+$/, '');
    if (abs !== root && !abs.startsWith(root + '/')) return null;
    if (t.kind === 'local' && !realpathContained(root, abs, followLast)) return null;
  }
  return abs;
}

function execArgs(t: ContainerTarget, argv: string[]): string[] {
  return ['exec', t.container, ...argv];
}

// ─── Local (Node fs) file operations for the host scope ─────────────────────

// O_NONBLOCK so a FIFO the bot planted in its own data dir cannot park the
// manager's single thread in open(2) forever. It is absent on Windows.
const O_NONBLOCK = fs.constants.O_NONBLOCK || 0;
const O_DIRECTORY = fs.constants.O_DIRECTORY || 0;
const O_NOFOLLOW = fs.constants.O_NOFOLLOW || 0;

const OUT_OF_SCOPE = 'Path outside allowed scope';

/**
 * The directory an operation will act in, resolved and confirmed to be inside
 * the scope, plus the leaf name. Acting on `<realDir>/<name>` takes every
 * symlinked component out of the path the kernel will walk, which is what the
 * upstream string check cannot do on its own. A parent that does not exist is
 * reported as such, not as an escape.
 *
 * Nothing here ever undoes work to enforce the boundary. An undo has to name
 * its target by path, and re-walking an attacker-controlled path as root is a
 * worse primitive than the mistake it is trying to correct: the honest failure
 * is to refuse before acting, and at worst to leave an empty file behind.
 */
type SafeDir = { dir: string; name: string } | { error: string; missing?: true };

function safeDir(abs: string, realBase: string | null): SafeDir {
  const name = path.posix.basename(abs);
  let realDir: string;
  try {
    realDir = toPosix(fs.realpathSync(path.posix.dirname(abs)));
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return { error: 'No such file or directory', missing: true };
    return { error: err.message || 'Failed to resolve path' };
  }
  if (realBase !== null && !pathInside(realBase, realDir)) return { error: OUT_OF_SCOPE };
  return { dir: realDir, name };
}

/**
 * mkdir -p that creates nothing outside the scope. It resolves the deepest
 * EXISTING ancestor, confirms the path it will create is inside, then anchors on
 * a pinned directory fd that must be exactly that ancestor, and creates ONE
 * component at a time through /proc/self/fd, so no string the
 * bot can re-point is walked while creating: mkdir(2) never follows a symlink at
 * its final component, and the O_NOFOLLOW open refuses one swapped in under the
 * new name. Each level is handed to the app's uid through its fd as it is made.
 * Without /proc (the native Windows dev rig) it falls back to the resolved
 * string, which is best effort there and where ownership is a no-op anyway.
 */
function mkdirInScope(dirPath: string, realBase: string | null): { error?: string } {
  // No scope root means the scope's own parent is missing. Creating it from
  // here would build manager-level directories and hand them to the app.
  if (realBase === null) return { error: 'No such file or directory' };
  const missing: string[] = [];
  let probe = dirPath;
  let real: string;
  for (;;) {
    try { real = toPosix(fs.realpathSync(probe)); break; }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return { error: (e as Error).message || 'Failed to create directory' };
      missing.unshift(path.posix.basename(probe));
      const parent = path.posix.dirname(probe);
      if (parent === probe) return { error: 'No such file or directory' };
      probe = parent;
    }
  }
  // The anchor may sit above the scope only as its direct parent, when the
  // scope root itself is still to be created. Anything higher means the parent
  // vanished after resolvedBase looked, and creating it here would hand a
  // manager-level directory to the app. Containment is judged on the final
  // path; every component below the anchor is created fresh and opened O_NOFOLLOW.
  const finalPath = path.posix.join(real, ...missing);
  if (!pathInside(realBase, finalPath)) return { error: OUT_OF_SCOPE };
  if (!pathInside(realBase, real) && real !== path.posix.dirname(realBase)) return { error: 'No such file or directory' };

  let fd: number;
  try {
    fd = fs.openSync(real, fs.constants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_NONBLOCK);
  } catch (e) {
    return { error: (e as Error).message || 'Failed to create directory' };
  }
  try {
    // Judged on every platform: O_DIRECTORY is undefined on Windows, where an
    // existing FILE at the path would otherwise open fine and read as success.
    if (!fs.fstatSync(fd).isDirectory()) return { error: 'Not a directory' };
    // The fd must be exactly the directory the probe resolved: landing anywhere
    // else means a component was swapped or renamed after realpath. Inside the
    // scope that is a benign change worth a retry, not a scope violation.
    const landed = fdRealPath(fd, real);
    if (landed === null || toPosix(landed) !== real) {
      return { error: landed !== null && pathInside(realBase, toPosix(landed)) ? 'Path changed during the operation, retry' : OUT_OF_SCOPE };
    }
    if (!missing.length) return {};

    let anchored = true;
    try { fs.readlinkSync(`/proc/self/fd/${fd}`); } catch { anchored = false; }
    if (!anchored) {
      const created = fs.mkdirSync(finalPath, { recursive: true }) as string | undefined;
      if (created) grantToApp(created, { recursive: true });
      return {};
    }

    // One component at a time could build a tree deeper than PATH_MAX, which
    // nothing path-based (list, delete, the bot itself) could reach again.
    if (Buffer.byteLength(finalPath) >= 4096) return { error: 'ENAMETOOLONG: name too long' };

    for (let i = 0; i < missing.length; i++) {
      const at = `/proc/self/fd/${fd}/${missing[i]}`;
      // Errors name the path the operator asked for, never the /proc mechanism.
      const shown = path.posix.join(real, ...missing.slice(0, i + 1));
      try { fs.mkdirSync(at); }
      catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST') return { error: `${code || 'Error'}: cannot create directory ${shown}` };
      }
      let next: number;
      try { next = fs.openSync(at, fs.constants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_NONBLOCK); }
      catch { return { error: `Not a directory: ${shown}` }; }
      try { fs.closeSync(fd); } catch { /* handed over to next */ }
      fd = next;
      if (!fs.fstatSync(fd).isDirectory()) return { error: `Not a directory: ${shown}` };
      grantFd(fd);
    }
    return {};
  } catch (e) {
    return { error: (e as Error).message || 'Failed to create directory' };
  } finally {
    try { fs.closeSync(fd); } catch { /* already gone */ }
  }
}

/**
 * List through an fd. Resolving the string first and listing the resolved
 * string is a no-op against a swapped leaf, because when the leaf is a real
 * directory the resolved string IS the original string and the kernel walks it
 * again. The fd pins the directory; /proc/self/fd/N reads that inode and never
 * re-walks the path.
 */
function localList(abs: string, realBase: string | null): any {
  if (realBase === null) {
    try {
      const entries = fs.readdirSync(abs, { withFileTypes: true }).map((e) => ({ name: e.name, isDir: e.isDirectory() }));
      return { success: true, path: abs, entries };
    } catch (e) {
      return { success: false, error: (e as Error).message || 'Failed to list directory', path: abs };
    }
  }
  let fd: number;
  try {
    fd = fs.openSync(abs, fs.constants.O_RDONLY | O_DIRECTORY | O_NONBLOCK);
  } catch (e) {
    return { success: false, error: (e as Error).message || 'Failed to list directory', path: abs };
  }
  try {
    const landed = fdRealPath(fd, abs);
    if (!landed || !pathInside(realBase, landed)) return { success: false, error: OUT_OF_SCOPE, path: abs };
    if (!fs.fstatSync(fd).isDirectory()) return { success: false, error: 'Not a directory', path: abs };
    let walk = landed;
    try { fs.readlinkSync(`/proc/self/fd/${fd}`); walk = `/proc/self/fd/${fd}`; } catch { /* not Linux: best effort */ }
    const entries = fs.readdirSync(walk, { withFileTypes: true }).map((e) => ({ name: e.name, isDir: e.isDirectory() }));
    return { success: true, path: abs, entries };
  } catch (e) {
    return { success: false, error: (e as Error).message || 'Failed to list directory', path: abs };
  } finally {
    try { fs.closeSync(fd); } catch { /* already gone */ }
  }
}

/**
 * Read through an fd and judge the fd, never the path: the descriptor pins the
 * inode, so a component swapped after the check cannot redirect it.
 */
function localRead(abs: string, realBase: string | null): any {
  let fd: number;
  try {
    fd = fs.openSync(abs, fs.constants.O_RDONLY | O_NONBLOCK);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'EISDIR') return { success: false, error: 'Cannot read a directory', path: abs };
    if (err.code === 'ENXIO' || err.code === 'ELOOP') return { success: false, error: 'Not a regular file', path: abs };
    return { success: false, error: err.message || 'Failed to read file', path: abs };
  }
  try {
    const landed = fdRealPath(fd, abs);
    if (realBase !== null && (!landed || !pathInside(realBase, landed))) {
      return { success: false, error: OUT_OF_SCOPE, path: abs };
    }
    const st = fs.fstatSync(fd);
    if (st.isDirectory()) return { success: false, error: 'Cannot read a directory', path: abs };
    if (!st.isFile()) return { success: false, error: 'Not a regular file', path: abs };
    if (st.size > MAX_FILE_BYTES) return { success: false, error: 'File too large to edit (over 1 MB)', path: abs, tooLarge: true };

    const body = readAll(fd, st.size);
    if (body.includes(0)) return { success: false, error: 'Binary file (not editable here)', path: abs, binary: true };
    return { success: true, path: abs, body: body.toString('utf8') };
  } catch (e) {
    return { success: false, error: (e as Error).message || 'Failed to read file', path: abs };
  } finally {
    try { fs.closeSync(fd); } catch { /* already gone */ }
  }
}

function readAll(fd: number, size: number): Buffer {
  const buf = Buffer.alloc(size);
  let off = 0;
  while (off < size) {
    const n = fs.readSync(fd, buf, off, size - off, off);
    if (n <= 0) break;
    off += n;
  }
  return buf.subarray(0, off);
}

function writeAll(fd: number, buf: Buffer): void {
  let off = 0;
  while (off < buf.length) {
    // writeSync counts BYTES, and the explicit position makes it a pwrite
    // that does not move the fd offset, so the offset is carried here.
    const n = fs.writeSync(fd, buf, off, buf.length - off, off);
    if (n <= 0) throw new Error(`short write: ${off} of ${buf.length} bytes`);
    off += n;
  }
}

function localWrite(abs: string, body: string, realBase: string | null): any {
  const made = mkdirInScope(path.posix.dirname(abs), realBase);
  if (made.error) return { success: false, error: made.error };

  const safe = safeDir(abs, realBase);
  if ('error' in safe) return { success: false, error: safe.error };
  const target = `${safe.dir}/${safe.name}`;

  let fd: number;
  try {
    // No O_TRUNC: nothing is emptied until the fd has been judged. O_CREAT with
    // no O_EXCL so an in-scope symlink whose target does not exist yet still
    // gets its target created, which is what the previous writeFileSync did.
    // O_RDWR rather than O_WRONLY: the current content is read back first so a
    // failed write can put it back.
    fd = fs.openSync(target, fs.constants.O_RDWR | fs.constants.O_CREAT | O_NONBLOCK, 0o644);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'EISDIR') return { success: false, error: 'Cannot write over a directory' };
    if (err.code === 'ENXIO' || err.code === 'ELOOP') return { success: false, error: 'Not a regular file' };
    return { success: false, error: err.message || 'Failed to write file' };
  }
  try {
    const landed = fdRealPath(fd, target);
    if (realBase !== null && (!landed || !pathInside(realBase, landed))) {
      return { success: false, error: OUT_OF_SCOPE };
    }
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { success: false, error: 'Not a regular file' };

    // A write that fails partway (ENOSPC, EIO) has already emptied the file, so
    // whatever fit in the editor is kept in memory first and put back on
    // failure. Best effort: the original occupied the space it needs, and the
    // truncation has just freed it.
    const previous = st.size <= MAX_FILE_BYTES ? readAll(fd, st.size) : null;
    fs.ftruncateSync(fd, 0);
    try {
      writeAll(fd, Buffer.from(body, 'utf8'));
    } catch (e) {
      if (previous) {
        try { fs.ftruncateSync(fd, 0); writeAll(fd, previous); } catch { /* the error below is the one to report */ }
      }
      throw e;
    }
    // Ownership goes through the fd, so it cannot be aimed elsewhere.
    grantFd(fd);
    return { success: true, path: abs };
  } catch (e) {
    return { success: false, error: (e as Error).message || 'Failed to write file' };
  } finally {
    try { fs.closeSync(fd); } catch { /* already gone */ }
  }
}

function localMkdir(abs: string, realBase: string | null): any {
  const made = mkdirInScope(abs, realBase);
  if (made.error) return { success: false, error: made.error };
  return { success: true, path: abs };
}

function localDelete(abs: string, realBase: string | null): any {
  const safe = safeDir(abs, realBase);
  if ('error' in safe) {
    if (safe.missing) return { success: true, path: abs };   // rm -f semantics
    return { success: false, error: safe.error };
  }
  try {
    // rm never follows a final symlink, so this removes the entry named in the
    // scope, and the resolved parent keeps the walk inside it.
    fs.rmSync(`${safe.dir}/${safe.name}`, { recursive: true, force: true });
    return { success: true, path: abs };
  } catch (e) { return { success: false, error: (e as Error).message || 'Failed to delete' }; }
}

function localRename(absFrom: string, absTo: string, realBase: string | null): any {
  const from = safeDir(absFrom, realBase);
  if ('error' in from) return { success: false, error: from.error };
  const to = safeDir(absTo, realBase);
  if ('error' in to) return { success: false, error: to.error };
  try {
    fs.renameSync(`${from.dir}/${from.name}`, `${to.dir}/${to.name}`);
    return { success: true, from: absFrom, to: absTo };
  } catch (e) { return { success: false, error: (e as Error).message || 'Failed to rename' }; }
}

// ─── File operations ────────────────────────────────────────────────────────

export async function fsList(botId: string, target: string, reqPath: string): Promise<any> {
  const t = await resolveTarget(botId, target);
  if ('error' in t) return { success: false, error: t.error };
  const abs = resolveAbs(t, reqPath);
  if (!abs) return { success: false, error: 'Path outside allowed scope' };

  if (t.kind === 'local') return localList(abs, t.jail ? resolvedBase(t.base) : null);

  const { stdout, stderr, code } = await spawnCapture('docker', execArgs(t, ['ls', '-Ap1', '--', abs]));
  if (code !== 0) return { success: false, error: stderr.trim() || 'Failed to list directory', path: abs };

  const entries = stdout.toString('utf8').split('\n').map((l) => l.replace(/\r$/, '')).filter(Boolean).map((name) => {
    const isDir = name.endsWith('/');
    return { name: isDir ? name.slice(0, -1) : name, isDir };
  });
  return { success: true, path: abs, entries };
}

export async function fsRead(botId: string, target: string, reqPath: string): Promise<any> {
  const t = await resolveTarget(botId, target);
  if ('error' in t) return { success: false, error: t.error };
  const abs = resolveAbs(t, reqPath);
  if (!abs) return { success: false, error: 'Path outside allowed scope' };

  if (t.kind === 'local') return localRead(abs, t.jail ? resolvedBase(t.base) : null);

  const { stdout, stderr, code } = await spawnCapture('docker', execArgs(t, ['head', '-c', String(MAX_FILE_BYTES + 1), '--', abs]));
  if (code !== 0) return { success: false, error: stderr.trim() || 'Failed to read file', path: abs };
  if (stdout.length > MAX_FILE_BYTES) return { success: false, error: 'File too large to edit (over 1 MB)', path: abs, tooLarge: true };
  if (stdout.includes(0)) return { success: false, error: 'Binary file (not editable here)', path: abs, binary: true };
  return { success: true, path: abs, body: stdout.toString('utf8') };
}

export async function fsWrite(botId: string, target: string, reqPath: string, body: string): Promise<any> {
  const t = await resolveTarget(botId, target);
  if ('error' in t) return { success: false, error: t.error };
  const abs = resolveAbs(t, reqPath);
  if (!abs) return { success: false, error: 'Path outside allowed scope' };

  // Guard against accidentally truncating a file to nothing (a blank editor save
  // would erase a config). Deleting is the explicit way to remove a file.
  if (body.length === 0) {
    return { success: false, error: 'Refusing to save an empty file (this would erase its contents). Use delete if you mean to remove it.' };
  }

  if (t.kind === 'local') return localWrite(abs, body, t.jail ? resolvedBase(t.base) : null);

  // Pass the path as $1 (argv), never interpolated into the shell.
  const { stderr, code } = await spawnCapture(
    'docker',
    execArgs(t, ['sh', '-c', 'cat > "$1"', 'sh', abs]),
    { input: Buffer.from(body, 'utf8') }
  );
  if (code !== 0) return { success: false, error: stderr.trim() || 'Failed to write file' };
  return { success: true, path: abs };
}

export async function fsMkdir(botId: string, target: string, reqPath: string): Promise<any> {
  const t = await resolveTarget(botId, target);
  if ('error' in t) return { success: false, error: t.error };
  const abs = resolveAbs(t, reqPath);
  if (!abs) return { success: false, error: 'Path outside allowed scope' };
  if (t.kind === 'local') return localMkdir(abs, t.jail ? resolvedBase(t.base) : null);
  const { stderr, code } = await spawnCapture('docker', execArgs(t, ['mkdir', '-p', '--', abs]));
  if (code !== 0) return { success: false, error: stderr.trim() || 'Failed to create directory' };
  return { success: true, path: abs };
}

export async function fsDelete(botId: string, target: string, reqPath: string): Promise<any> {
  const t = await resolveTarget(botId, target);
  if ('error' in t) return { success: false, error: t.error };
  const abs = resolveAbs(t, reqPath, false);
  if (!abs || (t.jail && abs === t.base)) return { success: false, error: 'Path outside allowed scope' };
  if (t.kind === 'local') return localDelete(abs, t.jail ? resolvedBase(t.base) : null);
  const { stderr, code } = await spawnCapture('docker', execArgs(t, ['rm', '-rf', '--', abs]));
  if (code !== 0) return { success: false, error: stderr.trim() || 'Failed to delete' };
  return { success: true, path: abs };
}

export async function fsRename(botId: string, target: string, fromPath: string, toPath: string): Promise<any> {
  const t = await resolveTarget(botId, target);
  if ('error' in t) return { success: false, error: t.error };
  const absFrom = resolveAbs(t, fromPath, false);
  const absTo = resolveAbs(t, toPath, false);
  if (!absFrom || !absTo) return { success: false, error: 'Path outside allowed scope' };
  if (t.kind === 'local') return localRename(absFrom, absTo, t.jail ? resolvedBase(t.base) : null);
  const { stderr, code } = await spawnCapture('docker', execArgs(t, ['mv', '--', absFrom, absTo]));
  if (code !== 0) return { success: false, error: stderr.trim() || 'Failed to rename' };
  return { success: true, from: absFrom, to: absTo };
}

// ─── Interactive terminal (multiplexed over the /ws connection) ─────────────

interface TermSession { child: ChildProcess }

function send(ws: WebSocket, type: string, extra: Record<string, unknown> = {}): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type, ...extra }));
}

export function closeTerminal(ws: WebSocket): void {
  const sess = (ws as any).__term as TermSession | undefined;
  if (sess?.child) { try { sess.child.kill('SIGKILL'); } catch { /* ignore */ } }
  (ws as any).__term = undefined;
}

// `docker exec` args for an interactive shell. The wrapper sets the initial TTY
// size, then execs bash if present else sh.
function buildExecArgs(container: string, useTty: boolean, cols: number, rows: number): string[] {
  const args = ['exec', '-i'];
  if (useTty) args.push('-t');
  const wrap = `stty rows ${rows} cols ${cols} 2>/dev/null; if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi`;
  args.push(container, '/bin/sh', '-c', wrap);
  return args;
}

async function startTerminal(ws: WebSocket, msg: any): Promise<void> {
  const bot = getBot(msg.botId);
  if (!bot) { send(ws, 'terminal:error', { message: 'Bot not found' }); return; }

  const containers = await getBotContainers(bot.sanitizedName);
  const target = String(msg.container || '');
  const match = containers.find((c) => c.name === target);
  if (!match) { send(ws, 'terminal:error', { message: 'Container does not belong to this bot' }); return; }
  if (match.state !== 'running') { send(ws, 'terminal:error', { message: 'Container is not running' }); return; }

  closeTerminal(ws);

  const cols = Number(msg.cols) || 80;
  const rows = Number(msg.rows) || 24;
  let retried = false;

  // Node's stdin is a pipe, so some daemons refuse `-t` ("the input device is not
  // a TTY"). On that error, retry once without a TTY (line-buffered but usable).
  const launch = (useTty: boolean): void => {
    const child = spawn('docker', buildExecArgs(target, useTty, cols, rows), { windowsHide: true });
    (ws as any).__term = { child } as TermSession;

    const forward = (d: Buffer) => send(ws, 'terminal:data', { data: d.toString('base64') });
    child.stdout?.on('data', forward);
    child.stderr?.on('data', (d: Buffer) => {
      if (useTty && !retried && /not a TTY/i.test(d.toString())) {
        retried = true;
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
        launch(false);
        return;
      }
      forward(d);
    });
    child.on('exit', () => {
      if (retried && useTty) return;   // this is the TTY attempt we replaced
      if (((ws as any).__term as TermSession | undefined)?.child === child) (ws as any).__term = undefined;
      send(ws, 'terminal:exit', {});
    });
    child.on('error', (err) => {
      if (retried && useTty) return;
      send(ws, 'terminal:error', { message: err instanceof Error ? err.message : String(err) });
    });
  };

  launch(true);
  send(ws, 'terminal:ready', { container: target });
}

/**
 * Handle a terminal:* control message on the shared /ws socket.
 * Returns true if the message was a terminal message (handled), false otherwise.
 */
export function handleTerminalMessage(ws: WebSocket, raw: string): boolean {
  let msg: any;
  try { msg = JSON.parse(raw); } catch { return false; }
  if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('terminal:')) return false;

  const sess = (ws as any).__term as TermSession | undefined;
  switch (msg.type) {
    case 'terminal:start':
      void startTerminal(ws, msg);
      break;
    case 'terminal:input':
      if (sess?.child?.stdin) sess.child.stdin.write(Buffer.from(String(msg.data || ''), 'base64'));
      break;
    case 'terminal:resize':
      // Live resize needs a real PTY (node-pty follow-up); initial size is set by
      // buildExecArgs. No-op here to keep the CLI path dependency-free.
      break;
    case 'terminal:stop':
      closeTerminal(ws);
      break;
  }
  return true;
}
