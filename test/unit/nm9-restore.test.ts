import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm9-restore-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir };
});

const pg = vi.hoisted(() => ({
  events: [] as string[],
  sql: [] as string[],
  urls: {} as Record<string, string>,
  live: {} as Record<string, string[] | null>,
  sidecar: true,
  exists: '1',
  liftFails: false,
  at: {} as Record<string, () => void>,
  noticeAtDrop: undefined as unknown,
  floorAtDrop: null as string | null,
}));

vi.mock('../../src/config/appCapabilities', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/config/appCapabilities')>();
  return { ...real, findAppCapabilities: () => ({ companionDb: { env: { url: 'DATABASE_URL' } } }) };
});
vi.mock('../../src/env/manager', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/env/manager')>();
  return {
    ...real,
    getEnvVarsWithStatus: (id: string) => ({ vars: { DATABASE_URL: pg.urls[id] ?? '' }, corrupt: false, undecryptable: [], encrypted: [] }),
    getEnvVars: (id: string) => ({ DATABASE_URL: pg.urls[id] ?? '' }),
  };
});
vi.mock('../../src/instance/appHookClient', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/instance/appHookClient')>();
  return { ...real, callAppHook: async () => ({ ok: true, status: 200, body: { success: true } }) };
});
vi.mock('../../src/docker/containerManager', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/docker/containerManager')>();
  const ev = (name: string) => { pg.events.push(name); pg.at[name]?.(); };
  return {
    ...real,
    isShuttingDown: () => false,
    appContainerRunning: async () => false,
    runningInstanceContainers: async (id: string) => (id in pg.live ? pg.live[id] : []),
    startFleetDbSidecar: async () => { ev('sidecar-up'); pg.sidecar = true; return { success: true }; },
    stopBot: async (id: string) => { ev(`stop:${id}`); pg.live[id] = []; return { success: true }; },
    startBot: async (id: string) => { ev(`start:${id}`); return { success: true }; },
    stopBotInOp: async (id: string) => { ev(`stopInOp:${id}`); pg.live[id] = []; pg.sidecar = false; return { success: true }; },
    startBotInOp: async (id: string) => { ev(`startInOp:${id}`); return { success: true }; },
    updateInstanceFleetDbSwitch: (botId: string, patch: any) => {
      (globalThis as any).__claimDb?.genEvents.push(`switch:${Object.keys(patch).join(',')}`);
      return real.updateInstanceFleetDbSwitch(botId, patch);
    },
  };
});

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const { EventEmitter } = require('events') as typeof import('events');
  const { PassThrough } = require('stream') as typeof import('stream');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const ev = (name: string) => { pg.events.push(name); pg.at[name]?.(); };
  const execFile = vi.fn((_cmd: string, args: string[], optsOrCb: unknown, maybeCb?: unknown) => {
    const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as (err: Error | null, stdout: string, stderr: string) => void;
    const sql = args.join(' ');
    const fail = (text: string) => cb(new Error(text), '', `ERROR:  ${text}`);
    if (args[0] === 'inspect') return cb(null, args[args.length - 1] === 'bot-a-postgres' ? `${pg.sidecar}\n` : 'true\n', '');
    const readOnlyOn = ((globalThis as any).__fenceOwners as Map<string, string> | undefined)?.has('bot-a-postgres') === true;
    if (sql.includes('rolsuper')) return cb(null, 'true\n', '');
    if (sql.includes('ALTER ROLE') && !sql.includes('PGOPTIONS=-c default_transaction_read_only=off') && readOnlyOn) return fail('cannot execute ALTER ROLE in a read-only transaction');
    if (sql.endsWith("SELECT current_setting('default_transaction_read_only')")) return cb(null, readOnlyOn ? 'on\n' : 'off\n', '');
    if (args[0] === 'stop') {
      pg.events.push(`docker-stop:${args[1]}`);
      for (const id of Object.keys(pg.live)) pg.live[id] = pg.live[id]?.filter(n => n !== args[1]) ?? null;
      return cb(null, '', '');
    }
    if (sql.includes('ALTER SYSTEM SET default_transaction_read_only = on')) { ev('fence'); return cb(null, '0\n', ''); }
    if (sql.includes('ALTER SYSTEM RESET')) { ev('lift'); return pg.liftFails ? fail('could not write auto.conf') : cb(null, '', ''); }
    if (sql.includes('SHOW default_transaction_read_only')) return cb(null, 'off\n', '');
    if (sql.includes('FROM pg_database WHERE datname')) return cb(null, `${pg.exists}\n`, '');
    if (sql.includes('DROP DATABASE')) {
      const registry = JSON.parse(nodeFs.readFileSync(nodePath.join(tmp.dir, 'instances.json'), 'utf-8'));
      pg.noticeAtDrop = registry.instances.a.fleetRestoreError;
      const floorFile = nodePath.join(tmp.dir, 'backups', 'a', 'fleet-postgres', 'claim-floor.json');
      pg.floorAtDrop = nodeFs.existsSync(floorFile) ? nodeFs.readFileSync(floorFile, 'utf-8') : null;
      ev('drop');
    }
    return cb(null, '', '');
  });
  const exec = (_cmd: string, opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    done(null, { stdout: '', stderr: '' });
  };
  const spawn = vi.fn((_cmd: string, args: string[]) => {
    const child: any = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.stdin.resume();
    child.kill = () => true;
    const isDump = args.includes('pg_dump');
    ev(isDump ? 'dump' : 'pg_restore');
    setTimeout(() => {
      child.stdout.end(isDump ? 'dump' : '');
      child.stderr.end('');
      setTimeout(() => child.emit('close', 0), 5);
    }, 5);
    return child;
  });
  const fakes = await import('./restore-fake');
  const fenced = (await import('./fence-fake')).withFence(fakes.withRestoreFakes(execFile as any));
  const fencedExecFile = ((cmd: string, args: string[], a: unknown, b?: unknown) => { pg.sql.push(args.join(' ')); return (fenced as any)(cmd, args, a, b); }) as typeof fenced;
  const heldSpawn = (await import('./dump-fake')).withDumpHolder(fakes.withTocFake(spawn as any));
  return { ...real, execFile: fencedExecFile, exec, spawn: heldSpawn, default: { ...real, execFile: fencedExecFile, exec, spawn: heldSpawn } };
});

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';
import * as fleetBackup from '../../src/instance/fleetBackup';
import * as fleetBackupGuards from '../../src/instance/fleetBackupGuards';
import { fenceOwners } from './fence-fake';
import { claimDb, resetClaimDb, MAINTAINED } from './restore-fake';

