/**
 * Manager self-update (standalone "docker" mode only).
 *
 * On Yundera/CasaOS the platform updates the manager, so this is gated off there.
 * In docker mode the manager is built from a git clone whose project dir is bind-
 * mounted at /repo. The manager rebuilds itself by: git pull -> `docker compose
 * build` (streamed live) -> a detached one-shot container (the manager's OWN image,
 * which bundles docker-cli-compose) runs `docker compose up -d` to recreate the
 * whole stack (manager + Caddy/Authelia), so the auth layer is patched too.
 * Authelia secrets (*_FILE / gitignored) and its named data volume survive the
 * recreate untouched, so logins/MFA seeds/sessions are preserved.
 */
import { spawn, execFile, execSync, spawnSync } from 'child_process';
import { randomUUID } from 'crypto';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { getDeploymentMode } from '../casaos/detector';

const REPO = '/repo';
// Regenerated on every process start; lets the UI tell "server restarted" apart
// from "same server, transient ws drop".
const BOOT_ID = randomUUID();
type Emit = (msg: string, level?: 'info' | 'warning' | 'error' | 'success') => void;

interface SelfInfo {
  project: string;
  service: string;
  hostRepoDir: string;   // compose project working_dir as the HOST daemon sees it
  composeFile: string;   // basename of the compose file used
  image: string;
}

export interface ManagerVersion {
  supported: boolean;
  bootId: string;
  reason?: string;
  branch?: string;
  currentCommit?: string;
  updateAvailable?: boolean;
  behindBy?: number;
}

let updateInProgress = false;
export function isUpdateInProgress(): boolean {
  return updateInProgress;
}

const execFileAsync = promisify(execFile);

async function gitAsync(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-c', 'safe.directory=*', '-C', REPO, ...args], { encoding: 'utf-8', timeout: 30000 });
  return stdout.trim();
}

function gitOut(args: string[]): string {
  return execSync(`git -c safe.directory='*' -C "${REPO}" ${args.join(' ')}`, { encoding: 'utf-8', timeout: 30000 }).trim();
}

function dockerOut(args: string[]): string {
  const r = spawnSync('docker', args, { encoding: 'utf-8', timeout: 10000 });
  if (r.status !== 0) throw new Error((r.stderr || '').trim() || `docker ${args[0]} failed`);
  return (r.stdout || '').trim();
}

function isGitRepo(): boolean {
  try { return fs.existsSync(path.join(REPO, '.git')); } catch { return false; }
}

function selfContainerId(): string {
  return process.env.HOSTNAME || 'discordbotmanagerapp';
}

/** Read this container's compose deployment from its own labels (no host config needed). */
function inspectSelf(): SelfInfo | null {
  try {
    const raw = execSync(`docker inspect ${selfContainerId()}`, { encoding: 'utf-8', timeout: 10000 });
    const c = JSON.parse(raw)[0];
    const labels = (c?.Config?.Labels || {}) as Record<string, string>;
    const project = labels['com.docker.compose.project'];
    const service = labels['com.docker.compose.service'];
    const hostRepoDir = labels['com.docker.compose.project.working_dir'];
    const configFiles = labels['com.docker.compose.project.config_files'] || '';
    const image = c?.Config?.Image;
    if (!project || !service || !hostRepoDir || !image) return null;
    // basename, separator-agnostic: the label is a Windows path on Docker Desktop and
    // POSIX path.basename (this container is Linux) would not split on backslashes.
    const composeFile = (configFiles.split(',')[0] || 'docker-compose.remote.yml').split(/[\\/]/).pop() || 'docker-compose.remote.yml';
    return { project, service, hostRepoDir, composeFile, image };
  } catch {
    return null;
  }
}

/** Git refuses to merge over the locally-edited (tracked) users_database.yml; keep ours. */
function preserveLocalUsersDb(): void {
  try { gitOut(['update-index', '--skip-worktree', 'authelia/users_database.yml']); } catch { /* best effort */ }
}

