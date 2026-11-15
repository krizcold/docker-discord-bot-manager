import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm22-l5-f-join-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return {
    dir,
    ends: [] as Array<{ args: string[]; ended: boolean }>,
    stdinError: false,
    thrown: [] as unknown[],
    onSpawn: null as ((args: string[]) => void) | null,
  };
});

vi.mock('child_process', async (importOriginal) => {
  const m = (await import('./join-fake')).childProcessMock(await importOriginal<typeof import('child_process')>()) as any;
  const inner = m.spawn;
  const spawn = (cmd: string, args: string[], opts?: unknown) => {
    const c = inner(cmd, args, opts);
    const rec = { args, ended: false };
    h.ends.push(rec);
    const end = c.stdin.end.bind(c.stdin);
    c.stdin.end = (...a: unknown[]) => { rec.ended = true; return end(...a); };
    h.onSpawn?.(args);
    if (h.stdinError) {
      setTimeout(() => {
        try { c.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })); } catch (e) { h.thrown.push(e); }
      }, 0);
    }
    return c;
  };
  return { ...m, spawn, default: { ...m.default, spawn } };
});
vi.mock('../../src/casaos/detector', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/casaos/detector')>()),
  getDeploymentMode: async () => 'docker',
}));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));
vi.mock('../../src/docker/dockerClient', async (importOriginal) => {
  const { docker } = await import('./join-fake');
  return { ...(await importOriginal<typeof import('../../src/docker/dockerClient')>()), volumeState: () => (docker.volumeExists ? 'exists' : 'absent') };
});
vi.mock('../../src/docker/containerManager', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/docker/containerManager')>();
  const { docker } = await import('./join-fake');
  return {
    ...real,
    deployedComposeExists: () => true,
    markPendingApplyIfRunning: async () => undefined,
    applyFleetDbReplicaService: async () => { docker.events.push('apply'); docker.running = 'true'; return { success: true }; },
    removeFleetDbReplicaService: async () => { docker.events.push('service-out'); docker.running = 'false'; return { success: true }; },
  };
});

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';
import { certSource, joinFleet, runPrimaryClient } from '../../src/instance/fleetJoin';
import { getFleetReplicaStatus, provisionFleetReplica, reseedStalePrimary } from '../../src/instance/fleetReplica';
import { docker, fakeJoinCode, fakeJoinRecord, FIXTURE_FP, FIXTURE_PEM, resetDocker } from './join-fake';

const SMDB = 'https://example.invalid/fake/super-modular-discord-bot';
const REGISTRY = path.join(h.dir, 'instances.json');
const ID = '0f1e2d3c-4b5a-4968-8776-655443322110';
const LOGIN = 'smdb_copy_0f1e2d3c4b5a49688776655443322110';
const OTHER = 'smdb_copy_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const OWN_PW = 'Own-Machine-Secret-01';
const PROBE_REFUSED = `psql: error: connection to server at "main.invalid" (192.0.2.10), port 15432 failed: FATAL:  password authentication failed for user "${LOGIN}"`;
const JOIN_MINT = (reason: string) => `The main at main.invalid:15432 could not make a login for this machine (${reason}); nothing was changed.`;
const NO_OWN_LOGIN = "this machine's own login to the main is not stored; press Re-seed (or Join, on a machine without a copy) to get a new one; if the main still has this machine's earlier login, the answer names it";
const NO_LOGIN_TEXT = `${NO_OWN_LOGIN.charAt(0).toUpperCase()}${NO_OWN_LOGIN.slice(1)}.`;
const ADDR_TAKEN = `its address copy.invalid:15433 is listed on the main for the machine login ${OTHER}. If no machine uses that address under that login any more, remove the login ${OTHER} in the main's Database window; this machine then adds its address at its next hourly check`;

