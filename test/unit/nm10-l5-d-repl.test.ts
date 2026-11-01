import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// nm10-hba's fake docker: h.hba answers the fence line reads of fenceLinesRefusal, h.during runs at each psql.
const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm10-l5-d-repl-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  const KEY = '-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgtM9o4pDpv0Cozikt\n4uwMJM46EUEJfbQjdtA2ByXUiKmhRANCAASCO4i47sdvseuYxeVB4O0rlxjNcVMU\n+oDBbAmwCX/c8cCbXLEKcl+wkz1IYT34cczAPZABg6O0Az0dRZ6eF3hp\n-----END PRIVATE KEY-----\n';
  const CERT = '-----BEGIN CERTIFICATE-----\nMIIBmTCCAT6gAwIBAgIUDgY+bMG7vClw3xqVXtdber+h0UswCgYIKoZIzj0EAwIw\nFTETMBEGA1UEAwwKcmVsYXkudGVzdDAgFw0yNjEwMjQxOTU2NTNaGA8yMTI2MDkz\nMDE5NTY1M1owFTETMBEGA1UEAwwKcmVsYXkudGVzdDBZMBMGByqGSM49AgEGCCqG\nSM49AwEHA0IABII7iLjux2+x65jF5UHg7SuXGM1xUxT6gMFsCbAJf9zxwJtcsQpy\nX7CTPUhhPfhxzMA9kAGDo7QDPR1Fnp4XeGmjajBoMB0GA1UdDgQWBBQqYKbJkFWh\nxPOcT7Q49mMc8zDPvjAfBgNVHSMEGDAWgBQqYKbJkFWhxPOcT7Q49mMc8zDPvjAP\nBgNVHRMBAf8EBTADAQH/MBUGA1UdEQQOMAyCCnJlbGF5LnRlc3QwCgYIKoZIzj0E\nAwIDSQAwRgIhAPguVl9lDTbwuZR4c91bTG90pN57G5fKrqNVJt6cb1HKAiEA/AUV\nrXUvU3u3dD9I72F/lLjbLGmWaqohTGadeXPYkCk=\n-----END CERTIFICATE-----\n';
  return {
    dir, KEY, CERT,
    calls: [] as Array<{ args: string[]; stdin: string }>,
    hba: { count: '0', owner: '' },
    layers: null as string | null,
    addrs: null as string | null,
    migrateSettings: null as string | null,
    fenceOut: 'fenced\n',
    liftOut: '',
    liftExecFail: null as string | null,
    stripOut: '',
    reloadFail: null as string | null,
    execs: [] as string[],
    during: null as ((text: string) => void) | null,
  };
});

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const { EventEmitter } = await import('events');
  const { PassThrough } = await import('stream');
  const nodeFs = await import('fs');
  const answer = (text: string): { out: string; code: number } => {
    if (/^test -f \S*server\.crt$/.test(text)) return { out: '', code: 0 };
    if (text.includes('pg_stat_ssl')) return { out: '\n', code: 0 };
    if (text.includes('FROM pg_stat_replication WHERE usename')) return { out: '\n', code: 0 };
    if (text.includes('FROM pg_roles')) return { out: '0\n', code: 0 };
    if (text.includes('string_agg(DISTINCT')) return { out: `${h.hba.owner}\n`, code: 0 };
    if (text.includes('count(*)') && text.includes('pg_read_file')) return { out: `${h.hba.count}\n`, code: 0 };
    if (text.includes('pg_read_file')) return { out: '0\n', code: 0 };
    return { out: '', code: 0 };
  };
  const execFile = (cmd: string, args: string[], opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    setTimeout(() => {
      if (cmd === 'openssl') {
        nodeFs.writeFileSync(args[args.indexOf('-keyout') + 1], h.KEY);
        nodeFs.writeFileSync(args[args.indexOf('-out') + 1], h.CERT);
        return done(null, '', '');
      }
      if (args[0] === 'ps') return done(null, '', '');
      if (args[0] === 'inspect' && args.join(' ').includes('IPAddress')) return done(null, '', '');
      if (args[0] === 'inspect') return done(null, 'true\n', '');
      done(null, '', '');
    }, 1);
    return new EventEmitter();
  };
  const spawn = (_cmd: string, args: string[]) => {
    const call = { args: args.slice(1), stdin: '' };
    h.calls.push(call);
    const child: any = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.stdin.on('data', (d: Buffer) => { call.stdin += d.toString(); });
    child.kill = () => {};
    const text = args.slice(args.indexOf('-i') === 1 ? 3 : 2).join(' ');
    setTimeout(() => {
      const { out, code } = answer(text);
      child.stdout.end(out);
      child.stderr.end('');
      setTimeout(() => { h.during?.(`${call.args.join(' ')}\n${call.stdin}`); child.emit('close', code); }, 1);
    }, 2);
    return child;
  };
  const fencedExecFile = (await import('./fence-fake')).withFence(execFile as any);
  const layeredExecFile = (cmd: string, args: string[], opts: any, cb?: any) => {
    const sql = args.join(' ');
    const done = typeof opts === 'function' ? opts : cb;
    h.execs.push(sql);
    const reply = (out: string, fail: string | null = null) => {
      setTimeout(() => (fail === null ? done(null, out, '') : done(Object.assign(new Error(fail), { code: 1 }), '', fail)), 1);
      return new EventEmitter();
    };
    if (h.layers !== null && sql.includes('FROM regexp_split_to_table') && sql.includes('default_transaction_read_only')) return reply(`${h.layers}\n`);
    const root = args[0] === 'exec' && args[1] === '-u' && args[2] === 'root';
    if (args[0] === 'inspect' && sql.includes('IPAddress') && h.addrs !== null) return reply(h.addrs);
    if (args[0] === 'exec' && sql.includes("current_setting('hba_file')") && !sql.includes("current_setting('ssl')") && h.migrateSettings !== null) return reply(`${h.migrateSettings}\n`);
    if (root && sql.includes('echo fenced')) return reply(h.fenceOut);
    if (root && sql.includes('stripped-hba')) return reply(h.liftOut, h.liftExecFail);
    if (args[0] === 'run' && sql.includes('stripped-hba')) return reply(h.stripOut);
    if (sql.includes('pg_reload_conf()') && h.reloadFail !== null) return reply('', h.reloadFail);
    return fencedExecFile(cmd, args, opts, cb);
  };
  const heldSpawn = (await import('./dump-fake')).withDumpHolder(spawn as any);
  const exec = (c: string, _o: any, cb?: any) => {
    const stdout = h.addrs === null ? '' : c.startsWith('docker ps -q') ? 'bot1-app-id\n' : c.startsWith('docker inspect') && c.includes('IPAddress') ? h.addrs : '';
    (typeof _o === 'function' ? _o : cb)(null, { stdout, stderr: '' });
    return new EventEmitter();
  };
  return { ...real, exec, execFile: layeredExecFile, spawn: heldSpawn, default: { ...real, exec, execFile: layeredExecFile, spawn: heldSpawn } };
});
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';
import * as envManager from '../../src/env/manager';
import * as fleetReplication from '../../src/instance/fleetReplication';
import { WRITE_FENCE_MARK } from '../../src/instance/fleetBackupGuards';
import { enableFleetReplication, disableFleetReplication } from '../../src/instance/fleetReplication';
import { fenceMigrateSource, fenceStartWarning, liftMigrateFence, liftMigrateFenceScript, migrateFenceHbaScript, FENCE_PGDATA } from '../../src/instance/fleetBackup';
import { createBotRoutes } from '../../src/webui/routes/bots';
import { runOnDataDir, FENCED_HBA, MANAGED_HBA, ownedFencedHba } from './fence-fake';

