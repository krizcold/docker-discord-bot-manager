import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm22-l5-c-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir, printThenHang: null as string | null };
});

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const laned = (await import('./nm22-lane-fake')).laneChildProcess(real) as any;
  const spawn = (cmd: string, args: string[]) => {
    const child = laned.spawn(cmd, args);
    let stdin = '';
    child.stdin.on('data', (d: Buffer) => { stdin += d; });
    setTimeout(() => {
      if (h.printThenHang !== null && stdin.includes("SELECT 'blocked|'")) child.stdout.write(h.printThenHang);
    }, 10);
    return child;
  };
  return { ...laned, spawn, default: { ...laned.default, spawn } };
});
vi.mock('../../src/instance/fleetJoin', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/fleetJoin')>()),
  sendAddresses: async () => ({ state: 'applied' }),
}));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';
import * as envManager from '../../src/env/manager';
import { removeCopyLogin } from '../../src/instance/fleetReplication';
import { lane, resetLane } from './nm22-lane-fake';

const ID = '0f1e2d3c-4b5a-4968-8776-655443322110';
const A = 'smdb_copy_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SA = 'fleet_standby_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const REGISTRY = path.join(h.dir, 'instances.json');
const fleetDb = { containerName: 'm-fleet-postgres', user: 'smdb', db: 'smdb', volume: 'm-fleet-postgres-data', password: 'Db-Secret,%x' };
const replication = { role: 'smdb_join', password: 'Join-Secret-0123456789', hostPort: 15432, publicHost: 'main.invalid', certHost: 'main.invalid', slotWalKeepMb: 4096 };

const bot = () => containerManager.getBot(ID)!;
const callOf = (needle: string) => lane.calls.find(c => `${c.args} ${c.stdin}`.includes(needle));
const stepText = (step: string, reason: string) => `The login ${A} was not removed completely: ${step} failed (${reason}). It is blocked: it cannot log in, other machines stop listing it within an hour, and this database ends its open sessions within 5 minutes. Press Remove again to finish.`;
const DONE = `Removed the login ${A}: its sessions were ended, its slot dropped, its address taken off the list and what it owned dropped. A machine that holds this database's join code can join again; New join code stops that.`;
const COUNT = 'pg_catalog.count(*) FROM pg_catalog.pg_stat_activity';
const BLOCK_OUT = 'BEGIN\nDO\nALTER ROLE\nDO\nALTER ROLE\ncommitting\nCOMMIT\nblocked|true|true|true\n';

async function underFakeTimers<T>(run: () => Promise<T>): Promise<T> {
  vi.useFakeTimers();
  try {
    const pending = run();
    await vi.advanceTimersByTimeAsync(40_000);
    return await pending;
  } finally {
    vi.useRealTimers();
  }
}

beforeEach(() => {
  resetLane();
  h.printThenHang = null;
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
  fs.mkdirSync(path.join(h.dir, 'bots', ID, 'env'), { recursive: true });
  fs.writeFileSync(REGISTRY, JSON.stringify({ instances: { [ID]: {
    id: ID, sanitizedName: 'm', displayName: 'M', titleName: 'M', status: 'running', sourceType: 'git',
    sourceUrl: 'https://example.invalid/fake/super-modular-discord-bot', envVars: { DATA_BACKEND: 'postgres' },
    createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z', fleetDb: { ...fleetDb, replication },
  } } }));
  (containerManager as any).updateInstanceFleetLogin(ID, { password: 'Own-Machine-Secret-01' });
  envManager.setEnvVars(ID, { DATA_BACKEND_URL: 'postgresql://smdb:Db-Secret%2C%25x@m-fleet-postgres:5432/smdb?sslmode=no-verify' });
  lane.slotActive = 'false';
  lane.slotStates = ['false', 'absent'];
});
afterAll(() => fs.rmSync(h.dir, { recursive: true, force: true }));

