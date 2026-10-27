import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm2-dump-'));
  process.env.DATA_DIR = dir;
  return {
    dir,
    url: 'postgresql://app:pw@bot-a-postgres:5432/app',
    seedView: null as null | ((instance: any) => any),
    freeBytes: null as number | null,
    failDirSync: false,
  };
});

vi.mock('child_process', async (importOriginal) => (await import('./nm2-docker')).childProcessMock(await importOriginal()));
vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>();
  const statfsSync = (p: any, o?: any) => (h.freeBytes !== null ? { bavail: h.freeBytes / 4096, bsize: 4096 } : (real.statfsSync as any)(p, o));
  const openSync = (p: any, flags: any, mode?: any) => {
    if (h.failDirSync && flags === 'r' && String(p).endsWith('fleet-postgres')) throw new Error('EIO: folder sync refused');
    return real.openSync(p, flags, mode);
  };
  return { ...real, statfsSync, openSync, default: { ...real, statfsSync, openSync } };
});
vi.mock('../../src/config/appCapabilities', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/config/appCapabilities')>()),
  findAppCapabilities: () => ({ companionDb: { env: { url: 'DATABASE_URL' } } }),
}));
vi.mock('../../src/env/manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/env/manager')>()),
  getEnvVars: () => ({ DATABASE_URL: h.url }),
  getEnvVarsWithStatus: () => ({ vars: { DATABASE_URL: h.url }, undecryptable: [], corrupt: false }),
}));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));
vi.mock('../../src/instance/fleetReplica', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/instance/fleetReplica')>();
  return { ...real, seedView: (instance: any) => (h.seedView ? h.seedView(instance) : real.seedView(instance)) };
});

import * as fs from 'fs';
import * as path from 'path';
import { docker, resetDocker, callsWith } from './nm2-docker';
import { holder } from './dump-fake';
import { fenceOwners } from './fence-fake';
import {
  PRIMARY, REPLICA, seedBot, clearRegistry, stored, files, dumps, dumpsDir, putDump, stampText, restartedManager, startedWithTick, tickOnce, localAt, logged,
} from './nm2-harness';
import { setNow, realNow } from './nm2-harness';

