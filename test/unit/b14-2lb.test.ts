import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'b14-2lb-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir };
});

const HBA = '/var/lib/postgresql/data/pg_hba.conf';

// Every docker step the fence, the lifts and the lanes take, in order, with the scripts and SQL they sent.
const pg = vi.hoisted(() => ({
  events: [] as string[],
  scripts: [] as string[],
  sql: [] as string[],
  settings: '',
  rejects: true,
  sweep: '',
  recheck: '0',
  layers: 'off|0',
  hbaStripFails: false,
  resetFails: false,
  volumeStripFails: false,
  // Per docker run, in order; empty falls back to volumeStripFails.
  volumeStripPlan: [] as boolean[],
  spawned: [] as string[],
  reloadFails: false,
  restoreFails: false,
  rewrites: [] as string[],
  hbaCount: '0',
  // The owner file's content; '' when missing.
  owner: '',
  // The read-only value the lift reads: on until a reset lands.
  readOnly: true,
}));

vi.mock('../../src/config/appCapabilities', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/config/appCapabilities')>();
  return { ...real, findAppCapabilities: () => ({ companionDb: { env: { url: 'DATABASE_URL' } } }) };
});
vi.mock('../../src/env/manager', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/env/manager')>();
  return {
    ...real,
    getEnvVarsWithStatus: () => ({ vars: { DATABASE_URL: 'postgres://bot-a-postgres/app' }, corrupt: false, undecryptable: [] }),
    getEnvVars: () => ({ DATABASE_URL: 'postgres://bot-a-postgres/app' }),
  };
});
vi.mock('../../src/docker/containerManager', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/docker/containerManager')>();
  return {
    ...real,
    runningNonSidecarContainers: async () => [],
    runningInstanceContainers: async () => [],
    deployedComposeExists: () => true,
    startFleetDbSidecar: async () => ({ success: true }),
    stopBot: async () => ({ success: true }),
    startBot: async () => ({ success: true }),
  };
});

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const { EventEmitter } = require('events') as typeof import('events');
  const { PassThrough } = require('stream') as typeof import('stream');
  const fail = (cb: (err: Error | null, stdout: string, stderr: string) => void, stderr: string) => cb(new Error(stderr), '', stderr);
  const execFile = vi.fn((_cmd: string, args: string[], optsOrCb: unknown, maybeCb?: unknown) => {
    const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as (err: Error | null, stdout: string, stderr: string) => void;
    const sql = args.join(' ');
    if (args[0] === 'inspect') return cb(null, 'true\n', '');
    if (args[0] === 'volume' && args[1] === 'inspect') return cb(null, '[]', '');
    if (args[0] === 'run') {
      pg.events.push('volume-strip');
      pg.scripts.push(args[args.length - 1]);
      const fails = pg.volumeStripPlan.length > 0 ? pg.volumeStripPlan.shift()! : pg.volumeStripFails;
      return fails ? fail(cb, 'strip refused') : cb(null, '', '');
    }
    if (args[0] !== 'exec') return cb(null, '', '');
    if (args[1] === '-u' && args[2] === 'root') {
      const script = args[args.length - 1];
      pg.scripts.push(script);
      if (script.includes('smdb-fence-owner; printf')) {
        pg.events.push('owner-write');
        pg.owner = /printf '%s' '([^']*)'/.exec(script)![1];
        return cb(null, '', '');
      }
      if (script.includes('grep -qx')) {
        pg.events.push('owner-drop');
        if (script.includes(`grep -qx '${pg.owner}'`)) pg.owner = '';
        return cb(null, '', '');
      }
      if (script.includes('printf')) { pg.events.push('hba-write'); return cb(null, '', ''); }
      pg.events.push('hba-strip');
      return pg.hbaStripFails ? fail(cb, 'sed: permission denied') : cb(null, '', '');
    }
    if (args.includes('127.0.0.1')) {
      pg.events.push('probe');
      return fail(cb, pg.rejects ? 'psql: error: FATAL:  pg_hba.conf rejects connection for host "127.0.0.1"' : 'psql: error: fe_sendauth: no password supplied');
    }
    pg.sql.push(sql);
    if (sql.includes("current_setting('hba_file') ||")) {
      pg.events.push('read-settings');
      // A test names the first four settings; the layers read unfenced, with the owner file as it is.
      return cb(null, `${pg.settings.split('|').length === 4 ? `${pg.settings}|off|${pg.owner}|0|` : pg.settings}\n`, '');
    }
    if (sql.includes("pg_read_file('smdb-fence-owner', true)") && !sql.includes('regexp_split_to_table')) { pg.events.push('owner-read'); return cb(null, `${pg.readOnly ? 'on' : 'off'}|${pg.owner}\n`, ''); }
    if (sql.includes('pg_read_file')) { pg.events.push('layers'); return cb(null, `${pg.layers.split('|').length === 2 ? `${pg.layers}|${pg.owner}|` : pg.layers}\n`, ''); }
    if (sql.includes('ALTER SYSTEM SET default_transaction_read_only = on')) { pg.events.push('read-only'); pg.readOnly = true; return cb(null, '', ''); }
    if (sql.includes('pg_terminate_backend(pid, 5000)')) { pg.events.push('sweep'); return cb(null, pg.sweep, ''); }
    if (sql.includes('pid IN (')) { pg.events.push('recheck'); return cb(null, `${pg.recheck}\n`, ''); }
    if (sql.includes('ALTER SYSTEM RESET')) {
      pg.events.push('reset');
      if (pg.resetFails) return fail(cb, 'ERROR: reset refused');
      pg.readOnly = false;
      return cb(null, '', '');
    }
    if (sql.includes('pg_reload_conf()')) { pg.events.push('reload'); return pg.reloadFails ? fail(cb, 'ERROR: reload refused') : cb(null, '', ''); }
    if (sql.includes("name = 'default_transaction_read_only'")) return cb(null, '0\n', '');
    if (sql.includes('FROM pg_database WHERE datname')) return cb(null, '1\n', '');
    if (sql.includes('to_regclass')) return cb(null, 'f\n', '');
    if (sql.includes('DROP DATABASE')) pg.events.push('drop');
    return cb(null, '', '');
  });
  const spawn = vi.fn((_cmd: string, args: string[]) => {
    const child: any = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.stdin.resume();
    child.kill = () => true;
    const sql = args.join(' ');
    const isDump = args.includes('pg_dump');
    const isRestore = args.includes('pg_restore');
    if (isDump) pg.events.push('dump');
    if (isRestore) pg.events.push('restore');
    pg.spawned.push(sql);
    if (sql.includes('pg_hba.conf.new')) pg.rewrites.push(sql);
    const code = isRestore && pg.restoreFails ? 1 : 0;
    const out = isDump ? 'dump' : sql.includes('pg_read_file') ? `${pg.hbaCount}\n` : '';
    setTimeout(() => {
      child.stdout.end(out);
      child.stderr.end(code ? 'pg_restore: error: could not execute query' : '');
      setTimeout(() => child.emit('close', code), 5);
    }, 5);
    return child;
  });
  const heldSpawn = (await import('./dump-fake')).withDumpHolder((await import('./restore-fake')).withTocFake(spawn as any));
  const claimExecFile = (await import('./restore-fake')).withRestoreFakes(execFile as any);
  return { ...real, execFile: claimExecFile, spawn: heldSpawn, default: { ...real, execFile: claimExecFile, spawn: heldSpawn } };
});