describe('NM22 L5 c: Remove from the confirm through the slot step and the DETAIL line', () => {
  it('a stream on a local socket with no address row: the confirm says "a local socket"', async () => {
    lane.slotActive = 'true';
    lane.client = '';
    expect((await removeCopyLogin(bot(), A, false)).error).toContain(`streams from this database now (a local socket).`);
  });

  it('the block printed its line, but docker exec\'s exit was not seen before the call\'s time limit: the Remove goes on and finishes', async () => {
    h.printThenHang = BLOCK_OUT;
    lane.rules.push({ match: "SELECT 'blocked|'", hang: true });
    expect(await underFakeTimers(() => removeCopyLogin(bot(), A, false))).toEqual({ success: true, text: DONE });
  });

  it('the block exits 0 with no blocked| line: psql ran the whole script, COMMIT included, so the block can\'t be confirmed', async () => {
    lane.rules.push({ match: "SELECT 'blocked|'", out: 'BEGIN\n' });
    expect(await removeCopyLogin(bot(), A, false)).toEqual({ success: false, error: `The manager can't confirm whether the login ${A} was blocked: the manager did not read the result (the database's answer held no result line), and the block may be applied there. Press Remove again to finish.` });
  });

  it('the session count read fails: RM-STEP ending its sessions with its reason, at once', async () => {
    lane.rules.push({ match: COUNT, code: 1, err: 'ERROR:  out of shared memory\n' });
    expect(await removeCopyLogin(bot(), A, false)).toEqual({ success: false, error: stepText('ending its sessions', 'out of shared memory') });
    expect(lane.calls.filter(c => `${c.args} ${c.stdin}`.includes(COUNT))).toHaveLength(1);
  });

  it('one session left at the first count and none at the second: the Remove finishes', async () => {
    lane.rules.push({ match: COUNT, out: '1\n', once: true });
    expect(await underFakeTimers(() => removeCopyLogin(bot(), A, false))).toEqual({ success: true, text: DONE });
  });

  it('sessions still counted at the read at 10 seconds: RM-STEP, with no read after it', async () => {
    for (let i = 0; i < 41; i++) lane.rules.push({ match: COUNT, out: '1\n', once: true });
    expect(await underFakeTimers(() => removeCopyLogin(bot(), A, false))).toEqual({ success: false, error: stepText('ending its sessions', '1 of its sessions were still open after 10 seconds') });
    expect(lane.calls.filter(c => `${c.args} ${c.stdin}`.includes(COUNT))).toHaveLength(41);
  });

  it('12 sessions still open after 10 seconds: the text gives the count', async () => {
    lane.rules.push({ match: COUNT, out: '12\n' });
    expect(await underFakeTimers(() => removeCopyLogin(bot(), A, false))).toEqual({ success: false, error: stepText('ending its sessions', '12 of its sessions were still open after 10 seconds') });
  });

  it('the slot state read fails: RM-STEP dropping its slot with the reason, nothing after it', async () => {
    lane.rules.push({ match: 'SELECT coalesce((SELECT active::text', code: 1, err: 'ERROR:  out of shared memory\n', once: true });
    expect(await removeCopyLogin(bot(), A, false)).toEqual({ success: false, error: stepText(`dropping its slot ${SA}`, 'out of shared memory') });
    expect(callOf('SELECT pg_catalog.pg_drop_replication_slot')).toBeUndefined();
    expect(callOf(`DELETE FROM smdb_manager.addresses WHERE slot = '${SA}'`)).toBeUndefined();
  });

  it('an inactive slot is dropped without ending any stream', async () => {
    expect(await removeCopyLogin(bot(), A, false)).toEqual({ success: true, text: DONE });
    expect(callOf('pg_terminate_backend(active_pid)')).toBeUndefined();
    expect(callOf('SELECT pg_catalog.pg_drop_replication_slot')).toBeDefined();
  });

  it('ending the stream on the slot fails: RM-STEP dropping its slot with the reason', async () => {
    lane.slotActive = 'true';
    lane.slotStates = ['true', 'absent'];
    lane.rules.push({ match: 'pg_terminate_backend(active_pid)', code: 1, err: 'ERROR:  must be a superuser to terminate superuser process\n' });
    expect(await removeCopyLogin(bot(), A, true)).toEqual({ success: false, error: stepText(`dropping its slot ${SA}`, 'must be a superuser to terminate superuser process') });
    expect(callOf(`DELETE FROM smdb_manager.addresses WHERE slot = '${SA}'`)).toBeUndefined();
  });

  it('a stream holds the slot through the read at 10 seconds: RM-STEP, with no read after it', async () => {
    lane.slotActive = 'true';
    lane.slotStates = Array(41).fill('true');
    expect(await underFakeTimers(() => removeCopyLogin(bot(), A, true))).toEqual({ success: false, error: stepText(`dropping its slot ${SA}`, 'a stream still held it after 10 seconds') });
    expect(lane.calls.filter(c => `${c.args} ${c.stdin}`.includes('SELECT coalesce((SELECT active::text'))).toHaveLength(41);
  });

  it('the slot is gone once its stream ended: no drop is sent', async () => {
    lane.slotActive = 'true';
    lane.slotStates = ['true', 'absent'];
    expect(await removeCopyLogin(bot(), A, true)).toEqual({ success: true, text: DONE });
    expect(callOf('SELECT pg_catalog.pg_drop_replication_slot')).toBeUndefined();
  });

  it('the slot is still there, inactive, after the drop: RM-STEP says so', async () => {
    lane.slotStates = ['false', 'false'];
    expect((await removeCopyLogin(bot(), A, false)).error).toBe(stepText(`dropping its slot ${SA}`, 'it was still there after the drop'));
  });
});