const NOW = localAt(10, 30);
const H = 3_600_000;
const mainBot = (extra: Record<string, unknown> = {}) => seedBot({ fleetDb: PRIMARY, ...extra });
const copyBot = (extra: Record<string, unknown> = {}) => seedBot({ fleetDbReplica: { ...REPLICA, seededAt: NOW - 30 * 86400000 }, ...extra });
const pgDumps = () => callsWith('pg_dump').filter(a => a.includes('pg_dump'));
const HOLDER_CONFLICT = 'psql:<stdin>:4: ERROR:  canceling statement due to conflict with recovery\nDETAIL:  User query might have needed to see row versions that must be removed.';
const HOLDER_FATAL = 'psql:<stdin>:4: FATAL:  terminating connection due to conflict with recovery\nDETAIL:  User was holding a relation lock for too long.\nHINT:  In a moment you should be able to reconnect to the database and repeat your command.\npsql:<stdin>:4: error: connection to server was lost';
const DUMP_CONFLICT = 'pg_dump: error: Dumping the contents of table "t" failed: PQgetResult() failed.\npg_dump: detail: Error message from server: ERROR:  canceling statement due to conflict with recovery\nDETAIL:  User query might have needed to see row versions that must be removed.\npg_dump: detail: Command was: COPY public.t (x) TO stdout;';
const utc = (at: number) => `${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

async function ready() {
  const fb = await restartedManager();
  const tick = startedWithTick(fb);
  return { fb, tick, run: () => tickOnce(fb, tick) };
}

beforeEach(() => {
  setNow(NOW);
  resetDocker();
  fenceOwners.clear();
  h.url = 'postgresql://app:pw@bot-a-postgres:5432/app';
  h.seedView = null;
  h.freeBytes = null;
  h.failDirSync = false;
  fs.rmSync(path.join(h.dir, 'backups'), { recursive: true, force: true });
  clearRegistry();
});
afterEach(() => { realNow(); });
afterAll(() => { fs.rmSync(h.dir, { recursive: true, force: true }); });

describe('NM2 A: the scheduled dump of one family', () => {
  it.each([
    ['no record', () => seedBot({})],
    ['backups off', () => mainBot({ fleetBackup: { enabled: false, hour: 4 } })],
    ['out of scope', () => { h.url = 'postgresql://app:pw@elsewhere:5432/app'; mainBot(); }],
    ['seed running', () => { h.seedView = () => ({ phase: 'seeding', parked: false }); copyBot(); }],
    ['copy cleared', () => seedBot({ fleetDbReplica: { ...REPLICA, copyCleared: true } })],
  ])('A1 %s: nothing runs', async (_name, arrange) => {
    arrange();
    const { run } = await ready();
    await run();
    expect(pgDumps()).toEqual([]);
    expect(holder.spawned).toEqual([]);
  });

  it('A1 out of scope reads as scoped false in the status, with no error', async () => {
    h.url = 'postgresql://app:pw@elsewhere:5432/app';
    mainBot();
    const { fb, run } = await ready();
    await run();
    const st = fb.fleetBackupStatus(stored());
    expect(st.scoped).toBe(false);
    expect(st.main?.lastError).toBeNull();
    expect(st.main?.skip).toBe('scope');
  });

  it('A1 a copy whose seed runs carries skip seed; a family backed up carries none', async () => {
    h.seedView = () => ({ phase: 'seeding', parked: false });
    seedBot({ fleetDb: PRIMARY, fleetDbReplica: { ...REPLICA, seededAt: NOW - 30 * 86400000 } });
    const { fb, run } = await ready();
    await run();
    const st = fb.fleetBackupStatus(stored());
    expect(st.copy?.skip).toBe('seed');
    expect(st.main?.skip).toBeNull();
  });

  it('A2 a held slot skips the tick and the next tick dumps', async () => {
    mainBot();
    const { fb, run } = await ready();
    const guards = await import('../../src/instance/fleetBackupGuards');
    expect(guards.claimFleetBackupBusy('a')).toBe(true);
    await run();
    expect(pgDumps()).toEqual([]);
    guards.releaseFleetBackupBusy('a');
    await run();
    expect(dumps()).toEqual([`daily-${stampText(NOW)}.dump`]);
    expect(fb.fleetBackupStatus(stored()).main?.lastError).toBeNull();
  });

  it('A3 a stopped database is paused: no dump, no error, no alert', async () => {
    docker.running[PRIMARY.containerName] = false;
    mainBot();
    const { fb, run } = await ready();
    setNow(NOW + 5 * H);
    await run();
    const st = fb.fleetBackupStatus(stored()).main!;
    expect(st.paused).toBe(true);
    expect(st.lastError).toBeNull();
    expect(st.alerts.dumps).toBeNull();
    expect(pgDumps()).toEqual([]);
  });

  it('A4 docker not answering is an error, tried once in the hour slot', async () => {
    docker.running[PRIMARY.containerName] = null;
    mainBot();
    const { fb, run } = await ready();
    await run();
    expect(fb.fleetBackupStatus(stored()).main?.lastError).toMatch(/^Could not probe the database container/);
    delete docker.running[PRIMARY.containerName];
    await run();
    expect(dumps()).toEqual([]);
    setNow(NOW + H);
    await run();
    expect(dumps()).toEqual([`daily-${stampText(NOW + H)}.dump`]);
  });

  it('A5 too little free space fails the dump with D-DISK, and the trim still runs', async () => {
    const old = `hourly-${stampText(NOW - 49 * H)}.dump`;
    putDump(old);
    putDump(`daily-${stampText(NOW - 2 * H)}.dump`);
    h.freeBytes = 100 * 1048576;
    mainBot();
    const { fb, run } = await ready();
    setNow(localAt(4, 30, 1));
    await run();
    const err = fb.fleetBackupStatus(stored()).main?.lastError;
    expect(err).toMatch(/^only 100 MB is free under .+, and a dump needs about 512 MB; free space there \(backups past their 48-hour or 30-day keep are deleted after each hourly run\)$/);
    expect(dumps()).not.toContain(old);
    expect(holder.spawned).toEqual([]);
  });

  it('A6 a holder that cannot be started answers the docker exec error', async () => {
    holder.spawnError = 'spawn docker ENOENT';
    mainBot();
    const { fb, run } = await ready();
    await run();
    expect(fb.fleetBackupStatus(stored()).main?.lastError).toBe('Failed to run docker exec: spawn docker ENOENT');
    expect(files()).toEqual([]);
  });

  it('A7 a failed snapshot or counts query fails with D-SNAP and leaves no file', async () => {
    holder.failQueue = ['psql:<stdin>:3: ERROR:  permission denied for table t'];
    mainBot();
    const { fb, run } = await ready();
    await run();
    expect(fb.fleetBackupStatus(stored()).main?.lastError).toBe("the dump's snapshot and table counts could not be taken (psql:<stdin>:3: ERROR:  permission denied for table t)");
    expect(pgDumps()).toEqual([]);
    expect(files()).toEqual([]);
  });

  it('A8 no counts within the bound: the holder is killed and D-SNAPTIME is the error', async () => {
    holder.hang = true;
    mainBot();
    const { fb, run } = await ready();
    fb.dumpTiming.snapshotTimeoutMs = 30;
    await run();
    expect(fb.fleetBackupStatus(stored()).main?.lastError).toBe('the database did not return its table counts within 5 minutes, so no dump was taken');
    expect(holder.killed).toBe(1);
    expect(files()).toEqual([]);
  });

  it('A9 pg_dump exiting non-zero keeps the existing text and deletes both temp files', async () => {
    docker.dumps = [{ code: 1, stderr: 'pg_dump: error: connection lost' }];
    mainBot();
    const { fb, run } = await ready();
    await run();
    expect(fb.fleetBackupStatus(stored()).main?.lastError).toBe('pg_dump exited with code 1: pg_dump: error: connection lost');
    expect(files()).toEqual([]);
    expect(holder.killed).toBe(1);
  });

  it('A7 a holder failure of several lines keeps its ERROR or FATAL line as the text', async () => {
    holder.failQueue = ['psql:<stdin>:2: ERROR:  could not serialize access due to read/write dependencies among transactions\nDETAIL:  Reason code: Canceled on identification as a pivot, during conflict in checking.\nHINT:  The transaction might succeed if retried.'];
    mainBot();
    const { fb, run } = await ready();
    await run();
    expect(fb.fleetBackupStatus(stored()).main?.lastError).toBe("the dump's snapshot and table counts could not be taken (psql:<stdin>:2: ERROR:  could not serialize access due to read/write dependencies among transactions)");
    expect(holder.spawned.length).toBe(1);
  });

  it.each([
    ['the holder, ERROR then DETAIL', () => { holder.failQueue = [HOLDER_CONFLICT]; }],
    ['the holder, FATAL, DETAIL, HINT and the lost connection', () => { holder.failQueue = [HOLDER_FATAL]; }],
    ['pg_dump, ERROR then DETAIL', () => { docker.dumps = [{ code: 1, stderr: DUMP_CONFLICT }]; }],
  ])('A10 a recovery conflict in %s with attempts left is retried at once in the same hold', async (_name, arrange) => {
    arrange();
    holder.inRecovery = 't';
    copyBot();
    const { fb, run } = await ready();
    await run();
    expect(holder.spawned.length).toBe(2);
    expect(dumps()).toEqual([`copy-daily-${stampText(NOW)}.dump`]);
    expect(fb.fleetBackupStatus(stored()).copy?.lastError).toBeNull();
  });

  it('A11 a recovery conflict on the third attempt fails with D-CONFLICT', async () => {
    holder.failQueue = [HOLDER_FATAL];
    docker.dumps = [{ code: 1, stderr: DUMP_CONFLICT }, { code: 1, stderr: 'pg_dump: error: query failed: ERROR:  canceling statement due to conflict with recovery\nDETAIL:  User query might have needed to see row versions that must be removed.' }];
    copyBot();
    const { fb, run } = await ready();
    await run();
    expect(holder.spawned.length).toBe(3);
    expect(fb.fleetBackupStatus(stored()).copy?.lastError).toBe("the live copy's replay cancelled the dump 3 times in a row (conflict with recovery); the next hourly run tries again");
    expect(files()).toEqual([]);
  });

  it('A11 a conflict once the run has used its time for attempts starts no new attempt', async () => {
    holder.failQueue = [HOLDER_CONFLICT, HOLDER_CONFLICT, HOLDER_CONFLICT];
    copyBot();
    const { fb, run } = await ready();
    fb.dumpTiming.conflictBudgetMs = 0;
    await run();
    expect(holder.spawned.length).toBe(1);
    expect(fb.fleetBackupStatus(stored()).copy?.lastError).toBe("the live copy's replay cancelled the dump once (conflict with recovery), and no new attempt starts once a run has taken 10 minutes; the next hourly run tries again");
  });

  it('A31 the dump loop starts with a different bot each tick', async () => {
    mainBot();
    seedBot({ fleetDbReplica: { ...REPLICA, containerName: 'bot-b-replica', seededAt: NOW - 30 * 86400000 } }, 'b');
    const { run } = await ready();
    const order = () => pgDumps().map(a => a[1]);
    await run();
    expect(order()).toEqual([PRIMARY.containerName, 'bot-b-replica']);
    setNow(NOW + H);
    await run();
    expect(order().slice(2)).toEqual(['bot-b-replica', PRIMARY.containerName]);
  });

  it('A12 pg_dump past its bound keeps the existing timeout text', async () => {
    docker.dumpHang = true;
    mainBot();
    const { fb, run } = await ready();
    fb.dumpTiming.dumpTimeoutMs = 30;
    await run();
    expect(fb.fleetBackupStatus(stored()).main?.lastError).toBe('Dump timed out after 10 minutes');
    expect(files()).toEqual([]);
  });

  it('A13 a dump file that cannot be written keeps the existing text', async () => {
    mainBot();
    const { fb, run } = await ready();
    fs.mkdirSync(path.join(dumpsDir(), `daily-${stampText(NOW)}.dump.tmp`), { recursive: true });
    await run();
    expect(fb.fleetBackupStatus(stored()).main?.lastError).toMatch(/^Failed to write dump file: /);
    expect(dumps()).toEqual([]);
  });

  it('A14 a counts file that cannot be written fails with D-META and keeps neither file', async () => {
    mainBot();
    const { fb, run } = await ready();
    fs.mkdirSync(path.join(dumpsDir(), `daily-${stampText(NOW)}.dump.json.tmp`), { recursive: true });
    await run();
    expect(fb.fleetBackupStatus(stored()).main?.lastError).toMatch(/^the dump finished, but its counts file could not be written \(.+\), so the dump was not kept$/);
    expect(files()).toEqual([`daily-${stampText(NOW)}.dump.json.tmp`]);
  });

  it('A15 a rename that fails keeps the existing text, and no counts file stays behind', async () => {
    mainBot();
    let release: () => void = () => {};
    docker.dumpHold = new Promise<void>(r => { release = r; });
    const { fb, tick } = await ready();
    const running = tickOnce(fb, tick);
    await vi.waitFor(() => expect(pgDumps().length).toBe(1));
    const blocker = path.join(dumpsDir(), `daily-${stampText(NOW)}.dump`);
    fs.mkdirSync(path.join(blocker, 'inside'), { recursive: true });
    release();
    await running;
    expect(fb.fleetBackupStatus(stored()).main?.lastError).toMatch(/^Failed to finalize dump file: /);
    expect(files()).toEqual([`daily-${stampText(NOW)}.dump`]);
    expect(fs.statSync(blocker).isDirectory()).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('A16 a folder sync that fails keeps the existing text, and the files stay', async () => {
    mainBot();
    const { fb, run } = await ready();
    h.failDirSync = true;
    await run();
    expect(fb.fleetBackupStatus(stored()).main?.lastError).toMatch(/was written, but its folder could not be synced to disk/);
    expect(dumps()).toEqual([`daily-${stampText(NOW)}.dump`]);
  });

  it('A17 a dump that succeeds writes the dump and its counts, clears the error and the alert, and logs', async () => {
    mainBot({ fleetBackupAlerts: { 'main:dumps': { kind: 'dumps', text: 'old', since: NOW - 5 * H, dm: 'sent', dmAt: NOW - 4 * H } } });
    holder.counts = { '"public"."a"': 2, '"smdb_data"."b|c"': 5 };
    holder.dataAt = NOW - 1000;
    const { fb, run } = await ready();
    const lines = await run();
    const name = `daily-${stampText(NOW)}.dump`;
    expect(files()).toEqual([name, `${name}.json`]);
    const meta = JSON.parse(fs.readFileSync(path.join(dumpsDir(), `${name}.json`), 'utf-8'));
    expect(meta).toEqual({ file: name, takenAt: NOW, family: 'main', kind: 'daily', inRecovery: false, dataAt: NOW - 1000, dbBytes: 1000, tables: 2, rows: 7, counts: { '"public"."a"': 2, '"smdb_data"."b|c"': 5 } });
    expect(lines.join('\n')).toContain(`[FleetBackup] Dumped Bot a's main database -> ${name}`);
    expect(fb.fleetBackupStatus(stored()).main?.alerts.dumps).toBeNull();
    expect(stored().fleetBackupAlerts?.['main:dumps']).toBeUndefined();
    const dump = pgDumps()[0];
    expect(dump).toContain('--snapshot=00000003-0000001B-1');
    expect(holder.spawned[0]).toEqual(['exec', '-i', PRIMARY.containerName, 'psql', '-X', '-q', '-tA', '-v', 'ON_ERROR_STOP=1', '-U', 'dbm_admin', '-d', PRIMARY.db]);
    expect(holder.stdin[0]).toMatch(/^SET idle_in_transaction_session_timeout = '720s';\nBEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\n/);
    expect(holder.stdin[0]).toContain('pg_export_snapshot()');
    expect(holder.stdin[0]).toMatch(/SELECT 'end\|';\nCOMMIT;\n$/);
  });

  it('A18 a holder that lingers past COMMIT is stopped, logged, and the dump stands', async () => {
    holder.linger = true;
    mainBot();
    const { fb, run } = await ready();
    fb.dumpTiming.holderExitMs = 20;
    const lines = await run();
    const name = `daily-${stampText(NOW)}.dump`;
    expect(dumps()).toEqual([name]);
    expect(lines.join('\n')).toContain(`[FleetBackup] The snapshot session of Bot a's main database did not end 10 s after the dump; it was stopped, and the dump ${name} is complete`);
    expect(holder.killed).toBe(1);
  });

  it.each([
    ['A19 a crash during the dump', ['hourly-x.dump.tmp', 'hourly-x.dump.json.tmp']],
    ['A20 a crash between the two renames', ['hourly-y.dump.json', 'hourly-y.dump.tmp']],
  ])('%s: the start sweep deletes what it left and the next tick dumps', async (_name, left) => {
    fs.mkdirSync(dumpsDir(), { recursive: true });
    for (const f of left) fs.writeFileSync(path.join(dumpsDir(), f), 'x');
    mainBot();
    const fb = await restartedManager();
    const { value: tick, lines } = await logged(() => startedWithTick(fb));
    expect(lines.join('\n')).toContain(`[FleetBackup] Deleted 2 unfinished backup file(s) a stopped manager left in ${dumpsDir()}`);
    expect(files()).toEqual([]);
    await tickOnce(fb, tick);
    expect(dumps()).toEqual([`daily-${stampText(NOW)}.dump`]);
  });

  it('A21 a dump lost to power loss after its rename: the next tick finds none and dumps', async () => {
    mainBot();
    const { run } = await ready();
    await run();
    fs.rmSync(dumpsDir(), { recursive: true, force: true });
    setNow(NOW + H);
    await run();
    expect(dumps()).toEqual([`daily-${stampText(NOW + H)}.dump`]);
  });

  it('A22 backups turned off during a dump: the dump is kept, and nothing more runs or is deleted', async () => {
    const old = `hourly-${stampText(NOW - 60 * H)}.dump`;
    putDump(old);
    mainBot({ fleetBackupAlerts: { 'main:dumps': { kind: 'dumps', text: 'old', since: NOW - 5 * H, dm: 'sent', dmAt: NOW } } });
    let release: () => void = () => {};
    docker.dumpHold = new Promise<void>(r => { release = r; });
    const { fb, tick } = await ready();
    const cm = await import('../../src/docker/containerManager');
    const running = tickOnce(fb, tick);
    await vi.waitFor(() => expect(pgDumps().length).toBe(1));
    cm.updateInstanceFleetBackup('a', { enabled: false });
    release();
    await running;
    expect(dumps()).toContain(`daily-${stampText(NOW)}.dump`);
    expect(dumps()).toContain(old);
    setNow(NOW + 2 * H);
    await tickOnce(fb, tick);
    expect(pgDumps().length).toBe(1);
    expect(dumps()).toContain(old);
    expect(stored().fleetBackupAlerts?.['main:dumps']).toBeUndefined();
  });

  it('A23 backups turned on again dump at the next tick', async () => {
    mainBot({ fleetBackup: { enabled: false, hour: 4 } });
    const { run } = await ready();
    await run();
    expect(dumps()).toEqual([]);
    const cm = await import('../../src/docker/containerManager');
    cm.updateInstanceFleetBackup('a', { enabled: true });
    await run();
    expect(dumps()).toEqual([`daily-${stampText(NOW)}.dump`]);
  });

  it('A24 a changed hour takes a daily at once when none was taken since the new boundary', async () => {
    putDump(`daily-${stampText(localAt(4, 10))}.dump`);
    putDump(`hourly-${stampText(localAt(10, 5))}.dump`);
    mainBot();
    const { run } = await ready();
    await run();
    expect(pgDumps()).toEqual([]);
    const cm = await import('../../src/docker/containerManager');
    cm.updateInstanceFleetBackup('a', { hour: 8 });
    await run();
    expect(dumps()).toContain(`daily-${stampText(NOW)}.dump`);
  });

  it('A25 a restore during a dump is refused as before', async () => {
    putDump(`hourly-${stampText(NOW - 2 * H)}.dump`);
    mainBot();
    let release: () => void = () => {};
    docker.dumpHold = new Promise<void>(r => { release = r; });
    const { fb, tick } = await ready();
    const running = tickOnce(fb, tick);
    await vi.waitFor(() => expect(pgDumps().length).toBe(1));
    const res = await fb.restoreFleetBackup('a', `hourly-${stampText(NOW - 2 * H)}.dump`);
    release();
    await running;
    expect(res.error).toBe('A backup operation is already in progress');
  });

  it('A26 a re-seed claim during a copy dump is refused (the full re-seed row is D1)', async () => {
    copyBot();
    let release: () => void = () => {};
    docker.dumpHold = new Promise<void>(r => { release = r; });
    const { fb, tick } = await ready();
    const running = tickOnce(fb, tick);
    await vi.waitFor(() => expect(pgDumps().length).toBe(1));
    const guards = await import('../../src/instance/fleetBackupGuards');
    expect(guards.claimFleetBackupBusy('a')).toBe(false);
    release();
    await running;
    expect(guards.claimFleetBackupBusy('a')).toBe(true);
    guards.releaseFleetBackupBusy('a');
  });

  it('A27 a stamp ahead of the clock: due ignores it, the trim keeps all and logs D-CLOCK', async () => {
    const old = `hourly-${stampText(NOW - 60 * H)}.dump`;
    putDump(old);
    putDump(`daily-${stampText(NOW + 2 * H)}.dump`);
    mainBot();
    const { run } = await ready();
    const lines = await run();
    expect(dumps()).toContain(`daily-${stampText(NOW)}.dump`);
    expect(dumps()).toContain(old);
    expect(lines.join('\n')).toContain("[FleetBackup] Kept every backup of Bot a's main database: a backup is dated ahead of the clock, so the clock may have stepped back");
  });

  it('A28 a shutdown begun starts no new dump', async () => {
    mainBot();
    const { run } = await ready();
    const cm = await import('../../src/docker/containerManager');
    cm.beginShutdown();
    await run();
    expect(pgDumps()).toEqual([]);
  });

  it('A29 a registry fault skips the tick', async () => {
    mainBot();
    const { run } = await ready();
    fs.writeFileSync(path.join(h.dir, 'instances.json'), '{ broken');
    const lines = await run();
    expect(lines.join('\n')).toContain('[FleetBackup] Tick skipped:');
    expect(pgDumps()).toEqual([]);
    clearRegistry();
  });

  it('A30 dumps that fail for 3 hours raise the dumps alert once', async () => {
    holder.failQueue = Array(10).fill('psql: error: connection refused');
    mainBot();
    const { fb, run } = await ready();
    for (let k = 0; k <= 4; k++) {
      setNow(NOW + k * H);
      await run();
    }
    const alert = stored().fleetBackupAlerts?.['main:dumps'];
    expect(alert?.text).toMatch(/^No backup of Bot a's main database has succeeded since .+ UTC\. Last error: the dump's snapshot and table counts could not be taken \(psql: error: connection refused\)\. The manager tries again every hour; its Database window has the details\.$/);
    expect(alert?.dm).toBe('unsupported');
    expect(fb.fleetBackupStatus(stored()).main?.failingSince).not.toBeNull();
  });

  it('A32 a restart keeps a standing dumps alert and its DM state, and the texts count from the newest dump', async () => {
    holder.failQueue = Array(10).fill('psql: error: connection refused');
    putDump(`hourly-${stampText(NOW - 10 * H)}.dump`, { takenAt: NOW - 10 * H });
    mainBot({ fleetBackupStarts: { main: NOW - 720 * H }, fleetBackupAlerts: { 'main:dumps': { kind: 'dumps', text: 'old', since: NOW - 7 * H, dm: 'sent', dmAt: NOW - 7 * H } } });
    const { fb, run } = await ready();
    await run();
    expect(stored().fleetBackupAlerts?.['main:dumps']).toMatchObject({ since: NOW - 7 * H, dm: 'sent', dmAt: NOW - 7 * H });
    expect(stored().fleetBackupAlerts['main:dumps'].text).toContain(`has succeeded since ${utc(NOW - 10 * H)}.`);
    expect(fb.fleetBackupStatus(stored()).main?.failingSince).toBe(NOW - 10 * H);
    setNow(NOW + 3 * H + 60_000);
    await run();
    expect(stored().fleetBackupAlerts?.['main:dumps']).toMatchObject({ since: NOW - 7 * H, dm: 'sent', dmAt: NOW - 7 * H });
  });

  it('A33 the family start is saved at first sight and cleared with the family; a new alert waits for an attempt or 3 hours of this process', async () => {
    mainBot();
    const first = await ready();
    await first.run();
    expect(stored().fleetBackupStarts).toEqual({ main: NOW });
    seedBot({ fleetBackupStarts: stored().fleetBackupStarts });
    await first.run();
    expect(stored().fleetBackupStarts).toBeUndefined();
    fs.rmSync(path.join(h.dir, 'backups'), { recursive: true, force: true });

    holder.failQueue = Array(10).fill('psql: error: connection refused');
    putDump(`hourly-${stampText(NOW - 10 * H)}.dump`, { takenAt: NOW - 10 * H });
    mainBot({ fleetBackupStarts: { main: NOW - 720 * H } });
    const { run } = await ready();
    const guards = await import('../../src/instance/fleetBackupGuards');
    expect(guards.claimFleetBackupBusy('a')).toBe(true);
    await run();
    expect(stored().fleetBackupAlerts).toBeUndefined();
    setNow(NOW + 3 * H);
    await run();
    expect(stored().fleetBackupAlerts?.['main:dumps']?.text).toContain(`has succeeded since ${utc(NOW - 10 * H)}.`);
    guards.releaseFleetBackupBusy('a');

    holder.failQueue = Array(10).fill('psql: error: connection refused');
    mainBot({ fleetBackupStarts: { main: NOW - 720 * H } });
    const again = await ready();
    setNow(NOW);
    const spawnedBefore = holder.spawned.length;
    await again.run();
    expect(holder.spawned.length).toBe(spawnedBefore + 1);
    expect(stored().fleetBackupAlerts?.['main:dumps']?.text).toContain(`has succeeded since ${utc(NOW - 10 * H)}.`);
  });

  it('A34 a family off for days and switched on alerts only after 3 hours of failed dumps', async () => {
    holder.failQueue = Array(10).fill('psql: error: connection refused');
    mainBot({ fleetBackup: { enabled: false, hour: 4 }, fleetBackupStarts: { main: NOW - 720 * H } });
    const { run } = await ready();
    setNow(NOW + 5 * H);
    await run();
    expect(stored().fleetBackupStarts).toBeUndefined();
    const cm = await import('../../src/docker/containerManager');
    cm.updateInstanceFleetBackup('a', { enabled: true });
    setNow(NOW + 6 * H);
    await run();
    expect(holder.spawned.length).toBe(1);
    expect(stored().fleetBackupStarts).toEqual({ main: NOW + 6 * H });
    expect(stored().fleetBackupAlerts).toBeUndefined();
    for (let k = 7; k <= 9; k++) {
      setNow(NOW + k * H);
      await run();
    }
    expect(stored().fleetBackupAlerts?.['main:dumps']).toBeUndefined();
    setNow(NOW + 10 * H);
    await run();
    expect(stored().fleetBackupAlerts?.['main:dumps']?.text).toContain(`has succeeded since ${utc(NOW + 6 * H)}.`);
  });
});
