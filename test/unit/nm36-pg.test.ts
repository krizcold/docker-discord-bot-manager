import { afterAll, describe, expect, it, vi } from 'vitest';

// NM36 against a real Postgres 16. Skipped on Windows and without docker; the main session runs it on Linux.
const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm36-pg-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir };
});

vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import * as containerManager from '../../src/docker/containerManager';
import { containerMounts } from '../../src/docker/dockerClient';
import * as envManager from '../../src/env/manager';
import { clusterPsql, runCall } from '../../src/instance/dbLogin';
import * as fleetReplica from '../../src/instance/fleetReplica';
import * as fleetReplication from '../../src/instance/fleetReplication';
import { KEPT_TEXT, readKeptSsl } from '../../src/instance/keptData';
import { runMaintenanceOrder } from '../../src/instance/maintenance';
import { addFleetPostgresService } from '../../src/templates/pcsProcessing';
import { probeDatabaseUrl, splitDbUrl } from '../../src/webui/dbProbe';
import { createBotRoutes } from '../../src/webui/routes/bots';
import { type Cluster, docker, dockerRuns, PG_IMAGE, provisionedCluster, startCluster } from './pg-cluster';
import { seedBot } from './nm2-harness';

const ID = `nm36pg${process.pid}`;
const U = 'app';
const DB = 'app';
const PW = 'nm36-pg-bot-password';
const P = '/var/lib/postgresql/data';
const SMDB = 'https://github.com/x/fully-modular-discord-bot';
const NETWORK = 'dbm_internal';

const ok = (r: { status: number | null; out: string; err: string }) => {
  expect(r.status, r.err).toBe(0);
  return r.out;
};

const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const record = (c: Cluster) => ({ containerName: c.name, user: c.user, db: c.db, volume: `${c.name}-data` });
const opensslRuns = () => spawnSync('openssl', ['version'], { stdio: 'ignore' }).status === 0;

