import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'fu-o-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir };
});

// One database per container as postgres keeps it: the live read-only value, the owner file, and the owner each
// fence line names ('' for a line that names none). Every docker call the fence, the lifts and the probes send is
// answered from it, and logged in order.
type Db = { readOnly: boolean; ownerFile: string | null; lines: string[] };
const pg = vi.hoisted(() => ({
  dbs: new Map<string, { readOnly: boolean; ownerFile: string | null; lines: string[] }>(),
  events: [] as string[],
  runs: [] as string[],
  resetFails: false,
  ownerDropFails: false,
  liveFails: false,
  volumeStripFails: false,
}));

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const HBA = '/var/lib/postgresql/data/pg_hba.conf';
  const db = (name: string) => {
    if (!pg.dbs.has(name)) pg.dbs.set(name, { readOnly: false, ownerFile: null, lines: [] });
    return pg.dbs.get(name)!;
  };
  const owners = (d: { lines: string[] }) => Array.from(new Set(d.lines.map(o => o || '-'))).join(',');
  const execFile = (_cmd: string, args: string[], optsOrCb: unknown, maybeCb?: unknown) => {
    const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as (err: Error | null, stdout: string, stderr: string) => void;
    const ok = (out = '') => setImmediate(() => cb(null, out, ''));
    const no = (err: string) => setImmediate(() => cb(new Error(err), '', err));
    const sql = args.join(' ');
    if (args[0] === 'inspect') return ok('true\n');
    if (args[0] === 'volume') return ok('[]');
    if (args[0] === 'rm') return ok();
    if (args[0] === 'run') { pg.runs.push(args[args.length - 1]); pg.events.push('volume-strip'); return pg.volumeStripFails ? no('strip refused') : ok(); }
    if (args[0] !== 'exec') return ok();
    if (args[1] === '-u' && args[2] === 'root') {
      const d = db(args[3]);
      const script = args[args.length - 1];
      if (pg.liveFails) return no('Error response from daemon: container is not running');
      if (script.includes('smdb-fence-owner; printf')) {
        pg.events.push('owner-write');
        d.ownerFile = /printf '%s' '([^']*)'/.exec(script)![1];
        return ok();
      }
      if (script.includes('grep -qx')) {
        pg.events.push('owner-drop');
        if (pg.ownerDropFails) return no('rm: cannot remove');
        const pattern = new RegExp(`^${/grep -qx '([^']*)'/.exec(script)![1].replace('[0-9][0-9]*', '[0-9]+')}$`);
        if (d.ownerFile !== null && pattern.test(d.ownerFile)) d.ownerFile = null;
        return ok();
      }
      if (script.includes('held-hba')) {
        pg.events.push('hba-lift');
        if (d.lines.length === 0) return ok();
        const pattern = /grep -v '# smdb-fence-owner=([^ ]*) # smdb-write-fence\$'/.exec(script)![1];
        const re = new RegExp(`^${pattern.replace('[0-9][0-9]*', '[0-9]+')}$`);
        if (d.lines.every(o => re.test(o))) { d.lines = []; return ok('stripped-hba\n'); }
        return ok(`held-hba ${d.lines.find(o => o) ?? ''}\n`);
      }
      if (script.includes('printf') && script.includes('smdb-write-fence')) {
        pg.events.push('hba-write');
        const named = /smdb-fence-owner=([a-z]+:[0-9]+) /.exec(script)![1];
        d.lines = [named, named];
        return ok();
      }
      return ok();
    }
    const d = db(args[1]);
    if (args.includes('127.0.0.1')) return no('psql: error: FATAL:  pg_hba.conf rejects connection for host "127.0.0.1"');
    if (sql.includes("current_setting('hba_file') ||")) {
      pg.events.push('read-settings');
      return ok(`${HBA}|on|0|0|${d.readOnly ? 'on' : 'off'}|${d.ownerFile ?? ''}|${d.lines.length}|${owners(d)}\n`);
    }
    if (sql.includes("pg_read_file('smdb-fence-owner', true)") && !sql.includes('regexp_split_to_table')) {
      if (pg.liveFails) return no('psql: error: connection refused');
      pg.events.push('owner-read');
      return ok(`${d.readOnly ? 'on' : 'off'}|${d.ownerFile ?? ''}\n`);
    }
    if (sql.includes("pg_read_file('smdb-fence-owner', true)")) return ok(`${d.readOnly ? 'on' : 'off'}|${d.lines.length}|${d.ownerFile ?? ''}|${owners(d)}\n`);
    if (sql.includes('ALTER SYSTEM SET default_transaction_read_only = on')) { pg.events.push('read-only'); d.readOnly = true; return ok(); }
    if (sql.includes('ALTER SYSTEM RESET default_transaction_read_only')) {
      pg.events.push('reset');
      if (pg.resetFails || pg.liveFails) return no('ERROR: reset refused');
      d.readOnly = false;
      return ok();
    }
    if (sql.includes("name = 'default_transaction_read_only'")) return ok('1\n');
    if (sql.includes('pg_reload_conf()')) return pg.liveFails ? no('psql: error: connection refused') : ok();
    return ok();
  };
  return { ...real, execFile, default: { ...real, execFile } };
});

