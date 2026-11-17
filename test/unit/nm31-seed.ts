// The NM31 fixtures, each from the state the real writers leave: a main stamped by ensureFleetDataBackend, a compose
// from addFleetPostgresService or addFleetPostgresReplicaService, db-certs from writeCertFiles, an Off record from a
// real Off order. The test file mocks child_process, fs and dockerClient with nm31-run.ts before importing this.
import * as fs from 'fs';
import * as path from 'path';
import { expect, vi } from 'vitest';
import * as containerManager from '../../src/docker/containerManager';
import * as envManager from '../../src/env/manager';
import * as dbLogin from '../../src/instance/dbLogin';
import * as fleetReplica from '../../src/instance/fleetReplica';
import * as fleetReplication from '../../src/instance/fleetReplication';
import * as fleetSwitch from '../../src/instance/fleetSwitch';
import * as maintenance from '../../src/instance/maintenance';
import { writeCertFiles } from '../../src/instance/fleetJoin';
import { addFleetPostgresReplicaService, addFleetPostgresService } from '../../src/templates/pcsProcessing';
import { docker } from './nm2-docker';
import { seedBot, stored } from './nm2-harness';
import { run, PsqlAnswer, PsqlCall, stopsStop } from './nm31-run';
import { COPY_PEM, FIXTURE_PEM, fakeJoinRecord } from './join-fake';

export const SMDB = 'https://github.com/x/fully-modular-discord-bot';
export const CONTAINER = 'bota-fleet-postgres';
export const COPY_CONTAINER = 'bota-fleet-postgres-replica';
export const COPY_VOLUME = 'bota-fleet-postgres-replica-data';
export const OFF_MESSAGE = 'Moving to a new database';

export const dataDirOf = (id: string): string => path.join(process.env.DATA_DIR as string, 'bots', id, 'data');
export const composePathOf = (id: string): string => path.join(process.env.DATA_DIR as string, 'bots', id, 'docker-compose.yml');

/** The app running per bot id, as appContainerRunning answers it; absent: stopped. */
export const app: Record<string, boolean | null> = {};

export const gen = { meta: { code: 0, stdout: '0||\n' } as PsqlAnswer, restore: { code: 0, stdout: '\n' } as PsqlAnswer };

export function psqlAnswer(c: PsqlCall): PsqlAnswer {
  if (c.login === 'dbm_meta') return gen.meta;
  if (c.login === 'dbm_admin' && c.db === 'postgres' && c.input.includes('restore_state')) return gen.restore;
  return { code: 1, stderr: 'ERROR: unexpected psql call' };
}

/** What the database calls of a run answer: dbLogin and provisioning are answered here, the docker calls by nm31-run. */
export const db = {
  role: { ok: true } as dbLogin.DbResult,
  open: { ok: true } as dbLogin.DbResult,
  login: { ok: true, login: { inRecovery: false, canLogin: true, sessions: 0 } } as Awaited<ReturnType<typeof dbLogin.readBotLogin>>,
  roles: { ok: true, wrote: [] } as dbLogin.ProvisionResult,
  checksums: { ok: true, stdout: 'on\n' } as { ok: boolean; stdout?: string; stderr?: string },
};

/** Resets the fakes' answers and spies the reads every row shares; call from beforeEach. */
export function resetSeed(): void {
  for (const k of Object.keys(app)) delete app[k];
  Object.assign(gen, { meta: { code: 0, stdout: '0||\n' }, restore: { code: 0, stdout: '\n' } });
  Object.assign(db, {
    role: { ok: true }, open: { ok: true }, login: { ok: true, login: { inRecovery: false, canLogin: true, sessions: 0 } },
    roles: { ok: true, wrote: [] }, checksums: { ok: true, stdout: 'on\n' },
  });
  run.psql = psqlAnswer;
  stopsStop();
  docker.overrides.push({ match: a => a.join(' ').includes('SHOW data_checksums'), answer: () => ({ ...db.checksums }) });
  vi.spyOn(containerManager, 'appContainerRunning').mockImplementation(async (id: string) => (id in app ? app[id] : false));
  vi.spyOn(containerManager, 'runningAppContainer').mockImplementation(async () => 'f00dcafe1234');
  vi.spyOn(fleetReplica, 'instanceDataDir').mockImplementation(async (inst) => dataDirOf(inst.id));
  process.env.DEPLOYMENT_MODE = 'docker';
}

/** The database calls of a run, spied after the fixtures' Off order (which spies its own and restores them). */
export function answerDatabase(): void {
  vi.spyOn(dbLogin, 'ensureManagerDbRole').mockImplementation(async () => db.role);
  vi.spyOn(dbLogin, 'openBotLogin').mockImplementation(async () => db.open);
  vi.spyOn(dbLogin, 'readBotLogin').mockImplementation(async () => db.login);
  vi.spyOn(fleetReplication, 'provisionManagedRoles').mockImplementation(async () => db.roles);
  vi.spyOn(fleetSwitch, 'ensureMainGeneration').mockResolvedValue({ ok: true } as any);
}

function makeDataDir(id: string): void {
  const d = dataDirOf(id);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, '.env'), 'DISCORD_TOKEN=x\n');
  fs.writeFileSync(path.join(d, 'state.json'), '{}');
}

const BASE_COMPOSE = (id: string) => `services:
  app:
    image: bot${id}:latest
    container_name: bot${id}-app
    volumes:
      - ./data:/data
`;