const fb = fleetBackup as any;
const REGISTRY = path.join(tmp.dir, 'instances.json');
const DIR = path.join(tmp.dir, 'backups', 'a', 'fleet-postgres');
const FLOOR = path.join(DIR, 'claim-floor.json');
const primary = { containerName: 'bot-a-postgres', user: 'app', db: 'app', volume: 'bot-a-pgdata' };
const BROKEN = { at: '2026-10-30T09:00:00.000Z', safetyDump: 'pre-receive-x.dump' };

function writeRegistry(extraA: Record<string, unknown> = MAINTAINED): void {
  fs.writeFileSync(REGISTRY, JSON.stringify({ instances: {
    a: { id: 'a', displayName: 'a', sanitizedName: 'bot-a', status: 'running', sourceUrl: 'https://example.invalid/fake/app', createdAt: '2026-10-01T00:00:00.000Z', fleetDb: primary, fleetBackup: { enabled: false, hour: 4, keep: 7 }, ...extraA },
    w: { id: 'w', displayName: 'w', status: 'running', sourceUrl: 'https://example.invalid/fake/app' },
  } }, null, 2));
}
const registryA = () => JSON.parse(fs.readFileSync(REGISTRY, 'utf-8')).instances.a;
const floorFile = () => (fs.existsSync(FLOOR) ? JSON.parse(fs.readFileSync(FLOOR, 'utf-8')) : null);
const brokenPush = () => writeRegistry({ ...MAINTAINED, fleetDb: { ...primary, pushBroken: BROKEN } });

let logs: string[] = [];
beforeEach(() => {
  Object.assign(pg, { sidecar: true, exists: '1', liftFails: false, at: {}, noticeAtDrop: undefined, floorAtDrop: null });
  pg.events.length = 0;
  pg.sql.length = 0;
  pg.urls = { a: 'postgres://app:pw@bot-a-postgres/app', w: 'postgres://app:pw@bot-a-postgres:5432/app?sslmode=no-verify' };
  pg.live = { a: ['bot-a-app'], w: ['bot-w-app'] };
  resetClaimDb({ onRaise: () => { pg.events.push('raise'); claimDb.genEvents.push('raise'); } });
  fenceOwners.clear();
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, 'old.dump'), 'dump');
  fleetBackup.clearClaimFloor('a');
  fleetBackup.dismissFleetRestoreError('a');
  writeRegistry();
  fs.mkdirSync(path.join(tmp.dir, 'bots', 'a'), { recursive: true });
  logs = [];
});
afterAll(() => { fs.rmSync(tmp.dir, { recursive: true, force: true }); });

const restore = (file = 'old.dump') => fleetBackup.restoreFleetBackup('a', file);
const dropped = () => pg.events.includes('drop');
const V3 = 't|t|t|t|t';
const V2 = 't|t|t|f|f';
const NONE = 'f|f|f|f|f';
const ALL = { seq: true, table: true, claim: true, shards: true, clock: true };
const V2_OBJ = { seq: true, table: true, claim: true, shards: false, clock: false };
const RAISE3 = 'seq|9\nclock|1000\nbelow|2\nrows|3\ncapped|3\nshard|2|0|8\nshard|2|1|9\nguild|g1\n';
const raiseFor = (F: number) => `seq|${F + 2}\nclock|1000\nbelow|2\nrows|3\ncapped|3\nshard|2|0|${F + 1}\nshard|2|1|${F + 2}\n`;
const v3 = (over: Record<string, unknown> = {}) => Object.assign(claimDb, { tables: V3, restoredTables: V3, toc: 'shards', raise: RAISE3 }, over);
const noFloor = (over: Record<string, unknown> = {}) => Object.assign(claimDb, { tables: NONE, restoredTables: V3, toc: 'shards' }, over);
const floorSql = () => pg.sql.find(s => s.includes('SELECT coalesce(GREATEST(')) ?? '';
/** The SQL of a docker exec psql call, from its argv joined. */
const sqlOf = (sent: string) => sent.slice(sent.indexOf(' -c ') + 4);
const SHARD_RAISE_MARK = 'FROM smdb_data.shard_claims WHERE claim <= ';

