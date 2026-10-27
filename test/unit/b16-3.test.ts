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
  };
});

import * as fs from 'fs';
import * as path from 'path';
import YAML from 'yaml';
import * as containerManager from '../../src/docker/containerManager';
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
});
afterAll(() => {
  fs.rmSync(tmp.dir, { recursive: true, force: true });
});

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
