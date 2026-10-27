import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm2-l5a-'));
  process.env.DATA_DIR = dir;
  return {
    dir,
    url: 'postgresql://app:pw@bot-a-postgres:5432/app',
    freeBytes: null as number | null,
    statfsThrows: false,
    readdirThrows: false,
    readdirAfterDump: false,
    failOpen: null as null | ((p: string, flags: string) => boolean),
    failWrite: null as null | ((p: string) => boolean),
    writes: [] as Array<{ p: string; opts: any }>,
    holders: [] as any[],
    dumps: [] as any[],
    onHolder: null as null | ((child: any) => void),
    bare: false,
    bareDump: false,
    throwHolder: false,
    throwDump: false,
    holdFirstClose: false,
    streams: [] as any[],
  };
});

vi.mock('child_process', async (importOriginal) => {
  const mod = await (await import('./nm2-docker')).childProcessMock(await importOriginal());
  const { isHolder } = await import('./dump-fake');
  const inner = mod.spawn as (cmd: string, args: string[], opts?: any) => any;
  const spawn = (cmd: string, args: string[], opts?: any) => {
    if ((h.throwHolder && cmd === 'docker' && isHolder(args)) || (h.throwDump && cmd === 'docker' && args.includes('pg_dump'))) {
      throw Object.assign(new Error('spawn ENOMEM'), { code: 'ENOMEM' });
    }
    if ((h.bare && cmd === 'docker' && isHolder(args)) || (h.bareDump && cmd === 'docker' && args.includes('pg_dump'))) {
      const { EventEmitter } = require('events') as typeof import('events');
      const bare: any = new EventEmitter();
      bare.kill = () => true;
      process.nextTick(() => bare.emit('error', { message: 'spawn docker EMFILE' }));
      return bare;
    }
    const child = inner(cmd, args, opts);
    if (cmd === 'docker' && isHolder(args)) { h.holders.push(child); h.onHolder?.(child); }
    if (cmd === 'docker' && args.includes('pg_dump')) { h.dumps.push(child); if (h.readdirAfterDump) h.readdirThrows = true; }
    return child;
  };
  return { ...mod, spawn, default: { ...(mod.default as object), spawn } };
});
vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>();
  const statfsSync = (p: any, o?: any) => {
    if (h.statfsThrows) throw new Error('ENOSYS: statfs refused');
    return h.freeBytes !== null ? { bavail: h.freeBytes / 4096, bsize: 4096 } : (real.statfsSync as any)(p, o);
  };
  const openSync = (p: any, flags: any, mode?: any) => {
    if (h.failOpen?.(String(p), String(flags))) throw new Error('EIO: sync refused');
    return real.openSync(p, flags, mode);
  };
  const readdirSync = (p: any, o?: any) => {
    if (h.readdirThrows && String(p).endsWith('fleet-postgres')) throw new Error('EACCES: denied');
    return (real.readdirSync as any)(p, o);
  };
  const writeFileSync = (p: any, data: any, opts?: any) => {
    h.writes.push({ p: String(p), opts });
    if (h.failWrite?.(String(p))) throw new Error('EACCES: meta refused');
    return real.writeFileSync(p, data, opts);
  };
  const createWriteStream = (p: any, o?: any) => {
    const s: any = (real.createWriteStream as any)(p, o);
    h.streams.push(s);
    if (h.holdFirstClose && h.streams.length === 1) {
      const destroy = s._destroy.bind(s);
      const gate = new Promise<void>(r => {
        const t = setInterval(() => { if (h.streams[1] && !h.streams[1].pending) { clearInterval(t); r(); } }, 2);
        setTimeout(() => { clearInterval(t); r(); }, 300);
      });
      s._destroy = (err: any, cb: any) => { gate.then(() => destroy(err, cb)); };
    }
    return s;
  };
  const over = { statfsSync, openSync, readdirSync, writeFileSync, createWriteStream };
  return { ...real, ...over, default: { ...real, ...over } };
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

import * as fs from 'fs';
import * as path from 'path';
import { docker, resetDocker, callsWith } from './nm2-docker';
import { holder } from './dump-fake';
import { fenceOwners } from './fence-fake';
import { PRIMARY, seedBot, clearRegistry, stored, dumps, files, dumpsDir, putDump, stampText, restartedManager, startedWithTick, tickOnce, localAt, logged, setNow, realNow } from './nm2-harness';