const T11 = 'The dump old.dump has no shard claims, but the database has them, so the restore was refused, and nothing was changed: the database has smdb_data.shard_claims and the dump does not, and a bot that keeps its shard claims in the database does not start on data without them; a pre-restore dump is never refused for this, so a restore can be undone with the one it took';
const T12 = 'The dump old.dump has shard claims but no claim clock, so the restore was refused, and nothing was changed: it has smdb_data.shard_claims but no smdb_data.claim_clock, and the bot creates both together';
const T10 = (error: string) => `The dump was restored, but the restored claim numbers could not be raised above 7 (${error}). The write fence stays on`;
const T13 = (error: string) => `The dump was restored, but the restored shard claims could not be expired (${error}). The write fence stays on`;
const T13_NOTICE = (error: string) => `Restore of old.dump failed: the restored shard claims could not be expired (${error}). A process named in a restored shard claim could keep that shard, so the write fence stays on (`;
const T13U = (error: string) => `The dump was restored, but whether the restored database holds shard claims could not be read (${error}). The write fence stays on`;
const T13U_NOTICE = (error: string) => `Restore of old.dump failed: whether the restored database holds shard claims could not be read (${error}). The manager can't confirm that no restored shard claim is left live, so the write fence stays on (`;
const E1 = 'the restored database has smdb_data.shard_claims but no smdb_data.claim_clock';
const L1S = '[FleetBackup] Raised the claim numbers on bot-a-postgres above 7: 1 guild(s) to 8, 2 shard claim(s) to 8 to 9, 3 shard claim(s) expired at the restored claim clock 1000, claim_seq to 9';
const L1 = '[FleetBackup] Raised the claim numbers on bot-a-postgres above 7: 2 guild(s) to 8, claim_seq to 8';
const L_CAP = '[FleetBackup] Expired 2 restored shard claim(s) on bot-a-postgres at the restored claim clock 1000; no claim number was raised (none was used before)';

const keptFenced = (r: any) => {
  expect(r.success).toBe(false);
  expect(dropped()).toBe(true);
  expect(pg.events.filter(e => e.startsWith('start'))).toEqual([]);
  expect(fleetBackup.getFleetFenceStuck('a')).toMatch(/READ-ONLY/);
  expect(registryA().fleetRestoreError.text).toMatch(/^Restore of old\.dump failed: /);
};
const refusedAfterFence = (r: any, text: string) => {
  expect(r.success).toBe(false);
  expect(r.error).toBe(text);
  expect(dropped()).toBe(false);
  expect(fenceOwners.has('bot-a-postgres')).toBe(false);
  expect(registryA().fleetRestoreError).toBeUndefined();
};
const succeeded = (r: any) => {
  expect(r.error).toBeUndefined();
  expect(r.success).toBe(true);
  expect(registryA().fleetRestoreError).toBeUndefined();
};
const shardSteps = (r: any, raised: number | null, expired: number | null) => {
  expect(r.steps.shardClaimsRaised).toBe(raised);
  expect(r.steps.shardClaimsExpired).toBe(expired);
};

