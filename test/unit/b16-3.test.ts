import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'b16-3-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir };
});

const st = vi.hoisted(() => ({
  bots: [] as any[],
  calls: [] as string[][],
  mounts: '' as string,
  // Called with each docker call before it is answered.
  onCall: null as ((args: string[]) => void) | null,
  composeAtStart: null as string | null,
  hasDb: false,
  onDump: null as (() => Promise<void>) | null,
}));

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const execFile = (_cmd: string, args: string[], _opts: any, cb: (err: any, stdout: string, stderr: string) => void) => {
    st.calls.push(args);
    if (st.onCall) st.onCall(args);
    const ok = (out: string) => setImmediate(() => cb(null, out, ''));
    const fail = (text: string) => setImmediate(() => cb(new Error(text), '', text));
    if (args[0] === 'run' && args.some(a => a.includes('then echo partial'))) ok(st.hasDb ? 'database\n' : 'empty\n');
    else if (args.join(' ').includes("to_regclass('smdb_data.meta')")) ok('f\n');
    else if (args[0] === 'ps') ok(st.mounts);
    else if (args[0] === 'inspect' && args.includes('{{.Config.Image}}')) ok('relay:1\n');
    else if (args[0] === 'inspect' && args.some(a => a.includes('.NetworkSettings.Networks'))) ok('pcs\n');
    else if (args[0] === 'inspect' && args.includes('{{.State.Running}} {{.State.ExitCode}}')) ok('false 0\n');
    else if (args[0] === 'inspect') fail(`Error: No such object: ${args[args.length - 1]}`);
    else ok('');
    return { stdin: null };
  };
  return { ...real, execFile };
});
vi.mock('../../src/instance/fleetBackup', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/instance/fleetBackup')>();
  return {
    ...real,
    runFleetDump: async () => {
      st.calls.push(['runFleetDump']);
      if (st.onDump) await st.onDump();
      return { success: true };
    },
  };
});
vi.mock('../../src/docker/containerManager', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/docker/containerManager')>();
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  return {
    ...real,
    getAllBots: () => st.bots,
    getBot: (id: string) => st.bots.find(b => b.id === id) ?? null,
    runningNonSidecarContainers: async () => [],
    startFleetDbSidecar: async (id: string) => {
      st.composeAtStart = nodeFs.readFileSync(nodePath.join(tmp.dir, 'DATA', 'AppData', 'casaos', 'apps', id, 'docker-compose.yml'), 'utf-8');
      st.calls.push(['startFleetDbSidecar']);
      return { success: true };
    },
    updateInstanceRecoveryRescue: (id: string, rec: any) => {
      const b = st.bots.find(x => x.id === id);
      if (b) b.recoveryRescue = rec ?? undefined;
    },
  };
});

import * as fs from 'fs';
import * as path from 'path';
import YAML from 'yaml';
import * as containerManager from '../../src/docker/containerManager';
import * as rescue from '../../src/instance/recoveryRescue';
import { isFleetBackupBusy } from '../../src/instance/fleetBackup';
import { putServiceBack, takeServiceOut } from '../../src/templates/pcsProcessing';

