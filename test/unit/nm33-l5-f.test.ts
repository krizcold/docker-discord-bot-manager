// NM33 L5 survivors, group f: parseSaveRows's shape checks, the restore's rewrite of the save order with the
// record's id (decision 7), the lane's can't-confirm text and the no-answer reason. Every docker call is faked as in
// nm20-code5: execFile by restore-fake and fence-fake, spawn by the TOC, meta and dump fakes.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm33-l5-f-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir };
});

const pg = vi.hoisted(() => ({ events: [] as string[] }));
const hx = vi.hoisted(() => ({ saveOrder: false, proof: null as unknown }));

vi.mock('../../src/config/appCapabilities', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/config/appCapabilities')>();
  return { ...real, findAppCapabilities: () => ({ companionDb: { env: { url: 'DATABASE_URL' }, ...(hx.saveOrder ? { saveOrder: true } : {}) } }) };
});
vi.mock('../../src/instance/maintenance', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/instance/maintenance')>();
  return { ...real, requireMaintenance: (id: string, need: 'database' | 'any') => (hx.proof ? Promise.resolve(hx.proof) : real.requireMaintenance(id, need)) };
});
vi.mock('../../src/env/manager', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/env/manager')>();
  return {
    ...real,
    getEnvVarsWithStatus: () => ({ vars: { DATABASE_URL: 'postgres://app:pw@bot-a-postgres/app' }, corrupt: false, undecryptable: [], encrypted: [] }),
    getEnvVars: () => ({ DATABASE_URL: 'postgres://app:pw@bot-a-postgres/app' }),
  };
});
vi.mock('../../src/instance/appHookClient', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/instance/appHookClient')>();
  return { ...real, callAppHook: async () => ({ ok: true, status: 200, body: { success: true } }) };
});
vi.mock('../../src/docker/containerManager', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/docker/containerManager')>();
  return {
    ...real,
    isShuttingDown: () => false,
    appContainerRunning: async () => false,
    runningInstanceContainers: async () => [],
    startFleetDbSidecar: async () => ({ success: true }),
    stopBot: async () => ({ success: true }),
    startBot: async () => ({ success: true }),
    stopBotInOp: async () => ({ success: true }),
    startBotInOp: async () => ({ success: true }),
  };
});

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const { EventEmitter } = require('events') as typeof import('events');
  const { PassThrough } = require('stream') as typeof import('stream');
  const execFile = vi.fn((_cmd: string, args: string[], optsOrCb: unknown, maybeCb?: unknown) => {
    const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as (err: Error | null, stdout: string, stderr: string) => void;
    const sql = args.join(' ');
    if (args[0] === 'inspect') return cb(null, 'true\n', '');
    const readOnlyOn = ((globalThis as any).__fenceOwners as Map<string, string> | undefined)?.has('bot-a-postgres') === true;
    if (sql.endsWith("SELECT current_setting('default_transaction_read_only')") || sql.includes('SHOW default_transaction_read_only')) return cb(null, readOnlyOn ? 'on\n' : 'off\n', '');
    if (sql.includes('ALTER SYSTEM SET default_transaction_read_only = on')) { pg.events.push('fence'); return cb(null, '0\n', ''); }
    if (sql.includes('ALTER SYSTEM RESET')) { pg.events.push('lift'); return cb(null, '', ''); }
    if (sql.includes('FROM pg_database WHERE datname')) return cb(null, '1\n', '');
    if (sql.includes('DROP DATABASE')) pg.events.push('drop');
    return cb(null, '', '');
  });
  const spawn = vi.fn((_cmd: string, args: string[]) => {
    const child: any = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.stdin.resume();
    child.kill = () => { setTimeout(() => child.emit('close', 137), 1); return true; };
    const isDump = args.includes('pg_dump');
    pg.events.push(isDump ? 'dump' : 'pg_restore');
    setTimeout(() => {
      child.stdout.end(isDump ? 'dump' : '');
      child.stderr.end('');
      setTimeout(() => child.emit('close', 0), 5);
    }, 5);
    return child;
  });
  const fakes = await import('./restore-fake');
  const fenced = (await import('./fence-fake')).withFence(fakes.withRestoreFakes(execFile as any));
  const held = (await import('./dump-fake')).withDumpHolder(fakes.withTocFake(spawn as any));
  return { ...real, execFile: fenced, spawn: held, default: { ...real, execFile: fenced, spawn: held } };
});

import * as fs from 'fs';
import * as path from 'path';
import * as fleetBackup from '../../src/instance/fleetBackup';
import { provenMaintenance, saveVerdict } from '../../src/instance/fleetSwitch';
import { parseSaveRows, restoreOrderSql } from '../../src/instance/switchSql';
import { fenceOwners } from './fence-fake';
import { claimDb, resetClaimDb, MAINTAINED, writeDumpMeta } from './restore-fake';
import { resetHolder } from './dump-fake';