type Row = { id: string; setup?: () => void; check: (r: any) => void };
const ROWS: Row[] = [
  { id: 'A1 the dump has shard_claims and claim_clock', setup: () => v3(), check: r => { succeeded(r); expect(claimDb.raiseSql[0]).toContain(SHARD_RAISE_MARK); } },
  { id: 'A2 the dump has neither (v2)', check: r => { succeeded(r); expect(sqlOf(claimDb.raiseSql[0])).toBe(fb.claimRaiseSql(7, V2_OBJ)); expect(claimDb.raiseSql[0]).not.toContain('shard_claims'); } },
  {
    id: 'A3 the dump has shard_claims without claim_clock: T12 before anything stops', setup: () => v3({ toc: 'shardsNoClock' }),
    check: r => {
      expect(r).toMatchObject({ success: false, error: T12 });
      expect(pg.events.filter(e => e.startsWith('stop') || e === 'fence')).toEqual([]);
      expect(dropped()).toBe(false);
      expect(claimDb.genEvents).toEqual([]);
      expect(registryA().fleetRestoreError).toBeUndefined();
    },
  },
  { id: 'A4 the dump has claim_clock alone: as a v2 dump', setup: () => { claimDb.toc = 'clockOnly'; }, check: r => { succeeded(r); expect(sqlOf(claimDb.raiseSql[0])).toBe(fb.claimRaiseSql(7, V2_OBJ)); } },
  {
    id: 'A5 the live database on v3: the floor reads the shard claims', setup: () => v3(),
    check: r => { succeeded(r); expect(floorSql()).toContain('SELECT coalesce(GREATEST((SELECT last_value FROM smdb_data.claim_seq), (SELECT max(claim) FROM smdb_data.guild_ownership), (SELECT max(claim) FROM smdb_data.shard_claims)), -1)'); },
  },
  {
    id: 'A6 R-FLOOR-SHARD: a shard claim is the highest number', setup: () => v3({ floor: '18', raise: raiseFor(18) }),
    check: r => {
      succeeded(r);
      expect(floorSql()).toContain('(SELECT max(claim) FROM smdb_data.shard_claims)');
      expect(JSON.parse(pg.floorAtDrop ?? 'null')).toEqual({ claim: 18 });
      expect(claimDb.raiseSql[0]).toContain('WHERE claim <= 18');
      expect(r.steps.claimFloor).toBe(18);
    },
  },
  {
    id: 'A7 the live database on term columns: T6', setup: () => v3({ tables: 't|t|f|t|t' }),
    check: r => refusedAfterFence(r, "The bot's database numbers its saves by term, which this manager no longer reads, so the restore was refused, and nothing was changed: smdb_data.guild_ownership has no claim column"),
  },
  {
    id: 'A8 the tables probe answers three fields: T7', setup: () => { claimDb.tables = 't|t|t'; },
    check: r => refusedAfterFence(r, "Could not read the claim numbers before the restore, so the restore was refused, and nothing was changed: the claim probe answered 't|t|t'"),
  },
  {
    id: 'A9 R-T11: live v3, a v2 dump, no pushBroken', setup: () => v3({ toc: 'claims' }),
    check: r => {
      refusedAfterFence(r, T11);
      expect(claimDb.genEvents).not.toContain('gen-live');
      expect(claimDb.genEvents).not.toContain('state-upsert');
    },
  },
  {
    id: 'A10 live v3, a dump with no claims: T5', setup: () => v3({ toc: 'none' }),
    check: r => refusedAfterFence(r, 'The dump old.dump holds no claim numbers, so the restore was refused, and nothing was changed: the bot has used claim numbers up to 7, and without smdb_data.claim_seq in the dump a process that ran before the restore could save over the restored data'),
  },
  {
    id: 'A10e live v3, a dump of a database with no objects: T5', setup: () => v3({ toc: 'empty' }),
    check: r => refusedAfterFence(r, 'The dump old.dump holds no claim numbers, so the restore was refused, and nothing was changed: the bot has used claim numbers up to 7, and without smdb_data.claim_seq in the dump a process that ran before the restore could save over the restored data'),
  },
  { id: 'A11 live v2, a dump with the shard tables', setup: () => v3({ tables: V2 }), check: r => { succeeded(r); shardSteps(r, 2, 3); } },
  {
    id: 'A12 the database missing, a file floor, a v2 dump', setup: () => { pg.exists = '0'; fs.writeFileSync(FLOOR, '{"claim":7}'); },
    check: r => { succeeded(r); expect(sqlOf(claimDb.raiseSql[0])).toBe(fb.claimRaiseSql(7, V2_OBJ)); shardSteps(r, null, null); },
  },
  {
    id: 'A13 the database missing, a file floor, a v3 dump', setup: () => { v3(); pg.exists = '0'; fs.writeFileSync(FLOOR, '{"claim":7}'); },
    check: r => { succeeded(r); expect(claimDb.raiseSql[0]).toContain(`${SHARD_RAISE_MARK}7)`); shardSteps(r, 2, 3); expect(logs).toContain(L1S); },
  },
  {
    id: 'A14 the floor not written: T9', setup: () => { v3(); fs.mkdirSync(`${FLOOR}.tmp`); },
    check: r => { expect(r.success).toBe(false); expect(r.error).toMatch(/^The claim floor 7 could not be kept on disk, so the restore was refused, and nothing was changed: /); expect(dropped()).toBe(false); },
  },
  {
    id: 'A15 no floor, a restored database without shard_claims', setup: () => { claimDb.tables = NONE; },
    check: r => { succeeded(r); expect(claimDb.raiseSql).toEqual([]); expect(claimDb.capSql).toEqual([]); shardSteps(r, null, null); expect(claimDb.genEvents).toContain('gen-write'); },
  },
  { id: 'A16 the restored tables probe fails, with a floor: T10', setup: () => v3({ fail: 'restored' }), check: r => { keptFenced(r); expect(r.error).toMatch(/^The dump was restored, but the restored claim numbers could not be raised above 7 \(/); } },
  {
    id: 'A16 the restored tables probe fails, no floor: T13U', setup: () => noFloor({ fail: 'restored' }),
    check: r => {
      keptFenced(r);
      expect(r.error.startsWith(T13U('ERROR:  connection reset by peer'))).toBe(true);
      expect(registryA().fleetRestoreError.text.startsWith(T13U_NOTICE('ERROR:  connection reset by peer'))).toBe(true);
      expect(claimDb.capSql).toEqual([]);
    },
  },
  {
    id: 'A16c the restored tables probe answers three fields, no floor: T13U', setup: () => noFloor({ restoredTables: 't|t|t' }),
    check: r => {
      keptFenced(r);
      expect(r.error.startsWith(T13U("the claim probe answered 't|t|t'"))).toBe(true);
      expect(registryA().fleetRestoreError.text.startsWith(T13U_NOTICE("the claim probe answered 't|t|t'"))).toBe(true);
      expect(claimDb.capSql).toEqual([]);
    },
  },
  {
    id: 'A17 restored shard_claims without claim_clock, with a floor: T10 with E1', setup: () => v3({ restoredTables: 't|t|t|t|f' }),
    check: r => { keptFenced(r); expect(r.error.startsWith(T10(E1))).toBe(true); expect(claimDb.raiseSql).toEqual([]); expect(claimDb.genEvents).not.toContain('gen-write'); },
  },
  {
    id: 'A18 R-V2-SAME: a v2 restored database gets NM4\'s statement and L1',
    check: r => { succeeded(r); expect(claimDb.raiseSql).toHaveLength(1); expect(sqlOf(claimDb.raiseSql[0])).toBe(fb.claimRaiseSql(7, V2_OBJ)); expect(logs).toContain(L1); expect(claimDb.capSql).toEqual([]); shardSteps(r, null, null); },
  },
  {
    id: 'A19 R-SHARD-SQL: the raise renumbers and caps, L1S', setup: () => v3(),
    check: r => {
      succeeded(r);
      expect(claimDb.raiseSql).toHaveLength(1);
      expect(sqlOf(claimDb.raiseSql[0])).toBe(fb.claimRaiseSql(7, ALL));
      expect(fb.claimRaiseSql(7, ALL)).toContain(SHARD_RAISE_MARK);
      shardSteps(r, 2, 3);
      expect(r.steps.claimRaisedTo).toBe(8);
      expect(logs).toContain(L1S);
      expect(claimDb.capSql).toEqual([]);
    },
  },
  { id: 'A20 the raise fails: T10 with psql\'s line', setup: () => v3({ fail: 'raise' }), check: r => { keptFenced(r); expect(r.error.startsWith(T10('ERROR:  permission denied for sequence claim_seq'))).toBe(true); } },
  {
    id: 'A21 the restored clock has no row: T10 with E2', setup: () => v3({ raise: 'below|0\nrows|3\ncapped|0\n' }),
    check: r => { keptFenced(r); expect(r.error.startsWith(T10('the restored smdb_data.claim_clock has no row, so no claim number was raised'))).toBe(true); },
  },
  {
    id: 'A22 the raise answer breaks a rule: T10 with that error', setup: () => v3({ raise: 'seq|10\nclock|1000\nbelow|3\nrows|3\ncapped|3\nshard|2|0|8\nshard|2|1|9\n' }),
    check: r => { keptFenced(r); expect(r.error.startsWith(T10('the raise answered 2 raised shard claim(s) for 3 at or below 7'))).toBe(true); },
  },
  {
    id: 'A23 every shard row above the floor: 0 raised, every row capped', setup: () => v3({ raise: 'seq|12\nclock|1000\nbelow|0\nrows|2\ncapped|2\nguild|g1\n' }),
    check: r => {
      succeeded(r);
      shardSteps(r, 0, 2);
      expect(claimDb.raiseSql[0]).toContain('GREATEST(q.last_value, 8, (SELECT coalesce(max(claim), 0) FROM c), (SELECT coalesce(max(claim), 0) FROM smdb_data.guild_ownership))');
      expect(logs).toContain('[FleetBackup] Raised the claim numbers on bot-a-postgres above 7: 1 guild(s) to 8, no shard claim at or below 7, 2 shard claim(s) expired at the restored claim clock 1000, claim_seq to 12');
    },
  },
  {
    id: 'A24 R-ORDER: drop, pg_restore, raise, then the generation, then the lift', setup: () => v3(),
    check: r => {
      succeeded(r);
      expect(pg.events.filter(e => ['drop', 'pg_restore', 'raise', 'lift'].includes(e))).toEqual(['drop', 'pg_restore', 'raise', 'lift']);
      expect(claimDb.genEvents.filter(e => ['raise', 'gen-restored', 'gen-write', 'state-clear'].includes(e))).toEqual(['raise', 'gen-restored', 'gen-write', 'state-clear']);
      shardSteps(r, 2, 3);
    },
  },
  {
    id: 'A25 the generation write fails after the raise: RS-GENWRITE, the shard fields set', setup: () => v3({ fail: 'genwrite' }),
    check: r => { keptFenced(r); expect(r.error).toMatch(/^The dump was restored, but the generation row could not be written back/); shardSteps(r, 2, 3); },
  },
  {
    id: 'A26 a sharer started meanwhile after the raise: C47', setup: () => { v3(); pg.at.pg_restore = () => { pg.live.w = ['bot-w-app']; }; },
    check: r => { expect(r.success).toBe(false); expect(r.error).toMatch(/^The dump was restored, but bot-w-app was started outside the manager during the restore/); shardSteps(r, 2, 3); },
  },
  {
    id: 'A27 the lift not lifted after the raise: C49', setup: () => { v3(); pg.liftFails = true; },
    check: r => { expect(r.success).toBe(false); expect(r.error).toMatch(/^Restored, but /); expect(registryA().fleetRestoreError.text).toMatch(/^Restore of old\.dump ran, but /); shardSteps(r, 2, 3); },
  },
  {
    id: 'A28 R-CAP-NO-FLOOR: no floor, a v3 restored database: capped, nothing raised', setup: () => noFloor(),
    check: r => {
      succeeded(r);
      expect(claimDb.raiseSql).toEqual([]);
      expect(claimDb.capSql).toHaveLength(1);
      expect(sqlOf(claimDb.capSql[0])).toBe(fb.claimCapSql());
      expect(claimDb.capSql[0]).toContain('PGOPTIONS=-c default_transaction_read_only=off');
      expect(r.steps).toMatchObject({ claimFloor: null, guildsRaised: null, claimRaisedTo: null });
      shardSteps(r, null, 2);
      expect(logs).toContain(L_CAP);
      expect(claimDb.genEvents.filter(e => e === 'raise' || e === 'gen-write')).toEqual(['raise', 'gen-write']);
      expect(floorFile()).toBeNull();
    },
  },
  {
    id: 'A29 no floor, restored shard_claims without claim_clock: T13 with E1', setup: () => noFloor({ restoredTables: 't|t|t|t|f' }),
    check: r => { keptFenced(r); expect(r.error.startsWith(T13(E1))).toBe(true); expect(claimDb.capSql).toEqual([]); expect(claimDb.genEvents).not.toContain('gen-write'); },
  },
  {
    id: 'A29 no floor, the restored clock without its row: T13 with E2', setup: () => noFloor({ cap: 'rows|2\ncapped|0\n' }),
    check: r => { keptFenced(r); expect(r.error.startsWith(T13('the restored smdb_data.claim_clock has no row, so no shard claim was expired'))).toBe(true); },
  },
  { id: 'A30 no floor, the cap fails: T13 with psql\'s line', setup: () => noFloor({ fail: 'cap' }), check: r => { keptFenced(r); expect(r.error.startsWith(T13('ERROR:  permission denied for table shard_claims'))).toBe(true); } },
  {
    id: 'A31 no floor, the cap answer breaks a rule: T13 with E8', setup: () => noFloor({ cap: 'clock|1000\nrows|2\ncapped|1\n' }),
    check: r => { keptFenced(r); expect(r.error.startsWith(T13('the cap expired 1 of 2 restored shard claims'))).toBe(true); },
  },
  {
    id: 'A32 R-PUSHBROKEN: under pushBroken a v2 dump over a pushed v3 database is restored', setup: () => { brokenPush(); v3({ toc: 'claims', restoredTables: V2, raise: 'seq|8\nguild|g1\nguild|g2\n' }); },
    check: r => {
      succeeded(r);
      expect(dropped()).toBe(true);
      expect(sqlOf(claimDb.raiseSql[0])).toBe(fb.claimRaiseSql(7, V2_OBJ));
      expect(claimDb.raiseSql[0]).not.toContain('shard_claims');
      expect(claimDb.genEvents.filter(e => ['gen-write', 'state-clear', 'mark-clear'].includes(e))).toEqual(['gen-write', 'state-clear', 'mark-clear']);
      expect(registryA().fleetDb.pushBroken).toBeUndefined();
    },
  },
  {
    id: 'A33 under pushBroken a v3 restore: raise, generation, state clear, pushBroken clear, mark clear', setup: () => { brokenPush(); v3(); },
    check: r => {
      succeeded(r);
      shardSteps(r, 2, 3);
      expect(claimDb.genEvents.filter(e => ['raise', 'gen-write', 'state-clear', 'switch:pushBroken', 'mark-clear'].includes(e))).toEqual(['raise', 'gen-write', 'state-clear', 'switch:pushBroken', 'mark-clear']);
      expect(registryA().fleetDb.pushBroken).toBeUndefined();
    },
  },
  {
    id: 'A34 R-PUSHBROKEN-FENCED: under pushBroken the raise fails: the fence, the notice and pushBroken stay', setup: () => { brokenPush(); v3({ toc: 'claims', fail: 'raise' }); },
    check: r => {
      keptFenced(r);
      expect(r.error.startsWith(T10('ERROR:  permission denied for sequence claim_seq'))).toBe(true);
      expect(claimDb.genEvents).not.toContain('state-clear');
      expect(claimDb.genEvents).not.toContain('mark-clear');
      expect(registryA().fleetDb.pushBroken).toEqual(BROKEN);
    },
  },
  {
    id: 'A40 under pushBroken a dump with no claim numbers that pushBroken does not name: T5 with the pushed floor', setup: () => { brokenPush(); Object.assign(claimDb, { tables: V3, floor: '20', toc: 'none' }); },
    check: r => refusedAfterFence(r, 'The dump old.dump holds no claim numbers, so the restore was refused, and nothing was changed: the bot has used claim numbers up to 20, and without smdb_data.claim_seq in the dump a process that ran before the restore could save over the restored data'),
  },
];

describe('NM9 the restore lane, one row per cell', () => {
  it.each(ROWS)('$id', async (row) => {
    row.setup?.();
    const log = vi.spyOn(console, 'log').mockImplementation((m: unknown) => { logs.push(String(m)); });
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let r: any;
    try {
      r = await restore();
    } finally {
      log.mockRestore();
      err.mockRestore();
      warn.mockRestore();
    }
    row.check(r);
    expect(containerManager.isBotBusy('a')).toBeNull();
    expect(fleetBackupGuards.isFleetBackupBusy('a')).toBe(false);
    expect(pg.events).not.toContain('start:a');
  });
});

describe('NM9 B5: a second restore raises above the first', () => {
  it('the second raise is above the first one\'s highest number', async () => {
    v3();
    expect((await restore()).success).toBe(true);
    const first = claimDb.raiseSql[0];
    expect(first).toContain('WHERE claim <= 7');
    resetClaimDb({ onRaise: () => pg.events.push('raise') });
    v3({ floor: '9', raise: raiseFor(9) });
    const again = await restore();
    expect(again.success).toBe(true);
    expect(claimDb.raiseSql[0]).toContain('WHERE claim <= 9');
    expect(claimDb.raiseSql[0]).toContain('SET claim = 10');
    expect(floorFile()).toEqual({ claim: 9 });
  });
});

describe('NM9 XA, XB, XD: a retry after a restart reads the floor from the restored copy', () => {
  const retry = async (floor: number) => {
    vi.resetModules();
    const fresh = await import('../../src/instance/fleetBackup');
    resetClaimDb({ onRaise: () => pg.events.push('raise') });
    v3({ floor: String(floor), raise: raiseFor(floor) });
    const r = await fresh.restoreFleetBackup('a', 'old.dump');
    return r;
  };
  const quiet = () => {
    const spies = [vi.spyOn(console, 'log'), vi.spyOn(console, 'error'), vi.spyOn(console, 'warn')].map(s => s.mockImplementation(() => undefined));
    return () => spies.forEach(s => s.mockRestore());
  };

  it.each([
    ['XA a crash at the raise', () => v3({ onRaise: () => { throw new Error('docker crashed at raise'); } })],
    ['XD after A20 (the raise failed)', () => v3({ fail: 'raise' })],
    ['XB after A25 (raised, the generation not written)', () => v3({ fail: 'genwrite' })],
  ] as Array<[string, () => void]>)('%s: the retry raises above the restored copy\'s highest number', async (_n, first) => {
    const loud = quiet();
    first();
    await restore().catch(() => undefined);
    expect(registryA().fleetRestoreError.text).toMatch(/^Restore of old\.dump (has not finished|failed)/);
    expect(floorFile()).toEqual({ claim: 7 });
    const r = await retry(9);
    loud();
    expect(r.error).toBeUndefined();
    expect(r.success).toBe(true);
    expect(floorFile()).toEqual({ claim: 9 });
    expect(claimDb.raiseSql[0]).toContain('WHERE claim <= 9');
    expect(claimDb.capSql).toEqual([]);
  });

  it('XA after A28: a crash at the cap; the retry finds the restored copy, writes its floor and runs 7.1, not the cap', async () => {
    const loud = quiet();
    noFloor({ onRaise: () => { throw new Error('docker crashed at the cap'); } });
    await restore().catch(() => undefined);
    expect(registryA().fleetRestoreError.text).toMatch(/^Restore of old\.dump has not finished/);
    expect(floorFile()).toBeNull();
    const r = await retry(5);
    loud();
    expect(r.success).toBe(true);
    expect(floorFile()).toEqual({ claim: 5 });
    expect(claimDb.raiseSql).toHaveLength(1);
    expect(claimDb.raiseSql[0]).toContain(`${SHARD_RAISE_MARK}5)`);
    expect(claimDb.capSql).toEqual([]);
  });
});

describe('NM9 A35 to A39, A41: a restore can be undone, and the pre-receive- dump under pushBroken', () => {
  const PRE = /^pre-restore-.+\.dump$/;
  const quietly = async <T>(run: () => Promise<T>): Promise<T> => {
    const log = vi.spyOn(console, 'log').mockImplementation((m: unknown) => { logs.push(String(m)); });
    const spies = [vi.spyOn(console, 'error'), vi.spyOn(console, 'warn')].map(s => s.mockImplementation(() => undefined));
    try { return await run(); } finally { log.mockRestore(); spies.forEach(s => s.mockRestore()); }
  };
  const settled = () => {
    expect(containerManager.isBotBusy('a')).toBeNull();
    expect(fleetBackupGuards.isFleetBackupBusy('a')).toBe(false);
  };
  const undoOf = async (pre: string) => {
    Object.assign(claimDb, { toc: 'claims', raise: 'seq|8\nguild|g1\nguild|g2\n', raiseSql: [], onDrop: () => { claimDb.restoredTables = V2; } });
    pg.events.length = 0;
    pg.sql.length = 0;
    return quietly(() => restore(pre));
  };
  const undone = (r2: any, pre: string) => {
    succeeded(r2);
    expect(dropped()).toBe(true);
    const floors = pg.sql.filter(s => s.includes('SELECT coalesce(GREATEST('));
    expect(floors[floors.length - 1]).toContain('(SELECT max(claim) FROM smdb_data.shard_claims)');
    expect(sqlOf(claimDb.raiseSql[0])).toBe(fb.claimRaiseSql(7, V2_OBJ));
    shardSteps(r2, null, null);
    expect(r2.steps.preRestoreDump).toMatch(PRE);
    expect(r2.steps.preRestoreDump).not.toBe(pre);
    expect(String(r2.error ?? '')).not.toContain('shard claims, but the database has them');
    expect(String(registryA().fleetRestoreError?.text ?? '')).not.toContain('shard claims, but the database has them');
    settled();
  };

  it('A35 R-UNDO: a v3 dump restored over a v2 database, then its own pre-restore dump restored over the v3 copy', async () => {
    v3({ tables: V2 });
    const r1 = await quietly(() => restore());
    succeeded(r1);
    const pre = r1.steps.preRestoreDump ?? '';
    expect(pre).toMatch(PRE);
    expect(fs.existsSync(path.join(DIR, pre))).toBe(true);
    const r2 = await undoOf(pre);
    undone(r2, pre);
  });

  it('A36 R-UNDO-FENCED: the first restore ends fenced after pg_restore, then its pre-restore dump is restored', async () => {
    v3({ tables: V2, fail: 'raise' });
    const r1 = await quietly(() => restore());
    keptFenced(r1);
    const pre = r1.steps.preRestoreDump ?? '';
    expect(pre).toMatch(PRE);
    expect(r1.error).toContain(`the pre-restore dump ${pre} holds the database as it was`);
    expect(registryA().fleetRestoreError.text).toContain(`the pre-restore dump is ${pre}`);
    claimDb.fail = null;
    const r2 = await undoOf(pre);
    undone(r2, pre);
    expect(fenceOwners.has('bot-a-postgres')).toBe(false);
    expect(fleetBackup.getFleetFenceStuck('a')).toBeNull();
  });

  it('A37 R-T11-AFTER: after A35\'s first restore a v2 dump not named pre-restore- is refused by T11', async () => {
    v3({ tables: V2 });
    succeeded(await quietly(() => restore()));
    claimDb.toc = 'claims';
    pg.events.length = 0;
    const r2 = await quietly(() => restore('old.dump'));
    refusedAfterFence(r2, T11);
    settled();
  });

  const receiveUndo = () => {
    fs.writeFileSync(path.join(DIR, 'pre-receive-x.dump'), 'dump');
    brokenPush();
    Object.assign(claimDb, { tables: V3, floor: '20', toc: 'none', restoredTables: NONE });
  };
  const receiveUndone = (r: any) => {
    succeeded(r);
    expect(floorSql()).toBe('');
    expect(claimDb.raiseSql).toEqual([]);
    expect(claimDb.capSql).toEqual([]);
    expect(r.steps.claimFloor).toBeNull();
    expect(dropped()).toBe(true);
    expect(registryA().fleetDb.pushBroken).toBeUndefined();
    expect(claimDb.genEvents.filter(e => ['gen-write', 'state-clear', 'switch:pushBroken', 'mark-clear'].includes(e))).toEqual(['gen-write', 'state-clear', 'switch:pushBroken', 'mark-clear']);
    settled();
  };

  it('A38 R-RECEIVE-UNDO: under pushBroken the pre-receive- dump with no claim numbers is restored without a floor', async () => {
    receiveUndo();
    const r = await quietly(() => restore('pre-receive-x.dump'));
    receiveUndone(r);
    expect(pg.sql.filter(s => s.includes("to_regclass('smdb_data.claim_seq')"))).toHaveLength(1);
    expect(floorFile()).toBeNull();
  });

  it('A38e: as A38 with the pre-receive- dump of a database with no objects', async () => {
    receiveUndo();
    claimDb.toc = 'empty';
    const r = await quietly(() => restore('pre-receive-x.dump'));
    receiveUndone(r);
    expect(floorFile()).toBeNull();
  });

  it('A38n: as A38e with a negative TOC count: refused before any drop', async () => {
    receiveUndo();
    claimDb.toc = 'emptyNeg';
    const r = await quietly(() => restore('pre-receive-x.dump'));
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/^The dump pre-receive-x.dump could not be read, so the restore was refused/);
    expect(dropped()).toBe(false);
  });

  it('A39: as A38 with claim-floor.json present: restored, the file left as it is', async () => {
    fs.writeFileSync(FLOOR, '{"claim":30}');
    receiveUndo();
    const r = await quietly(() => restore('pre-receive-x.dump'));
    receiveUndone(r);
    expect(floorFile()).toEqual({ claim: 30 });
  });

  it('A41: under pushBroken the pre-receive- dump with claim numbers keeps the live floor', async () => {
    fs.writeFileSync(path.join(DIR, 'pre-receive-x.dump'), 'dump');
    brokenPush();
    Object.assign(claimDb, { tables: V3, floor: '20', toc: 'claims', restoredTables: V2, raise: 'seq|21\nguild|g1\n' });
    const r = await quietly(() => restore('pre-receive-x.dump'));
    succeeded(r);
    expect(sqlOf(claimDb.raiseSql[0])).toBe(fb.claimRaiseSql(20, V2_OBJ));
    expect(floorFile()).toEqual({ claim: 20 });
    expect(registryA().fleetDb.pushBroken).toBeUndefined();
    settled();
  });
});