const NOW = localAt(10, 30);
const H = 3_600_000;
const MIB = 1024 * 1024;
const NAME = `pre-restore-${stampText(NOW)}.dump`;
const CONFLICT = 'psql:<stdin>:4: ERROR:  canceling statement due to conflict with recovery\nDETAIL:  User query might have needed to see row versions that must be removed.';
const pgDumps = () => callsWith('pg_dump').filter(a => a.includes('pg_dump'));
const meta = (name = NAME) => JSON.parse(fs.readFileSync(path.join(dumpsDir(), `${name}.json`), 'utf-8'));

async function dumpNow(prefix = 'pre-restore-') {
  seedBot({ fleetDb: PRIMARY });
  const fb = await restartedManager();
  const run = await logged(() => fb.runFleetDump(stored(), prefix));
  return { fb, result: run.value, lines: run.lines };
}

async function ticked() {
  const fb = await restartedManager();
  const tick = startedWithTick(fb);
  return { fb, run: () => tickOnce(fb, tick) };
}

beforeEach(() => {
  setNow(NOW);
  resetDocker();
  fenceOwners.clear();
  Object.assign(h, { freeBytes: null, statfsThrows: false, readdirThrows: false, readdirAfterDump: false, failOpen: null, failWrite: null, writes: [], holders: [], dumps: [], onHolder: null, bare: false, bareDump: false, throwHolder: false, throwDump: false, holdFirstClose: false, streams: [] });
  fs.rmSync(path.join(h.dir, 'backups'), { recursive: true, force: true });
  clearRegistry();
});
afterEach(() => { realNow(); });
afterAll(() => { fs.rmSync(h.dir, { recursive: true, force: true }); });

describe('NM2 L5 a: the list of backups', () => {
  it('ignores a counts file that names another dump, and lists newest first by the time taken', async () => {
    putDump('other-b.dump', { takenAt: NOW - 5 * H });
    putDump('other-a.dump', { takenAt: NOW - H });
    putDump('other-c.dump', { meta: { file: 'other-x.dump' }, mtime: NOW - 9 * H });
    putDump('other-0.dump', { takenAt: NOW - 20 * H });
    seedBot({ fleetDb: PRIMARY });
    const fb = await restartedManager();
    const list = fb.listFleetBackups('a');
    expect(list.map(e => e.file)).toEqual(['other-a.dump', 'other-b.dump', 'other-c.dump', 'other-0.dump']);
    expect(list[2].tables).toBeNull();
    expect(list[0].tables).toBe(1);
  });

  it('carries a failed test verdict for the dump the last test read', async () => {
    putDump('other-a.dump');
    seedBot({ fleetDb: PRIMARY, fleetBackupTests: { main: { last: { file: 'other-a.dump', startedAt: NOW - H, finishedAt: NOW - H, result: 'failed', text: 'x' } } } });
    const fb = await restartedManager();
    expect(fb.listFleetBackups('a')[0].test).toBe('failed');
  });
});

describe('NM2 L5 a: the trim', () => {
  it('logs the folder fault and keeps every backup', async () => {
    seedBot({ fleetDb: PRIMARY });
    h.readdirAfterDump = true;
    const { run } = await ticked();
    const lines = await run();
    expect(lines).toContain("[FleetBackup] Kept every backup of Bot a's main database: The backup folder for a could not be read: EACCES: denied");
  });

  it('deletes a victim with its counts file, and one without a counts file logs nothing', async () => {
    const withJson = `hourly-${stampText(NOW - 60 * H)}.dump`;
    const bare = `hourly-${stampText(NOW - 61 * H)}.dump`;
    putDump(withJson);
    putDump(bare, { meta: null });
    seedBot({ fleetDb: PRIMARY });
    const { run } = await ticked();
    const lines = await run();
    expect(files()).toEqual([`daily-${stampText(NOW)}.dump`, `daily-${stampText(NOW)}.dump.json`]);
    expect(lines.filter(l => l.includes('Failed to trim'))).toEqual([]);
  });

  it('logs a victim that cannot be deleted', async () => {
    const stuck = `hourly-${stampText(NOW - 60 * H)}.dump`;
    fs.mkdirSync(path.join(dumpsDir(), stuck, 'inside'), { recursive: true });
    seedBot({ fleetDb: PRIMARY });
    const { run } = await ticked();
    const lines = await run();
    expect(lines.some(l => l.startsWith(`[FleetBackup] Failed to trim ${stuck} of Bot a's main database: `))).toBe(true);
  });
});

