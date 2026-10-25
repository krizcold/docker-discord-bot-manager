import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'b20-4-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return {
    dir,
    volumes: new Set<string>(),
    calls: [] as string[],
    // A shell command whose text matches answers with this stderr as a failure.
    execFails: [] as Array<[RegExp, string]>,
    // First matching rule answers an execFile docker call: [predicate, ok, stdout, stderr].
    rules: [] as Array<[(args: string[]) => boolean, boolean, string, string]>,
    onExec: null as null | ((cmd: string) => void),
    onVolumeRm: null as null | (() => void),
    // The root execs the shared fence fake answers, failed as a down container fails them.
    rootFails: false,
    runs: [] as string[][],
  };
});

const fail = (stderr: string): Error => Object.assign(new Error(stderr), { stderr });
const volumeAnswer = (args: string[]): string => {
  if (args.join(' ').startsWith('image inspect')) throw fail('Error: No such image: x');
  if (args[0] === 'volume' && (args[1] === 'inspect' || args[1] === 'rm')) {
    const name = args[args.length - 1];
    if (!h.volumes.has(name)) throw fail(`Error: No such volume: ${name}`);
    if (args[1] === 'rm') { h.volumes.delete(name); h.onVolumeRm?.(); }
    return '';
  }
  return '';
};

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const execFileSync = (_f: string, args: string[]) => { h.calls.push(args.join(' ')); return volumeAnswer(args); };
  const execFile = (_f: string, args: string[], opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    h.calls.push(args.join(' '));
    const rule = h.rules.find(([match]) => match(args));
    if (rule) {
      const [, ok, stdout, stderr] = rule;
      setImmediate(() => done(ok ? null : Object.assign(new Error('docker failed'), { code: 1 }), stdout, stderr));
      return { stdin: null };
    }
    try { const out = volumeAnswer(args); setImmediate(() => done(null, out, '')); } catch (e: any) { setImmediate(() => done(e, '', e.stderr)); }
    return { stdin: null };
  };
  const execSync = () => '';
  const exec = (cmd: string, opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    h.calls.push(cmd);
    h.onExec?.(cmd);
    const failure = h.execFails.find(([re]) => re.test(cmd));
    if (failure) done(fail(failure[1]));
    else done(null, { stdout: '', stderr: '' });
  };
  const fenced = (await import('./fence-fake')).withFence(execFile as any);
  const outer = (f: string, args: string[], opts: any, cb?: any) => {
    if (args[0] === 'run') h.runs.push(args);
    if (args[0] === 'exec' && args[1] === '-u' && args[2] === 'root') {
      h.calls.push(args.join(' '));
      if (h.rootFails) {
        const done = typeof opts === 'function' ? opts : cb;
        setImmediate(() => done(Object.assign(new Error('docker failed'), { code: 1 }), '', 'Error response from daemon: container is not running'));
        return { stdin: null };
      }
    }
    return fenced(f, args, opts, cb);
  };
  const mod = { ...real, exec, execFile: outer, execFileSync, execSync };
  return { ...mod, default: mod };
});
vi.mock('../../src/casaos/detector', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/casaos/detector')>()),
  getDeploymentMode: async () => 'docker',
}));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';
import { cancelableFailback } from '../../src/instance/fleetFailback';
import { disarmRecoveryChannel, getRecoveryChannelStatus, reconcileRecoveryChannels } from '../../src/instance/recoveryChannel';
import { startRescue } from '../../src/instance/recoveryRescue';

const DB = 'bot1-fleet-postgres-data';
const registryPath = path.join(h.dir, 'instances.json');
const botDir = path.join(h.dir, 'bots', 'b1');
const composePath = path.join(botDir, 'docker-compose.yml');
const fleetDb = { containerName: 'bot1-fleet-postgres', user: 'smdb', db: 'smdb', volume: DB };
const compose = `services:
  bot:
    image: x
  fleet-postgres:
    image: postgres:16
    container_name: bot1-fleet-postgres
    volumes:
      - fleet-postgres-data:/var/lib/postgresql/data
  fleet-postgres-replica:
    image: postgres:16
    container_name: bot1-fleet-postgres-replica
volumes:
  fleet-postgres-data:
    name: ${DB}
`;
const record = (over: Record<string, unknown> = {}): any => ({
  id: 'b1', sanitizedName: 'bot1', displayName: 'Bot b1', titleName: 'Bot b1', status: 'stopped',
  sourceType: 'docker-image', envVars: {},
  createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z', ...over,
});
const writeRegistry = (inst: any): void => {
  fs.writeFileSync(registryPath, JSON.stringify({ instances: { b1: inst } }));
};
const stored = (): any => JSON.parse(fs.readFileSync(registryPath, 'utf-8')).instances.b1;

