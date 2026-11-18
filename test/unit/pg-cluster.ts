// A managed database cluster as the real compose makes it (POSTGRES_USER=dbm_admin, reserved_connections=4), then
// provisionRoles. For the real-Postgres rows only; the main session runs them on Linux with docker.
import { spawnSync } from 'child_process';
import { provisionRoles } from '../../src/instance/dbLogin';

export const PG_IMAGE = 'postgres:16-alpine';

export const dockerRuns = (() => {
  try {
    return spawnSync('docker', ['version'], { stdio: 'ignore', timeout: 10000 }).status === 0;
  } catch {
    return false;
  }
})();

export type Out = { status: number | null; out: string; err: string };

export function docker(args: string[], input?: string, timeout = 120000): Out {
  const r = spawnSync('docker', args, { encoding: 'utf-8', timeout, input });
  return { status: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export interface ClusterSpec {
  name: string;
  user: string;
  db: string;
  password: string;
  network?: string;
  /** POSTGRES_USER; the compose gives dbm_admin, an old cluster gave the bot role. */
  firstRole?: string;
  /** Server options after `postgres`; the compose gives reserved_connections=4. */
  serverArgs?: string[];
  /** More docker run arguments before the image: an address on the network, a published port. */
  dockerArgs?: string[];
  /** The Postgres image; PG_IMAGE when absent. */
  image?: string;
}

export interface Cluster extends ClusterSpec {
  /** psql over the container's socket as `role` in `db`; SQL on stdin, so it never reaches an argv. */
  psql(role: string, sql: string, db?: string, env?: string[]): Out;
  remove(): void;
}

/** Starts the cluster and waits over TCP: the image's first-start server listens on the socket only, so an answer there means init is over. */
export function startCluster(spec: ClusterSpec): Cluster {
  const volume = `${spec.name}-data`;
  const started = docker(['run', '-d', '--name', spec.name, ...(spec.network ? ['--network', spec.network] : []),
    '-v', `${volume}:/var/lib/postgresql/data`, ...(spec.dockerArgs ?? []),
    '-e', `POSTGRES_USER=${spec.firstRole ?? 'dbm_admin'}`, '-e', `POSTGRES_PASSWORD=${spec.password}`, '-e', `POSTGRES_DB=${spec.db}`,
    spec.image ?? PG_IMAGE, 'postgres', ...(spec.serverArgs ?? ['-c', 'reserved_connections=4'])]);
  if (started.status !== 0) {
    docker(['rm', '-f', '-v', spec.name]);
    throw new Error(`${spec.name} did not start: ${started.err}`);
  }
  let ready = false;
  for (let i = 0; i < 240 && !ready; i++) {
    ready = docker(['exec', spec.name, 'pg_isready', '-h', '127.0.0.1', '-q']).status === 0;
    if (!ready) pause(500);
  }
  if (!ready) throw new Error(`${spec.name} did not become ready`);
  return {
    ...spec,
    psql: (role, sql, db = spec.db, env = []) =>
      docker(['exec', ...env.flatMap(e => ['-e', e]), '-i', spec.name, 'psql', '-X', '-U', role, '-d', db, '-tA', '-v', 'ON_ERROR_STOP=1'], sql),
    remove: () => {
      docker(['rm', '-f', '-v', spec.name]);
      docker(['volume', 'rm', '-f', volume]);
    },
  };
}

/** startCluster, then provisionRoles with the record password; throws unless it confirms. */
export async function provisionedCluster(spec: ClusterSpec): Promise<Cluster> {
  const cluster = startCluster(spec);
  const r = await provisionRoles({ container: spec.name, user: spec.user, db: spec.db, botId: spec.name, password: spec.password, candidates: [] });
  if (!r.ok) {
    cluster.remove();
    throw new Error(`provisionRoles did not confirm ${spec.name}: ${JSON.stringify(r)}`);
  }
  return cluster;
}