describe('NM2 L5 a: a safety dump and its disk check', () => {
  it('a pre- prefix writes a safety dump and no prefix an other one, with no error key on success', async () => {
    const first = await dumpNow();
    expect(first.result).toStrictEqual({ success: true, file: NAME });
    expect(meta().kind).toBe('safety');
    setNow(NOW + 1000);
    const second = await dumpNow('');
    expect(meta(`${stampText(NOW + 1000)}.dump`).kind).toBe('other');
    expect(second.result.success).toBe(true);
  });

  it('a free space that cannot be read is logged and the dump goes ahead', async () => {
    h.statfsThrows = true;
    const { result, lines } = await dumpNow();
    expect(result.success).toBe(true);
    expect(lines).toContain(`[FleetBackup] The free space under ${dumpsDir()} could not be read (Error: ENOSYS: statfs refused); the dump goes ahead`);
  });

  it('twice the newest scheduled dump sets the need when it passes the floor', async () => {
    fs.mkdirSync(dumpsDir(), { recursive: true });
    const big = path.join(dumpsDir(), `daily-${stampText(NOW - 2 * H)}.dump`);
    fs.writeFileSync(big, '');
    fs.truncateSync(big, 300 * MIB);
    h.freeBytes = 550 * MIB;
    const { result } = await dumpNow();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/^only 550 MB is free under .+, and a dump needs about 600 MB;/);
  });

  it('free space equal to the need lets the dump go ahead', async () => {
    h.freeBytes = 512 * MIB;
    const { result } = await dumpNow();
    expect(result).toStrictEqual({ success: true, file: NAME });
  });

  it('a disk refusal is a failure', async () => {
    h.freeBytes = 100 * MIB;
    const { result } = await dumpNow();
    expect(result.success).toBe(false);
    expect(holder.spawned).toEqual([]);
  });
});

describe('NM2 L5 a: the attempts', () => {
  it('a dump that succeeds logs in once', async () => {
    docker.overrides.push({ match: a => a.join(' ').includes('rolsuper'), answer: { ok: true, stdout: 'true\n' } });
    const { result } = await dumpNow();
    expect(result.success).toBe(true);
    expect(holder.spawned.length).toBe(1);
  });

  it('a failure that is not a missing role is not tried again', async () => {
    docker.overrides.push({ match: a => a.join(' ').includes('rolsuper'), answer: { ok: true, stdout: 'true\n' } });
    holder.failQueue = ['psql: error: connection refused'];
    const { result } = await dumpNow();
    expect(result.success).toBe(false);
    expect(holder.spawned.length).toBe(1);
  });

  it('a missing manager role is made and the dump runs once more', async () => {
    docker.overrides.push({ match: a => a.join(' ').includes('rolsuper'), answer: { ok: true, stdout: 'true\n' } });
    holder.failQueue = ['psql: error: connection to server failed: FATAL:  role "dbm_admin" does not exist'];
    const { result } = await dumpNow();
    expect(result).toStrictEqual({ success: true, file: NAME });
    expect(holder.spawned.length).toBe(2);
  });

  it('three conflicts are a failure', async () => {
    holder.failQueue = [CONFLICT, CONFLICT, CONFLICT];
    const { result } = await dumpNow();
    expect(result).toStrictEqual({ success: false, error: "the live copy's replay cancelled the dump 3 times in a row (conflict with recovery); the next hourly run tries again" });
  });

  it('a second conflict past the time for attempts names 2 times and fails', async () => {
    holder.failQueue = [CONFLICT, CONFLICT, CONFLICT];
    seedBot({ fleetDb: PRIMARY });
    const fb = await restartedManager();
    h.onHolder = () => { if (h.holders.length === 2) fb.dumpTiming.conflictBudgetMs = 0; };
    const result = await fb.runFleetDump(stored(), 'pre-restore-');
    expect(result).toStrictEqual({ success: false, error: "the live copy's replay cancelled the dump 2 times in a row (conflict with recovery), and no new attempt starts once a run has taken 10 minutes; the next hourly run tries again" });
  });
});

