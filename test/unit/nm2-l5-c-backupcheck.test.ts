import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm2-l5c-'));
  process.env.DATA_DIR = dir;
  return {
    dir,
    execs: [] as Array<{ cmd: string; args: string[]; opts: any }>,
    raw: null as null | ((args: string[]) => { err: any; stdout: any; stderr: any } | undefined),
    children: [] as any[],
    kills: 0,
    endless: false,
    streams: [] as any[],
    testSaveFails: null as null | ((tests: any) => boolean),
    alertSaveFails: null as null | ((id: string) => boolean),
    alertSaves: 0,
    hooks: false,
    hookAnswer: { ok: true } as any,
    bare: false,
    throwRestore: false,
    readThrows: false,
    readHit: false,
    rmThrows: null as null | (() => boolean),
  };
});

vi.mock('child_process', async (importOriginal) => {
  const base: any = await (await import('./nm2-docker')).childProcessMock(await importOriginal());
  const execFile = (cmd: string, args: string[], opts: any, cb: any) => {
    h.execs.push({ cmd, args, opts });
    if (args[0] === 'rm' && args[1] === '-f' && h.rmThrows?.()) throw Object.assign(new Error('spawn docker ENOMEM'), { code: 'ENOMEM' });
    const r = h.raw?.(args);
    if (r) { setTimeout(() => cb(r.err, r.stdout, r.stderr), 1); return undefined; }
    return base.execFile(cmd, args, opts, cb);
  };
  const spawn = (cmd: string, args: string[], ...rest: any[]) => {
    if (h.throwRestore && args.includes('pg_restore')) throw Object.assign(new Error('spawn ENOMEM'), { code: 'ENOMEM' });
    if (h.bare && args.includes('pg_restore')) {
      const { EventEmitter } = require('events') as typeof import('events');
      const bare: any = new EventEmitter();
      bare.kill = () => { h.kills++; return true; };
      h.children.push({ args, child: bare });
      process.nextTick(() => bare.emit('error', { message: 'spawn docker EMFILE' }));
      return bare;
    }
    const child = base.spawn(cmd, args, ...rest);
    const kill = child.kill;
    child.kill = (...a: any[]) => { h.kills++; return kill(...a); };
    h.children.push({ args, child });
    return child;
  };
  return { ...base, execFile, spawn, default: { ...base.default, execFile, spawn } };
});
vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>();
  const { Readable } = await import('stream');
  const createReadStream = (p: any, o?: any) => {
    if (h.readThrows) h.readHit = true;
    if (h.readThrows) throw new Error('EMFILE: too many open files');
    if (!h.endless) return (real.createReadStream as any)(p, o);
    const s = new Readable({ read() {} });
    h.streams.push(s);
    return s;
  };
  return { ...real, createReadStream, default: { ...real, createReadStream } };
});
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));
vi.mock('../../src/instance/appHookClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/appHookClient')>()),
  hasAppHooks: () => h.hooks,
  callAppHook: async () => h.hookAnswer,
}));
vi.mock('../../src/docker/containerManager', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/docker/containerManager')>();
  return {
    ...real,
    updateInstanceFleetBackupTest: (id: string, family: any, tests: any) => {
      if (h.testSaveFails?.(tests)) throw new Error('disk full');
      return real.updateInstanceFleetBackupTest(id, family, tests);
    },
    updateInstanceFleetBackupAlert: (id: string, key: string, alert: any) => {
      h.alertSaves++;
      if (h.alertSaveFails?.(id)) throw new Error('disk full');
      return real.updateInstanceFleetBackupAlert(id, key, alert);
    },
  };
});

import * as fs from 'fs';
import * as path from 'path';
import { docker, resetDocker, callsWith } from './nm2-docker';
import { PRIMARY, seedBot, clearRegistry, stored, putDump, stampText, localAt, dumpsDir, logged, setNow, realNow } from './nm2-harness';