function waitReady(name: string): void {
  for (let i = 0; i < 240; i++) {
    if (docker(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-q']).status === 0) return;
    pause(500);
  }
  throw new Error(`${name} did not become ready`);
}

/** E7's read on the container's loopback over TLS, as `user`. */
const tlsRead = (name: string, user = 'dbm_admin') => docker(['exec', name, 'psql', '-X', '-w', '-d',
  `host=127.0.0.1 port=5432 dbname=postgres user=${user} sslmode=require connect_timeout=10`, '-tA', '-v', 'ON_ERROR_STOP=1', '-c', fleetReplication.LOCAL_TLS_READ_SQL]);

/** The stored URL's client: psql in a throwaway container on the network, the URL mapped as the manager's own probe maps it (D12). */
function clientSsl(url: string): { status: number | null; out: string; err: string } {
  const split = splitDbUrl(url)!;
  return docker(['run', '--rm', '--network', NETWORK, ...(split.password ? ['-e', `PGPASSWORD=${split.password}`] : []), PG_IMAGE,
    'psql', '-X', split.url, '-tA', '-c', 'SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()']);
}

const showSsl = async (name: string) => runCall(name, clusterPsql(name, 'SHOW ssl'));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

const router = createBotRoutes({ clients: new Set() } as any);
async function call(routePath: string, params: Record<string, string>): Promise<{ status: number; body: any }> {
  const layer = (router as any).stack.find((l: any) => l.route?.path === routePath && l.route.methods.post);
  expect(layer, `POST ${routePath}`).toBeTruthy();
  const res: any = { statusCode: 200 };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  await layer.route.stack[layer.route.stack.length - 1].handle({ params, query: {}, body: {} }, res);
  return { status: res.statusCode, body: res.body };
}

const cleanups: Array<() => void> = [];
const clusters: Cluster[] = [];
afterAll(() => {
  for (const c of clusters) c.remove();
  for (const f of cleanups) f();
  fs.rmSync(h.dir, { recursive: true, force: true });
});

const dataDirOf = (id: string) => path.join(process.env.DATA_DIR as string, 'bots', id, 'data');

/**
 * The kept database as the manager makes it (nm31-pg PG2's fixture): a main stamped by ensureFleetDataBackend, its compose
 * from addFleetPostgresService on dbm_internal, started by startFleetDbSidecar and provisioned; Enable by its own code
 * when `enable`; then the data folder and Off by the real order.
 */
async function keptMain(tag: string, enable: boolean): Promise<{ id: string; name: string; oldVolume: string }> {
  // The id as the create path writes it (uuidv4), so copyLogin(id) is a machine login name; the names derive from `name`.
  const id = crypto.randomUUID();
  const name = `${ID}${tag}`;
  const created = docker(['network', 'inspect', NETWORK]).status === 0 ? null : NETWORK;
  if (created) ok(docker(['network', 'create', created]));
  process.env.DEPLOYMENT_MODE = 'docker';
  seedBot({ sourceUrl: SMDB, sanitizedName: name }, id);
  envManager.setEnvVars(id, { DATA_BACKEND: 'postgres' });
  const spec = containerManager.ensureFleetDataBackend(containerManager.getBot(id)!)!;
  expect(spec).not.toBeNull();
  const composePath = path.join(process.env.DATA_DIR as string, 'bots', id, 'docker-compose.yml');
  fs.mkdirSync(path.dirname(composePath), { recursive: true });
  fs.writeFileSync(composePath, addFleetPostgresService(`services:\n  app:\n    image: bot${name}:latest\n    container_name: bot${name}-app\n    volumes:\n      - ./data:/data\n`,
    containerManager.getBot(id) as any, spec, { mode: 'docker' }));
  cleanups.push(() => {
    docker(['rm', '-f', spec.containerName]);
    const kept = containerManager.getBot(id)?.keptSets ?? [];
    for (const v of new Set([spec.volume, containerManager.getBot(id)?.fleetDb?.volume, ...kept.map(s => s.db?.volume)])) if (v) docker(['volume', 'rm', '-f', v]);
    docker(['network', 'rm', `${name}_default`]);
    if (created) docker(['network', 'rm', created]);
  });
  expect(await containerManager.startFleetDbSidecar(id)).toEqual({ success: true });
  expect(await fleetReplication.provisionManagedRoles(containerManager.getBot(id)!)).toMatchObject({ ok: true });
  if (enable) {
    const r = await fleetReplication.enableFleetReplication(containerManager.getBot(id)!, 'nm36.example', await freePort(), undefined, { offerAddresses: false });
    expect(r, r.error).toMatchObject({ success: true });
    expect(envManager.getEnvVars(id).DATA_BACKEND_URL.endsWith('?sslmode=no-verify')).toBe(true);
    expect(await showSsl(spec.containerName)).toMatchObject({ ok: true, stdout: 'on\n' });
  }
  const d = dataDirOf(id);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, '.env'), 'DISCORD_TOKEN=x\n');
  fs.writeFileSync(path.join(d, 'state.json'), '{}');
  vi.spyOn(fleetReplica, 'instanceDataDir').mockImplementation(async (inst) => dataDirOf(inst.id));
  const off = await runMaintenanceOrder(id, 'off', 'Moving to a new database');
  expect(off.settled, off.text).toBe(true);
  return { id, name: spec.containerName, oldVolume: spec.volume };
}

/** The done text the run must answer, from the record as the run left it. */
function doneOf(id: string, replication: boolean, tls: boolean): string {
  const bot = containerManager.getBot(id)!;
  const kept = bot.keptSets![0];
  return KEPT_TEXT.nDoneMain({ old: kept.db!.volume, outDir: kept.folder!, newVolume: bot.fleetDb!.volume, certs: false, replication, sharers: null, ...(tls ? { tls: true } : {}) });
}

const skip = process.platform === 'win32' || !dockerRuns;
const composeRuns = !skip && docker(['compose', 'version']).status === 0;