beforeEach(() => {
  h.volumes = new Set([DB]);
  h.calls = [];
  h.execFails = [];
  h.rules = [];
  h.onExec = null;
  h.onVolumeRm = null;
  h.rootFails = false;
  (globalThis as { __fenceOwners?: Map<string, string> }).__fenceOwners?.clear();
  h.runs = [];
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
  fs.mkdirSync(botDir, { recursive: true });
  fs.writeFileSync(composePath, compose);
});

afterAll(() => {
  fs.rmSync(h.dir, { recursive: true, force: true });
});

describe('R18-J4 and R7-J27: the fleet database retire', () => {
  it('stamps the retiring mark before the container is removed', async () => {
    writeRegistry(record({ fleetDb }));
    let markAtRm: unknown = 'not called';
    h.onExec = (cmd) => { if (cmd.startsWith('docker rm')) markAtRm = stored().fleetDb?.retiringAt; };
    const res = await containerManager.retireFleetDbSidecar('b1');
    expect(res.success).toBe(true);
    expect(typeof markAtRm).toBe('string');
    expect(stored().fleetDb).toBeUndefined();
  });

  it('refuses with everything kept when the deployed compose cannot be read', async () => {
    writeRegistry(record({ fleetDb }));
    fs.rmSync(composePath);
    fs.mkdirSync(composePath);
    const res = await containerManager.retireFleetDbSidecar('b1');
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/nothing was removed/);
    expect(h.volumes.has(DB)).toBe(true);
    expect(h.calls.filter((c) => c.startsWith('docker rm'))).toEqual([]);
    expect(stored().fleetDb).toMatchObject({ volume: DB });
  });

  it('keeps the volume when the container rm fails for any reason but absence, and clears its own mark', async () => {
    writeRegistry(record({ fleetDb }));
    h.execFails = [[/^docker rm/, 'Error response from daemon: permission denied']];
    const res = await containerManager.retireFleetDbSidecar('b1');
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/permission denied/);
    expect(h.volumes.has(DB)).toBe(true);
    expect(stored().fleetDb).toMatchObject({ volume: DB });
    expect(stored().fleetDb.retiringAt).toBeUndefined();
    expect(fs.readFileSync(composePath, 'utf-8')).toBe(compose);
  });

  it('tolerates a container that is already gone', async () => {
    writeRegistry(record({ fleetDb }));
    h.execFails = [[/^docker rm/, 'Error response from daemon: No such container: bot1-fleet-postgres']];
    const res = await containerManager.retireFleetDbSidecar('b1');
    expect(res.success).toBe(true);
    expect(h.volumes.has(DB)).toBe(false);
  });

  it('says the volume was removed when the compose write fails after it, keeps the mark, and a retry finishes', async () => {
    writeRegistry(record({ fleetDb }));
    h.onVolumeRm = () => fs.mkdirSync(`${composePath}.tmp`);
    const res: any = await containerManager.retireFleetDbSidecar('b1');
    expect(res.success).toBe(false);
    expect(res.volumeRemoved).toBe(true);
    expect(res.error).toMatch(/^the database volume bot1-fleet-postgres-data was removed, but its compose or record could not be updated/);
    expect(h.volumes.has(DB)).toBe(false);
    expect(typeof stored().fleetDb?.retiringAt).toBe('string');
    expect(containerManager.getBot('b1')?.fleetDb?.retiringAt).toBe(stored().fleetDb.retiringAt);

    const first = stored().fleetDb.retiringAt;
    h.onVolumeRm = null;
    fs.rmSync(`${composePath}.tmp`, { recursive: true, force: true });
    await new Promise((r) => setTimeout(r, 5));
    let markAtRetry: unknown;
    h.onExec = (cmd) => { if (cmd.startsWith('docker rm')) markAtRetry = stored().fleetDb?.retiringAt; };
    const again = await containerManager.retireFleetDbSidecar('b1');
    expect(again.success).toBe(true);
    expect(markAtRetry).toBe(first);
    expect(stored().fleetDb).toBeUndefined();
    expect(fs.readFileSync(composePath, 'utf-8')).not.toMatch(/fleet-postgres:/);
  });

  it('Start refuses while a retire is unfinished', async () => {
    writeRegistry(record({ fleetDb: { ...fleetDb, retiringAt: '2026-10-24T10:00:00.000Z' } }));
    const res = await containerManager.startBot('b1');
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/fleet database of this instance was being removed/);
    expect(h.calls.filter((c) => c.includes('compose') && c.includes(' up'))).toEqual([]);
  });

  it('the database sidecar alone refuses to come up while a retire is unfinished', async () => {
    writeRegistry(record({ fleetDb: { ...fleetDb, retiringAt: '2026-10-24T10:00:00.000Z' } }));
    const res = await containerManager.startFleetDbSidecar('b1');
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/was being removed .* and the removal did not finish/);
    expect(h.calls.filter((c) => c.includes('compose') && c.includes(' up'))).toEqual([]);
  });

  it('a retire retry that proved the volume predates the mark brings the sidecar up', async () => {
    writeRegistry(record({ fleetDb: { ...fleetDb, retiringAt: '2026-10-24T10:00:00.000Z' } }));
    const res = await containerManager.startFleetDbSidecar('b1', { retireRetry: true });
    expect(res.success).toBe(true);
    expect(h.calls.filter((c) => c.includes('compose') && c.includes(' up'))).toHaveLength(1);
  });
});