const NOW = localAt(10, 30);
const FILE = `daily-${stampText(localAt(4, 10))}.dump`;
const COUNTS = { '"public"."t"': 3 };
const T = 'smdb-testrestore-a';

async function load() {
  vi.resetModules();
  const bc = await import('../../src/instance/backupCheck');
  const cm = await import('../../src/docker/containerManager');
  return { bc, cm, bot: (id = 'a') => cm.getBot(id)! };
}

async function failText(): Promise<string | undefined> {
  const { bc, bot } = await load();
  return (await bc.runTestRestore(bot(), 'main', FILE))?.text;
}

const restoreChild = async () => {
  await vi.waitFor(() => expect(h.children.some(c => c.args.includes('pg_restore'))).toBe(true));
  return h.children.find(c => c.args.includes('pg_restore')).child;
};

beforeEach(() => {
  setNow(NOW);
  resetDocker();
  docker.restoredCounts = { ...COUNTS };
  h.execs = [];
  h.raw = null;
  h.children = [];
  h.kills = 0;
  h.endless = false;
  h.streams = [];
  h.testSaveFails = null;
  h.alertSaveFails = null;
  h.alertSaves = 0;
  h.hooks = false;
  h.hookAnswer = { ok: true };
  h.bare = false;
  h.throwRestore = false;
  h.readThrows = false;
  h.readHit = false;
  h.rmThrows = null;
  fs.rmSync(path.join(h.dir, 'backups'), { recursive: true, force: true });
  clearRegistry();
  seedBot({ fleetDb: PRIMARY });
  putDump(FILE, { counts: COUNTS });
});
afterEach(() => { realNow(); vi.restoreAllMocks(); });
afterAll(() => { fs.rmSync(h.dir, { recursive: true, force: true }); });