const botDir = path.join(h.dir, 'bots', 'b1');
const dbUrl = 'postgresql://smdb:Db-Secret-0123456789@bot1-fleet-postgres:5432/smdb';
const fleetDb = { containerName: 'bot1-fleet-postgres', user: 'smdb', db: 'smdb', volume: 'bot1-fleet-postgres-data' };
const OUTSIDE = 'postgresql://u:secret@db.example.test:5432/app';
const record = (over: Record<string, unknown> = {}) => ({ to: 'file', from: 'postgres', destination: null, companion: false, jobId: 'mgr-a', jobIds: ['mgr-a'], posted: true, started: 1, kept: 0, phase: 'following', loginOpened: true, sharers: [], sharersStopped: [], openedAt: '2026-10-31T00:00:00.000Z', ...over });

const writeRegistry = (extra: Record<string, unknown> = {}): void => {
  fs.writeFileSync(path.join(h.dir, 'instances.json'), JSON.stringify({
    instances: {
      b1: {
        id: 'b1', sanitizedName: 'bot1', displayName: 'Bot 1', titleName: 'Bot 1', status: 'running',
        sourceType: 'git', sourceUrl: 'https://example.invalid/fake/super-modular-discord-bot',
        envVars: { DATA_BACKEND: 'postgres' },
        fleetDb,
        createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z',
        ...extra,
      },
    },
  }));
};