const composePath = (id: string) => path.join(tmp.dir, 'DATA', 'AppData', 'casaos', 'apps', id, 'docker-compose.yml');
const held = (id: string) => path.join(tmp.dir, 'bots', id, 'docker-compose.lane-held.json');
const compose = (id: string) => YAML.parse(fs.readFileSync(composePath(id), 'utf-8'));
const ran = (pred: (a: string[]) => boolean) => st.calls.some(pred);
const IDS = ['b1', 'b2', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7'];
const ORIGINAL = YAML.stringify({
  name: 'bot1',
  services: {
    app: { image: 'app:1', container_name: 'bot1-app', depends_on: ['fleet-postgres'] },
    'fleet-postgres': { image: 'postgres:16-alpine', container_name: 'bot1-db', volumes: [{ type: 'volume', source: 'fleet-postgres-data', target: '/var/lib/postgresql/data' }] },
  },
  volumes: { 'fleet-postgres-data': { name: 'bot1-vol' } },
  'x-casaos': { main: 'app' },
});
const fleetDb = { containerName: 'bot1-db', user: 'u', db: 'd', volume: 'bot1-vol' };

function receiver(id: string, phase: string, extra: Record<string, unknown> = {}): any {
  return {
    id, sanitizedName: id, displayName: 'Bot 1', status: 'stopped', sourceUrl: 'x', fleetDb,
    recoveryChannel: { mode: 'receiver', containerName: 'bot1-recovery-relay', token: 't', createdAt: 1, tunnelPort: 15433, publicHost: 'h', tlsKey: 'k', tlsCert: 'c' },
    recoveryRescue: { phase, startedAt: 1, updatedAt: 1, dumpDone: true },
    ...extra,
  };
}

beforeEach(() => {
  st.calls.length = 0;
  st.mounts = '';
  st.onCall = null;
  st.composeAtStart = null;
  st.hasDb = false;
  st.onDump = null;
  st.bots = [];
  fs.rmSync(path.join(tmp.dir, 'bots'), { recursive: true, force: true });
  const instances: Record<string, unknown> = {};
  for (const id of IDS) {
    fs.mkdirSync(path.dirname(held(id)), { recursive: true });
    fs.mkdirSync(path.dirname(composePath(id)), { recursive: true });
    fs.writeFileSync(composePath(id), ORIGINAL);
    instances[id] = { id, displayName: 'Bot 1', sanitizedName: id, status: 'stopped', sourceUrl: 'x', fleetDb };
  }
  fs.writeFileSync(path.join(tmp.dir, 'instances.json'), JSON.stringify({ instances }));
  vi.stubGlobal('fetch', async (url: string) => {
    if (String(url).endsWith('/backup-stop')) return new Response(JSON.stringify({ success: true, result: { labelfile: 'START WAL LOCATION: 0/2000028\n' } }), { status: 200 });
    if (String(url).endsWith('/prepare')) return new Response(JSON.stringify({ success: true, slot: 'recovery_channel', replicator: { user: 'r', password: 'p' } }), { status: 200 });
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  });
});
afterAll(() => {
  vi.unstubAllGlobals();
  fs.rmSync(tmp.dir, { recursive: true, force: true });
});

async function runUntil(bot: any, done: (r: any) => boolean, timeout = 5000): Promise<void> {
  st.bots = [bot];
  rescue.resumeRecoveryRescues();
  await vi.waitFor(() => expect(done(st.bots[0].recoveryRescue)).toBe(true), { timeout, interval: 50 });
}

describe('R11-J7: the database service leaves the app file while a lane holds it', () => {
  it('taking a service out and putting it back keeps a change made to another service meanwhile', () => {
    const out = takeServiceOut(ORIGINAL, 'bot1-db');
    expect(out.key).toBe('fleet-postgres');
    const stripped = YAML.parse(out.content);
    expect(stripped.services['fleet-postgres']).toBeUndefined();
    expect(stripped.services.app.depends_on).toBeUndefined();
    expect(stripped.volumes['fleet-postgres-data']).toEqual({ name: 'bot1-vol' });
    stripped.services.app.environment = { NEW: '1' };
    const back = YAML.parse(putServiceBack(YAML.stringify(stripped), ORIGINAL, 'fleet-postgres'));
    expect(back.services['fleet-postgres']).toEqual(YAML.parse(ORIGINAL).services['fleet-postgres']);
    expect(back.services.app.depends_on).toEqual(['fleet-postgres']);
    expect(back.services.app.environment).toEqual({ NEW: '1' });
  });

  it('a hold keeps the compose as it was, a second hold keeps the first copy, and the release puts the service back', () => {
    expect(containerManager.holdFleetDbForLane('b1')).toEqual({ success: true });
    expect(compose('b1').services['fleet-postgres']).toBeUndefined();
    expect(containerManager.fleetDbHeldForLane('b1')).toBe(true);
    expect(containerManager.holdFleetDbForLane('b1')).toEqual({ success: true });
    expect(JSON.parse(fs.readFileSync(held('b1'), 'utf-8')).content).toBe(ORIGINAL);
    expect(containerManager.releaseFleetDbFromLane('b1')).toEqual({ success: true });
    expect(compose('b1').services['fleet-postgres'].container_name).toBe('bot1-db');
    expect(compose('b1').services.app.depends_on).toEqual(['fleet-postgres']);
    expect(fs.existsSync(held('b1'))).toBe(false);
    expect(containerManager.releaseFleetDbFromLane('b1')).toEqual({ success: true });
  });

  it('a hold that finds a kept copy from an earlier lane keeps the compose as it is now', () => {
    fs.writeFileSync(held('b2'), JSON.stringify({ path: composePath('b2'), key: 'fleet-postgres', content: ORIGINAL }));
    const rebuilt = ORIGINAL.replace('postgres:16-alpine', 'postgres:17-alpine');
    fs.writeFileSync(composePath('b2'), rebuilt);
    expect(containerManager.holdFleetDbForLane('b2')).toEqual({ success: true });
    expect(JSON.parse(fs.readFileSync(held('b2'), 'utf-8')).content).toBe(rebuilt);
    expect(containerManager.releaseFleetDbFromLane('b2')).toEqual({ success: true });
    expect(compose('b2').services['fleet-postgres'].image).toBe('postgres:17-alpine');
  });

  it('a release whose kept copy cannot be read fails, names the kept file and leaves it in place', () => {
    fs.writeFileSync(held('b1'), 'not json');
    const r = containerManager.releaseFleetDbFromLane('b1');
    expect(r.success).toBe(false);
    expect(r.error).toContain(held('b1'));
    expect(fs.readFileSync(held('b1'), 'utf-8')).toBe('not json');
  });
});

describe('R11-J7: a rescue keeps its database out of CasaOS reach while it rewrites the volume', () => {
  it('the preflight takes the database out of the app file and removes its container instead of stopping it', async () => {
    st.mounts = 'bot1-db\n';
    await runUntil(receiver('r1', 'preflight'), r => r?.phase === 'bulk' && r?.parked === true);
    expect(compose('r1').services['fleet-postgres']).toBeUndefined();
    expect(compose('r1').services.app).toBeDefined();
    expect(ran(a => a[0] === 'rm' && a[1] === '-f' && a[2] === 'bot1-db')).toBe(true);
    expect(ran(a => a[0] === 'stop')).toBe(false);
  });

  it('a container that mounts the volume before an rsync pass parks the rescue at bulk and starts no pass', async () => {
    containerManager.holdFleetDbForLane('r2');
    st.mounts = 'bot1-db\n';
    await runUntil(receiver('r2', 'bulk'), r => r?.parked === true);
    const rec = st.bots[0].recoveryRescue;
    expect(rec.phase).toBe('bulk');
    expect(rec.lastError).toMatch(/^the database container was started outside the manager during the copy \(bot1-db mounts the database volume\); the copy is discarded/);
    expect(ran(a => a[0] === 'run' && a[1] === '-d')).toBe(false);
  });

  it('a container that mounts the volume when backup_label is due parks at bulk and writes no label', async () => {
    containerManager.holdFleetDbForLane('r3');
    let ps = 0;
    st.onCall = args => { if (args[0] === 'ps' && ++ps === 2) st.mounts = 'intruder\n'; };
    await runUntil(receiver('r3', 'consistent'), r => r?.parked === true, 18000);
    expect(st.bots[0].recoveryRescue.phase).toBe('bulk');
    expect(st.bots[0].recoveryRescue.lastError).toMatch(/intruder mounts the database volume/);
    expect(ran(a => a.join(' ').includes('rsync -a'))).toBe(true);
    expect(ran(a => a.join(' ').includes('backup_label'))).toBe(false);
  }, 20000);

  it('the standby step writes the standby config, then puts the database back, then starts it', async () => {
    containerManager.holdFleetDbForLane('r4');
    await runUntil(receiver('r4', 'standby'), r => r?.phase === 'streaming');
    st.bots[0].recoveryRescue = undefined;
    expect(YAML.parse(st.composeAtStart!).services['fleet-postgres'].container_name).toBe('bot1-db');
    const config = st.calls.findIndex(a => a.join(' ').includes('standby.signal'));
    const start = st.calls.findIndex(a => a[0] === 'startFleetDbSidecar');
    expect(config).toBeGreaterThanOrEqual(0);
    expect(start).toBeGreaterThan(config);
    expect(fs.existsSync(held('r4'))).toBe(false);
  });

  it('a cancel puts the database back into the app file', async () => {
    containerManager.holdFleetDbForLane('r5');
    st.bots = [receiver('r5', 'bulk', { recoveryRescue: { phase: 'bulk', startedAt: 1, updatedAt: 1, parked: true } })];
    const r = await rescue.cancelRescue(st.bots[0]);
    expect(r).toMatchObject({ success: true });
    expect(r.warning).toBeUndefined();
    expect(compose('r5').services['fleet-postgres'].container_name).toBe('bot1-db');
    expect(fs.existsSync(held('r5'))).toBe(false);
  });

  it('a cancel during the pre-rescue dump leaves the database in the app file and its container in place', async () => {
    st.hasDb = true;
    const bot = receiver('r7', 'preflight', { recoveryRescue: { phase: 'preflight', startedAt: 1, updatedAt: 1 } });
    st.onDump = async () => { expect((await rescue.cancelRescue(bot)).warning).toBeUndefined(); };
    await runUntil(bot, () => ran(a => a[0] === 'runFleetDump') && !isFleetBackupBusy('r7'));
    expect(bot.recoveryRescue).toBeUndefined();
    expect(compose('r7').services['fleet-postgres'].container_name).toBe('bot1-db');
    expect(fs.existsSync(held('r7'))).toBe(false);
    expect(ran(a => a[0] === 'rm' && a[2] === 'bot1-db')).toBe(false);
  });

  it('a cancel whose release fails says the rescue was cancelled and the database is not back', async () => {
    fs.writeFileSync(held('r6'), 'not json');
    st.bots = [receiver('r6', 'bulk', { recoveryRescue: { phase: 'bulk', startedAt: 1, updatedAt: 1, parked: true } })];
    const r = await rescue.cancelRescue(st.bots[0]);
    expect(r.success).toBe(true);
    expect(r.warning).toMatch(/^The rescue was cancelled, but the database service could not be put back into the deployed compose/);
  });
});