/** Stream a child process's stdout+stderr to emit(), line by line. */
function streamProc(cmd: string, args: string[], emit: Emit, cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, DOCKER_BUILDKIT: '1' } });
    const onData = (buf: Buffer) => buf.toString().split(/[\r\n]+/).forEach((l) => { if (l.trim()) emit(l); });
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited with code ${code}`))));
    child.on('error', reject);
  });
}

const VERSION_TTL_MS = 60000;
let versionCache: ManagerVersion | null = null;
let versionCacheAt = 0;
let versionInFlight: Promise<ManagerVersion> | null = null;

export async function getManagerVersion(): Promise<ManagerVersion> {
  // Never run git while an update is pulling/mutating the repo.
  if (updateInProgress) return versionCache || { supported: true, bootId: BOOT_ID };
  if (versionCache && Date.now() - versionCacheAt < VERSION_TTL_MS) return versionCache;
  if (!versionInFlight) {
    versionInFlight = readManagerVersion()
      .then((v) => { versionCache = v; versionCacheAt = Date.now(); return v; })
      .finally(() => { versionInFlight = null; });
  }
  return versionInFlight;
}

async function readManagerVersion(): Promise<ManagerVersion> {
  if (await getDeploymentMode() !== 'docker') {
    return { supported: false, bootId: BOOT_ID, reason: 'Updates are managed by the platform (Yundera/CasaOS).' };
  }
  if (!isGitRepo()) {
    return { supported: false, bootId: BOOT_ID, reason: 'Self-update needs the repo mounted at /repo (rebuild from docker-compose).' };
  }
  try {
    const branch = await gitAsync(['rev-parse', '--abbrev-ref', 'HEAD']);
    const currentCommit = await gitAsync(['rev-parse', '--short', 'HEAD']);
    let updateAvailable = false;
    let behindBy = 0;
    try {
      await gitAsync(['fetch', '--quiet']);
      behindBy = parseInt(await gitAsync(['rev-list', '--count', 'HEAD..@{u}']) || '0', 10) || 0;
      updateAvailable = behindBy > 0;
    } catch { /* offline / no upstream: report current commit, no update info */ }
    return { supported: true, bootId: BOOT_ID, branch, currentCommit, updateAvailable, behindBy };
  } catch (err) {
    return { supported: false, bootId: BOOT_ID, reason: `Could not read git state: ${err}` };
  }
}

/**
 * Pull + rebuild + recreate. Streams progress via emit(). RESOLVES when nothing
 * needed applying (image and compose config unchanged) or when the recreate applied
 * without replacing this process; on a real restart this process is replaced before
 * the promise settles. REJECTS on pull/build failure, a recreate that could not
 * launch, or a recreate that did not take effect. onRestarting() fires once the
 * recreate has been launched.
 */
export async function runManagerUpdate(emit: Emit, onRestarting?: () => void): Promise<void> {
  updateInProgress = true;
  try {
    await doManagerUpdate(emit, onRestarting);
  } finally {
    // Never runs when the recreate replaces this process, which is fine.
    updateInProgress = false;
    versionCache = null;
  }
}

async function doManagerUpdate(emit: Emit, onRestarting?: () => void): Promise<void> {
  if (await getDeploymentMode() !== 'docker') throw new Error('Self-update is only available in standalone docker mode.');
  if (!isGitRepo()) throw new Error('Repo not mounted at /repo; cannot self-update.');
  const self = inspectSelf();
  if (!self) throw new Error('Could not read this container\'s compose labels (is it compose-managed?).');

  emit('[Update] Fetching latest code...', 'info');
  preserveLocalUsersDb();
  const oldHead = gitOut(['rev-parse', 'HEAD']);
  await streamProc('git', ['-c', 'safe.directory=*', '-C', REPO, 'pull', '--ff-only'], emit);
  const newHead = gitOut(['rev-parse', 'HEAD']);

  emit('[Update] Rebuilding the stack images...', 'info');
  await streamProc('docker', ['compose', '-p', self.project, '-f', self.composeFile, 'build'], emit, REPO);

  // A pull that changed neither the manager image nor its compose config makes
  // `compose up -d` a no-op: the process would survive and a blind watchdog would
  // falsely report failure. Detect that and finish here instead.
  const newImageId = dockerOut(['image', 'inspect', self.image, '--format', '{{.Id}}']);
  const runningImageId = () => dockerOut(['inspect', selfContainerId(), '--format', '{{.Image}}']);
  // Full-stack recreate: any pulled change (HEAD advanced) or a rebuilt manager
  // image means there is something to apply; `compose up -d` then reconciles the
  // whole stack and only recreates the services whose image or config changed.
  const needsApply = oldHead !== newHead || newImageId !== runningImageId();
  if (!needsApply) {
    emit(`[Update] Already up to date - nothing to apply (HEAD ${newHead.slice(0, 7)}).`, 'success');
    return;
  }

  emit('[Update] Recreating the stack - the UI will drop and reconnect in a few seconds...', 'info');
  // A container can't recreate itself in-process, so launch a detached one-shot that
  // runs `compose up -d` after we return. It uses the manager's own image (has compose).
  // The repo is mounted at its OWN host path so compose resolves the relative binds
  // (`.:/repo`, `./authelia`) to real host paths; HOST_DATA_DIR covers the standalone
  // case (no .env). The same-path trick is Linux-only - on Windows the host path is not
  // a valid Linux mount target, so `docker run` fails at launch and we fall back.
  spawnSync('docker', ['rm', '-f', 'dbm-self-update'], { encoding: 'utf-8' });   // free the name (keeps the previous run's logs until now)
  const script = `sleep 2; docker compose -p '${self.project}' -f '${self.composeFile}' up -d --remove-orphans`;
  const r = spawnSync('docker', [
    'run', '-d', '--name', 'dbm-self-update',
    '-e', `HOST_DATA_DIR=${process.env.HOST_DATA_DIR || ''}`,
    '-v', '/var/run/docker.sock:/var/run/docker.sock',
    '-v', `${self.hostRepoDir}:${self.hostRepoDir}`,
    '-w', self.hostRepoDir, self.image, 'sh', '-c', script,
  ], { encoding: 'utf-8' });
  if (r.status !== 0) {
    // Most likely a Docker Desktop host-path that didn't round-trip. The rebuild
    // already succeeded, so tell the operator how to finish it by hand.
    throw new Error(
      `Rebuilt OK, but could not launch the auto-recreate (${(r.stderr || '').trim() || 'docker run failed'}). ` +
      `Finish it from the host with:  docker compose -f ${self.composeFile} up -d ${self.service}`,
    );
  }
  emit('[Update] Recreate launched - waiting for the manager to restart...', 'info');
  onRestarting?.();

  // `docker run -d` reports only the LAUNCH, not the inner `compose up` result. Poll
  // the helper until it exits: a real recreate replaces THIS process mid-poll, so if
  // we survive the helper's success we compare image ids to tell "compose recreated
  // only other services" apart from "recreate did not take effect".
  const helperLogs = (): string => {
    try { return execSync('docker logs dbm-self-update', { encoding: 'utf-8', timeout: 10000 }).trim(); } catch { return ''; }
  };
  const failMsg = (logs: string) =>
    `The manager was rebuilt but the auto-recreate did not take effect.\n${logs || '(no recreate output)'}\n` +
    `Finish it from the host with:  docker compose -f ${self.composeFile} up -d ${self.service}`;
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    await sleep(3000);
    let status = '';
    let exitCode = NaN;
    try {
      const parts = dockerOut(['inspect', 'dbm-self-update', '--format', '{{.State.Status}} {{.State.ExitCode}}']).split(' ');
      status = parts[0];
      exitCode = Number(parts[1]);
    } catch { continue; }
    if (status !== 'exited') continue;
    if (exitCode !== 0) throw new Error(failMsg(helperLogs()));
    await sleep(6000);   // grace tick: a real recreate kills this process during it
    if (runningImageId() === newImageId) {
      emit('[Update] Applied without a manager restart.', 'success');
      return;
    }
    throw new Error(failMsg(helperLogs()));
  }
  throw new Error(failMsg(helperLogs()));
}
