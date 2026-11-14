import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm20-l5-f-receive-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir, join: { success: true, joinCode: '' } as { success: boolean; joinCode?: string; error?: string }, resetOut: null as string | null };
});

vi.mock('child_process', async (o) => {
  const m = (await import('./switch-harness')).childProcessMock(await o()) as Record<string, any>;
  const { EventEmitter } = await import('events');
  const { PassThrough } = await import('stream');
  const inner = m.spawn;
  const spawn = (cmd: string, args: string[], opts?: any) => {
    if (tmp.resetOut === null || cmd !== 'docker' || args[0] !== 'exec' || !args.includes('psql')) return inner(cmd, args, opts);
    const c: any = new EventEmitter();
    c.stdout = new PassThrough();
    c.stderr = new PassThrough();
    c.stdin = new PassThrough();
    c.kill = () => true;
    let input = '';
    c.stdin.on('data', (d: Buffer) => { input += d.toString(); });
    c.stdin.on('finish', () => {
      if (input.includes("SELECT 'receive|'")) {
        setTimeout(() => { c.stdout.end(`${tmp.resetOut}\n`); c.stderr.end(''); setTimeout(() => c.emit('close', 0), 1); }, 1);
        return;
      }
      const real = inner(cmd, args, opts);
      real.stdout.pipe(c.stdout);
      real.stderr.pipe(c.stderr);
      real.on('close', (code: number) => setTimeout(() => c.emit('close', code), 1));
      real.stdin.end(input);
    });
    return c;
  };
  return { ...m, spawn, default: { ...m.default, spawn } };
});
vi.mock('../../src/instance/dbLogin', async (o) => (await import('./switch-harness')).dbLoginMock(await o()));
vi.mock('../../src/instance/maintenance', async (o) => (await import('./switch-harness')).maintenanceMock(await o()));
vi.mock('../../src/docker/containerManager', async (o) => (await import('./switch-harness')).containerManagerMock(await o()));
vi.mock('../../src/instance/fleetBackup', async (o) => (await import('./switch-harness')).fleetBackupMock(await o()));
vi.mock('../../src/instance/fleetJoin', async (o) => (await import('./switch-harness')).fleetJoinMock(await o()));
vi.mock('../../src/instance/fleetReplica', async (o) => (await import('./switch-harness')).fleetReplicaMock(await o()));
vi.mock('../../src/instance/appHookClient', async (o) => (await import('./switch-harness')).appHookMock(await o()));
vi.mock('../../src/instance/backupCheck', async (o) => (await import('./switch-harness')).backupCheckMock(await o()));
vi.mock('../../src/env/manager', async (o) => (await import('./switch-harness')).envMock(await o()));
vi.mock('../../src/config/appCapabilities', async (o) => (await import('./switch-harness')).capsMock(await o()));
vi.mock('../../src/instance/fleetReplication', async (o) => ({
  ...(await o<typeof import('../../src/instance/fleetReplication')>()),
  getJoinCode: async () => tmp.join,
}));

import * as fs from 'fs';
import { encodeJoinCode } from '../../src/config/joinCode';
import { MOVE_TIMING, receive, receiveLoginsSql, receiveStep, stopReceive } from '../../src/instance/fleetMove';
import { releaseFleetBackupBusy } from '../../src/instance/fleetBackupGuards';
import * as containerManager from '../../src/docker/containerManager';
import { fake, fakeJoin, freshDb, h, mainFixture, resetHarness, stored, writeRegistry } from './switch-harness';

const OFF = { state: 'off', message: '', orderedAt: '2026-10-30T00:00:00.000Z', settled: true, hook: 'confirmed', login: 'blocked', savedByBot: 'maintenance' };
const off = (over: Record<string, unknown> = {}, id = 'a') => writeRegistry({ [id]: mainFixture({ maintenance: OFF, ...over }) });
const later = () => Date.now() + 25 * 60 * 60_000;
const step = (id = 'a', now = later()) => receiveStep(containerManager.getBot(id)!, now);
const pushed = (id = 'a') => fake.dbs['a-pg'].received.push({ pushId: stored(id).fleetDb.receive.pushId, from: '9', machine: 'win.local', generation: 6 });
const callsWith = (text: string) => fake.calls.filter(c => c.args[0] === 'exec' && c.input.includes(text));
const capture = (kind: 'log' | 'warn') => {
  const out: string[] = [];
  const spy = vi.spyOn(console, kind).mockImplementation((m: unknown) => { out.push(String(m)); });
  return { out, restore: () => spy.mockRestore() };
};