describe.skipIf(skip)('NM36: Start on a new database keeps TLS, against a real Postgres 16 (Linux with docker)', () => {
  it('PG1 (T1, T23): a database Enable turned TLS on for: the route answers done with TLS, the new database runs TLS, the unchanged URL connects over TLS; Enable on it then rotates the certificate', async () => {
    expect(opensslRuns(), 'this row needs openssl in the runner').toBe(true);
    expect(composeRuns, 'this row needs the docker compose plugin in the runner').toBe(true);
    const { id, name, oldVolume } = await keptMain('a', true);
    const url = envManager.getEnvVars(id).DATA_BACKEND_URL;
    const spy = vi.spyOn(fleetReplication, 'ensureLocalTls');
    const r = await call('/:id/fleet-db/new-start', { id });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toEqual({ success: true, text: doneOf(id, true, true) });
    const newVolume = containerManager.getBot(id)!.fleetDb!.volume;
    expect(newVolume).not.toBe(oldVolume);
    expect(containerMounts(name, P)).toEqual({ ok: true, mounts: [`volume ${newVolume}`] });
    expect(await showSsl(name)).toMatchObject({ ok: true, stdout: 'on\n' });
    expect(envManager.getEnvVars(id).DATA_BACKEND_URL).toBe(url);
    expect(ok(clientSsl(url))).toBe('t');
    expect(await probeDatabaseUrl(url, NETWORK)).toMatchObject({ ok: true });
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();

    const again = await fleetReplication.enableFleetReplication(containerManager.getBot(id)!, 'nm36b.example', await freePort(), undefined, { offerAddresses: false });
    expect(again, again.error).toMatchObject({ success: true, certRotated: true });
    const crt = ok(docker(['exec', name, 'cat', `${P}/server.crt`]));
    expect(new crypto.X509Certificate(crt).subject).toBe('CN=nm36b.example');
    expect(ok(clientSsl(envManager.getEnvVars(id).DATA_BACKEND_URL))).toBe('t');
  }, 600_000);

  it('PG2 (T2): the same fixture without Enable: no TLS clause, ssl off, no certificate, the plain URL connects without TLS, no TLS call', async () => {
    expect(composeRuns, 'this row needs the docker compose plugin in the runner').toBe(true);
    const { id, name } = await keptMain('b', false);
    const url = envManager.getEnvVars(id).DATA_BACKEND_URL;
    const spy = vi.spyOn(fleetReplication, 'ensureLocalTls');
    const r = await call('/:id/fleet-db/new-start', { id });
    expect(r).toEqual({ status: 200, body: { success: true, text: doneOf(id, false, false) } });
    expect(await showSsl(name)).toMatchObject({ ok: true, stdout: 'off\n' });
    expect(docker(['exec', name, 'test', '-e', `${P}/server.crt`]).status).not.toBe(0);
    expect(ok(clientSsl(url))).toBe('f');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  }, 600_000);
});

/** A cluster as the pre-redesign manager made it (nm34-pg's oldCluster): POSTGRES_USER is the bot role, no command. */
function oldCluster(name: string, image: string): Cluster {
  return startCluster({ name, user: U, db: DB, password: PW, firstRole: U, serverArgs: [], image });
}

const catalogOf = (c: Cluster) => [
  ok(c.psql(U, 'SELECT string_agg(rolname, \',\' ORDER BY rolname) FROM pg_roles', 'postgres')),
  ok(c.psql(U, "SELECT coalesce(to_regnamespace('smdb_manager')::text, 'none')", 'postgres')),
  ok(c.psql(U, "SELECT coalesce(to_regnamespace('smdb_manager')::text, 'none')", DB)),
];

