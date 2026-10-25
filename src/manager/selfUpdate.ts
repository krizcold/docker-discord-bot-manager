/**
 * Manager self-update (standalone "docker" mode only).
 *
 * On Yundera/CasaOS the platform updates the manager, so this is gated off there.
 * In docker mode the manager is built from a git clone whose project dir is bind-
 * mounted at /repo. The manager rebuilds itself by: git pull -> `docker compose
 * build` (streamed live) -> a detached one-shot container (the manager's OWN image,
 * which bundles docker-cli-compose) runs `docker compose up -d` to recreate the
 * whole stack (manager + Caddy/Authelia). compose recreates Caddy/Authelia only when
 * their image or compose config changed; when the pull changed Authelia's bind-mounted
 * configuration.yml or users_database.yml, the helper also restarts Authelia.
 * Authelia secrets (*_FILE / gitignored) and its named data volume survive the
 * recreate untouched, so users and MFA seeds are preserved. Sessions are not: they
 * live in Authelia's memory, so a restart or recreate of Authelia logs admins out.
 */
import { spawn, execFile, execSync } from 'child_process';
import { randomUUID, createHash } from 'crypto';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { getDeploymentMode } from '../casaos/detector';
import { LOG_CAP_RUN_ARGS } from '../templates/logCaps';
import { databaseLaneBlocker } from '../instance/fleetBackup';

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

export type UpdateState = 'running' | 'restarting' | 'applied' | 'noop' | 'pending' | 'failed' | 'interrupted' | 'not-applied' | 'unstamped' | 'unknown';

export interface LastUpdate {
  opId: string;
  state: UpdateState;
  target?: string;
  message?: string;
  at: string;
}

export interface UpdateOutcome {
  state: 'applied' | 'noop' | 'pending' | 'failed';
  message: string;
}

export interface ManagerVersion {
  supported: boolean;
  bootId: string;
  reason?: string;
  checked?: boolean;
  fetchError?: string;
  stamped?: boolean;
  buildCommit?: string;
  stackPending?: boolean;
  updateInProgress?: boolean;
  lastUpdate?: LastUpdate | null;
  branch?: string;
  currentCommit?: string;
  repoCommit?: string;
  buildStale?: boolean;
  updateAvailable?: boolean;
  behindBy?: number;
}

/** The in-flight lane a recreate would cut short, named; null when none runs. */
export function updateLaneBlocker(): string | null {
  return databaseLaneBlocker();
}

let updateInProgress = false;
export async function isUpdateInProgress(): Promise<boolean> {
  return updateInProgress || await helperRunning();
}

/** Whether this process runs an update now; synchronous, so a route can check it with no await before it starts one. */
export function updateRunning(): boolean {
  return updateInProgress;
}

const HELPER = 'dbm-self-update';
const DOCKER_READ_MS = 10000;

/** status 'missing' only when docker confirms the helper does not exist; '' when inspect failed otherwise. */
async function helperState(): Promise<{ status: string; exitCode: number }> {
  try {
    const [status, code] = (await dockerOut(['container', 'inspect', HELPER, '--format', '{{.State.Status}} {{.State.ExitCode}}'])).split(' ');
    return { status, exitCode: Number(code) };
  } catch (err) {
    return { status: /no such (container|object)/i.test(String(err)) ? 'missing' : '', exitCode: NaN };
  }
}

function isLive(status: string): boolean {
  return status === 'running' || status === 'created' || status === 'restarting';
}

async function helperRunning(): Promise<boolean> {
  return isLive((await helperState()).status);
}

async function helperLogs(): Promise<string> {
  try { return await dockerOut(['logs', HELPER]); } catch { return ''; }
}

function upHint(composeFile: string): string {
  return `docker compose -f ${composeFile} up -d`;
}

function recreateFailed(composeFile: string, logs: string): string {
  return `The manager was rebuilt but the auto-recreate did not take effect.\n${logs || '(no recreate output)'}\n` +
    `Finish it from the host with:  ${upHint(composeFile)}`;
}

function autheliaRestartFailed(composeFile: string, logs: string): string {
  return `The stack was recreated, but restarting Authelia failed, so its new settings have not applied.\n${logs || '(no recreate output)'}\n` +
    `Restart it from the host with:  docker compose -f ${composeFile} restart authelia`;
}