describe('R18-J4: a failback whose database retire began is past cancellation', () => {
  it('reads a retiring mark as destroyed', () => {
    const run = { mode: 'failback', phase: 'seeding', parked: true, consentAt: 1, startedAt: 1, updatedAt: 1, standInNodeId: null, episode: null, lineage: null, dump: null, block: null, serve: null, stoppedByRun: false };
    expect(cancelableFailback(record({ fleetDb, fleetFailback: run }))).toBe(true);
    expect(cancelableFailback(record({ fleetDb: { ...fleetDb, retiringAt: '2026-10-24T10:00:00.000Z' }, fleetFailback: run }))).toBe(false);
  });
});

describe('R1-J38 and R7-J27: the standby service removal', () => {
  // Linux answers ENOTDIR here; Windows answers ENOENT, which is a compose never deployed.
  it.skipIf(process.platform === 'win32')('fails, and keeps the container, when the deployed compose cannot be read', async () => {
    fs.rmSync(botDir, { recursive: true, force: true });
    fs.writeFileSync(botDir, 'a file where the bot folder should be');
    const res = await containerManager.removeFleetDbReplicaService('b1', 'bot1-fleet-postgres-replica');
    expect(res.success).toBe(false);
    expect(h.calls.filter((c) => c.startsWith('docker rm'))).toEqual([]);
  });

  it('fails, and keeps the container, when the deployed compose is a folder', async () => {
    fs.rmSync(composePath);
    fs.mkdirSync(composePath);
    const res = await containerManager.removeFleetDbReplicaService('b1', 'bot1-fleet-postgres-replica');
    expect(res.success).toBe(false);
    expect(h.calls.filter((c) => c.startsWith('docker rm'))).toEqual([]);
  });

  it('fails when the container rm fails for any reason but absence', async () => {
    h.execFails = [[/^docker rm/, 'Error response from daemon: permission denied']];
    const res = await containerManager.removeFleetDbReplicaService('b1', 'bot1-fleet-postgres-replica');
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/permission denied/);
  });

  it('succeeds over a container that is already gone and a compose that was never deployed', async () => {
    fs.rmSync(composePath);
    h.execFails = [[/^docker rm/, 'Error: No such container: bot1-fleet-postgres-replica']];
    const res = await containerManager.removeFleetDbReplicaService('b1', 'bot1-fleet-postgres-replica');
    expect(res.success).toBe(true);
  });
});