describe('NM2 L5 a: one dump', () => {
  it('a slow dump is not failed by the snapshot timer once the counts are in', async () => {
    let release: () => void = () => {};
    docker.dumpHold = new Promise<void>(r => { release = r; });
    seedBot({ fleetDb: PRIMARY });
    const fb = await restartedManager();
    fb.dumpTiming.snapshotTimeoutMs = 20;
    const running = fb.runFleetDump(stored(), 'pre-restore-');
    await vi.waitFor(() => expect(pgDumps().length).toBe(1));
    await new Promise(r => setTimeout(r, 60));
    release();
    expect(await running).toStrictEqual({ success: true, file: NAME });
  });

  it('a dump file that cannot be synced fails with the finalize text', async () => {
    h.failOpen = (p, flags) => flags === 'r+' && p.endsWith('.dump.tmp');
    const { result } = await dumpNow();
    expect(result).toStrictEqual({ success: false, error: 'Failed to finalize dump file: Error: EIO: sync refused' });
    expect(files()).toEqual([]);
  });

  it('the counts file is written private, and one that cannot be written names the error message', async () => {
    const ok = await dumpNow();
    expect(ok.result.success).toBe(true);
    expect(h.writes.find(w => w.p.endsWith('.dump.json.tmp'))?.opts).toEqual({ mode: 0o600 });
    fs.rmSync(path.join(h.dir, 'backups'), { recursive: true, force: true });
    h.failWrite = p => p.endsWith('.dump.json.tmp');
    const { result } = await dumpNow();
    expect(result.error).toBe('the dump finished, but its counts file could not be written (EACCES: meta refused), so the dump was not kept');
  });

  it('a holder error after the dump is written does not fail it', async () => {
    holder.linger = true;
    seedBot({ fleetDb: PRIMARY });
    const fb = await restartedManager();
    fb.dumpTiming.holderExitMs = 300;
    const running = fb.runFleetDump(stored(), 'pre-restore-');
    await vi.waitFor(() => expect(dumps()).toEqual([NAME]));
    h.holders[0].emit('error', new Error('late'));
    expect(await running).toStrictEqual({ success: true, file: NAME });
  });

  it('a folder sync refused on Windows keeps the dump a success', async () => {
    const real = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      h.failOpen = (p, flags) => flags === 'r' && p.endsWith('fleet-postgres');
      const { result } = await dumpNow();
      expect(result).toStrictEqual({ success: true, file: NAME });
    } finally { Object.defineProperty(process, 'platform', real); }
  });

  it('a holder that ended before the dump finished answers at once with no stop', async () => {
    holder.linger = true;
    let release: () => void = () => {};
    docker.dumpHold = new Promise<void>(r => { release = r; });
    seedBot({ fleetDb: PRIMARY });
    const fb = await restartedManager();
    fb.dumpTiming.holderExitMs = 30;
    const out = await logged(async () => {
      const running = fb.runFleetDump(stored(), 'pre-restore-');
      await vi.waitFor(() => expect(pgDumps().length).toBe(1));
      h.holders[0].emit('close', 0);
      release();
      const r = await running;
      await new Promise(res => setTimeout(res, 80));
      return r;
    });
    expect(out.value).toStrictEqual({ success: true, file: NAME });
    expect(out.lines.filter(l => l.includes('did not end'))).toEqual([]);
    expect(holder.killed).toBe(0);
  });

  it('a holder that ends after the dump leaves no stop timer behind', async () => {
    seedBot({ fleetDb: PRIMARY });
    const fb = await restartedManager();
    fb.dumpTiming.holderExitMs = 30;
    const out = await logged(async () => {
      const r = await fb.runFleetDump(stored(), 'pre-restore-');
      await new Promise(res => setTimeout(res, 80));
      return r;
    });
    expect(out.value.success).toBe(true);
    expect(out.lines.filter(l => l.includes('did not end'))).toEqual([]);
    expect(holder.killed).toBe(0);
    expect(pgDumps()[0]).toContain('-Fc');
  });

  it('a pg_dump that cannot start fails with the docker exec text', async () => {
    let release: () => void = () => {};
    docker.dumpHold = new Promise<void>(r => { release = r; });
    seedBot({ fleetDb: PRIMARY });
    const fb = await restartedManager();
    const running = fb.runFleetDump(stored(), 'pre-restore-');
    await vi.waitFor(() => expect(h.dumps.length).toBe(1));
    h.dumps[0].emit('error', new Error('spawn docker ENOENT'));
    release();
    expect(await running).toStrictEqual({ success: false, error: 'Failed to run docker exec: spawn docker ENOENT' });
  });

  it('a pg_dump error text is trimmed and cut at 500 characters', async () => {
    docker.dumps = [{ code: 1, stderr: `  ${'e'.repeat(600)}` }];
    const { result } = await dumpNow();
    expect(result.error).toBe(`pg_dump exited with code 1: ${'e'.repeat(500)}`);
    docker.dumps = [{ code: 1, stderr: '  short\n' }];
    fs.rmSync(path.join(h.dir, 'backups'), { recursive: true, force: true });
    const again = await dumpNow();
    expect(again.result.error).toBe('pg_dump exited with code 1: short');
  });

  it('holder stderr past the cap is not kept, so its error line is not read', async () => {
    holder.failQueue = [CONFLICT];
    h.onHolder = child => { child.stderr.write(`${'x'.repeat(3999)}\n`); };
    const { result } = await dumpNow();
    expect(result.error).toBe(`the dump's snapshot and table counts could not be taken (${'x'.repeat(3999)})`);
  });

  it('holder output after the counts starts no extra pg_dump', async () => {
    let release: () => void = () => {};
    docker.dumpHold = new Promise<void>(r => { release = r; });
    seedBot({ fleetDb: PRIMARY });
    const fb = await restartedManager();
    const running = fb.runFleetDump(stored(), 'pre-restore-');
    await vi.waitFor(() => expect(pgDumps().length).toBe(1));
    h.holders[0].stdout.write('\n');
    await new Promise(r => setTimeout(r, 20));
    release();
    expect(await running).toStrictEqual({ success: true, file: NAME });
    expect(pgDumps().length).toBe(1);
  });

  it('a stdin error on the holder is ignored', async () => {
    let release: () => void = () => {};
    docker.dumpHold = new Promise<void>(r => { release = r; });
    seedBot({ fleetDb: PRIMARY });
    const fb = await restartedManager();
    const running = fb.runFleetDump(stored(), 'pre-restore-');
    await vi.waitFor(() => expect(pgDumps().length).toBe(1));
    h.holders[0].stdin.emit('error', new Error('EPIPE'));
    release();
    expect(await running).toStrictEqual({ success: true, file: NAME });
  });
});

