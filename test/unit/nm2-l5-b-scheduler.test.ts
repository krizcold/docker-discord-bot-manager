import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm2-l5b-'));
  process.env.DATA_DIR = dir;
  return {
    dir,
    holders: [] as any[],
    corrupt: false,
    undecryptable: [] as string[],
    outOfScope: false,
    shutdown: false,
    startSaveFails: false,
    startSaves: 0,
    testMode: 'real' as 'real' | 'hold' | 'reject' | 'resolve',
    testCalls: 0,
    releaseTest: null as null | (() => void),
    recoverThrows: false,
    orphansReject: false,
  };
});

vi.mock('child_process', async (importOriginal) => {
  const mocked = await (await import('./nm2-docker')).childProcessMock(await importOriginal());
  const { isHolder } = await import('./dump-fake');
  const inner = mocked.spawn as (...a: any[]) => any;
  const spawn = (...a: any[]) => {
    const child = inner(...a);
    if (isHolder(a[1])) h.holders.push(child);
    return child;
  };
  return { ...mocked, spawn, default: { ...(mocked.default as object), spawn } };
});
vi.mock('../../src/config/appCapabilities', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/config/appCapabilities')>()),
  findAppCapabilities: () => ({ companionDb: { env: { url: 'DATABASE_URL' } } }),
}));
vi.mock('../../src/env/manager', async (importOriginal) => {
  const url = (id: string) => (h.outOfScope ? 'postgresql://app:pw@elsewhere:5432/app' : `postgresql://app:pw@bot-${id}-postgres:5432/app`);
  return {
    ...(await importOriginal<typeof import('../../src/env/manager')>()),
    getEnvVars: (id: string) => ({ DATABASE_URL: url(id) }),
    getEnvVarsWithStatus: (id: string) => ({ vars: { DATABASE_URL: url(id) }, undecryptable: h.undecryptable, corrupt: h.corrupt }),
  };
});
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));
vi.mock('../../src/docker/containerManager', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/docker/containerManager')>();
  return {
    ...real,
    isShuttingDown: () => h.shutdown,
    updateInstanceFleetBackupStart: (...args: any[]) => {
      h.startSaves++;
      if (h.startSaveFails) throw new Error('disk full');
      return (real.updateInstanceFleetBackupStart as any)(...args);
    },
  };
});
vi.mock('../../src/instance/backupCheck', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/instance/backupCheck')>();
  return {
    ...real,
    runTestRestore: (...args: any[]) => {
      h.testCalls++;
      if (h.testMode === 'reject') return Promise.reject(new Error('boom'));
      if (h.testMode === 'resolve') return Promise.resolve(null);
      if (h.testMode === 'hold') return new Promise(res => { h.releaseTest = () => res(null); });
      return (real.runTestRestore as any)(...args);
    },
    recoverInterruptedTests: () => {
      if (h.recoverThrows) throw new Error('boom-recover');
      return real.recoverInterruptedTests();
    },
    removeOrphanThrowaways: () => (h.orphansReject ? Promise.reject(new Error('boom-orphans')) : real.removeOrphanThrowaways()),
  };
});

import * as fs from 'fs';
import * as path from 'path';
import { docker, resetDocker, callsWith } from './nm2-docker';
import { holder } from './dump-fake';
import { fenceOwners } from './fence-fake';
import { PRIMARY, REPLICA, seedBot, clearRegistry, stored, dumps, dumpsDir, putDump, stampText, restartedManager, startedWithTick, tickOnce, localAt, logged } from './nm2-harness';
import { setNow, realNow } from './nm2-harness';