describe('R1-J38: the recovery channel disarm reports what remains', () => {
  const channel = { mode: 'source', containerName: 'bot1-recovery-relay', token: 't', createdAt: 1, endpointHost: 'h', endpointPort: 15433, pinCert: 'c' };
  const sourceBot = () => { writeRegistry(record({ fleetDb, recoveryChannel: channel })); return containerManager.getBot('b1')!; };
  const isExec = (sql: string) => (a: string[]) => a[0] === 'exec' && a.join(' ').includes(sql);
  const isStrip = (a: string[]) => a[0] === 'run' && a.join(' ').includes('default_transaction_read_only');
  const isDbInspect = (a: string[]) => a[0] === 'inspect' && a[a.length - 1] === fleetDb.containerName;

  it('keeps the record and answers an error when the fence was stripped from the files but the database runs on', async () => {
    h.rules.push([isExec('ALTER SYSTEM RESET'), false, '', 'psql: error: connection refused']);
    h.rules.push([isStrip, true, 'stripped-ro\n', '']);
    h.rules.push([isDbInspect, true, 'true\n', '']);
    const res = await disarmRecoveryChannel(sourceBot());
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/may stay READ-ONLY or refusing every connection but the manager's until its container restarts/);
    expect(stored().recoveryChannel).toMatchObject({ containerName: 'bot1-recovery-relay' });
    expect(typeof stored().recoveryChannel.disarmingAt).toBe('number');
    expect(stored().recoveryChannel.disarmLeft).toMatch(/READ-ONLY/);
  });

  it('keeps the record and says the slot is not checked when the database is not running', async () => {
    h.rules.push([isExec('ALTER SYSTEM RESET'), false, '', 'Error response from daemon: No such container: bot1-fleet-postgres']);
    h.rules.push([isStrip, true, '', '']);
    h.rules.push([isDbInspect, false, '', 'Error: No such object: bot1-fleet-postgres']);
    const res = await disarmRecoveryChannel(sourceBot());
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/could not be checked or dropped because the database is not running; a stopped database holds no WAL for it, and Disarm drops the slot once the database runs again/);
    expect(res.error).not.toMatch(/start the instance/i);
    expect(res.error).not.toMatch(/keeps holding WAL/);
    expect(h.calls.filter((c) => c.includes('pg_drop_replication_slot'))).toEqual([]);
    expect(stored().recoveryChannel?.disarmLeft).toMatch(/not running/);
  });

  it('keeps the record when the slot could not be dropped', async () => {
    h.rules.push([isDbInspect, true, 'true\n', '']);
    h.rules.push([isExec('pg_drop_replication_slot'), false, '', 'ERROR: replication slot "recovery_channel" is active']);
    const res = await disarmRecoveryChannel(sourceBot());
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/recovery_channel could not be dropped \(ERROR: replication slot "recovery_channel" is active\), so it keeps holding WAL/);
    expect(stored().recoveryChannel?.disarmLeft).toMatch(/slot/);
    const status = await getRecoveryChannelStatus(containerManager.getBot('b1')!);
    expect(status.disarming?.left).toMatch(/slot/);
  }, 15_000);

  it('clears the record when the fence file held no fence and the slot dropped', async () => {
    h.rules.push([isExec('ALTER SYSTEM RESET'), false, '', 'container not running']);
    h.rules.push([isStrip, true, '', '']);
    const res = await disarmRecoveryChannel(sourceBot());
    expect(res).toEqual({ success: true });
    expect(stored().recoveryChannel).toBeUndefined();
  });

  it('B14-2Lb: strips the fence lines from pg_hba.conf before the read-only reset', async () => {
    const { fenceOwners } = await import('./fence-fake');
    fenceOwners.set(fleetDb.containerName, 'swap:5');
    h.rules.push([isExec('SHOW default_transaction_read_only'), true, 'on\n', '']);
    const res = await disarmRecoveryChannel(sourceBot());
    expect(res).toEqual({ success: true });
    const hba = h.calls.findIndex(c => c.startsWith('exec -u root bot1-fleet-postgres sh -c') && c.includes("sed -i '/# smdb-write-fence$/d'"));
    const reset = h.calls.findIndex(c => c.includes('ALTER SYSTEM RESET default_transaction_read_only'));
    expect(hba).toBeGreaterThanOrEqual(0);
    expect(reset).toBeGreaterThan(hba);
    expect(h.calls[hba]).toContain('f=/var/lib/postgresql/data/pg_hba.conf;');
  });

  it('B14-2Lb: with the database down, the volume strip removes both layers and keeps pg_hba.conf postgres-owned', async () => {
    h.rootFails = true;
    h.rules.push([isExec('ALTER SYSTEM RESET'), false, '', 'Error response from daemon: container is not running']);
    h.rules.push([isStrip, true, 'stripped-ro\n', '']);
    h.rules.push([isDbInspect, false, '', 'Error: No such object: bot1-fleet-postgres']);
    await disarmRecoveryChannel(sourceBot());
    const run = h.runs.find(isStrip)!;
    expect(run.slice(0, 6)).toEqual(['run', '--rm', '-v', `${DB}:/pgdata`, '--entrypoint', 'sh']);
    const script = run[run.length - 1];
    expect(script).toContain("sed -i '/^default_transaction_read_only/d' /pgdata/postgresql.auto.conf");
    expect(script).toContain('f=/pgdata/pg_hba.conf;');
    expect(script).toMatch(/sed -i '\/# smdb-write-fence\$\/d' "\$f" && chown postgres:postgres "\$f" && chmod 600 "\$f"/);

    const { ownedFencedHba, MANAGED_HBA, runOnDataDir } = await import('./fence-fake');
    const ran = await runOnDataDir(script, '/pgdata', {
      'pg_hba.conf': ownedFencedHba('swap:5') + MANAGED_HBA,
      'postgresql.auto.conf': "wal_log_hints = 'on'\ndefault_transaction_read_only = 'on'\n",
      'smdb-fence-owner': 'swap:5',
    });
    expect(ran.out.trim().split('\n')).toEqual(['stripped-ro', 'stripped-hba']);
    expect(ran.files['smdb-fence-owner']).toBeUndefined();
    expect(ran.files['pg_hba.conf']).toBe(MANAGED_HBA);
    expect(ran.files['postgresql.auto.conf']).toBe("wal_log_hints = 'on'\n");
    expect(ran.chowns).toEqual(['postgres:postgres /pgdata/pg_hba.conf']);
  });

  it('the reconciler leaves a channel that is being disarmed alone', async () => {
    writeRegistry(record({ fleetDb, recoveryChannel: { ...channel, disarmingAt: 5, disarmLeft: 'x' } }));
    h.rules.push([(a) => a[0] === 'inspect', false, '', 'Error: No such object: bot1-recovery-relay']);
    process.env.RECOVERY_RELAY_IMAGE = 'img';
    try {
      await reconcileRecoveryChannels();
    } finally {
      delete process.env.RECOVERY_RELAY_IMAGE;
    }
    expect(h.calls.filter((c) => !c.endsWith('bot1-recovery-relay'))).toEqual([]);
    expect(h.calls.filter((c) => c.startsWith('run') || c.startsWith('start') || c.startsWith('rm'))).toEqual([]);
  });
});

describe('R18-J4: a rescue does not start over an unfinished retire', () => {
  it('refuses a fresh rescue while the retiring mark is set, before asking the relay', async () => {
    const fetchCalls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => { fetchCalls.push(String(url)); throw new Error('no relay in the test'); });
    try {
      const channel = { mode: 'receiver', containerName: 'bot1-recovery-relay', token: 't', createdAt: 1 };
      writeRegistry(record({ fleetDb: { ...fleetDb, retiringAt: '2026-10-24T01:00:00.000Z' }, recoveryChannel: channel }));
      const res = await startRescue(containerManager.getBot('b1')!, true);
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/was being removed \(since 2026-10-24T01:00:00.000Z\) and the removal did not finish/);
      expect(fetchCalls).toEqual([]);
      expect(stored().recoveryRescue).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