/** A pair from generateCertPair; answers its PEM text. */
async function certPair(): Promise<{ key: string; crt: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nm36-pair-'));
  try {
    expect(await fleetReplication.generateCertPair(dir, 'localhost')).toEqual({ ok: true });
    return { key: fs.readFileSync(path.join(dir, 'server.key'), 'utf-8'), crt: fs.readFileSync(path.join(dir, 'server.crt'), 'utf-8') };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** E3's commands: the file under its .new name, owned by postgres, mode 600, then renamed into place. */
function installPair(name: string, pair: { key: string; crt: string }): void {
  for (const [file, content] of [[`${P}/server.key`, pair.key], [`${P}/server.crt`, pair.crt]]) {
    ok(docker(['exec', '-i', name, 'sh', '-c', `cat > ${file}.new && chown postgres:postgres ${file}.new && chmod 600 ${file}.new`], content));
  }
  ok(docker(['exec', name, 'sh', '-c', `mv -f ${P}/server.key.new ${P}/server.key && mv -f ${P}/server.crt.new ${P}/server.crt`]));
}

describe.skipIf(skip)('NM36: A21 and the TLS step on real clusters (Linux with docker)', () => {
  it.each([PG_IMAGE, 'postgres:16.0-alpine'])('PG3 (A21 as the bot role, %s): S4 reads off, then on after TLS is turned on as the bot role; the catalog unchanged by both reads', async (image) => {
    expect(opensslRuns(), 'this row needs openssl in the runner').toBe(true);
    const c = oldCluster(`${ID}-pg3-${image.replace(/[^a-z0-9]/g, '')}`, image);
    clusters.push(c);
    let before = catalogOf(c);
    expect(await readKeptSsl(record(c), { noAdmin: true })).toEqual({ ok: true, on: false });
    expect(catalogOf(c)).toEqual(before);
    installPair(c.name, await certPair());
    ok(c.psql(U, 'ALTER SYSTEM SET ssl = on;', 'postgres'));
    expect(ok(c.psql(U, 'SELECT pg_reload_conf();', 'postgres'))).toBe('t');
    let read = '';
    for (let i = 0; i < 40 && read !== 'on|true'; i++) {
      read = tlsRead(c.name, U).out;
      if (read !== 'on|true') pause(250);
    }
    expect(read).toBe('on|true');
    before = catalogOf(c);
    expect(await readKeptSsl(record(c), { noAdmin: true })).toEqual({ ok: true, on: true });
    expect(catalogOf(c)).toEqual(before);
  }, 240_000);

  it('PG4 (A21 as dbm_admin, T12 to T15, T22, G0): the mount read names the volume; ensureLocalTls turns TLS on, a second run keeps the pair, a restart keeps TLS; a removed container reads gone', async () => {
    expect(opensslRuns(), 'this row needs openssl in the runner').toBe(true);
    const c = await provisionedCluster({ name: `${ID}-pg4`, user: U, db: DB, password: PW });
    clusters.push(c);
    expect(containerMounts(c.name, P)).toEqual({ ok: true, mounts: [`volume ${c.name}-data`] });
    expect(await readKeptSsl(record(c))).toEqual({ ok: true, on: false });
    expect(await fleetReplication.ensureLocalTls(c.name)).toBeNull();
    expect(await readKeptSsl(record(c))).toEqual({ ok: true, on: true });
    const sha = () => ok(docker(['exec', c.name, 'sha256sum', `${P}/server.crt`]));
    const first = sha();
    expect(await fleetReplication.ensureLocalTls(c.name)).toBeNull();
    expect(sha()).toBe(first);
    ok(docker(['restart', c.name]));
    waitReady(c.name);
    expect(await showSsl(c.name)).toMatchObject({ ok: true, stdout: 'on\n' });
    let read = '';
    for (let i = 0; i < 40 && read !== 'on|true'; i++) {
      read = tlsRead(c.name).out;
      if (read !== 'on|true') pause(250);
    }
    expect(read).toBe('on|true');
    c.remove();
    expect(containerMounts(c.name, P)).toEqual({ gone: true });
  }, 240_000);

  it('PG5 (D6, T10): a key that does not match the certificate: the server refuses TLS, ensureLocalTls answers off true and undoes ssl and the pair; a restart starts; a second run installs a fresh pair that loads', async () => {
    expect(opensslRuns(), 'this row needs openssl in the runner').toBe(true);
    const c = await provisionedCluster({ name: `${ID}-pg5`, user: U, db: DB, password: PW });
    clusters.push(c);
    const a = await certPair();
    const b = await certPair();
    installPair(c.name, { key: b.key, crt: a.crt });
    const saved = { ...fleetReplication.LOCAL_TLS_TIMING };
    fleetReplication.LOCAL_TLS_TIMING.deadlineMs = 3000;
    try {
      const r = await fleetReplication.ensureLocalTls(c.name);
      expect(r?.off).toBe(true);
      expect(r?.why.startsWith('the server still refused TLS 3 s after the reload: ')).toBe(true);
      expect(r?.undo).toEqual({ stage: 'done' });
    } finally {
      Object.assign(fleetReplication.LOCAL_TLS_TIMING, saved);
    }
    // The reload only signals the postmaster; a session started before it rereads the files still shows ssl on.
    let ssl = '';
    for (let i = 0; i < 40 && ssl !== 'off\n'; i++) {
      ssl = (await showSsl(c.name)).stdout;
      if (ssl !== 'off\n') pause(250);
    }
    expect(ssl).toBe('off\n');
    for (const f of ['server.crt', 'server.key']) {
      expect(docker(['exec', c.name, 'test', '-e', `${P}/${f}`]).status, f).not.toBe(0);
      expect(docker(['exec', c.name, 'test', '-e', `${P}/${f}.new`]).status, `${f}.new`).toBe(0);
    }
    ok(docker(['restart', c.name]));
    waitReady(c.name);
    expect(await showSsl(c.name)).toMatchObject({ ok: true, stdout: 'off\n' });
    expect(await fleetReplication.ensureLocalTls(c.name)).toBeNull();
    expect(tlsRead(c.name).out).toBe('on|true');
    c.remove();
  }, 240_000);
});
