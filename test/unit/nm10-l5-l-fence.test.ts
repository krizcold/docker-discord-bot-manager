import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// NM10 L5 round 2, writer l: the settings read's field count and the fence owner's anchored match. nm10-hba's fake
// docker, copied as it is, with h.migrateSettings answering fenceMigrateSource's settings read.
const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm10-l5-l-'));
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
import { enableFleetReplication, disableFleetReplication } from '../../src/instance/fleetReplication';
import { fenceMigrateSource, fenceStartWarning, liftMigrateFence, liftMigrateFenceScript, migrateFenceHbaScript, FENCE_PGDATA } from '../../src/instance/fleetBackup';
import { createBotRoutes } from '../../src/webui/routes/bots';
import { runOnDataDir, FENCED_HBA, MANAGED_HBA, ownedFencedHba } from './fence-fake';
import { parseFenceOwner, fenceOwnerLane } from '../../src/instance/fleetBackupGuards';

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

describe("fenceMigrateSource's settings read", () => {
  it('a pg_hba path holding a bar and digits reads as an unknown form, not as a path to compare', async () => {
    h.addrs = '172.18.0.4 ';
    h.migrateSettings = '/srv/a|5|5|0';
    expect(await fenceMigrateSource(bot(), 'migrate:1')).toBe("the database's settings read back in an unknown form (/srv/a|5|5|0)");
    expect(h.execs.some(x => x.includes('smdb-fence-owner='))).toBe(false);
  });
});

describe('parseFenceOwner', () => {
  it('names a lane only when the whole text is lane:<epoch ms>', () => {
    expect(parseFenceOwner('migrate:1')).toBe('migrate:1');
    expect(parseFenceOwner('premigrate:1')).toBeNull();
    expect(fenceOwnerLane('premigrate:1')).toBeNull();
  });
});