function buildStamp(): string {
  const stamp = (process.env.MANAGER_BUILD_COMMIT || '').trim();
  return /^[0-9a-f]{40}$/.test(stamp) ? stamp : '';
}

function updateFile(): string {
  return path.join(process.env.DATA_DIR || '/data/data', 'manager-update.json');
}

interface StoredUpdate extends LastUpdate { bootId: string; composeFile?: string; imageId?: string }

function writeUpdate(u: Omit<StoredUpdate, 'bootId'>): void {
  const file = updateFile();
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ ...u, bootId: BOOT_ID }));
    fs.renameSync(tmp, file);
  } catch (err) {
    console.warn(`[ManagerUpdate] Could not record the update state: ${err}`);
  }
}

function currentOpId(): string | null {
  try { return JSON.parse(fs.readFileSync(updateFile(), 'utf-8'))?.opId ?? null; } catch { return null; }
}

/** The last update; one recorded by an earlier process is judged by this build's stamp. */
export async function readLastUpdate(): Promise<LastUpdate | null> {
  let u: StoredUpdate;
  try { u = JSON.parse(fs.readFileSync(updateFile(), 'utf-8')); } catch { return null; }
  if (!u || typeof u.opId !== 'string' || typeof u.state !== 'string') return null;
  const { bootId, composeFile = 'docker-compose.remote.yml', imageId, ...last } = u;
  const judged = (state: UpdateState, message: string): LastUpdate => {
    const out = { ...last, state, message };
    if (!updateInProgress && currentOpId() === last.opId) writeUpdate({ ...out, composeFile, imageId });
    return out;
  };
  const fromExitedHelper = async (exitCode: number): Promise<LastUpdate | null> => {
    if (exitCode === 3) return judged('failed', autheliaRestartFailed(composeFile, await helperLogs()));
    if (exitCode !== 0) return judged('failed', recreateFailed(composeFile, await helperLogs()));
    return null;
  };
  if (bootId === BOOT_ID) {
    if (last.state !== 'pending' || updateInProgress) return last;
    const helper = await helperState();
    if (isLive(helper.status)) return last;
    if (helper.status === 'exited' || helper.status === 'dead') {
      const failed = await fromExitedHelper(helper.status === 'dead' ? 1 : helper.exitCode);
      if (failed) return failed;
      let running = '';
      try { running = await dockerOut(['inspect', selfContainerId(), '--format', '{{.Image}}']); } catch { /* compared below */ }
      if (imageId && running === imageId) return judged('applied', 'Update applied without a manager restart.');
      return judged('failed', recreateFailed(composeFile, await helperLogs()));
    }
    if (helper.status !== 'missing') return last;
    return judged('unknown', `The recreate helper is gone, so whether the update applied cannot be confirmed; check the stack, or run on the host:  ${upHint(composeFile)}`);
  }
  if (last.state === 'running') {
    return { ...last, state: 'interrupted', message: 'The manager restarted before the update reached the recreate step, so the update did not finish.' };
  }
  if (last.state === 'restarting' || last.state === 'pending') {
    const helper = await helperState();
    if (isLive(helper.status)) return { ...last, state: 'pending', message: 'The recreate is still running; this page reconnects when it finishes.' };
    if (helper.status === 'exited' || helper.status === 'dead') {
      const failed = await fromExitedHelper(helper.status === 'dead' ? 1 : helper.exitCode);
      if (failed) return failed;
    }
    const built = buildStamp();
    if (!built) {
      return { ...last, state: 'unstamped', message: 'The manager restarted, but this build carries no commit stamp, so whether the update applied is unknown; run update.sh on the host.' };
    }
    if (built === last.target) return { ...last, state: 'applied', message: `Updated: the manager runs ${built.slice(0, 7)}.` };
    return { ...last, state: 'not-applied', message: `The manager restarted, but it runs ${built.slice(0, 7)}, not the update's target ${(last.target || '?').slice(0, 7)}.` };
  }
  return last;
}

const execFileAsync = promisify(execFile);

async function isAncestor(commit: string, head: string): Promise<boolean> {
  try {
    await gitAsync(['merge-base', '--is-ancestor', commit, head]);
    return true;
  } catch {
    return false;
  }
}

async function gitAsync(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-c', 'safe.directory=*', '-C', REPO, ...args], { encoding: 'utf-8', timeout: 30000 });
  return stdout.trim();
}