describe('NM2 L5 c: backupCheck survivors', () => {
  it('whereText names the host of each family', async () => {
    const { bc } = await load();
    const inst: any = { fleetDb: { replication: { publicHost: 'main.example' } }, fleetDbReplica: { publicHost: 'copy.example' } };
    expect(bc.whereText(inst, 'main')).toBe(' on main.example');
    expect(bc.whereText(inst, 'copy')).toBe(' on copy.example');
  });

  it('docker runs as docker with a 16 MiB buffer and the 30 s bound', async () => {
    expect(await failText()).toBeUndefined();
    const vol = h.execs.find(e => e.args[0] === 'volume' && e.args[1] === 'create')!;
    expect(vol.cmd).toBe('docker');
    expect(vol.opts).toMatchObject({ maxBuffer: 16 * 1024 * 1024, timeout: 30_000 });
    expect(vol.args).toEqual(['volume', 'create', '--label', 'smdb.testrestore=a', T]);
    expect(callsWith('df')[0]).toEqual(['exec', T, 'df', '-Pk', '/var/lib/postgresql/data']);
    expect(callsWith('psql')[0].slice(0, 12)).toEqual(['exec', T, 'psql', '-U', 'postgres', '-d', 'restorecheck', '-X', '-tA', '-v', 'ON_ERROR_STOP=1', '-c']);
    expect(callsWith('psql')[0][12]).toMatch(/count/i);
  });

  const volumeFails = (r: { err: any; stdout: any; stderr: any }) => {
    h.raw = args => (args[0] === 'volume' && args[1] === 'create' ? r : undefined);
  };

  it('a docker call past its bound reads as no answer within 30 s', async () => {
    volumeFails({ err: Object.assign(new Error('Command failed'), { killed: true }), stdout: '', stderr: '' });
    expect(await failText()).toBe('the throwaway database could not be started (docker did not answer within 30 s)');
  });

  it('docker stderr wins over the error message', async () => {
    volumeFails({ err: Object.assign(new Error('Command failed'), { killed: false }), stdout: '', stderr: 'real reason' });
    expect(await failText()).toBe('the throwaway database could not be started (real reason)');
  });

  it('with no stderr the error message is the reason', async () => {
    volumeFails({ err: Object.assign(new Error('boom'), { killed: false }), stdout: '', stderr: '' });
    expect(await failText()).toBe('the throwaway database could not be started (boom)');
  });

  it('with no stderr and no message docker gave no reason', async () => {
    volumeFails({ err: { killed: false }, stdout: undefined, stderr: '' });
    expect(await failText()).toBe('the throwaway database could not be started (docker gave no reason)');
  });

  it('the last line of stderr is trimmed', async () => {
    volumeFails({ err: new Error('x'), stdout: '', stderr: 'first\n   second' });
    expect(await failText()).toBe('the throwaway database could not be started (second)');
  });

  it('an empty df output reads as empty output', async () => {
    h.raw = args => (args.includes('df') ? { err: null, stdout: undefined, stderr: '' } : undefined);
    expect(await failText()).toBe("the free space of the disk that holds Docker's volumes could not be read (empty output)");
  });

  it('a throwaway ready on the second check passes', async () => {
    let n = 0;
    docker.overrides.push({ match: a => a.includes('pg_isready'), answer: () => (++n === 1 ? { ok: false, stderr: 'no response' } : { ok: true }) });
    const { bc, bot } = await load();
    bc.testTiming.readyDeadlineMs = 2000;
    bc.testTiming.readyGapMs = 5;
    expect((await bc.runTestRestore(bot(), 'main', FILE))?.result).toBe('passed');
  });

  it('a deadline reached exactly fails without a second check', async () => {
    let n = 0;
    docker.overrides.push({ match: a => a.includes('pg_isready'), answer: () => (++n === 1 ? { ok: false, stderr: 'no response' } : { ok: true }) });
    vi.spyOn(performance, 'now').mockReturnValue(5000);
    const { bc, bot } = await load();
    bc.testTiming.readyDeadlineMs = 0;
    bc.testTiming.readyGapMs = 5;
    expect((await bc.runTestRestore(bot(), 'main', FILE))?.text).toBe('the throwaway database did not accept connections within 90 s');
  });

  it('free space exactly the need passes', async () => {
    putDump(FILE, { counts: COUNTS, meta: { dbBytes: 512 } });
    docker.dfFreeKb = (1024 * 1024 * 1024 + 1024) / 1024;
    const { bc, bot } = await load();
    expect((await bc.runTestRestore(bot(), 'main', FILE))?.result).toBe('passed');
  });

  it('unparsable counts fail with their reason', async () => {
    docker.overrides.push({ match: a => a.includes('psql'), answer: { ok: true, stdout: 'count|x|notanumber\n' } });
    expect(await failText()).toMatch(/^the restored tables could not be counted \(.+\)$/);
  });

  it('a missing counts file names the read error', async () => {
    fs.rmSync(path.join(dumpsDir(), `${FILE}.json`));
    expect(await failText()).toMatch(/^the counts recorded with this backup could not be read \(ENOENT/);
  });

  it('a counts file naming another dump fails', async () => {
    putDump(FILE, { counts: COUNTS, meta: { file: 'other.dump' } });
    expect(await failText()).toBe('the counts recorded with this backup could not be read (the counts file names other.dump)');
  });

  it('pg_restore stderr is trimmed and cut at 500 characters', async () => {
    docker.restore = { code: 1, stderr: `  ${'e'.repeat(600)}  ` };
    expect(await failText()).toBe(`pg_restore exited with code 1: ${'e'.repeat(500)}`);
  });

  it('pg_restore stderr past 4000 characters is not kept', async () => {
    docker.restore = { code: 0, hang: true };
    const { bc, bot } = await load();
    const run = bc.runTestRestore(bot(), 'main', FILE);
    const child = await restoreChild();
    child.stderr.write(' '.repeat(4000));
    await new Promise(r => setTimeout(r, 10));
    child.stderr.write('late');
    await new Promise(r => setTimeout(r, 10));
    child.emit('close', 1);
    expect((await run)?.text).toBe('pg_restore exited with code 1: ');
  });

  const closeWith = async (code: number, restoreSec: number) => {
    docker.restore = { code: 0, hang: true };
    const { bc, bot } = await load();
    bc.testTiming.restoreSec = restoreSec;
    const run = bc.runTestRestore(bot(), 'main', FILE);
    const child = await restoreChild();
    await new Promise(r => setTimeout(r, 10));
    child.emit('close', code);
    return (await run)?.text;
  };

  it('code 137 past the bound reads as not finished', async () => {
    expect(await closeWith(137, 0)).toBe('pg_restore did not finish within 10 minutes');
  });

  it('code 137 within the bound reads as its exit code', async () => {
    expect(await closeWith(137, 600)).toBe('pg_restore exited with code 137: ');
  });

  it('another code past the bound reads as its exit code', async () => {
    expect(await closeWith(1, 0)).toBe('pg_restore exited with code 1: ');
  });

  it('code 137 at exactly the bound reads as not finished', async () => {
    vi.spyOn(performance, 'now').mockReturnValue(400_000);
    expect(await closeWith(137, 0)).toBe('pg_restore did not finish within 10 minutes');
  });

  it('code 137 within the bound late in the process reads as its exit code', async () => {
    vi.spyOn(performance, 'now').mockReturnValue(400_000);
    expect(await closeWith(137, 600)).toBe('pg_restore exited with code 137: ');
  });

  it('a docker exec that cannot start fails with its error', async () => {
    docker.restore = { code: 0, hang: true };
    const { bc, bot } = await load();
    const run = bc.runTestRestore(bot(), 'main', FILE);
    const child = await restoreChild();
    child.emit('error', new Error('spawn docker ENOENT'));
    expect((await run)?.text).toBe('Failed to run docker exec: spawn docker ENOENT');
  });

  it('an error on the restore stdin is absorbed', async () => {
    docker.restore = { code: 0, hang: true };
    h.endless = true;
    const { bc, bot } = await load();
    const run = bc.runTestRestore(bot(), 'main', FILE);
    const child = await restoreChild();
    h.streams[0].unpipe();
    expect(() => child.stdin.emit('error', new Error('EPIPE'))).not.toThrow();
    child.emit('close', 1);
    await run;
  });

  it('a finished restore closes the dump stream and stops its backstop', async () => {
    docker.restore = { code: 0, hang: true };
    h.endless = true;
    const { bc, bot } = await load();
    bc.testTiming.backstopMs = 400;
    const run = bc.runTestRestore(bot(), 'main', FILE);
    const child = await restoreChild();
    child.emit('close', 1);
    await run;
    expect(h.streams[0].destroyed).toBe(true);
    await new Promise(r => setTimeout(r, 600));
    expect(h.kills).toBe(0);
  });

  it('a restore child spawned with no stdio fails the test with the spawn error, and the throwaway is removed', async () => {
    h.bare = true;
    h.endless = true;
    const { bc, bot } = await load();
    const record = await bc.runTestRestore(bot(), 'main', FILE);
    expect(record).toMatchObject({ result: 'failed', text: 'Failed to run docker exec: spawn docker EMFILE' });
    expect(stored().fleetBackupTests?.main?.last).toMatchObject({ result: 'failed', text: 'Failed to run docker exec: spawn docker EMFILE' });
    expect(h.streams[0].destroyed).toBe(true);
    const removals = docker.calls.filter(a => (a[0] === 'rm' && a[1] === '-f' && a[2] === T) || (a[0] === 'volume' && a[1] === 'rm' && a[2] === T));
    expect(removals.length).toBeGreaterThanOrEqual(4);
  });

  it('a pg_restore spawn that throws fails the test, removes the throwaway, and leaves nothing to recover', async () => {
    h.throwRestore = true;
    const escaped: unknown[] = [];
    const onEscape = (e: unknown) => { escaped.push(e); };
    process.on('uncaughtException', onEscape);
    process.on('unhandledRejection', onEscape);
    try {
      const { bc, bot } = await load();
      const record = await bc.runTestRestore(bot(), 'main', FILE);
      await new Promise(r => setTimeout(r, 50));
      expect(record).toMatchObject({ result: 'failed', text: 'Failed to run docker exec: spawn ENOMEM' });
      expect(stored().fleetBackupTests?.main?.last).toMatchObject({ result: 'failed', text: 'Failed to run docker exec: spawn ENOMEM' });
      expect(escaped).toEqual([]);
      const removals = docker.calls.filter(a => (a[0] === 'rm' && a[1] === '-f' && a[2] === T) || (a[0] === 'volume' && a[1] === 'rm' && a[2] === T));
      expect(removals.length).toBeGreaterThanOrEqual(4);
    const before = JSON.stringify(stored().fleetBackupTests);
      (await load()).bc.recoverInterruptedTests();
      expect(JSON.stringify(stored().fleetBackupTests)).toBe(before);
    } finally {
      process.off('uncaughtException', onEscape);
      process.off('unhandledRejection', onEscape);
    }
  });

  it('a test that throws is saved as failed with the error text, and the throwaway is removed', async () => {
    h.readThrows = true;
    const { bc, bot } = await load();
    const record = await bc.runTestRestore(bot(), 'main', FILE);
    expect(record).toMatchObject({ result: 'failed' });
    expect(record?.text).toContain('EMFILE: too many open files');
    expect(stored().fleetBackupTests?.main?.last).toMatchObject({ result: 'failed', text: record?.text });
    const removals = docker.calls.filter(a => (a[0] === 'rm' && a[1] === '-f' && a[2] === T) || (a[0] === 'volume' && a[1] === 'rm' && a[2] === T));
    expect(removals.length).toBeGreaterThanOrEqual(4);
    const before = JSON.stringify(stored().fleetBackupTests);
    (await load()).bc.recoverInterruptedTests();
    expect(JSON.stringify(stored().fleetBackupTests)).toBe(before);
  });

  it('a failed test whose throwaway removal throws is saved as failed with the first error, and nothing escapes', async () => {
    h.readThrows = true;
    h.rmThrows = () => h.readHit;
    const escaped: unknown[] = [];
    const onEscape = (e: unknown) => { escaped.push(e); };
    process.on('uncaughtException', onEscape);
    process.on('unhandledRejection', onEscape);
    try {
      const { bc, bot } = await load();
      const record = await bc.runTestRestore(bot(), 'main', FILE);
      await new Promise(r => setTimeout(r, 50));
      expect(record).toMatchObject({ result: 'failed', text: 'the test stopped on an error: EMFILE: too many open files; the throwaway container or volume smdb-testrestore-a could not be removed (Failed to run docker exec: spawn docker ENOMEM), and the next test removes it first' });
      expect(stored().fleetBackupTests?.main?.last).toMatchObject({ result: 'failed', text: record?.text });
      expect(escaped).toEqual([]);
    } finally {
      process.off('uncaughtException', onEscape);
      process.off('unhandledRejection', onEscape);
    }
  });

  it('a passed test whose throwaway removal throws stays passed and says the throwaway is left', async () => {
    h.rmThrows = () => h.children.some(c => c.args.includes('pg_restore'));
    const escaped: unknown[] = [];
    const onEscape = (e: unknown) => { escaped.push(e); };
    process.on('uncaughtException', onEscape);
    process.on('unhandledRejection', onEscape);
    try {
      const { bc, bot } = await load();
      const record = await bc.runTestRestore(bot(), 'main', FILE);
      await new Promise(r => setTimeout(r, 50));
      expect(record).toMatchObject({ result: 'passed', text: '; the throwaway container or volume smdb-testrestore-a could not be removed (Failed to run docker exec: spawn docker ENOMEM), and the next test removes it first' });
      expect(stored().fleetBackupTests?.main).toMatchObject({ last: { result: 'passed' }, lastGood: FILE });
      expect(escaped).toEqual([]);
    } finally {
      process.off('uncaughtException', onEscape);
      process.off('unhandledRejection', onEscape);
    }
  });

  it('a test after an interrupted one keeps cutShort, and a fresh one has none', async () => {
    const { bc, bot } = await load();
    const fresh = await bc.runTestRestore(bot(), 'main', FILE);
    expect(Object.keys(fresh!)).not.toContain('cutShort');
    seedBot({ fleetDb: PRIMARY, fleetBackupTests: { main: { last: { file: FILE, startedAt: NOW, result: 'interrupted', cutShort: 1 } } } });
    const again = await bc.runTestRestore(bot(), 'main', FILE);
    expect(again?.cutShort).toBe(1);
    expect(stored().fleetBackupTests.main.last.cutShort).toBe(1);
  });

  it('a failed test sets no lastGood, and the result line is logged', async () => {
    docker.restore = { code: 1, stderr: 'bad' };
    const { bc, bot } = await load();
    const { lines } = await logged(() => bc.runTestRestore(bot(), 'main', FILE));
    expect(stored().fleetBackupTests.main.lastGood).toBeUndefined();
    expect(lines).toContain(`[FleetBackup] Test restore of ${FILE} (Bot a's main database) failed: pg_restore exited with code 1: bad`);
    docker.restore = { code: 0 };
    const ok = await logged(() => bc.runTestRestore(bot(), 'main', FILE));
    expect(ok.lines).toContain(`[FleetBackup] Test restore of ${FILE} (Bot a's main database) passed`);
  });

  it('a held result belongs to its family and goes once a later save lands', async () => {
    h.testSaveFails = t => t?.last?.result === 'passed';
    const { bc, bot } = await load();
    await bc.runTestRestore(bot(), 'main', FILE);
    expect(bc.currentTests(bot(), 'main').last?.result).toBe('passed');
    expect(bc.currentTests(bot(), 'copy')).toEqual({});
    h.testSaveFails = null;
    docker.restore = { code: 1, stderr: 'bad' };
    await bc.runTestRestore(bot(), 'main', FILE);
    expect(bc.currentTests(bot(), 'main').last?.result).toBe('failed');
  });

  it('a refused clear with no lastGood drops the held result', async () => {
    h.testSaveFails = t => t?.last?.result === 'failed';
    docker.restore = { code: 1, stderr: 'bad' };
    const { bc, bot } = await load();
    await bc.runTestRestore(bot(), 'main', FILE);
    expect(bc.currentTests(bot(), 'main').last?.result).toBe('failed');
    h.testSaveFails = () => true;
    await logged(() => bc.clearLastTest(bot(), 'main', NOW));
    expect(bc.currentTests(bot(), 'main').last?.result).toBe('running');
  });

  it('a family with no last test is not cleared', async () => {
    h.testSaveFails = () => true;
    const { bc, bot } = await load();
    const { lines } = await logged(() => bc.clearLastTest(bot(), 'main', NOW));
    expect(lines).toEqual([]);
  });

  it('a cut-short test is logged only when its record is refused', async () => {
    seedBot({ fleetDb: PRIMARY, fleetBackupTests: { main: { last: { file: FILE, startedAt: NOW, result: 'running' } } } });
    const { bc } = await load();
    expect((await logged(() => bc.recoverInterruptedTests())).lines).toEqual([]);
    seedBot({ fleetDb: PRIMARY, fleetBackupTests: { main: { last: { file: FILE, startedAt: NOW, result: 'running' } } } });
    h.testSaveFails = () => true;
    expect((await logged(() => bc.recoverInterruptedTests())).lines).toEqual(["[FleetBackup] The cut-short test restore of Bot a's main database could not be recorded (disk full)"]);
  });

  it('orphans: exact names only, trimmed, listed by label, with each failure logged', async () => {
    docker.orphans = { containers: ['xsmdb-testrestore-a', 'smdb-testrestore-ok'], volumes: [' smdb-testrestore-z', 'smdb-testrestore-gone'] };
    docker.overrides.push({ match: a => a[0] === 'rm' && a.includes('smdb-testrestore-ok'), answer: { ok: false, stderr: 'permission denied' } });
    docker.overrides.push({ match: a => a[0] === 'volume' && a[1] === 'rm' && a.includes('smdb-testrestore-gone'), answer: { ok: false, stderr: 'Error: No such volume' } });
    const { bc } = await load();
    const { lines } = await logged(() => bc.removeOrphanThrowaways());
    expect(callsWith('xsmdb')).toEqual([]);
    expect(docker.calls).toContainEqual(['volume', 'rm', 'smdb-testrestore-z']);
    expect(docker.calls).toContainEqual(['volume', 'ls', '--filter', 'label=smdb.testrestore', '--format', '{{.Name}}']);
    expect(lines).toEqual(['[FleetBackup] Could not remove the test-restore leftover smdb-testrestore-ok (permission denied)']);
  });

  it('orphan lists that fail are logged by kind', async () => {
    docker.overrides.push({ match: a => a[0] === 'ps' || (a[0] === 'volume' && a[1] === 'ls'), answer: { ok: false, stderr: 'daemon down' } });
    const { bc } = await load();
    const { lines } = await logged(() => bc.removeOrphanThrowaways());
    expect(lines).toEqual([
      '[FleetBackup] The test-restore containers left by an earlier run could not be listed (daemon down)',
      '[FleetBackup] The test-restore volumes left by an earlier run could not be listed (daemon down)',
    ]);
  });

  it('a held alert belongs to its bot, and goes once a later save lands', async () => {
    seedBot({ fleetDb: PRIMARY }, 'b');
    const { bc, bot } = await load();
    h.alertSaveFails = () => true;
    await logged(() => bc.stepAlerts(bot('b'), [{ family: 'main', kind: 'dumps', on: true, text: 'x' }], NOW));
    await logged(() => bc.stepAlerts(bot('a'), [{ family: 'main', kind: 'dumps', on: true, text: 'x' }], NOW));
    expect(Object.keys(bc.currentAlerts('b'))).toEqual(['main:dumps']);
    h.alertSaveFails = id => id === 'b';
    await logged(() => bc.stepAlerts(bot('a'), [{ family: 'main', kind: 'dumps', on: false, text: 'x' }], NOW));
    expect(bc.currentAlerts('a')).toEqual({});
  });

  it('an alert that is off and absent, or unchanged, is not saved', async () => {
    seedBot({ fleetDb: PRIMARY, fleetBackupAlerts: { 'main:test': { kind: 'test', text: 'x', since: NOW, dm: 'sent', dmAt: NOW } } });
    const { bc, bot } = await load();
    await bc.stepAlerts(bot(), [{ family: 'main', kind: 'test', on: true, text: 'x' }, { family: 'main', kind: 'dumps', on: false, text: 'y' }], NOW);
    expect(h.alertSaves).toBe(0);
  });

  it('the DM log names the outcome and its error', async () => {
    const { bc, bot } = await load();
    const a = await logged(() => bc.stepAlerts(bot(), [{ family: 'main', kind: 'test', on: true, text: 'x' }], NOW));
    expect(a.lines).toEqual(['[FleetBackup] DM to the owner of Bot a about main:test: unsupported']);
    h.hooks = true;
    h.hookAnswer = { ok: false, error: 'boom' };
    const b = await logged(() => bc.stepAlerts(bot(), [{ family: 'main', kind: 'dumps', on: true, text: 'y' }], NOW));
    expect(b.lines).toEqual(['[FleetBackup] DM to the owner of Bot a about main:dumps: failed (boom)']);
  });

  it('a refused hook with no error text reads notify-owner failed', async () => {
    h.hooks = true;
    h.hookAnswer = { ok: false, error: '' };
    const { bc, bot } = await load();
    expect(await bc.notifyOwner(bot(), 'x')).toEqual({ dm: 'failed', dmError: 'notify-owner failed' });
  });
});