import * as fs from 'fs';
import { MAINTAINED } from './restore-fake';
import * as path from 'path';
import { execFileSync } from 'child_process';
import * as fleetBackup from '../../src/instance/fleetBackup';
import { enableFleetReplication, narrowKeptPlainHba } from '../../src/instance/fleetReplication';

const REGISTRY = path.join(tmp.dir, 'instances.json');
const DIR = path.join(tmp.dir, 'backups', 'a', 'fleet-postgres');
const primary = { containerName: 'bot-a-postgres', user: 'app', db: 'app', volume: 'bot-a-pgdata' };
// The lane these rows fence and lift as; the owner file names it unless a row says otherwise.
const OWNER = 'decommission:1';
const at = (event: string) => pg.events.indexOf(event);
const count = (event: string) => pg.events.filter(e => e === event).length;
const bot = () => ({ id: 'a', displayName: 'a', status: 'stopped', sourceUrl: 'https://example.invalid/fake/app', ...MAINTAINED, fleetDb: primary, fleetBackup: { enabled: false, hour: 4, keep: 7 } } as any);

beforeEach(() => {
  pg.events.length = 0;
  pg.scripts.length = 0;
  pg.sql.length = 0;
  pg.rewrites.length = 0;
  pg.settings = `${HBA}|on|0|0`;
  pg.rejects = true;
  pg.sweep = '';
  pg.recheck = '0';
  pg.layers = 'off|0';
  pg.hbaStripFails = false;
  pg.resetFails = false;
  pg.volumeStripFails = false;
  pg.volumeStripPlan = [];
  pg.spawned.length = 0;
  pg.reloadFails = false;
  pg.restoreFails = false;
  pg.hbaCount = '0';
  pg.owner = OWNER;
  pg.readOnly = true;
  Object.assign(fleetBackup.fenceTiming ?? {}, { probeDeadlineMs: 15_000, probeGapMs: 1 });
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, 'old.dump'), 'dump');
  fs.writeFileSync(REGISTRY, JSON.stringify({ instances: { a: bot() } }, null, 2));
  fs.mkdirSync(path.join(tmp.dir, 'bots', 'a'), { recursive: true });
});
afterAll(() => { fs.rmSync(tmp.dir, { recursive: true, force: true }); });