const REGISTRY = path.join(tmp.dir, 'instances.json');
const DIR = path.join(tmp.dir, 'backups', 'a', 'fleet-postgres');
const primary = { containerName: 'bot-a-postgres', user: 'app', db: 'app', volume: 'bot-a-pgdata' };
const TS = '2026-11-13 11:32:24.265756+00';
const GEN_BLOCK = `--\n-- Data for Name: generation; Type: TABLE DATA; Schema: smdb_manager; Owner: dbm_meta\n--\n\nCOPY smdb_manager.generation (one_row, machine, generation, since) FROM stdin;\nt\tmain.example\t3\t${TS}\n\\.\n\n\n`;
const metaDump = (blocks: string) => `--\n-- PostgreSQL database dump\n--\n\nSET statement_timeout = 0;\nSET row_security = off;\n\n${blocks}--\n-- PostgreSQL database dump complete\n--\n\n`;
const FLEET = { orderId: 'X', generation: 3, upMs: 100_000, askedBlocked: false, blockedAt: '2026-10-28T00:00:05.000Z', orderFor: '2026-10-28T00:00:00.000Z' };

function writeRegistry(maintenance: Record<string, unknown>): void {
  fs.writeFileSync(REGISTRY, JSON.stringify({ instances: {
    a: { id: 'a', displayName: 'Bot A', sanitizedName: 'bot-a', status: 'running', sourceUrl: 'https://example.invalid/fake/app', createdAt: '2026-10-01T00:00:00.000Z', fleetDb: primary, fleetBackup: { enabled: false, hour: 4, keep: 7 }, maintenance },
  } }, null, 2));
}

beforeEach(() => {
  hx.saveOrder = false;
  hx.proof = null;
  pg.events.length = 0;
  resetClaimDb();
  resetHolder();
  claimDb.metaText = metaDump(GEN_BLOCK);
  fenceOwners.clear();
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, 'old.dump'), 'dump');
  writeDumpMeta(DIR, 'old.dump');
  fleetBackup.clearClaimFloor('a');
  fleetBackup.dismissFleetRestoreError('a');
  writeRegistry({ ...MAINTAINED.maintenance });
  fs.mkdirSync(path.join(tmp.dir, 'bots', 'a'), { recursive: true });
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterAll(() => { vi.restoreAllMocks(); fs.rmSync(tmp.dir, { recursive: true, force: true }); });

describe("parseSaveRows: SAVE_READ_SQL's last line", () => {
  const ORDER = { id: 'X', state: 'maintenance', message: 'm', current: true, reason: 'order', upMs: 100000 };
  const HOLDER = { process: 'p1', name: 'host-a', agoMs: 4000 };
  const line = (over: Record<string, unknown> = {}) => `${JSON.stringify({ order: ORDER, claims: true, expected: [HOLDER], notSeen: [], acks: [], ...over })}\n`;

  it('a well-shaped line parses, so the rows below differ from it only in the field they change', () => {
    expect(parseSaveRows(line())).toEqual({ order: ORDER, claims: true, expected: [HOLDER], notSeen: [], acks: [] });
  });
  it('a last line of JSON null is not the shape: undefined, not a throw', () => {
    expect(parseSaveRows('null\n')).toBeUndefined();
  });
  it('an up_ms past the safe integers (bigint printed by jsonb) is not the shape', () => {
    expect(parseSaveRows(line().replace('"upMs":100000', '"upMs":9007199254740993'))).toBeUndefined();
  });
  it('an expected holder with no name (max of null names) is not the shape', () => {
    expect(parseSaveRows(line({ expected: [{ ...HOLDER, name: null }] }))).toBeUndefined();
  });
  it('a not-seen holder with no name is not the shape', () => {
    expect(parseSaveRows(line({ expected: [], notSeen: [{ ...HOLDER, name: null }] }))).toBeUndefined();
  });
});

describe('the lane verdict and the held answer (decision 6, contract 1)', () => {
  it("own row, login blocked, no claim tables: the can't-confirm text ends 'once the bot has served from this database'", () => {
    const rows = { order: { id: 'X', state: 'maintenance', message: 'm', current: true, reason: 'order', upMs: 100_000 }, claims: false, expected: [], notSeen: [], acks: [] } as any;
    const v = saveVerdict(rows, { ...MAINTAINED.maintenance, fleet: FLEET } as any, 'push', null);
    expect(v).toEqual({ refuse: "The manager can't confirm which bot processes use this database (this database has no shard claim tables), so Hand over, Push and Move by file are refused. Choose Running, then Maintenance again once the bot has served from this database." });
  });
  it("no held answer after an unconfirmed hook: the refusal names the hook's reason", async () => {
    const { savedByBot: _s, ...rest } = MAINTAINED.maintenance;
    writeRegistry({ ...rest, hook: 'unconfirmed', hookError: 'the bot did not answer within 30 seconds', savedByBot: 'running' });
    hx.proof = { ok: true, state: 'maintenance', enforcement: 'database', botConfirmed: false };
    expect(await provenMaintenance('a', 'push', false)).toEqual({ success: false, status: 409, text: "The bot did not answer the maintenance order (the bot did not answer within 30 seconds), so the manager can't confirm it saved the changes it holds; the push was refused and nothing was changed. Choose Maintenance again while the bot runs, or choose Off." });
  });
});

describe("the restore's rewrite of the save order (decision 7)", () => {
  it("a save-order app's restore writes the row with the record's own order id and message in the raise", async () => {
    hx.saveOrder = true;
    writeRegistry({ ...MAINTAINED.maintenance, message: 'Back soon', fleet: FLEET });
    const r = await fleetBackup.restoreFleetBackup('a', 'old.dump');
    expect(r.error).toBeUndefined();
    expect(r.success).toBe(true);
    expect(claimDb.genWrites).toHaveLength(1);
    expect(claimDb.genWrites[0]).toContain(restoreOrderSql({ user: 'app', orderId: 'X', message: 'Back soon' }));
  });
});