const bot = () => containerManager.getBot('b1')!;
const enable = () => enableFleetReplication(bot(), 'primary.invalid', 15432);
const ran = (re: RegExp) => h.calls.filter(c => re.test(`${c.args.join(' ')}\n${c.stdin}`));
const storedUrl = () => envManager.getEnvVars('b1').DATA_BACKEND_URL;

const router = createBotRoutes({ clients: new Set() } as any);
const call = async (method: 'get' | 'put' | 'post' | 'delete', routePath: string, params: Record<string, string>, body: unknown = {}): Promise<{ status: number; body: any }> => {
  const layer = (router as any).stack.find((l: any) => l.route?.path === routePath && l.route.methods[method]);
  if (!layer) throw new Error(`no route ${method} ${routePath}`);
  const res: any = { statusCode: 200 };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  res.send = (b: unknown) => { res.body = b; return res; };
  await layer.route.stack[layer.route.stack.length - 1].handle({ params, query: {}, body, headers: {} }, res);
  return { status: res.statusCode, body: res.body };
};
const putUrl = (url: string) => call('put', '/:id/env', { id: 'b1' }, { vars: { DATA_BACKEND_URL: url } });

const KEPT_E = (what: string) => `The Database URL was kept as it is: it names ${what}, not this bot's managed database, so the bot goes on using it; Enable writes the managed database's address only when the Database URL is blank or names that database.`;
const KEPT_D = (what: string) => `The Database URL was kept as it is: it names ${what}, not this bot's managed database, and Disable sets it back only when it names that database.`;

beforeEach(() => {
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
  fs.mkdirSync(path.join(botDir, 'env'), { recursive: true });
  writeRegistry();
  envManager.setEnvVars('b1', { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: dbUrl });
  h.calls.length = 0;
  h.hba = { count: '0', owner: '' };
  h.layers = null;
  Object.assign(h, { addrs: null, migrateSettings: null, fenceOut: 'fenced\n', liftOut: '', liftExecFail: null, stripOut: '', reloadFail: null, execs: [], during: null });
});

afterAll(() => {
  fs.rmSync(h.dir, { recursive: true, force: true });
});


const PRIVATE = 'postgresql://smdb:Db-Secret-0123456789@bot1-fleet-postgres:5432/smdb?sslmode=no-verify';
const NO_PASSWORD = 'Could not recover the database password from the stored URL';

describe('fenceLinesRefusal names the lane that owns the lines', () => {
  const addBot2 = () => {
    const reg = JSON.parse(fs.readFileSync(path.join(h.dir, 'instances.json'), 'utf-8'));
    reg.instances.b2 = { ...reg.instances.b1, id: 'b2', sanitizedName: 'bot2', displayName: 'Bot 2', titleName: 'Bot 2',
      fleetDb: { containerName: 'bot2-fleet-postgres', user: 'smdb', db: 'smdb', volume: 'bot2-fleet-postgres-data' } };
    delete reg.instances.b2.migrate;
    fs.writeFileSync(path.join(h.dir, 'instances.json'), JSON.stringify(reg));
  };
  it("a migration's lines on another bot's database are not lifted by this bot's open migration", async () => {
    writeRegistry({ migrate: record({ hbaFence: 'migrate:1' }) });
    addBot2();
    h.hba = { count: '4', owner: 'migrate:1' };
    expect(await fleetReplication.fenceLinesRefusal('bot2-fleet-postgres', 'smdb')).toBe(
      `a write fence stands in pg_hba.conf (lines ending in ${WRITE_FENCE_MARK}`
      + '); it belongs to a migration (started 1970-01-01 00:00 UTC) that is no longer open, so no lane lifts it; a restore takes it over and lifts it, or remove the lines by hand if nothing should hold them');
  });
  it("a restore's lines name the restore, which lifts them when it finishes", async () => {
    h.hba = { count: '4', owner: 'restore:5' };
    expect(await fleetReplication.fenceLinesRefusal('bot1-fleet-postgres', 'smdb')).toBe(
      `a write fence stands in pg_hba.conf (lines ending in ${WRITE_FENCE_MARK}); it belongs to a restore (started 1970-01-01 00:00 UTC), and that lane lifts it when it finishes`);
  });
});