import * as fs from 'fs';
import * as path from 'path';
import * as fleetBackup from '../../src/instance/fleetBackup';
import { ownedFenceLayers, runFenceOwner } from '../../src/instance/fleetFailback';
import { runOnDataDir, MANAGED_HBA } from './fence-fake';

const REGISTRY = path.join(tmp.dir, 'instances.json');
const primary = { containerName: 'bot-a-postgres', user: 'app', db: 'app', volume: 'bot-a-pgdata' };
const state = (): Db => pg.dbs.get(primary.containerName)!;
const both = { readOnly: true, hba: true };

function seedRegistry(extra: Record<string, unknown> = {}): void {
  fs.writeFileSync(REGISTRY, JSON.stringify({ instances: { a: { id: 'a', displayName: 'a', fleetDb: primary, fleetBackup: { enabled: false, hour: 4, keep: 7 }, ...extra } } }, null, 2));
}
const onDisk = () => JSON.parse(fs.readFileSync(REGISTRY, 'utf-8')).instances.a;

async function startedWithTick(fb: typeof fleetBackup): Promise<() => void> {
  let tick: () => void = () => {};
  const spy = vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void) => { tick = fn; return 0; }) as unknown as typeof setInterval);
  fb.startFleetBackupScheduler();
  spy.mockRestore();
  fb.stopFleetBackupScheduler();
  return tick;
}

async function restartedManager(): Promise<typeof fleetBackup> {
  vi.resetModules();
  return import('../../src/instance/fleetBackup');
}

beforeEach(() => {
  pg.dbs = new Map([[primary.containerName, { readOnly: false, ownerFile: null, lines: [] }]]);
  pg.events = [];
  pg.runs = [];
  pg.resetFails = false;
  pg.ownerDropFails = false;
  pg.liveFails = false;
  pg.volumeStripFails = false;
  Object.assign(fleetBackup.fenceTiming, { probeGapMs: 1 });
  seedRegistry();
});
afterAll(() => { fs.rmSync(tmp.dir, { recursive: true, force: true }); });