/** The Off order as the maintenance tool runs it with the app stopped, its database calls answered at dbLogin. */
export async function offOrder(id: string, opts: { blockFails?: string } = {}): Promise<void> {
  const spies = [
    vi.spyOn(dbLogin, 'ensureManagerDbRole').mockResolvedValue({ ok: true }),
    vi.spyOn(dbLogin, 'blockBotLogin').mockResolvedValue(opts.blockFails ? { ok: false, cls: 'other', error: opts.blockFails } : { ok: true } as any),
    vi.spyOn(dbLogin, 'endBotSessions').mockResolvedValue({ ok: true }),
    vi.spyOn(dbLogin, 'readBotLogin').mockResolvedValue({ ok: true, login: { inRecovery: false, canLogin: false, sessions: 0 } }),
  ];
  try {
    const r = await maintenance.runMaintenanceOrder(id, 'off', OFF_MESSAGE);
    expect(r.settled).toBe(!opts.blockFails);
  } finally {
    spies.forEach(s => s.mockRestore());
  }
}

/** A main as ensureFleetDataBackend stamps it, its compose and data folder, and Off settled. */
export async function seedMain(id = 'a', opts: { off?: boolean; replication?: boolean } = {}): Promise<void> {
  seedBot({ sourceUrl: SMDB }, id);
  envManager.setEnvVars(id, { DATA_BACKEND: 'postgres' });
  const spec = containerManager.ensureFleetDataBackend(containerManager.getBot(id)!);
  expect(spec).not.toBeNull();
  if (opts.replication) {
    const reg = JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR as string, 'instances.json'), 'utf-8'));
    reg.instances[id].fleetDb.replication = { role: 'smdb_join', password: '', hostPort: 15432, publicHost: 'pub.example', certHost: 'pub.example' };
    fs.writeFileSync(path.join(process.env.DATA_DIR as string, 'instances.json'), JSON.stringify(reg, null, 2));
  }
  fs.mkdirSync(path.dirname(composePathOf(id)), { recursive: true });
  fs.writeFileSync(composePathOf(id), addFleetPostgresService(BASE_COMPOSE(id), containerManager.getBot(id) as any, spec!, { mode: 'docker' }));
  makeDataDir(id);
  if (opts.off !== false) await offOrder(id);
}

/** A machine's live copy: the join record, the copy record, its compose service and db-certs written by writeCertFiles. */
export async function seedCopy(id = 'a'): Promise<void> {
  const replica = {
    containerName: COPY_CONTAINER, volume: COPY_VOLUME, user: 'smdb', db: 'smdb', slot: 's1', primaryHost: 'main.invalid', primaryPort: 15432,
    publicHost: 'copy.example', hostPort: 25432, certHost: COPY_CONTAINER, seededAt: 1,
  };
  seedBot({ sourceUrl: SMDB, fleetJoin: fakeJoinRecord(), fleetDbReplica: replica }, id);
  envManager.setEnvVars(id, { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: 'postgresql://smdb:app%2Cpa%25ss@main.invalid:15432/smdb' });
  fs.mkdirSync(path.dirname(composePathOf(id)), { recursive: true });
  fs.writeFileSync(composePathOf(id), addFleetPostgresReplicaService(BASE_COMPOSE(id), containerManager.getBot(id) as any, replica, { mode: 'docker' }));
  makeDataDir(id);
  expect(await writeCertFiles(containerManager.getBot(id)!, [FIXTURE_PEM, COPY_PEM])).toBeNull();
  await offOrder(id);
}

/** A bot on a database this manager does not run (the folder variant); `certs` writes db-certs as a join refresh does. */
export async function seedExternal(id = 'a', opts: { certs?: boolean } = {}): Promise<void> {
  seedBot({ sourceUrl: SMDB }, id);
  envManager.setEnvVars(id, { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: 'postgresql://smdb:pw@db.example:5432/smdb' });
  fs.mkdirSync(path.dirname(composePathOf(id)), { recursive: true });
  fs.writeFileSync(composePathOf(id), BASE_COMPOSE(id));
  makeDataDir(id);
  if (opts.certs) expect(await writeCertFiles(containerManager.getBot(id)!, [FIXTURE_PEM])).toBeNull();
  await offOrder(id);
}

export function patchRegistry(id: string, fields: Record<string, unknown>): void {
  const file = path.join(process.env.DATA_DIR as string, 'instances.json');
  const reg = JSON.parse(fs.readFileSync(file, 'utf-8'));
  Object.assign(reg.instances[id], fields);
  fs.writeFileSync(file, JSON.stringify(reg, null, 2));
}

/** Every path under dir with its kind and, for a file, its content. */
export function treeOf(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fs.existsSync(dir)) return out;
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { out[r] = 'dir'; walk(r); } else out[r] = fs.readFileSync(path.join(dir, r), 'utf-8');
    }
  };
  walk('');
  return out;
}

export { stored };

/** The page's keptOpenLineText, run on a record as the page holds it. */
export function pageOpenLine(rec: unknown): string {
  const vm = require('vm') as typeof import('vm');
  const html = (require('fs') as typeof import('fs')).readFileSync(path.resolve(__dirname, '../../src/webui/public/index.html'), 'utf8');
  const fn = (name: string): string => {
    const start = html.indexOf(`function ${name}(`);
    let i = html.indexOf('{', html.indexOf(')', start));
    for (let depth = 0; ; i++) {
      if (html[i] === '{') depth++;
      else if (html[i] === '}' && --depth === 0) return html.slice(start, i + 1);
    }
  };
  const ctx = vm.createContext({});
  vm.runInContext(`${fn('keptStepWords')}\n${fn('keptOpenLineText')}\nthis.line = keptOpenLineText;`, ctx);
  return (ctx as { line: (r: unknown) => string }).line(rec);
}