const base = (over: Record<string, unknown> = {}) => ({
  id: ID, sanitizedName: 'b', displayName: 'B', titleName: 'B', status: 'running', sourceType: 'git', sourceUrl: SMDB,
  envVars: { DATA_BACKEND: 'postgres' }, createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z', ...over,
});
const writeRegistry = (over: Record<string, unknown> = {}, password: string | null = OWN_PW) => {
  fs.writeFileSync(REGISTRY, JSON.stringify({ instances: { [ID]: base(over) } }, null, 2));
  if (password !== null) containerManager.updateInstanceFleetLogin(ID, { password });
};
const bot = () => containerManager.getBot(ID)!;
const settled = async () => {
  for (let i = 0; i < 500; i++) {
    const seed = containerManager.getBot(ID)?.fleetDbReplicaSeed;
    if (!seed || seed.parked) return containerManager.getBot(ID)!;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error('the seed did not settle');
};

const realFetch = certSource.fetch;
let fetches = 0;
beforeEach(() => {
  resetDocker();
  h.ends = [];
  h.stdinError = false;
  h.thrown = [];
  h.onSpawn = null;
  fetches = 0;
  certSource.fetch = async () => { fetches++; return { ok: true, pem: FIXTURE_PEM, fp: FIXTURE_FP }; };
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
  fs.mkdirSync(path.join(h.dir, 'bots', ID, 'env'), { recursive: true });
  writeRegistry();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => {
  certSource.fetch = realFetch;
  fs.rmSync(h.dir, { recursive: true, force: true });
});

describe('runPrimaryClient and its stdin', () => {
  it('a run with no stdin leaves the client\'s stdin as it is', async () => {
    const r = await runPrimaryClient('b-probe', { password: 'pw-1234' }, [], 'psql', ['-Atc', 'SELECT 1'], 60_000);
    expect(r.ok).toBe(true);
    expect(h.ends).toHaveLength(1);
    expect(h.ends[0].args).not.toContain('-i');
    expect(h.ends[0].ended).toBe(false);
  });

  it('a run with stdin ends it with the text; a write error on it (EPIPE) does not escape', async () => {
    h.stdinError = true;
    const r = await runPrimaryClient('b-mint', { password: 'pw-1234' }, [], 'sh', ['-c', 'cat'], 60_000, { stdin: 'SELECT 1;\n' });
    await new Promise(res => setTimeout(res, 20));
    expect(r.ok).toBe(true);
    expect(h.ends[0].ended).toBe(true);
    expect(h.thrown).toEqual([]);
  });
});

describe('the mint answers a word the manager does not read', () => {
  it('JOIN-MINT names that the answer was not read', async () => {
    docker.mint = { out: 'maybe', fail: '' };
    docker.main.fail = PROBE_REFUSED;
    expect(await joinFleet(bot(), fakeJoinCode())).toEqual({ success: false, error: JOIN_MINT('the main gave an answer the manager does not read') });
  });
});

describe('the seed after its mint', () => {
  it('a cancel recorded while the mint runs stops the seed before its probe of the main', async () => {
    writeRegistry({ fleetJoin: fakeJoinRecord() }, null);
    h.onSpawn = (args) => {
      if (!args.includes('b-fleet-join-login')) return;
      const raw = JSON.parse(fs.readFileSync(REGISTRY, 'utf-8'));
      raw.instances[ID].fleetDbReplicaSeed = { ...raw.instances[ID].fleetDbReplicaSeed, cancelRequested: true };
      fs.writeFileSync(REGISTRY, JSON.stringify(raw, null, 2));
    };
    expect(provisionFleetReplica(bot(), 'copy.invalid', 15433)).toEqual({ success: true, started: true });
    await settled();
    expect(docker.events).toContain('mint');
    expect(docker.events).not.toContain('seed-probe');
    expect(docker.events).not.toContain('basebackup');
  });

  it('an address the main lists for another machine: the note has no sentence after it', async () => {
    writeRegistry({ fleetJoin: fakeJoinRecord() });
    docker.registerFail = `ERROR:  smdb-address-taken: copy.invalid:15433 is listed with the slot fleet_standby_${OTHER.slice(10)}`;
    provisionFleetReplica(bot(), 'copy.invalid', 15433);
    await settled();
    const note = `The copy runs, but its address could not be added to the main's list (${ADDR_TAKEN}).`;
    const text = (await getFleetReplicaStatus(bot())).seedNote ?? '';
    expect(text.startsWith(note)).toBe(true);
    expect(/^(\s|$)/.test(text.slice(note.length))).toBe(true);
  });
});

describe('Rejoin as a copy with a code that names a machine login', () => {
  const stale = () => ({
    status: 'stopped',
    fleetDb: { containerName: 'b-fleet-postgres', user: 'smdb', db: 'smdb', volume: 'b-pgdata', replication: { role: 'smdb_join', password: '', hostPort: 15440, publicHost: 'b.invalid', certHost: 'b.invalid' } },
  });
  const composed = { repl: { user: OTHER, password: 'x' } };

  it('with no stored password: NO-OWN-LOGIN, before any call to the main or to docker', async () => {
    writeRegistry(stale(), null);
    expect(await reseedStalePrimary(bot(), fakeJoinCode(composed), undefined)).toEqual({ success: false, error: NO_LOGIN_TEXT });
    expect(fetches).toBe(0);
    expect(docker.calls).toEqual([]);
  });

  it('with a stored password the guard passes: the next step, the certificate, answers', async () => {
    writeRegistry(stale());
    certSource.fetch = async () => { fetches++; return { ok: false, reason: 'connect ECONNREFUSED 192.0.2.10:15432' }; };
    const r = await reseedStalePrimary(bot(), fakeJoinCode(composed), undefined);
    expect(fetches).toBe(1);
    expect(r.success).toBe(false);
    expect(r.error).toContain('connect ECONNREFUSED 192.0.2.10:15432');
  });
});