// Runs a fence script through this machine's sh against a temp file, with chown as a no-op (no postgres user here).
const scratch = fs.mkdtempSync(path.join(tmp.dir, 'sh-'));
const bin = path.join(scratch, 'bin');
fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, 'chown'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
const shPath = (p: string): string => (process.platform === 'win32' ? `/${p[0].toLowerCase()}${p.slice(2).replace(/\\/g, '/')}` : p);
function runSh(script: string): void {
  execFileSync('sh', ['-c', script], { env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` } });
}
const MANAGED = 'local   all             all                                     trust\nhost    all             all             127.0.0.1/32            trust\n';

describe('B14-2Lb: the fence refuses every outside connection', () => {
  it('sends the read-only default, the pg_hba lines, the reload, the probe and two sweeps, in that order', async () => {
    const fence = await fleetBackup.applyWriteFence(primary, OWNER, 'any');
    expect(fence.ok).toBe(true);
    expect(pg.events).toEqual(['read-settings', 'owner-write', 'read-only', 'hba-write', 'reload', 'probe', 'sweep', 'sweep']);
  });

  it('waits the server\'s authentication_timeout before the second sweep', async () => {
    pg.settings = `${HBA}|on|1|0`;
    const started = Date.now();
    expect((await fleetBackup.applyWriteFence(primary, OWNER, 'any')).ok).toBe(true);
    expect(count('sweep')).toBe(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(950);
  }, 10_000);

  it('puts the fence lines first, and a second fence leaves one block', () => {
    const file = path.join(scratch, 'pg_hba.conf');
    fs.writeFileSync(file, MANAGED);
    runSh(fleetBackup.fenceHbaScript(true, OWNER, shPath(file)));
    const once = fs.readFileSync(file, 'utf8');
    runSh(fleetBackup.fenceHbaScript(true, OWNER, shPath(file)));
    expect(fs.readFileSync(file, 'utf8')).toBe(once);
    expect(once).toBe(`hostssl replication replicator all scram-sha-256 # smdb-fence-owner=${OWNER} # smdb-write-fence\n`
      + `host replication all all reject # smdb-fence-owner=${OWNER} # smdb-write-fence\nhost all all all reject # smdb-fence-owner=${OWNER} # smdb-write-fence\n` + MANAGED);
    expect(fs.existsSync(`${file}.fence`)).toBe(false);
  });

  it('writes the file postgres-owned and 600 through a temp file', () => {
    const script = fleetBackup.fenceHbaScript(true, OWNER);
    expect(script).toContain(`f=${HBA};`);
    expect(script).toMatch(/> "\$f\.fence" && chown postgres:postgres "\$f\.fence" && chmod 600 "\$f\.fence" && mv -f "\$f\.fence" "\$f"/);
  });

  it('writes no hostssl line when ssl is off', async () => {
    pg.settings = `${HBA}|off|0|0`;
    expect((await fleetBackup.applyWriteFence(primary, OWNER, 'any')).ok).toBe(true);
    const script = pg.scripts.find(s => s.includes('printf') && s.includes('smdb-write-fence'))!;
    expect(script).not.toContain('hostssl');
    expect(script).toContain(`host all all all reject # smdb-fence-owner=${OWNER} # smdb-write-fence`);
  });

  it('a database that reads another pg_hba file refuses and changes nothing', async () => {
    pg.settings = '/etc/postgresql/pg_hba.conf|on|60|0';
    const fence = await fleetBackup.applyWriteFence(primary, OWNER, 'any');
    expect(fence).toMatchObject({ ok: false, changed: false });
    expect(fence.stderr).toContain('/etc/postgresql/pg_hba.conf');
    // The caller names what it changed before the fence (a quiesce has stopped the source by then).
    expect(fence.stderr).not.toMatch(/nothing was changed/);
    expect(pg.events).toEqual(['read-settings']);
  });

  it('a lane whose fence refused before any change lifts nothing', async () => {
    pg.settings = '/etc/postgresql/pg_hba.conf|on|60|0';
    const r = await fleetBackup.fencedSafetyDump(bot(), 'pre-decommission-', 'a decommission', 'running the decommission again retries the lift', OWNER);
    expect(r.success).toBe(false);
    expect(pg.events).toEqual(['read-settings']);
  });

  it('enabled subscriptions refuse the fence before it changes anything', async () => {
    pg.settings = `${HBA}|on|60|2`;
    const fence = await fleetBackup.applyWriteFence(primary, OWNER, 'any');
    expect(fence).toMatchObject({ ok: false, changed: false });
    expect(fence.stderr).toMatch(/2 enabled subscription/);
    expect(pg.events).toEqual(['read-settings']);
  });

  it('a probe that never sees the reject lifts both layers and refuses, with no dump taken', async () => {
    pg.rejects = false;
    Object.assign(fleetBackup.fenceTiming ?? {}, { probeDeadlineMs: 30 });
    const r = await fleetBackup.fencedSafetyDump(bot(), 'pre-decommission-', 'a decommission', 'running the decommission again retries the lift', OWNER);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error).toMatch(/did not refuse a TCP connection/);
    expect(count('probe')).toBeGreaterThan(1);
    expect(pg.events).not.toContain('sweep');
    expect(pg.events).not.toContain('dump');
    expect(at('hba-strip')).toBeGreaterThan(at('probe'));
    expect(at('hba-strip')).toBeLessThan(at('reset'));
  });

  it('ends a walsender that is not the managed role\'s physical one, and keeps that one', async () => {
    await fleetBackup.applyWriteFence(primary, OWNER, 'any');
    const sweep = pg.sql.find(s => s.includes('pg_terminate_backend(pid, 5000)'))!;
    expect(sweep).toContain("backend_type = 'client backend'");
    expect(sweep).toContain("backend_type = 'walsender' AND NOT (usename IS NOT DISTINCT FROM 'replicator' AND datname IS NULL)");
  });

  it('a session that did not end refuses the fence; one that ended meanwhile does not', async () => {
    pg.sweep = '42|f\n43|t\n';
    pg.recheck = '1';
    const kept = await fleetBackup.applyWriteFence(primary, OWNER, 'any');
    expect(kept.ok).toBe(false);
    expect(kept.stderr).toMatch(/1 open session\(s\) did not end/);
    pg.recheck = '0';
    pg.events.length = 0;
    expect((await fleetBackup.applyWriteFence(primary, OWNER, 'any')).ok).toBe(true);
    expect(pg.sql.some(s => s.includes('pid IN (42)'))).toBe(true);
  });
});