describe('the Database URL Enable and Disable read', () => {
  it('a blank Database URL: Enable writes the managed address with the password it was handed', async () => {
    envManager.deleteEnvVar('b1', 'DATA_BACKEND_URL');
    const r: any = await enableFleetReplication(bot(), 'primary.invalid', 15432, undefined, { dbPassword: 'Db-Secret-0123456789' });
    expect(r.success).toBe(true);
    expect(r.urlKept).toBeUndefined();
    expect(storedUrl()).toBe(PRIVATE);
  });
  it('a Database URL of spaces is blank, so Enable needs the stored password and refuses without it', async () => {
    envManager.setEnvVars('b1', { DATA_BACKEND_URL: '   ' });
    expect(await enable()).toEqual({ success: false, error: NO_PASSWORD });
    expect(bot().fleetDb!.replication).toBeUndefined();
  });
  it('a managed URL with no password: Enable refuses and changes nothing', async () => {
    envManager.setEnvVars('b1', { DATA_BACKEND_URL: 'postgresql://smdb@bot1-fleet-postgres:5432/smdb' });
    expect(await enable()).toEqual({ success: false, error: NO_PASSWORD });
    expect(bot().fleetDb!.replication).toBeUndefined();
    expect(ran(/replicator/).length).toBe(0);
  });
  it('a managed URL with no password: Disable refuses and keeps replication on', async () => {
    expect((await enable()).success).toBe(true);
    envManager.setEnvVars('b1', { DATA_BACKEND_URL: 'postgresql://smdb@bot1-fleet-postgres:5432/smdb' });
    expect(await disableFleetReplication(bot())).toEqual({ success: false, error: NO_PASSWORD });
    expect(bot().fleetDb!.replication!.hostPort).toBe(15432);
  });
  it('a join code saved as the Database URL is kept as no single database address', async () => {
    const { fakeJoinCode } = await import('./join-fake');
    const code = fakeJoinCode();
    envManager.setEnvVars('b1', { DATA_BACKEND_URL: code });
    const r: any = await enable();
    expect(r.success).toBe(true);
    expect(r.urlKept).toBe(KEPT_E('no single database address'));
    expect(storedUrl()).toBe(code);
  });
  it('an IPv6 address is named in brackets', async () => {
    const v6 = 'postgresql://u:secret@[fd00::5]:5432/app';
    envManager.setEnvVars('b1', { DATA_BACKEND_URL: v6 });
    const r: any = await enable();
    expect(r.success).toBe(true);
    expect(r.urlKept).toBe(KEPT_E('[fd00::5]:5432/app'));
    expect(storedUrl()).toBe(v6);
  });
  it("Disable over a URL on the replication address sets the private form back", async () => {
    expect((await enable()).success).toBe(true);
    envManager.setEnvVars('b1', { DATA_BACKEND_URL: 'postgresql://smdb:Db-Secret-0123456789@primary.invalid:15432/smdb' });
    const r: any = await disableFleetReplication(bot());
    expect(r.success).toBe(true);
    expect(r.urlKept).toBeUndefined();
    expect(storedUrl()).toBe(PRIVATE);
  });
  it('the managed URL saved during an Enable that started on an outside URL: nothing is written over it, and the kept text says it changed', async () => {
    envManager.setEnvVars('b1', { DATA_BACKEND_URL: OUTSIDE });
    let done = false;
    h.during = (t) => { if (/replicator/.test(t) && !done) { done = true; envManager.setEnvVars('b1', { DATA_BACKEND_URL: dbUrl }); } };
    const r: any = await enable();
    expect(r.success).toBe(true);
    expect(r.urlKept).toBe("The Database URL was kept as it is: it changed while Enable ran, and Enable writes the managed database's address only over the value it read when it started.");
    expect(storedUrl()).toBe(dbUrl);
  });
});

describe('the replication lane', () => {
  it("holds the instance's op as 'replication' while Enable runs", async () => {
    const seen: Array<string | null | undefined> = [];
    h.during = () => { seen.push(containerManager.isBotBusy('b1') as any); };
    expect((await enable()).success).toBe(true);
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen)).toEqual(new Set(['replication']));
  });
  it('an open migration record refuses Enable with its gate text and changes nothing', async () => {
    writeRegistry({ migrate: record() });
    const want = containerManager.migrateRefusal('b1', 'db');
    expect(want).not.toBeNull();
    expect(await enable()).toEqual(want);
    expect(bot().fleetDb!.replication).toBeUndefined();
    expect(h.calls.length).toBe(0);
  });
  it('an admission that throws inside the lane rejects, and the lane is released', async () => {
    expect((await enable()).success).toBe(true);
    await expect(disableFleetReplication(bot(), { admit: async () => { throw new Error('admit broke'); } })).rejects.toThrow('admit broke');
    expect(containerManager.isBotBusy('b1')).toBeFalsy();
  });
});