function gitOut(args: string[]): string {
  return execSync(`git -c safe.directory='*' -C "${REPO}" ${args.join(' ')}`, { encoding: 'utf-8', timeout: 30000 }).trim();
}

/** One docker CLI call off the event loop. A read passes a timeout; a call that changes the stack passes none. */
function dockerCall(args: string[], opts: { timeout?: number; cwd?: string } = {}): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile('docker', args, { encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      const timedOut = !!err && (err as { killed?: boolean }).killed === true;
      resolve({
        status: err ? 1 : 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || '') || (timedOut ? `docker ${args[0]} did not answer within ${(opts.timeout || 0) / 1000} s` : err ? err.message : ''),
      });
    });
  });
}

async function dockerOut(args: string[]): Promise<string> {
  const r = await dockerCall(args, { timeout: DOCKER_READ_MS });
  if (r.status !== 0) throw new Error(r.stderr.trim() || `docker ${args[0]} failed`);
  return r.stdout.trim();
}

function isGitRepo(): boolean {
  try { return fs.existsSync(path.join(REPO, '.git')); } catch { return false; }
}

function selfContainerId(): string {
  return process.env.HOSTNAME || 'discordbotmanagerapp';
}

/** Read this container's compose deployment from its own labels (no host config needed). */
async function inspectSelf(): Promise<SelfInfo | null> {
  try {
    const raw = await dockerOut(['inspect', selfContainerId()]);
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

const AUTHELIA_FILES = ['configuration.yml', 'users_database.yml'];

export function autheliaConfigHash(repoDir: string): string {
  const h = createHash('sha256');
  for (const name of AUTHELIA_FILES) {
    h.update(name + '\0');
    try { h.update(fs.readFileSync(path.join(repoDir, 'authelia', name))); } catch { h.update('(missing)'); }
    h.update('\0');
  }
  return h.digest('hex');
}

export function recreateScript(project: string, composeFile: string, restartAuthelia: boolean): string {
  const compose = `docker compose -p '${project}' -f '${composeFile}'`;
  const up = `sleep 2; ${compose} up -d --remove-orphans`;
  return restartAuthelia ? `${up} && { ${compose} restart authelia || exit 3; }` : up;
}

async function composeHasService(self: SelfInfo, service: string): Promise<boolean> {
  const r = await dockerCall(['compose', '-p', self.project, '-f', self.composeFile, 'config', '--services'], { cwd: REPO, timeout: DOCKER_READ_MS });
  return r.status === 0 && r.stdout.split('\n').map((l) => l.trim()).includes(service);
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
  const live = async () => ({ updateInProgress: await isUpdateInProgress(), lastUpdate: await readLastUpdate() });
  if (updateInProgress) return { ...(versionCache || { supported: true, bootId: BOOT_ID }), ...(await live()) };
  if (versionCache && Date.now() - versionCacheAt < VERSION_TTL_MS) return { ...versionCache, ...(await live()) };
  if (!versionInFlight) {
    versionInFlight = readManagerVersion()
      .then((v) => { versionCache = v; versionCacheAt = Date.now(); return v; })
      .finally(() => { versionInFlight = null; });
  }
  const version = await versionInFlight;
  return { ...version, ...(await live()) };
}

/** Why this manager cannot update itself, or null when it can. */
export async function updateBlocker(): Promise<string | null> {
  if (!isGitRepo()) return 'Self-update needs the repo mounted at /repo (rebuild from docker-compose).';
  const self = await inspectSelf();
  if (!self) return 'Could not read this container\'s compose labels (is it compose-managed?).';
  const r = await dockerCall(['compose', '-p', self.project, '-f', self.composeFile, 'config', '--format', 'json'], { cwd: REPO, timeout: DOCKER_READ_MS });
  let build: unknown;
  try {
    if (r.status !== 0) throw new Error((r.stderr || '').trim() || 'docker compose config failed');
    build = JSON.parse(r.stdout || '').services?.[self.service]?.build;
  } catch (err) {
    return `Could not read the compose file ${self.composeFile}: ${err instanceof Error ? err.message : err}`;
  }
  if (!build) return `The ${self.service} service in ${self.composeFile} runs a pulled image (${self.image}) with no build section, so a self-update cannot rebuild it.`;
  return null;
}

/**
 * Why `compose up -d` would change the stack, or null when it would not: every
 * declared service needs a running container with the current config hash and
 * the current id of its image. Anything that cannot be compared counts as a change.
 */
export async function stackNeedsApply(self: SelfInfo): Promise<string | null> {
  // The running labels were hashed on the host, where relative binds resolve
  // against hostRepoDir; resolve them the same way here.
  const compose = ['compose', '-p', self.project, '--project-directory', self.hostRepoDir, '-f', `${REPO}/${self.composeFile}`];
  if (fs.existsSync(`${REPO}/.env`)) compose.push('--env-file', `${REPO}/.env`);
  const hashes = await dockerCall([...compose, 'config', '--hash', '*'], { cwd: REPO, timeout: DOCKER_READ_MS });
  if (hashes.status !== 0) return 'the stack config could not be read';
  const want = new Map<string, string>();
  for (const line of hashes.stdout.split('\n')) {
    const [svc, hash] = line.trim().split(/\s+/);
    if (svc && hash) want.set(svc, hash);
  }
  if (want.size === 0) return 'the stack config could not be read';
  let ids: string[];
  try {
    ids = (await dockerOut([...compose, 'ps', '-a', '-q'])).split('\n').map((l) => l.trim()).filter(Boolean);
  } catch { return 'the stack containers could not be listed'; }
  const have = new Map<string, string[]>();
  for (const id of ids) {
    try {
      const parts = (await dockerOut(['inspect', id, '--format',
        '{{index .Config.Labels "com.docker.compose.service"}} {{index .Config.Labels "com.docker.compose.config-hash"}} {{.Image}} {{.Config.Image}} {{.State.Running}}'])).split(' ');
      have.set(parts[0], parts.slice(1));
    } catch { return 'a stack container could not be inspected'; }
  }
  for (const [svc, hash] of want) {
    const c = have.get(svc);
    if (!c) return `service ${svc} has no container`;
    const [cHash, imageId, imageRef, running] = c;
    if (cHash !== hash) return `service ${svc} runs an older compose config`;
    if (running !== 'true') return `service ${svc} is not running`;
    let current = '';
    try { current = await dockerOut(['image', 'inspect', imageRef, '--format', '{{.Id}}']); } catch { return `the image of service ${svc} could not be read`; }
    if (current !== imageId) return `service ${svc} runs an older image`;
  }
  return null;
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
    const head = await gitAsync(['rev-parse', 'HEAD']);
    // The image records the commit it was built from (the self-update passes
    // it); a first build by hand records none, and the checkout stands in.
    // Anything but a full sha (a shell that did not expand the argument) counts
    // as none too.
    const built = buildStamp();
    // Stale means behind: a build the checkout cannot fast-forward to (a
    // prebuilt image ahead of the clone, or a commit it never fetched) is not.
    const buildStale = built !== '' && built !== head && await isAncestor(built, head);
    const currentCommit = (built || head).slice(0, 7);
    const stamp = { stamped: built !== '', buildCommit: built };
    const blocker = await updateBlocker();
    if (blocker) return { supported: false, bootId: BOOT_ID, reason: blocker, currentCommit, ...stamp };
    let behindBy = 0;
    let checked = true;
    let fetchError: string | undefined;
    try {
      await gitAsync(['fetch', '--quiet']);
      behindBy = parseInt(await gitAsync(['rev-list', '--count', 'HEAD..@{u}']) || '0', 10) || 0;
    } catch (err) {
      checked = false;
      const e = err as { stderr?: string; message?: string };
      fetchError = String(e?.stderr || e?.message || err).trim().split('\n')[0] || 'git fetch failed';
    }
    const self = await inspectSelf();
    const stackPending = self ? await stackNeedsApply(self) !== null : true;
    const updateAvailable = behindBy > 0 || buildStale || stackPending;
    return {
      supported: true, bootId: BOOT_ID, branch, currentCommit, repoCommit: head.slice(0, 7), buildStale, updateAvailable, behindBy,
      checked, ...(fetchError ? { fetchError } : {}), ...stamp, stackPending,
    };
  } catch (err) {
    return { supported: false, bootId: BOOT_ID, reason: `Could not read git state: ${err}` };
  }
}

/**
 * Pull + rebuild + recreate. Streams progress via emit(). RESOLVES with the outcome
 * when nothing needed applying, when the recreate applied without replacing this
 * process, or when the recreate is still running at the deadline; on a real restart
 * this process is replaced before the promise settles, and the next process judges
 * the recorded target against its build stamp. REJECTS on pull/build failure, a
 * recreate that could not launch, or a recreate that did not take effect.
 * onRestarting(target) fires once the recreate has been launched.
 */
export async function runManagerUpdate(emit: Emit, onRestarting?: (target: string) => void, opId: string = randomUUID()): Promise<UpdateOutcome> {
  updateInProgress = true;
  const record = (state: UpdateState, extra: Partial<StoredUpdate> = {}) =>
    writeUpdate({ opId, state, at: new Date().toISOString(), ...extra });
  record('running');
  try {
    const outcome = await doManagerUpdate(emit, (target, extra) => {
      record('restarting', { target, ...extra });
      onRestarting?.(target);
    }, (target, message, extra) => record('pending', { target, message, ...extra }));
    if (outcome.state !== 'pending') record(outcome.state, { message: outcome.message });
    return outcome;
  } catch (err) {
    record('failed', { message: String((err as Error)?.message || err) });
    throw err;
  } finally {
    // Never runs when the recreate replaces this process, which is fine.
    updateInProgress = false;
    versionCache = null;
  }
}

function noopOutcome(newHead: string, self: SelfInfo): UpdateOutcome {
  const built = buildStamp();
  if (!built) {
    return { state: 'noop', message: `[Update] Every service in the stack already runs its current image and config (HEAD ${newHead.slice(0, 7)}), but this build carries no commit stamp, so whether it runs HEAD is unknown; run update.sh on the host.` };
  }
  if (built !== newHead) {
    return { state: 'failed', message: `[Update] Nothing was rebuilt: this stack runs a pulled image (${self.image}) built from ${built.slice(0, 7)}, not HEAD ${newHead.slice(0, 7)}.` };
  }
  return { state: 'noop', message: `[Update] Already up to date: HEAD ${newHead.slice(0, 7)}, and every service in the stack runs its current image and config.` };
}

type Recreate = { composeFile: string; imageId: string };

async function doManagerUpdate(
  emit: Emit,
  onRestarting: (target: string, extra: Recreate) => void,
  onPending: (target: string, message: string, extra: Recreate) => void,
): Promise<UpdateOutcome> {
  if (await getDeploymentMode() !== 'docker') throw new Error('Self-update is only available in standalone docker mode.');
  if (!isGitRepo()) throw new Error('Repo not mounted at /repo; cannot self-update.');
  const self = await inspectSelf();
  if (!self) throw new Error('Could not read this container\'s compose labels (is it compose-managed?).');
  if (await helperRunning()) {
    throw new Error(`An earlier recreate (the ${HELPER} container) is still running; wait for it to finish, then check the version again.`);
  }

  emit('[Update] Fetching latest code...', 'info');
  preserveLocalUsersDb();
  const oldHead = gitOut(['rev-parse', 'HEAD']);
  const oldAuthHash = autheliaConfigHash(REPO);
  await streamProc('git', ['-c', 'safe.directory=*', '-C', REPO, 'pull', '--ff-only'], emit);
  const newHead = gitOut(['rev-parse', 'HEAD']);
  const restartAuthelia = autheliaConfigHash(REPO) !== oldAuthHash && await composeHasService(self, 'authelia');

  emit('[Update] Rebuilding the stack images...', 'info');
  await streamProc('docker', ['compose', '-p', self.project, '-f', self.composeFile, 'build', '--build-arg', `BUILD_COMMIT=${newHead}`], emit, REPO);

  // When HEAD did not move and every service already runs its current image and
  // config, `compose up -d` is a no-op: the process would survive and a blind
  // watchdog would falsely report failure. Finish here instead.
  const newImageId = await dockerOut(['image', 'inspect', self.image, '--format', '{{.Id}}']);
  const runningImageId = () => dockerOut(['inspect', selfContainerId(), '--format', '{{.Image}}']);
  if (oldHead === newHead && newImageId === await runningImageId() && await stackNeedsApply(self) === null) {
    const outcome = noopOutcome(newHead, self);
    if (outcome.state === 'failed') throw new Error(outcome.message);
    emit(outcome.message, 'success');
    return outcome;
  }

  const laneRefusal = (lane: string) => new Error(`The images were rebuilt, but the stack was not recreated: ${lane}, and a recreate would cut it short. Update again once it ends.`);
  const lane = updateLaneBlocker();
  if (lane) throw laneRefusal(lane);
  emit('[Update] Recreating the stack - the UI will drop and reconnect in a few seconds...', 'info');
  // A container can't recreate itself in-process, so launch a detached one-shot that
  // runs `compose up -d` after we return. It uses the manager's own image (has compose).
  // The repo is mounted at its OWN host path so compose resolves the relative binds
  // (`.:/repo`, `./authelia`) to real host paths; HOST_DATA_DIR covers the standalone
  // case (no .env). The same-path trick is Linux-only - on Windows the host path is not
  // a valid Linux mount target, so `docker run` fails at launch and we fall back.
  if (await helperRunning()) throw new Error(`An earlier recreate (the ${HELPER} container) is still running; wait for it to finish, then update again.`);
  await dockerCall(['rm', HELPER]);   // free the name of the exited helper (keeps its logs until now)
  const script = recreateScript(self.project, self.composeFile, restartAuthelia);
  const laneNow = updateLaneBlocker();
  if (laneNow) throw laneRefusal(laneNow);
  const r = await dockerCall([
    'run', '-d', '--name', HELPER, ...LOG_CAP_RUN_ARGS,
    '-e', `HOST_DATA_DIR=${process.env.HOST_DATA_DIR || ''}`,
    '-v', '/var/run/docker.sock:/var/run/docker.sock',
    '-v', `${self.hostRepoDir}:${self.hostRepoDir}`,
    '-w', self.hostRepoDir, self.image, 'sh', '-c', script,
  ]);
  if (r.status !== 0) {
    // Most likely a Docker Desktop host-path that didn't round-trip. The rebuild
    // already succeeded, so tell the operator how to finish it by hand.
    throw new Error(
      `Rebuilt OK, but could not launch the auto-recreate (${r.stderr.trim() || 'docker run failed'}). ` +
      `Finish it from the host with:  ${upHint(self.composeFile)}`,
    );
  }
  emit('[Update] Recreate launched - waiting for the manager to restart...', 'info');
  if (restartAuthelia) {
    emit("[Update] Authelia's configuration changed, so the recreate also restarts Authelia; that logs every admin session out. " +
      `This page cannot confirm the restart. If the new Authelia settings do not apply, run on the host:  docker compose -f ${self.composeFile} restart authelia`, 'warning');
  }
  onRestarting(newHead, { composeFile: self.composeFile, imageId: newImageId });

  // `docker run -d` reports only the LAUNCH, not the inner `compose up` result. Poll
  // the helper until it exits: a real recreate replaces THIS process mid-poll, so if
  // we survive the helper's success we compare image ids to tell "compose recreated
  // only other services" apart from "recreate did not take effect".
  const failMsg = (logs: string) => recreateFailed(self.composeFile, logs);
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  const deadline = Date.now() + 60000;
  let status = '';
  while (Date.now() < deadline) {
    await sleep(3000);
    let exitCode = NaN;
    status = '';
    try {
      const parts = (await dockerOut(['inspect', HELPER, '--format', '{{.State.Status}} {{.State.ExitCode}}'])).split(' ');
      status = parts[0];
      exitCode = Number(parts[1]);
    } catch { continue; }
    if (status !== 'exited') continue;
    if (exitCode === 3) throw new Error(autheliaRestartFailed(self.composeFile, await helperLogs()));
    if (exitCode !== 0) throw new Error(failMsg(await helperLogs()));
    await sleep(6000);   // grace tick: a real recreate kills this process during it
    if (await runningImageId() === newImageId) {
      emit('[Update] Applied without a manager restart.', 'success');
      return { state: 'applied', message: 'Update applied without a manager restart.' };
    }
    throw new Error(failMsg(await helperLogs()));
  }
  if (status !== '' && status !== 'exited' && status !== 'dead') {
    const last = (await helperLogs()).split('\n').pop() || 'no output yet';
    const message = `The recreate is still running (${last}); this page reconnects when it finishes.`;
    emit(`[Update] ${message}`, 'warning');
    onPending(newHead, message, { composeFile: self.composeFile, imageId: newImageId });
    return { state: 'pending', message };
  }
  throw new Error(failMsg(await helperLogs()));
}