describe('B14-2Lb: the lift strips the pg_hba lines first, and each partial outcome says what is true', () => {
  const remedy = 'running the decommission again retries the lift';

  it('lifts the pg_hba lines before the read-only default', async () => {
    expect(await fleetBackup.liftLaneFence('a', primary, OWNER, 'a decommission', remedy)).toBe('');
    expect(pg.events).toEqual(['hba-strip', 'reload', 'owner-read', 'reset', 'owner-drop']);
    expect(pg.sql.find(s => s.includes('ALTER SYSTEM RESET'))).toMatch(/-tA -v ON_ERROR_STOP=1 -c SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE -c ALTER SYSTEM RESET default_transaction_read_only -c SELECT pg_reload_conf\(\)/);
  });

  it('pg_hba lines that cannot be removed say the bot cannot reach its database', async () => {
    pg.hbaStripFails = true;
    pg.volumeStripFails = true;
    const note = await fleetBackup.liftLaneFence('a', primary, OWNER, 'a decommission', remedy);
    expect(note).toMatch(/refuses every connection but the manager's/);
    expect(note).toMatch(/bot cannot reach it/);
    expect(note).toContain(remedy);
    expect(fleetBackup.getFleetFenceStuck('a')).toMatch(/refuses every connection but the manager's, so the bot cannot reach it/);
  });

  it('a live lift that fails after the pg_hba strip strips the files and names a restart', async () => {
    pg.resetFails = true;
    const note = await fleetBackup.liftLaneFence('a', primary, OWNER, 'a decommission', remedy);
    expect(at('hba-strip')).toBeLessThan(at('volume-strip'));
    expect(note).toMatch(/READ-ONLY, and may still refuse the bot's connections, until its container restarts/);
  });

  it('pg_hba lines the live strip missed are stripped from the volume and reloaded', async () => {
    pg.hbaStripFails = true;
    expect(await fleetBackup.liftLaneFence('a', primary, OWNER, 'a decommission', remedy)).toBe('');
    expect(pg.events.slice(-2)).toEqual(['volume-strip', 'reload']);
  });

  it('a read-only default that cannot be lifted or stripped stays READ-ONLY', async () => {
    pg.resetFails = true;
    pg.volumeStripFails = true;
    expect(await fleetBackup.liftOwnedFence(primary, OWNER, { readOnly: true, hba: false })).toBe('failed');
    expect(pg.events).not.toContain('hba-strip');
  });

  it('pg_hba lines stripped from the file but never reloaded say the bot may be refused until a reload or restart', async () => {
    pg.reloadFails = true;
    pg.resetFails = true;
    pg.volumeStripFails = true;
    const note = await fleetBackup.liftLaneFence('a', primary, OWNER, 'a decommission', remedy);
    expect(at('hba-strip')).toBe(0);
    expect(note).toMatch(/stays READ-ONLY/);
    expect(note).toMatch(/may still refuse the bot's connections until it reloads or restarts/);
    expect(note).toContain(remedy);
    expect(fleetBackup.getFleetFenceStuck('a')).toMatch(/may still refuse the bot's connections until it reloads or restarts/);
  });

  it('a reload that landed before the read-only reset failed is failed, and no text says the reload failed', async () => {
    pg.resetFails = true;
    pg.volumeStripFails = true;
    expect(await fleetBackup.liftOwnedFence(primary, OWNER)).toBe('failed');
    expect(pg.sql.some(s => /-c SELECT pg_reload_conf\(\)$/.test(s) && !s.includes('ALTER SYSTEM'))).toBe(true);
    const note = await fleetBackup.liftLaneFence('a', primary, OWNER, 'a decommission', remedy);
    expect(note).toMatch(/stays READ-ONLY/);
    expect(note).not.toMatch(/reload failed|until it reloads or restarts/);
    expect(fleetBackup.getFleetFenceStuck('a')).toMatch(/READ-ONLY/);
    expect(fleetBackup.getFleetFenceStuck('a')).not.toMatch(/reload failed|until it reloads or restarts/);
  });

  it('a lone reload that fails before a reset whose own reload lands is lifted, with no strip and no warning', async () => {
    pg.reloadFails = true;
    expect(await fleetBackup.liftOwnedFence(primary, OWNER)).toBe('lifted');
    expect(pg.events).toEqual(['hba-strip', 'reload', 'owner-read', 'reset', 'owner-drop']);
    expect(await fleetBackup.liftLaneFence('a', primary, OWNER, 'a decommission', remedy)).toBe('');
    expect(pg.events).not.toContain('volume-strip');
    expect(fleetBackup.getFleetFenceStuck('a') ?? '').not.toMatch(/READ-ONLY|refuse/);
  });

  it('an hba-only lift whose reload fails after the strip is stripped, not failed', async () => {
    pg.reloadFails = true;
    pg.volumeStripFails = true;
    expect(await fleetBackup.liftOwnedFence(primary, OWNER, { readOnly: false, hba: true })).toBe('stripped');
    expect(pg.events).not.toContain('reset');
  });

  it('the down-container strip removes the lines from both files and chowns pg_hba.conf back to postgres', async () => {
    pg.resetFails = true;
    await fleetBackup.liftLaneFence('a', primary, OWNER, 'a decommission', remedy);
    const script = pg.scripts.find(s => s.includes('/pgdata/postgresql.auto.conf'))!;
    expect(script).toContain(`if grep -qx '${OWNER}' /pgdata/smdb-fence-owner 2>/dev/null; then sed -i '/^default_transaction_read_only/d' /pgdata/postgresql.auto.conf && rm -f /pgdata/smdb-fence-owner`);
    expect(script).toContain('f=/pgdata/pg_hba.conf;');
    expect(script).toMatch(/sed -i '\/# smdb-write-fence\$\/d' "\$f" && chown postgres:postgres "\$f" && chmod 600 "\$f"/);
  });

  it('the strip script removes only the marked lines and passes a file with none', () => {
    const dir = fs.mkdtempSync(path.join(scratch, 'strip-'));
    const file = path.join(dir, 'pg_hba.conf');
    fs.writeFileSync(file, MANAGED);
    runSh(fleetBackup.fenceHbaScript(false, OWNER, shPath(file)));
    runSh(fleetBackup.stripFenceHbaScript(shPath(dir)));
    expect(fs.readFileSync(file, 'utf8')).toBe(MANAGED);
    runSh(fleetBackup.stripFenceHbaScript(shPath(dir)));
    expect(fs.readFileSync(file, 'utf8')).toBe(MANAGED);
    runSh(fleetBackup.stripFenceHbaScript(shPath(path.join(dir, 'missing'))));
  });
});

describe('B14-2Lb: a lift of some layers leaves the others', () => {
  it('lifting only the pg_hba layer leaves the read-only default another lane set', async () => {
    expect(await fleetBackup.liftOwnedFence(primary, OWNER, { readOnly: false, hba: true })).toBe('lifted');
    expect(pg.events).toEqual(['hba-strip', 'reload']);
  });

  it('lifting only the read-only layer leaves the pg_hba lines another lane set', async () => {
    expect(await fleetBackup.liftOwnedFence(primary, OWNER, { readOnly: true, hba: false })).toBe('lifted');
    expect(pg.events).not.toContain('hba-strip');
    expect(pg.events).toContain('reset');
  });
});

describe('B14-2Lb: the fence state reads both layers', () => {
  it('names the pg_hba layer at Start', async () => {
    pg.layers = 'off|3';
    expect(await fleetBackup.fenceStartWarning('a')).toMatch(/refuses every connection but the manager's/);
    pg.layers = 'on|0';
    expect(await fleetBackup.fenceStartWarning('a')).toBeNull();
    pg.layers = 'off|0';
    expect(await fleetBackup.fenceStartWarning('a')).toBeNull();
  });

  it('the seed finds the pg_hba lines and says a restart keeps them; the reprobe clears once both layers are off', async () => {
    vi.resetModules();
    const fb = await import('../../src/instance/fleetBackup');
    pg.layers = 'off|3';
    let tick: () => void = () => {};
    const spy = vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void) => { tick = fn; return 0; }) as unknown as typeof setInterval);
    fb.startFleetBackupScheduler();
    spy.mockRestore();
    fb.stopFleetBackupScheduler();
    await vi.waitFor(() => expect(fb.getFleetFenceStuck('a')).toMatch(/refuses every connection but the manager's/));
    expect(fb.getFleetFenceStuck('a')).toMatch(/a restart keeps it on/);
    pg.layers = 'on|0';
    tick();
    await new Promise(r => setTimeout(r, 50));
    expect(fb.getFleetFenceStuck('a')).not.toBeNull();
    pg.layers = 'off|0';
    tick();
    await vi.waitFor(() => expect(fb.getFleetFenceStuck('a')).toBeNull());
  });
});

describe('B14-2Lb: the pg_hba rewriters refuse while the fence lines are present', () => {
  it('the start lane\'s narrowing leaves a fenced pg_hba alone and says why', async () => {
    const record = { ...bot(), fleetDb: { ...primary, replication: { role: 'replicator', password: 'x', hostPort: 5433, publicHost: 'h', keptPlain: ['10.0.0.9'] } } };
    fs.writeFileSync(REGISTRY, JSON.stringify({ instances: { a: record } }, null, 2));
    pg.hbaCount = '3';
    expect(await narrowKeptPlainHba('a')).toMatch(/write fence/);
    expect(pg.rewrites).toEqual([]);
  });

  it('Enable refuses while the fence lines are present and sends no setting or pg_hba rewrite', async () => {
    fs.writeFileSync(REGISTRY, JSON.stringify({ instances: { a: { ...bot(), sanitizedName: 'a' } } }, null, 2));
    pg.hbaCount = '3';
    const r = await enableFleetReplication(bot(), 'h.example.invalid', 15432);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/write fence stands in pg_hba\.conf/);
    expect(r.error).toMatch(/no lane of this manager set its lines; a restore takes them over and lifts them, or remove them by hand/);
    expect(r.error).toMatch(/nothing was changed/);
    expect(pg.spawned.some(s => s.includes('pg_read_file'))).toBe(true);
    expect(pg.spawned.filter(s => /ALTER SYSTEM|ROLE replicator|pg_hba\.conf\.new|pg_reload_conf/.test(s))).toEqual([]);
    expect(pg.sql.filter(s => /ALTER SYSTEM|pg_reload_conf/.test(s))).toEqual([]);
    expect(pg.rewrites).toEqual([]);
  });
});

describe('B14-2Lb: a failed restore keeps only the read-only layer', () => {
  it('lifts the pg_hba lines and keeps the read-only default', async () => {
    pg.restoreFails = true;
    const r = await fleetBackup.restoreFleetBackup('a', 'old.dump');
    expect(r.success).toBe(false);
    const after = pg.events.slice(at('restore'));
    expect(after).toContain('hba-strip');
    expect(after).not.toContain('reset');
    expect(r.error).toMatch(/READ-ONLY/);
    expect(r.error).toMatch(/no longer refuses connections/);
  });
});

describe('B14-2Lb: a restore keeps a strip that landed', () => {
  it('a retry that cannot remove the pg_hba lines keeps the text of the first strip', async () => {
    pg.hbaStripFails = true;
    pg.resetFails = true;
    pg.volumeStripPlan = [false, true];
    const r = await fleetBackup.restoreFleetBackup('a', 'old.dump');
    expect(count('volume-strip')).toBe(2);
    expect(r.error).toMatch(/could not be lifted live: the database is READ-ONLY, and may still refuse the bot's connections, until its container restarts/);
    expect(r.error).not.toMatch(/pg_hba lines of the write fence could not be removed/);
    expect(fleetBackup.getFleetFenceStuck('a')).toMatch(/until it restarts/);
    expect(fleetBackup.getFleetFenceStuck('a')).not.toMatch(/a restart keeps them/);
  });
});