describe('NM2 L5 a: one tmp name per run', () => {
  it('a conflict attempt whose file closes late does not remove the file of the next attempt', async () => {
    h.holdFirstClose = true;
    docker.dumps = [{ code: 1, stderr: CONFLICT }];
    const { result } = await dumpNow();
    expect(result).toStrictEqual({ success: true, file: NAME });
    expect(pgDumps()).toHaveLength(2);
    expect(fs.readdirSync(dumpsDir()).sort()).toEqual([NAME, `${NAME}.json`]);
  });
});

async function quietly<T>(run: () => Promise<T>): Promise<{ value: T; escaped: unknown[] }> {
  const escaped: unknown[] = [];
  const onEscape = (e: unknown) => { escaped.push(e); };
  process.on('uncaughtException', onEscape);
  process.on('unhandledRejection', onEscape);
  try {
    const value = await run();
    await new Promise(r => setTimeout(r, 50));
    return { value, escaped };
  } finally {
    process.off('uncaughtException', onEscape);
    process.off('unhandledRejection', onEscape);
  }
}

describe('NM2 L5 a: a spawn that throws', () => {
  it('a holder spawn that throws fails the dump with the docker exec text', async () => {
    h.throwHolder = true;
    const { value, escaped } = await quietly(() => dumpNow());
    expect(value.result).toStrictEqual({ success: false, error: 'Failed to run docker exec: spawn ENOMEM' });
    expect(escaped).toEqual([]);
    expect(fs.readdirSync(dumpsDir())).toEqual([]);
  });

  it('a pg_dump spawn that throws fails the dump with the docker exec text and keeps no file', async () => {
    h.throwDump = true;
    const { value, escaped } = await quietly(() => dumpNow());
    expect(value.result).toStrictEqual({ success: false, error: 'Failed to run docker exec: spawn ENOMEM' });
    expect(escaped).toEqual([]);
    expect(fs.readdirSync(dumpsDir())).toEqual([]);
  });
});