const NOW = localAt(10, 30);
const H = 3_600_000;
const mainBot = (extra: Record<string, unknown> = {}) => seedBot({ fleetDb: PRIMARY, ...extra });
const pgDumps = () => callsWith('pg_dump').filter(a => a.includes('pg_dump'));
const inspects = (name: string) => docker.calls.filter(a => a[0] === 'inspect' && a[a.length - 1] === name).length;
const utc = (at: number) => `${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
const readError = (p: string): string => { try { fs.readdirSync(p); return ''; } catch (e: any) { return e.message; } };

async function ready() {
  const fb = await restartedManager();
  const bc = await import('../../src/instance/backupCheck');
  const tick = startedWithTick(fb);
  return { fb, bc, tick, run: () => tickOnce(fb, tick) };
}

beforeEach(() => {
  setNow(NOW);
  resetDocker();
  fenceOwners.clear();
  Object.assign(h, {
    holders: [], corrupt: false, undecryptable: [], outOfScope: false, shutdown: false, startSaveFails: false, startSaves: 0,
    testMode: 'real', testCalls: 0, releaseTest: null, recoverThrows: false, orphansReject: false,
  });
  fs.rmSync(path.join(h.dir, 'backups'), { recursive: true, force: true });
  clearRegistry();
});
afterEach(() => { h.releaseTest?.(); realNow(); });
afterAll(() => { fs.rmSync(h.dir, { recursive: true, force: true }); });

describe('NM2 L5 b: the snapshot session', () => {
  it('a session that ends after its counts and before the dump finishes leaves a complete dump, with no wait', async () => {
    holder.linger = true;
    mainBot();
    const { fb, tick } = await ready();
    fb.dumpTiming.holderExitMs = 50;
    let release!: () => void;
    docker.dumpHold = new Promise<void>(r => { release = r; });
    const { lines } = await logged(async () => {
      tick();
      await vi.waitFor(() => expect(pgDumps().length).toBe(1), { timeout: 4000, interval: 5 });
      h.holders[0].emit('close', 0);
      release();
      await vi.waitFor(() => expect(fb.isTickRunning()).toBe(false), { timeout: 4000, interval: 5 });
    });
    expect(lines.filter(l => l.includes('did not end'))).toEqual([]);
    expect(dumps().length).toBe(1);
    expect(fb.fleetBackupStatus(stored()).main?.lastError).toBeNull();
  });

  it('a session that ends with no counts and no error line names that', async () => {
    holder.failQueue = [''];
    mainBot();
    const { fb, run } = await ready();
    await run();
    expect(fb.fleetBackupStatus(stored()).main?.lastError).toBe("the dump's snapshot and table counts could not be taken (the session ended before its counts)");
  });
});

describe('NM2 L5 b: the family plan', () => {
  it('a corrupt env store stops the scheduled dump with its text', async () => {
    h.corrupt = true;
    mainBot();
    const { fb, run } = await ready();
    await run();
    expect(fb.fleetBackupStatus(stored()).main?.lastError).toBe('the env store cannot be read (a copy is kept beside it as storage.json.corrupt-<time> when it could be read), so the scheduled dump cannot verify its scope');
  });

  it('a database URL that no longer decrypts stops the scheduled dump with its text', async () => {
    h.undecryptable = ['DATABASE_URL'];
    mainBot();
    const { fb, run } = await ready();
    await run();
    expect(fb.fleetBackupStatus(stored()).main?.lastError).toBe('the stored database URL no longer decrypts (the encryption key changed?), so the scheduled dump cannot verify its scope');
  });

  it('a standby record with no user is an error, logged once per hour slot', async () => {
    seedBot({ fleetDbReplica: { ...REPLICA, user: '', seededAt: NOW - 30 * 86400000 } });
    const { fb, bc, run } = await ready();
    const text = 'the standby record has no database identity, so no scheduled dump of this copy ran';
    const first = await run();
    expect(first).toContain(`[FleetBackup] No scheduled dump of ${bc.familyText(stored(), 'copy')}: ${text}`);
    expect(fb.fleetBackupStatus(stored()).copy?.lastError).toBe(text);
    const second = await run();
    expect(second.filter(l => l.includes('No scheduled dump'))).toEqual([]);
  });

  it('an unreadable backup folder is the error, keeps a standing dumps alert, and names the list error', async () => {
    fs.mkdirSync(path.dirname(dumpsDir()), { recursive: true });
    fs.writeFileSync(dumpsDir(), 'x');
    const msg = readError(dumpsDir());
    mainBot({ fleetBackupStarts: { main: NOW - 10 * H }, fleetBackupAlerts: { 'main:dumps': { kind: 'dumps', text: 'old', since: NOW - 5 * H, dm: 'sent', dmAt: NOW - 5 * H } } });
    const { fb, run } = await ready();
    await run();
    const expected = `The backup folder for a could not be read: ${msg}`;
    expect(stored().fleetBackupAlerts?.['main:dumps']?.text).toContain(`Last error: ${expected}.`);
    const st = fb.fleetBackupStatus(stored()).main!;
    expect(st.lastError).toBe(expected);
    expect(st.listError).toBe(`${expected}, so the last backup cannot be named`);
  });

  it('an out of scope family saves no start', async () => {
    h.outOfScope = true;
    mainBot();
    const { run } = await ready();
    await run();
    expect(stored().fleetBackupStarts).toBeUndefined();
  });
});

describe('NM2 L5 b: a stopped database', () => {
  it('counts from the tick that found it stopped, is not paused once it runs, and probes once per tick', async () => {
    mainBot({ fleetBackupStarts: { main: NOW - 10 * H } });
    docker.running[PRIMARY.containerName] = false;
    setNow(NOW - H);
    const { fb, run } = await ready();
    const before = inspects(PRIMARY.containerName);
    await run();
    expect(inspects(PRIMARY.containerName) - before).toBe(1);
    expect(fb.fleetBackupStatus(stored()).main?.paused).toBe(true);
    docker.running[PRIMARY.containerName] = null;
    setNow(NOW);
    await run();
    expect(inspects(PRIMARY.containerName) - before).toBe(2);
    expect(stored().fleetBackupAlerts?.['main:dumps']).toBeUndefined();
    expect(fb.fleetBackupStatus(stored()).main?.paused).toBe(false);
  });
});

describe('NM2 L5 b: dataAt and the status', () => {
  it('a copy dump keeps the dataAt it took in memory', async () => {
    holder.inRecovery = 't';
    holder.dataAt = 5000;
    seedBot({ fleetDbReplica: { ...REPLICA, seededAt: NOW - 30 * 86400000 } });
    const { fb, run } = await ready();
    await run();
    const name = dumps()[0];
    const metaPath = path.join(dumpsDir(), `${name}.json`);
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    fs.writeFileSync(metaPath, JSON.stringify({ ...meta, dataAt: 9999 }));
    expect(fb.fleetBackupStatus(stored()).copy?.dataAt).toBe(5000);
  });

  it('the main family shows no dataAt, and shows its standing test alert', async () => {
    putDump(`hourly-${stampText(localAt(10, 5))}.dump`, { takenAt: localAt(10, 5), meta: { dataAt: 5000 } });
    mainBot({ fleetBackupAlerts: { 'main:test': { kind: 'test', text: 'held', since: NOW - H, dm: 'sent', dmAt: NOW - H } } });
    const { fb } = await ready();
    const st = fb.fleetBackupStatus(stored()).main!;
    expect(st.dataAt).toBeNull();
    expect(st.alerts.test).toMatchObject({ text: 'held' });
  });
});

describe('NM2 L5 b: the family start', () => {
  it('a start already stored is not written again', async () => {
    mainBot();
    const { run } = await ready();
    await run();
    setNow(NOW + H);
    await run();
    expect(h.startSaves).toBe(1);
  });

  it('a start that failed to save is saved at its first time on the next tick', async () => {
    mainBot();
    h.startSaveFails = true;
    const { run } = await ready();
    await run();
    h.startSaveFails = false;
    setNow(NOW + H);
    await run();
    expect(stored().fleetBackupStarts).toEqual({ main: NOW });
  });

  it('a failed start save is logged once per hour slot', async () => {
    mainBot();
    h.startSaveFails = true;
    const { run } = await ready();
    const lines = [...await run(), ...await run()];
    expect(lines.filter(l => l.includes('No start of the backups')).length).toBe(1);
  });

  it('an unsaved start is dropped when the family goes off and the registry already agrees', async () => {
    mainBot();
    h.startSaveFails = true;
    const { run } = await ready();
    await run();
    h.startSaveFails = false;
    mainBot({ fleetBackup: { enabled: false, hour: 4 } });
    setNow(NOW + H);
    await run();
    mainBot();
    setNow(NOW + 2 * H);
    await run();
    expect(stored().fleetBackupStarts).toEqual({ main: NOW + 2 * H });
  });

  it('an unsaved start is dropped once saved, so a later clear and restart take a new start', async () => {
    mainBot();
    h.startSaveFails = true;
    const { run } = await ready();
    await run();
    h.startSaveFails = false;
    setNow(NOW + H);
    await run();
    expect(stored().fleetBackupStarts).toEqual({ main: NOW });
    mainBot({ fleetBackup: { enabled: false, hour: 4 }, fleetBackupStarts: stored().fleetBackupStarts });
    setNow(NOW + 2 * H);
    await run();
    expect(stored().fleetBackupStarts).toBeUndefined();
    mainBot();
    setNow(NOW + 3 * H);
    await run();
    expect(stored().fleetBackupStarts).toEqual({ main: NOW + 3 * H });
  });
});

describe('NM2 L5 b: the alert texts', () => {
  it('a dumps alert with no recorded error has no error sentence', async () => {
    mainBot({ fleetBackupStarts: { main: NOW - 10 * H } });
    const { bc, run } = await ready();
    const guards = await import('../../src/instance/fleetBackupGuards');
    expect(guards.claimFleetBackupBusy('a')).toBe(true);
    try {
      setNow(NOW + 3 * H);
      await run();
    } finally { guards.releaseFleetBackupBusy('a'); }
    expect(stored().fleetBackupAlerts?.['main:dumps']?.text).toBe(`No backup of ${bc.familyText(stored(), 'main')}${bc.whereText(stored(), 'main')} has succeeded since ${utc(NOW - 10 * H)}. The manager tries again every hour; its Database window has the details.`);
  });

  it('a standing dumps alert stays after a restart that has not tried yet', async () => {
    mainBot({ fleetBackupStarts: { main: NOW - 10 * H }, fleetBackupAlerts: { 'main:dumps': { kind: 'dumps', text: 'old', since: NOW - 5 * H, dm: 'sent', dmAt: NOW - 5 * H } } });
    const { run } = await ready();
    const guards = await import('../../src/instance/fleetBackupGuards');
    expect(guards.claimFleetBackupBusy('a')).toBe(true);
    try { await run(); } finally { guards.releaseFleetBackupBusy('a'); }
    expect(stored().fleetBackupAlerts?.['main:dumps']).toBeDefined();
  });

  it('a failed test with no text says no reason was recorded', async () => {
    h.testMode = 'resolve';
    mainBot({ fleetBackupTests: { main: { last: { file: 'x.dump', startedAt: NOW - 60_000, finishedAt: NOW, result: 'failed' } } } });
    const { run } = await ready();
    await run();
    expect(stored().fleetBackupAlerts?.['main:test']?.text).toContain('x.dump, a backup of');
    expect(stored().fleetBackupAlerts?.['main:test']?.text).toContain(', failed: no reason was recorded. The manager tests');
  });

  it('an interrupted test keeps the held alert text', async () => {
    h.testMode = 'resolve';
    mainBot({
      fleetBackupTests: { main: { last: { file: 'x.dump', startedAt: NOW - 60_000, result: 'interrupted' } } },
      fleetBackupAlerts: { 'main:test': { kind: 'test', text: 'held text', since: NOW - H, dm: 'sent', dmAt: NOW - H } },
    });
    const { run } = await ready();
    await run();
    expect(stored().fleetBackupAlerts?.['main:test']?.text).toBe('held text');
  });
});

describe('NM2 L5 b: the tick', () => {
  it('a running test restore blocks a second one', async () => {
    h.testMode = 'hold';
    mainBot();
    const { fb, tick } = await ready();
    tick();
    await vi.waitFor(() => expect(fb.isTickRunning()).toBe(false), { timeout: 4000, interval: 5 });
    expect(h.testCalls).toBe(1);
    setNow(NOW + 60_000);
    tick();
    await vi.waitFor(() => expect(fb.isTickRunning()).toBe(false), { timeout: 4000, interval: 5 });
    expect(h.testCalls).toBe(1);
  });

  it('a test restore that throws is logged with its family', async () => {
    h.testMode = 'reject';
    mainBot();
    const { bc, run } = await ready();
    const lines = await run();
    expect(lines).toContain(`[FleetBackup] The test restore of ${bc.familyText(stored(), 'main')} stopped on an error: Error: boom`);
  });

  it('a shutdown begun skips the alerts and the start', async () => {
    h.shutdown = true;
    mainBot();
    const { run } = await ready();
    await run();
    expect(stored().fleetBackupStarts).toBeUndefined();
  });

  it('the rotation moves only on ticks with bots, one bot a tick', async () => {
    const { run } = await ready();
    await run();
    mainBot();
    seedBot({ fleetDbReplica: { ...REPLICA, containerName: 'bot-b-replica', seededAt: NOW - 30 * 86400000 } }, 'b');
    seedBot({ fleetDbReplica: { ...REPLICA, containerName: 'bot-c-replica', seededAt: NOW - 30 * 86400000 } }, 'c');
    const order = () => pgDumps().map(a => a[1]);
    await run();
    expect(order()).toEqual([PRIMARY.containerName, 'bot-b-replica', 'bot-c-replica']);
    setNow(NOW + H);
    await run();
    expect(order().slice(3)).toEqual(['bot-b-replica', 'bot-c-replica', PRIMARY.containerName]);
  });
});

describe('NM2 L5 b: the start sweep and its logs', () => {
  it('no backups folder logs nothing', async () => {
    const { lines } = await logged(() => ready());
    expect(lines.filter(l => l.includes('could not be read'))).toEqual([]);
  });

  it('a backups path that is a file is logged with its message', async () => {
    const root = path.join(h.dir, 'backups');
    fs.writeFileSync(root, 'x');
    const msg = readError(root);
    const { lines } = await logged(() => ready());
    expect(lines).toContain(`[FleetBackup] The backups folder could not be read: ${msg}`);
  });

  it('per folder: unreadable logged, missing silent, undeletable logged, none deleted silent', async () => {
    const root = path.join(h.dir, 'backups');
    const bad = path.join(root, 'x', 'fleet-postgres');
    fs.mkdirSync(path.dirname(bad), { recursive: true });
    fs.writeFileSync(bad, 'x');
    const msg = readError(bad);
    fs.mkdirSync(path.join(root, 'y'), { recursive: true });
    const z = path.join(root, 'z', 'fleet-postgres');
    fs.mkdirSync(path.join(z, 'q.dump.tmp'), { recursive: true });
    putDump(`hourly-${stampText(localAt(9, 5))}.dump`, { id: 'w', takenAt: localAt(9, 5) });
    const { lines } = await logged(() => ready());
    expect(lines).toContain(`[FleetBackup] The backup folder ${bad} could not be read: ${msg}`);
    expect(lines.filter(l => l.includes(path.join(root, 'y')))).toEqual([]);
    expect(lines.some(l => l.startsWith(`[FleetBackup] Could not delete the unfinished backup file q.dump.tmp in ${z}: Error: `))).toBe(true);
    expect(lines.filter(l => l.includes('Deleted 0'))).toEqual([]);
  });

  it('start errors of the interrupted tests and the leftover removal are logged', async () => {
    h.recoverThrows = true;
    h.orphansReject = true;
    const { lines } = await logged(async () => {
      const r = await ready();
      await new Promise(res => setTimeout(res, 20));
      return r;
    });
    expect(lines).toContain('[FleetBackup] The test restores a restart cut short could not be read: Error: boom-recover');
    expect(lines).toContain('[FleetBackup] Test-restore leftover removal error: Error: boom-orphans');
  });
});