describe('FU-O row 1: each fence layer names its owner', () => {
  it('writes the owner file before the read-only default, and names the owner on every pg_hba line', async () => {
    const fence = await fleetBackup.applyWriteFence(primary, 'restore:1', 'any');
    expect(fence.ok).toBe(true);
    expect(pg.events.indexOf('owner-write')).toBeGreaterThan(-1);
    expect(pg.events.indexOf('owner-write')).toBeLessThan(pg.events.indexOf('read-only'));
    expect(state()).toEqual({ readOnly: true, ownerFile: 'restore:1', lines: ['restore:1', 'restore:1'] });
  });

  it('the pg_hba script writes the owner before the mark on each line, every line still ending in the mark', async () => {
    const ran = await runOnDataDir(fleetBackup.fenceHbaScript(true, 'restore:1', '/pgdata/pg_hba.conf'), '/pgdata', { 'pg_hba.conf': MANAGED_HBA });
    const lines = ran.files['pg_hba.conf'].split('\n').filter(l => l.includes('smdb-write-fence'));
    expect(lines).toHaveLength(3);
    for (const line of lines) expect(line).toMatch(/ # smdb-fence-owner=restore:1 # smdb-write-fence$/);
    expect(ran.files['pg_hba.conf'].endsWith(MANAGED_HBA)).toBe(true);
  });

  it('the owner file is written postgres-owned and 600 through a temp file', async () => {
    const ran = await runOnDataDir(fleetBackup.fenceOwnerFileScript('restore:1', '/pgdata'), '/pgdata', {});
    expect(ran.files['smdb-fence-owner']).toBe('restore:1');
    expect(ran.chowns).toEqual(['postgres:postgres /pgdata/smdb-fence-owner.new']);
    expect(fleetBackup.fenceOwnerFileScript('restore:1')).toMatch(/chmod 600 "\$f\.new" && mv -f "\$f\.new" "\$f"$/);
  });
});

describe('FU-O row 2: a promote\'s read-only layer is not a failback run\'s', () => {
  it('a re-armed park over a read-only layer with no owner file owns only the pg_hba layer, and its Cancel sends no read-only reset', async () => {
    // The failback record outlived its fence; after a restart the promote fenced the old primary read-only from the app.
    seedRegistry({ fleetConsentFenceLeft: [{ containerName: primary.containerName, owner: 'failback:1' }] });
    state().readOnly = true;
    const fb = await restartedManager();
    const prior = await fb.fenceLayers(primary);
    const owned = ownedFenceLayers(prior!, runFenceOwner({ mode: 'failback', startedAt: 2 }));
    expect(owned).toEqual({ readOnly: false, hba: true });
    await fb.fenceForConsent(primary, 'failback:2');
    pg.events = [];
    expect(await fb.liftConsentFence('a', primary, 'failback:2', 'x', owned)).toBe('lifted');
    expect(pg.events).not.toContain('reset');
    expect(pg.events).not.toContain('owner-read');
    expect(state()).toEqual({ readOnly: true, ownerFile: null, lines: [] });
  });
});

describe('FU-O row 3: the seeded warning names the owner the layers name, not the record', () => {
  it('a failback record still on disk over a promote\'s fence does not name the failback run', async () => {
    const run = { mode: 'failback', phase: 'wipe-consent', startedAt: 1, updatedAt: 1, standInNodeId: null, episode: null, lineage: null, dump: null, block: null, serve: null, stoppedByRun: false, parked: true, consentAt: null };
    seedRegistry({ fleetFailback: run, fleetConsentFenceLeft: [{ containerName: primary.containerName, owner: 'failback:1' }] });
    // Within one tick the failback's fence went off and the promote fenced the database read-only, with no owner.
    state().readOnly = true;
    const fb = await restartedManager();
    await startedWithTick(fb);
    await vi.waitFor(() => expect(fb.getFleetFenceStuck('a')).not.toBeNull());
    const text = fb.getFleetFenceStuck('a')!;
    expect(text).not.toMatch(/failback run on this instance owns it/);
    expect(text).toMatch(/no lane of this manager/);
  });
});

describe('FU-O row 4: a restore that takes over a park\'s fence owns it', () => {
  it('the failback Cancel lifts nothing and names the restore', async () => {
    await fleetBackup.applyWriteFence(primary, 'failback:5', 'lane');
    await fleetBackup.applyWriteFence(primary, 'restore:1729900000000', 'any');
    expect(state()).toEqual({ readOnly: true, ownerFile: 'restore:1729900000000', lines: ['restore:1729900000000', 'restore:1729900000000'] });
    pg.events = [];
    const held: fleetBackup.FenceHeld = { readOnly: false, hba: false, holder: null };
    expect(await fleetBackup.liftConsentFence('a', primary, 'failback:5', 'x', both, held)).toBe('held');
    expect(pg.events).not.toContain('reset');
    expect(state().readOnly).toBe(true);
    expect(state().lines).toHaveLength(2);
    expect(held).toMatchObject({ readOnly: true, hba: true, holder: 'restore:1729900000000' });
    expect(fleetBackup.heldText(held, 'the run')).toMatch(/belong to a restore \(started 2024-10-25 23:46 UTC\)/);
    expect(fleetBackup.getFleetFenceStuck('a')).toMatch(/a restore \(started/);
  });

  it('the park takes over only a layer its own lane left', async () => {
    await fleetBackup.applyWriteFence(primary, 'failback:5', 'lane');
    await fleetBackup.applyWriteFence(primary, 'failback:6', 'lane');
    expect(state().ownerFile).toBe('failback:6');
    pg.dbs.set(primary.containerName, { readOnly: true, ownerFile: null, lines: [] });
    await fleetBackup.applyWriteFence(primary, 'swap:7', 'lane');
    expect(state()).toEqual({ readOnly: true, ownerFile: null, lines: ['swap:7', 'swap:7'] });
  });

  it('the swap quiesce takes over a failback, drop-back or swap layer, never a restore, re-seed, decommission or no-owner one', async () => {
    for (const prior of ['failback:5', 'dropback:5', 'swap:5']) {
      pg.dbs.set(primary.containerName, { readOnly: true, ownerFile: prior, lines: [prior, prior] });
      await fleetBackup.applyWriteFence(primary, 'swap:9', 'run');
      expect(state()).toEqual({ readOnly: true, ownerFile: 'swap:9', lines: ['swap:9', 'swap:9'] });
    }
    for (const prior of ['restore:5', 'reseed:5', 'decommission:5', '']) {
      pg.dbs.set(primary.containerName, { readOnly: true, ownerFile: prior || null, lines: [prior, prior] });
      await fleetBackup.applyWriteFence(primary, 'swap:9', 'run');
      expect(state()).toEqual({ readOnly: true, ownerFile: prior || null, lines: [prior, prior] });
    }
  });
});

describe('FU-O row 5: the disarm lifts only a swap\'s layers', () => {
  const channel = { mode: 'source', containerName: 'bot-a-recovery-relay', token: 't', createdAt: 1, endpointHost: 'h', endpointPort: 15433, pinCert: 'c' };

  async function disarm(): Promise<{ success: boolean; error?: string; warning?: string }> {
    seedRegistry({ recoveryChannel: channel, sanitizedName: 'bot-a' });
    vi.resetModules();
    const cm = await import('../../src/docker/containerManager');
    const rc = await import('../../src/instance/recoveryChannel');
    return rc.disarmRecoveryChannel(cm.getBot('a')!);
  }

  it('a read-only layer a restore owns stays on and the answer names it', async () => {
    pg.dbs.set(primary.containerName, { readOnly: true, ownerFile: 'restore:1729900000000', lines: ['swap:2', 'swap:2'] });
    const res = await disarm();
    expect(res.success).toBe(true);
    expect(pg.events).not.toContain('reset');
    expect(state()).toEqual({ readOnly: true, ownerFile: 'restore:1729900000000', lines: [] });
    expect(res.warning).toMatch(/read-only layer of the write fence belongs to a restore \(started 2024-10-25 23:46 UTC\)/);
    expect(onDisk().recoveryChannel).toBeUndefined();
  });

  it('a read-only layer no lane owns stays on and the answer says so', async () => {
    pg.dbs.set(primary.containerName, { readOnly: true, ownerFile: null, lines: [] });
    const res = await disarm();
    expect(res.success).toBe(true);
    expect(pg.events).not.toContain('reset');
    expect(state().readOnly).toBe(true);
    expect(res.warning).toMatch(/belongs to no lane of this manager/);
  });

  it('a swap\'s layers are lifted, whichever swap set them', async () => {
    pg.dbs.set(primary.containerName, { readOnly: true, ownerFile: 'swap:3', lines: ['swap:3', 'swap:3'] });
    const res = await disarm();
    expect(res).toEqual({ success: true });
    expect(state()).toEqual({ readOnly: false, ownerFile: null, lines: [] });
  });
});

describe('FU-O row 6: half lifts leave an owner that the next step clears', () => {
  it('a reset that lands with a failed file removal leaves a stale owner the reprobe removes', async () => {
    const fb = await restartedManager();
    await fb.applyWriteFence(primary, 'restore:1', 'any');
    pg.ownerDropFails = true;
    expect(await fb.liftLaneFence('a', primary, 'restore:1', 'a restore', 'x')).toBe('');
    expect(state()).toEqual({ readOnly: false, ownerFile: 'restore:1', lines: [] });
    pg.ownerDropFails = false;
    const tick = await startedWithTick(fb);
    tick();
    await vi.waitFor(() => expect(state().ownerFile).toBeNull());
  });

  it('pg_hba lines stripped with a failed read-only reset keep the owner file, and the lane\'s next run lifts the layer', async () => {
    await fleetBackup.applyWriteFence(primary, 'reseed:1', 'any');
    pg.resetFails = true;
    pg.volumeStripFails = true;
    const note = await fleetBackup.liftLaneFence('a', primary, 'reseed:1', 'a re-seed', 'retrying the re-seed retries the lift');
    expect(note).toMatch(/stays READ-ONLY/);
    expect(state()).toEqual({ readOnly: true, ownerFile: 'reseed:1', lines: [] });
    pg.resetFails = false;
    pg.volumeStripFails = false;
    await fleetBackup.applyWriteFence(primary, 'reseed:2', 'any');
    expect(await fleetBackup.liftLaneFence('a', primary, 'reseed:2', 'a re-seed', 'retrying the re-seed retries the lift')).toBe('');
    expect(state()).toEqual({ readOnly: false, ownerFile: null, lines: [] });
  });
});

describe('FU-O row 7: the copy strips remove the owner file', () => {
  it('the copy strip removes the fence lines and the owner file', async () => {
    const ran = await runOnDataDir(fleetBackup.stripCopiedFenceScript('/pgdata'), '/pgdata', {
      'pg_hba.conf': `host all all all reject # smdb-fence-owner=restore:1 # smdb-write-fence\n${MANAGED_HBA}`,
      'smdb-fence-owner': 'restore:1',
    });
    expect(ran.files['pg_hba.conf']).toBe(MANAGED_HBA);
    expect(ran.files['smdb-fence-owner']).toBeUndefined();
  });

  it('the re-seed copy, the rescue standby, the adopt and the flip strip the owner file', () => {
    const src = (file: string) => fs.readFileSync(path.resolve(__dirname, '../../src/instance', file), 'utf8');
    const replica = src('fleetReplica.ts');
    expect(replica).toMatch(/default_transaction_read_only\/d' \$\{PGDATA\}\/postgresql\.auto\.conf && \$\{fleetBackup\.stripCopiedFenceScript\(PGDATA\)\}/);
    expect(replica).toMatch(/'exec', '-u', 'root', rec\.containerName, 'sh', '-c', fleetBackup\.stripCopiedFenceScript\(PGDATA\)/);
    const rescue = src('recoveryRescue.ts');
    expect(rescue).toMatch(/postgresql\.auto\.conf && \$\{stripCopiedFenceScript\(PGDATA\)\}/);
    expect(rescue).toMatch(/primary_slot_name\/d' \$\{PGDATA\}\/postgresql\.auto\.conf && rm -f \$\{PGDATA\}\/\$\{FENCE_OWNER_FILE\}/);
  });
});

describe('FU-O row 8: the volume fallback lifts only this lane\'s read-only line', () => {
  async function volumeScript(owner: string): Promise<string> {
    pg.liveFails = true;
    await fleetBackup.liftLaneFence('a', primary, owner, 'a restore', 'x');
    pg.liveFails = false;
    return pg.runs[pg.runs.length - 1];
  }
  const files = (owner: string) => ({
    'postgresql.auto.conf': "wal_log_hints = 'on'\ndefault_transaction_read_only = 'on'\n",
    'pg_hba.conf': `host all all all reject # smdb-fence-owner=${owner} # smdb-write-fence\n${MANAGED_HBA}`,
    'smdb-fence-owner': owner,
  });

  it('keeps the read-only line and the owner file when another lane owns them', async () => {
    const ran = await runOnDataDir(await volumeScript('restore:1'), '/pgdata', files('swap:2'));
    expect(ran.files['postgresql.auto.conf']).toContain('default_transaction_read_only');
    expect(ran.files['smdb-fence-owner']).toBe('swap:2');
    expect(ran.files['pg_hba.conf']).toContain('smdb-fence-owner=swap:2');
    expect(ran.out).toMatch(/held-ro swap:2/);
    expect(ran.out).toMatch(/held-hba swap:2/);
  });

  it('removes the line, the owner file and the fence lines when this lane owns them', async () => {
    const ran = await runOnDataDir(await volumeScript('restore:1'), '/pgdata', files('restore:1'));
    expect(ran.files['postgresql.auto.conf']).toBe("wal_log_hints = 'on'\n");
    expect(ran.files['smdb-fence-owner']).toBeUndefined();
    expect(ran.files['pg_hba.conf']).toBe(MANAGED_HBA);
  });
});

describe('FU-O row 10: the sender keeps the receiver\'s cancel with its swap record', () => {
  it('saves the cancelled swap and clears it with the swap record', async () => {
    vi.resetModules();
    const cm = await import('../../src/docker/containerManager');
    cm.updateInstanceRecoverySwappedAway('a', { at: 5 });
    cm.updateInstanceRecoverySwapAbandoned('a', { at: 6, phase: 'catchup', fenced: true });
    expect(onDisk().recoverySwapAbandoned).toEqual({ at: 6, phase: 'catchup', fenced: true });
    cm.updateInstanceRecoverySwappedAway('a', null);
    expect(onDisk().recoverySwappedAway).toBeUndefined();
    expect(onDisk().recoverySwapAbandoned).toBeUndefined();
  });
});

describe('FU-O row 11: both pg_hba rewrites keep the file 600', () => {
  it('enable and narrow chmod pg_hba.conf.new to 600 before the move', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../src/instance/fleetReplication.ts'), 'utf8');
    const writes = src.match(/cat > \$\{hbaFile\}\.new[^`]*/g) ?? [];
    expect(writes).toHaveLength(2);
    for (const w of writes) expect(w).toContain('chown postgres:postgres ${hbaFile}.new && chmod 600 ${hbaFile}.new && mv -f ${hbaFile}.new ${hbaFile}');
  });
});