describe('NM2 L5 a: the snapshot line', () => {
  it('a later snap| in the snapshot line does not match', async () => {
    holder.hang = true;
    h.onHolder = child => { setTimeout(() => child.stdout.write('snap|x|snap|S1|f|10|-1\ncount|"public"."t"|3\nend|\n'), 5); };
    const { result } = await dumpNow();
    expect(result.error).toBe("the dump's snapshot and table counts could not be taken (the snapshot line read back as snap|x|snap|S1|f|10|-1)");
    expect(pgDumps()).toHaveLength(0);
  });

  it('a holder spawned with no stdio fails with the spawn error and nothing rejects', async () => {
    h.bare = true;
    const { result } = await dumpNow();
    expect(result).toStrictEqual({ success: false, error: 'Failed to run docker exec: spawn docker EMFILE' });
    expect(pgDumps()).toHaveLength(0);
  });

  it('a pg_dump spawned with no stdio fails with the spawn error, keeps no file, and nothing rejects', async () => {
    h.bareDump = true;
    const { result } = await dumpNow();
    expect(result).toStrictEqual({ success: false, error: 'Failed to run docker exec: spawn docker EMFILE' });
    await new Promise(r => setTimeout(r, 50));
    expect(fs.readdirSync(dumpsDir())).toEqual([]);
  });

  it('pg_dump stderr past the cap is not kept, so the exit text keeps only the blanks', async () => {
    let release: () => void = () => {};
    docker.dumpHold = new Promise<void>(r => { release = r; });
    docker.dumps = [{ code: 1 }];
    seedBot({ fleetDb: PRIMARY });
    const fb = await restartedManager();
    const running = fb.runFleetDump(stored(), 'pre-restore-');
    await vi.waitFor(() => expect(h.dumps.length).toBe(1));
    h.dumps[0].stderr.write(' '.repeat(4000));
    h.dumps[0].stderr.write('pg_dump: error: X\n');
    release();
    expect(await running).toStrictEqual({ success: false, error: 'pg_dump exited with code 1: ' });
  });

  it('a snapshot line with trailing spaces after a blank line is read', async () => {
    holder.dataAt = '5 ' as any;
    h.onHolder = child => { child.stdout.write('\n'); };
    const { result } = await dumpNow();
    expect(result).toStrictEqual({ success: true, file: NAME });
    expect(meta().dataAt).toBe(5);
  });

  it('no snapshot line reads back as nothing', async () => {
    holder.hang = true;
    h.onHolder = child => { setTimeout(() => child.stdout.write('end|\n'), 5); };
    const { result } = await dumpNow();
    expect(result.error).toBe("the dump's snapshot and table counts could not be taken (the snapshot line read back as nothing)");
  });

  it('a long bad snapshot line is cut at 200 characters', async () => {
    holder.hang = true;
    const bad = `snap|${'z'.repeat(300)}`;
    h.onHolder = child => { setTimeout(() => child.stdout.write(`${bad}\nend|\n`), 5); };
    const { result } = await dumpNow();
    expect(result.error).toBe(`the dump's snapshot and table counts could not be taken (the snapshot line read back as ${bad.slice(0, 200)})`);
  });

  it('text after the data time fails the snapshot line', async () => {
    holder.dataAt = '-1x' as any;
    const { result } = await dumpNow();
    expect(result.error).toBe("the dump's snapshot and table counts could not be taken (the snapshot line read back as snap|00000003-0000001B-1|f|1000|-1x)");
  });

  it('records recovery and the data time: t is true, -1 is none, 0 is 0', async () => {
    holder.inRecovery = 't';
    holder.dataAt = -1;
    await dumpNow();
    expect(meta()).toMatchObject({ inRecovery: true, dataAt: null });
    fs.rmSync(path.join(h.dir, 'backups'), { recursive: true, force: true });
    holder.dataAt = 0;
    await dumpNow();
    expect(meta().dataAt).toBe(0);
  });
});
