/**
 * Manager self-update (standalone "docker" mode only).
 *
 * On Yundera/CasaOS the platform updates the manager, so this is gated off there.
 * In docker mode the manager is built from a git clone whose project dir is bind-
 * mounted at /repo. The manager rebuilds itself by: git pull -> `docker compose
 * build` (streamed live) -> a detached one-shot container (the manager's OWN image,
 * which bundles docker-cli-compose) runs `docker compose up -d` to recreate it.
 */
import { spawn, execSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { getDeploymentMode } from '../casaos/detector';

const REPO = '/repo';
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
  reason?: string;
  branch?: string;
  currentCommit?: string;
  updateAvailable?: boolean;
  behindBy?: number;
}

function gitOut(args: string[]): string {
  return execSync(`git -c safe.directory='*' -C "${REPO}" ${args.join(' ')}`, { encoding: 'utf-8', timeout: 30000 }).trim();
}

function isGitRepo(): boolean {
  try { return fs.existsSync(path.join(REPO, '.git')); } catch { return false; }
}

/** Read this container's compose deployment from its own labels (no host config needed). */
function inspectSelf(): SelfInfo | null {
  try {
    const id = process.env.HOSTNAME || 'discordbotmanagerapp';
    const raw = execSync(`docker inspect ${id}`, { encoding: 'utf-8', timeout: 10000 });
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

export async function getManagerVersion(): Promise<ManagerVersion> {
  if (await getDeploymentMode() !== 'docker') {
    return { supported: false, reason: 'Updates are managed by the platform (Yundera/CasaOS).' };
  }
  if (!isGitRepo()) {
    return { supported: false, reason: 'Self-update needs the repo mounted at /repo (rebuild from docker-compose).' };
  }
  try {
    const branch = gitOut(['rev-parse', '--abbrev-ref', 'HEAD']);
    const currentCommit = gitOut(['rev-parse', '--short', 'HEAD']);
    let updateAvailable = false;
    let behindBy = 0;
    try {
      gitOut(['fetch', '--quiet']);
      behindBy = parseInt(gitOut(['rev-list', '--count', 'HEAD..@{u}']) || '0', 10) || 0;
      updateAvailable = behindBy > 0;
    } catch { /* offline / no upstream: report current commit, no update info */ }
    return { supported: true, branch, currentCommit, updateAvailable, behindBy };
  } catch (err) {
    return { supported: false, reason: `Could not read git state: ${err}` };
  }
}

/**
 * Pull + rebuild + recreate. Streams progress via emit(); the actual restart is done
 * by a detached one-shot container. On success this process is replaced before the
 * promise settles, so it only ever REJECTS here: on pull/build failure, a recreate
 * that could not launch, or (via the watchdog) a recreate that launched but never took
 * effect. onRestarting() fires once the recreate has been launched.
 */
export async function runManagerUpdate(emit: Emit, onRestarting?: () => void): Promise<void> {
  if (await getDeploymentMode() !== 'docker') throw new Error('Self-update is only available in standalone docker mode.');
  if (!isGitRepo()) throw new Error('Repo not mounted at /repo; cannot self-update.');
  const self = inspectSelf();
  if (!self) throw new Error('Could not read this container\'s compose labels (is it compose-managed?).');

  emit('[Update] Fetching latest code...', 'info');
  preserveLocalUsersDb();
  await streamProc('git', ['-c', 'safe.directory=*', '-C', REPO, 'pull', '--ff-only'], emit);

  emit(`[Update] Rebuilding the manager image (${self.service})...`, 'info');
  await streamProc('docker', ['compose', '-p', self.project, '-f', self.composeFile, 'build', self.service], emit, REPO);

  emit('[Update] Recreating the manager - the UI will drop and reconnect in a few seconds...', 'info');
  // A container can't recreate itself in-process, so launch a detached one-shot that
  // runs `compose up -d` after we return. It uses the manager's own image (has compose).
  // The repo is mounted at its OWN host path so compose resolves the relative binds
  // (`.:/repo`, `./authelia`) to real host paths; HOST_DATA_DIR covers the standalone
  // case (no .env). The same-path trick is Linux-only - on Windows the host path is not
  // a valid Linux mount target, so `docker run` fails at launch and we fall back.
  spawnSync('docker', ['rm', '-f', 'dbm-self-update'], { encoding: 'utf-8' });   // free the name (keeps the previous run's logs until now)
  const script = `sleep 2; docker compose -p '${self.project}' -f '${self.composeFile}' up -d '${self.service}'`;
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

  // `docker run -d` reports only the LAUNCH, not the inner `compose up` result. But a
  // successful recreate replaces THIS process, so if we are still alive after a grace
  // period the recreate must have failed - surface the helper's output instead of
  // silently "succeeding". (On success this process is gone before the timer fires.)
  await new Promise<void>((_resolve, reject) => {
    setTimeout(() => {
      let logs = '';
      try { logs = execSync('docker logs dbm-self-update', { encoding: 'utf-8', timeout: 10000 }).trim(); } catch { /* gone / unreadable */ }
      reject(new Error(
        `The manager was rebuilt but the auto-recreate did not take effect.\n${logs || '(no recreate output)'}\n` +
        `Finish it from the host with:  docker compose -f ${self.composeFile} up -d ${self.service}`,
      ));
    }, 45000);
  });
}