beforeEach(() => {
  resetHarness({ proof: { ok: true, state: 'off', enforcement: 'database', botConfirmed: true } });
  releaseFleetBackupBusy('a');
  fake.dbs['a-pg'] = freshDb();
  MOVE_TIMING.sessionPauseMs = 0;
  tmp.resetOut = null;
  tmp.join = { success: true, joinCode: encodeJoinCode(fakeJoin({ host: 'main.example', port: 5433 })) };
  off();
});
afterEach(() => { vi.restoreAllMocks(); tmp.resetOut = null; });
afterAll(() => fs.rmSync(tmp.dir, { recursive: true, force: true }));

describe('L5 f (NM20): the receive logins script', () => {
  it('a bot role name with a double quote is quoted with the quote doubled', () => {
    expect(receiveLoginsSql('o"wn', 'p', 'm', '2026-11-15T00:00:00.000Z')).toContain('GRANT dbm_meta, "o""wn", pg_signal_backend TO smdb_receive_meta;');
  });
});

describe('L5 f (NM20): the end of receiving', () => {
  it('the reset statements are one per line in the script sent to psql', async () => {
    await receive('a');
    await stopReceive('a');
    const sent = callsWith("SELECT 'receive|'");
    expect(sent.length).toBeGreaterThan(0);
    expect(sent[0].input).toContain("  EXECUTE pg_catalog.format('ALTER DATABASE %I IS_TEMPLATE false', 'app');\n  EXECUTE pg_catalog.format('ALTER DATABASE %I ALLOW_CONNECTIONS true', 'app');\n");
  });
  it('an answer that does not read as the logins line: STOP_FAIL names its first 200 characters', async () => {
    await receive('a');
    tmp.resetOut = 'x'.repeat(300);
    expect(await stopReceive('a')).toMatchObject({ success: false, status: 500, text: `The receive login could not be removed (the receive logins read back as ${'x'.repeat(200)}); try again.` });
  });
  it('only smdb_receive exists: only its own objects are cleared, with psql quiet', async () => {
    await receive('a');
    delete fake.dbs['a-pg'].roles.smdb_receive_meta;
    h.events.length = 0;
    fake.calls.length = 0;
    expect((await stopReceive('a')).success).toBe(true);
    expect(h.events).toContain('receive-clean:smdb_receive');
    expect(h.events).not.toContain('receive-clean:smdb_receive_meta');
    const clean = fake.calls.filter(c => c.input.startsWith('REASSIGN OWNED BY smdb_receive TO'));
    expect(clean.length).toBe(1);
    expect(clean[0].args[clean[0].args.length - 1]).toBe('-q');
    expect(clean[0].args).not.toContain('');
  });
  it('sessions left after the logins took no login: STOP_FAIL names their count', async () => {
    await receive('a');
    pushed();
    const d = fake.dbs['a-pg'];
    d.beforeAnswer = (sql: string) => { if (sql.includes('ALTER ROLE smdb_receive NOLOGIN')) { d.sessions.smdb_receive = 2; d.pinnedSessions.smdb_receive = true; } };
    expect(await receive('a')).toMatchObject({ success: false, status: 500, text: 'The receive login could not be removed (2 session(s) did not end); try again.' });
  });
  const ERR = 'ERROR:  nologin refused';
  const warned = (id: string) => `[Switch] ${id.toUpperCase()}: the move code expired, but the receive login could not be removed (${ERR}); the manager tries again every minute`;
  const endErrorRow = async (id: string, end: () => Promise<unknown>) => {
    off({}, id);
    const d = fake.dbs['a-pg'];
    const warn = capture('warn');
    await receive(id);
    d.fail['receive-nologin'] = ERR;
    await step(id);
    delete d.fail['receive-nologin'];
    await end();
    expect(stored(id).fleetDb.receive).toBeUndefined();
    await receive(id);
    d.fail['receive-nologin'] = ERR;
    await step(id);
    warn.restore();
    expect(warn.out.filter(m => m.includes('could not be removed'))).toEqual([warned(id), warned(id)]);
  };
  it('the end error logged is forgotten when Stop receiving ends it', async () => {
    await endErrorRow('e1', () => stopReceive('e1'));
  });
  it('the end error logged is forgotten when the code expires unused', async () => {
    await endErrorRow('e2', () => step('e2'));
  });
});
