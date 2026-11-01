import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// NM10 round 6: the migration's pg_hba lines on files, the readers that meet them, and Enable and Disable keeping a
// Database URL that names another database (W2). b19-1's fake docker, with h.hba answering the fence line reads of
// fenceLinesRefusal and h.layers the fence state read of fenceLayers.
const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm10-hba-'));
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

describe('W2: Enable and Disable keep a Database URL that names another database', () => {
  it('O40 Enable over an outside URL turns replication on, keeps the URL and says so', async () => {
    expect((await putUrl(OUTSIDE)).status).toBe(200);
    const r: any = await enableFleetReplication(bot(), 'primary.invalid', 15432);
    expect(r.success).toBe(true);
    expect(r.urlKept).toBe(KEPT_E('db.example.test:5432/app'));
    expect(storedUrl()).toBe(OUTSIDE);
    expect(bot().fleetDb!.replication!.hostPort).toBe(15432);
  });
  it('O39 Disable over an outside URL saved after Enable turns replication off, keeps the URL and says so', async () => {
    expect((await enable()).success).toBe(true);
    expect((await putUrl(OUTSIDE)).status).toBe(200);
    const r: any = await disableFleetReplication(bot());
    expect(r.success).toBe(true);
    expect(r.urlKept).toBe(KEPT_D('db.example.test:5432/app'));
    expect(storedUrl()).toBe(OUTSIDE);
    expect(bot().fleetDb!.replication).toBeUndefined();
    expect(ran(/ALTER ROLE replicator NOLOGIN/).length).toBeGreaterThan(0);
  });
  it('O39 Disable over a URL in a form keeps it and names the form', async () => {
    expect((await enable()).success).toBe(true);
    const form = 'postgresql://smdb:x@bot1-fleet-postgres:5432/smdb?host=db.example.test';
    expect((await putUrl(form)).status).toBe(200);
    const r: any = await disableFleetReplication(bot());
    expect(r.urlKept).toBe(KEPT_D("an address the manager reads differently from the bot's Postgres driver (it has a host, hostaddr or port parameter after the ?, which the driver uses in place of the host and port before it)"));
    expect(storedUrl()).toBe(form);
  });
  it('(pin) O40 Enable on the managed database writes its address and keeps nothing', async () => {
    const r: any = await enable();
    expect(r.success).toBe(true);
    expect(r.urlKept).toBeUndefined();
    expect(storedUrl()).toBe('postgresql://smdb:Db-Secret-0123456789@bot1-fleet-postgres:5432/smdb?sslmode=no-verify');
  });
  it('(pin) O39 Disable on the managed database sets its private form and keeps nothing', async () => {
    expect((await enable()).success).toBe(true);
    const r: any = await disableFleetReplication(bot());
    expect(r.success).toBe(true);
    expect(r.urlKept).toBeUndefined();
    expect(storedUrl()).toBe('postgresql://smdb:Db-Secret-0123456789@bot1-fleet-postgres:5432/smdb?sslmode=no-verify');
  });
});

describe("the migration's pg_hba lines on files (D96)", () => {
  const tail = (owner: string) => `# smdb-fence-owner=${owner} # smdb-write-fence`;
  const lines = (owner: string, admit: string[]) => [
    ...admit.map(a => `host all all ${a}/${a.includes(':') ? 128 : 32} scram-sha-256 ${tail(owner)}`),
    `host replication all all reject ${tail(owner)}`,
    `host all all all reject ${tail(owner)}`,
  ].map(l => `${l}\n`).join('');
  it("the fence's lines go first, for each address, and the file keeps the rest", async () => {
    const r = await runOnDataDir(migrateFenceHbaScript('migrate:1', ['172.18.0.4', 'fd00::4']), FENCE_PGDATA, { 'pg_hba.conf': MANAGED_HBA });
    expect(r.out).toBe('fenced\n');
    expect(r.files['pg_hba.conf']).toBe(lines('migrate:1', ['172.18.0.4', 'fd00::4']) + MANAGED_HBA);
    expect(r.chowns.some(c => c.includes('pg_hba.conf.fence'))).toBe(true);
  });
  it('renewed: the same owner\'s older lines are replaced by the new addresses', async () => {
    const r = await runOnDataDir(migrateFenceHbaScript('migrate:1', ['172.18.0.9']), FENCE_PGDATA, { 'pg_hba.conf': lines('migrate:1', ['172.18.0.4', 'fd00::4']) + MANAGED_HBA });
    expect(r.out).toBe('fenced\n');
    expect(r.files['pg_hba.conf']).toBe(lines('migrate:1', ['172.18.0.9']) + MANAGED_HBA);
    expect(r.files['pg_hba.conf']).not.toContain('172.18.0.4');
  });
  it("another owner's line: held-hba names it and the file is unchanged", async () => {
    const before = ownedFencedHba('restore:5') + MANAGED_HBA;
    const r = await runOnDataDir(migrateFenceHbaScript('migrate:1', ['172.18.0.4']), FENCE_PGDATA, { 'pg_hba.conf': before });
    expect(r.out).toBe('held-hba restore:5\n');
    expect(r.files['pg_hba.conf']).toBe(before);
  });
  it('a line of no owner: held-hba and the file unchanged', async () => {
    const before = FENCED_HBA + MANAGED_HBA;
    const r = await runOnDataDir(migrateFenceHbaScript('migrate:1', ['172.18.0.4']), FENCE_PGDATA, { 'pg_hba.conf': before });
    expect(r.out.startsWith('held-hba')).toBe(true);
    expect(r.files['pg_hba.conf']).toBe(before);
  });
  it("the switch's takeover line stays after the fence's lines", async () => {
    const takeover = 'host all "smdb" all reject # smdb-takeover-block\n';
    const r = await runOnDataDir(migrateFenceHbaScript('migrate:1', ['172.18.0.4', 'fd00::4']), FENCE_PGDATA, { 'pg_hba.conf': takeover + MANAGED_HBA });
    expect(r.files['pg_hba.conf']).toBe(lines('migrate:1', ['172.18.0.4', 'fd00::4']) + takeover + MANAGED_HBA);
  });
  it("the lift removes this owner's lines only", async () => {
    const r = await runOnDataDir(liftMigrateFenceScript('migrate:1'), FENCE_PGDATA, { 'pg_hba.conf': lines('migrate:1', ['172.18.0.4', 'fd00::4']) + ownedFencedHba('restore:5') + MANAGED_HBA });
    expect(r.out).toBe('stripped-hba\n');
    expect(r.files['pg_hba.conf']).toBe(ownedFencedHba('restore:5') + MANAGED_HBA);
    expect(r.files['pg_hba.conf']).not.toContain('migrate:1');
  });
  it('(pin) the lift on a file with none of its lines prints nothing and changes nothing', async () => {
    const r = await runOnDataDir(liftMigrateFenceScript('migrate:1'), FENCE_PGDATA, { 'pg_hba.conf': MANAGED_HBA });
    expect(r.out).toBe('');
    expect(r.files['pg_hba.conf']).toBe(MANAGED_HBA);
  });
});

describe('O41: the readers of the mark', () => {
  it("the start's warning skips the lines of the bot's own open migration", async () => {
    writeRegistry({ migrate: record({ hbaFence: 'migrate:1' }) });
    h.layers = 'off|4||migrate:1';
    expect(await fenceStartWarning('b1')).toBeNull();
  });
  it("(pin) the start's warning names a restore's lines", async () => {
    writeRegistry({ migrate: record({ hbaFence: 'migrate:1' }) });
    h.layers = 'off|4||restore:5';
    const w = await fenceStartWarning('b1');
    expect(w).toMatch(/refuses every connection but the manager's/);
    expect(w).toContain('a restore (started 1970-01-01 00:00 UTC)');
  });
  it("with no record, the start's warning names a migration's lines as a migration's", async () => {
    h.layers = 'off|4||migrate:1';
    const w = await fenceStartWarning('b1');
    expect(w).toContain('a migration (started 1970-01-01 00:00 UTC)');
    expect(w).toContain('no open migration holds it, so a restore of a dump into this database lifts it');
    expect(w).not.toContain('running that lane again lifts it');
  });
  it("the narrowing's refusal names a migration's lines and that the open migration lifts them", async () => {
    writeRegistry({ migrate: record({ hbaFence: 'migrate:1' }) });
    h.hba = { count: '4', owner: 'migrate:1' };
    expect(await fleetReplication.fenceLinesRefusal('bot1-fleet-postgres', 'smdb')).toContain('it belongs to a migration (started 1970-01-01 00:00 UTC), which lifts it when it ends');
  });
  it("O41 with no record, the narrowing's refusal says that migration is no longer open", async () => {
    h.hba = { count: '4', owner: 'migrate:1' };
    expect(await fleetReplication.fenceLinesRefusal('bot1-fleet-postgres', 'smdb')).toContain('it belongs to a migration (started 1970-01-01 00:00 UTC) that is no longer open, so no lane lifts it; a restore takes it over and lifts it, or remove the lines by hand if nothing should hold them');
  });
});

describe('round 7: the fence write, the lift and Enable and Disable', () => {
  const SETTINGS = '/var/lib/postgresql/data/pg_hba.conf';
  it('B39 an enabled subscription: fenceMigrateSource answers the subscription text and writes no line', async () => {
    h.addrs = '172.18.0.4 ';
    h.migrateSettings = `${SETTINGS}|0|1`;
    expect(await fenceMigrateSource(bot(), 'migrate:1')).toBe('the database has 1 enabled subscription(s), whose workers write past the fence; disable them (ALTER SUBSCRIPTION ... DISABLE) and retry');
    expect(h.execs.some(x => x.includes('smdb-fence-owner=migrate:1'))).toBe(false);
  });
  it("B39 the settings read's field count: two fields read as an unknown form", async () => {
    h.addrs = '172.18.0.4 ';
    h.migrateSettings = `${SETTINGS}|0`;
    expect(await fenceMigrateSource(bot(), 'migrate:1')).toBe(`the database's settings read back in an unknown form (${SETTINGS}|0)`);
  });
  it('(pin) B39 no enabled subscription: the lines are written and the answer is null', async () => {
    h.addrs = '172.18.0.4 ';
    h.migrateSettings = `${SETTINGS}|0|0`;
    expect(await fenceMigrateSource(bot(), 'migrate:1')).toBeNull();
    expect(h.execs.some(x => x.includes('smdb-fence-owner=migrate:1'))).toBe(true);
  });
  it("B43 the sweeps leave the sessions of the bot's own role open", async () => {
    h.addrs = '172.18.0.4 ';
    h.migrateSettings = `${SETTINGS}|0|0`;
    expect(await fenceMigrateSource(bot(), 'migrate:1')).toBeNull();
    const sweeps = h.execs.filter(x => x.includes('pg_terminate_backend'));
    expect(sweeps).toHaveLength(2);
    for (const x of sweeps) expect(x).toContain(`usename IS DISTINCT FROM '${bot().fleetDb!.user}'`);
  });
  const RELOAD_FAIL = 'psql: error: connection to server failed';
  it('F11 live, no line, the reload fails: unconfirmed', async () => {
    h.liftOut = '';
    h.reloadFail = RELOAD_FAIL;
    expect(await liftMigrateFence(fleetDb, 'migrate:1')).toEqual({ result: 'unconfirmed' });
  });
  it('(pin) F11 live, no line, the reload lands: lifted', async () => {
    h.liftOut = '';
    expect(await liftMigrateFence(fleetDb, 'migrate:1')).toEqual({ result: 'lifted' });
  });
  it('(pin) F10 live, lines removed, the reload fails: stripped', async () => {
    h.liftOut = 'stripped-hba\n';
    h.reloadFail = RELOAD_FAIL;
    expect(await liftMigrateFence(fleetDb, 'migrate:1')).toEqual({ result: 'stripped' });
  });
  const RESTARTING = 'Error response from daemon: Container bot1-fleet-postgres is restarting, wait until the container is running';
  it('F11 the volume, no line: unconfirmed', async () => {
    h.liftExecFail = RESTARTING;
    h.stripOut = '';
    expect(await liftMigrateFence(fleetDb, 'migrate:1')).toEqual({ result: 'unconfirmed' });
  });
  it('(pin) F10 the volume, lines removed: stripped', async () => {
    h.liftExecFail = RESTARTING;
    h.stripOut = 'stripped-hba\n';
    expect(await liftMigrateFence(fleetDb, 'migrate:1')).toEqual({ result: 'stripped' });
  });
  const PRIVATE = 'postgresql://smdb:Db-Secret-0123456789@bot1-fleet-postgres:5432/smdb?sslmode=no-verify';
  it("O44 Enable over a PGPORT form naming the managed container writes the managed database's address", async () => {
    expect((await call('put', '/:id/env', { id: 'b1' }, { vars: { DATA_BACKEND_URL: 'postgresql://smdb:Db-Secret-0123456789@bot1-fleet-postgres/smdb', PGPORT: '5432' } })).status).toBe(200);
    const r: any = await enable();
    expect(r.success).toBe(true);
    expect(r.urlKept).toBeUndefined();
    expect(storedUrl()).toBe(PRIVATE);
  });
  it('O44 Disable over a port parameter on the managed container sets its private form', async () => {
    expect((await enable()).success).toBe(true);
    expect((await putUrl('postgresql://smdb:Db-Secret-0123456789@bot1-fleet-postgres:5432/smdb?port=5432')).status).toBe(200);
    const r: any = await disableFleetReplication(bot());
    expect(r.success).toBe(true);
    expect(r.urlKept).toBeUndefined();
    expect(storedUrl()).toBe(PRIVATE);
  });
  it('O45 a second outside URL saved during Enable: the kept text names the URL read at the write', async () => {
    expect((await putUrl(OUTSIDE)).status).toBe(200);
    let done = false;
    h.during = (t) => { if (/replicator/.test(t) && !done) { done = true; envManager.setEnvVars('b1', { DATA_BACKEND_URL: 'postgresql://u:p@db2.example.test:5432/app2' }); } };
    const r: any = await enable();
    expect(r.success).toBe(true);
    expect(r.urlKept).toBe(KEPT_E('db2.example.test:5432/app2'));
    expect(storedUrl()).toBe('postgresql://u:p@db2.example.test:5432/app2');
  });
  it("O45 the managed URL saved during Disable: nothing is written over it, and the kept text says it changed", async () => {
    expect((await enable()).success).toBe(true);
    expect((await putUrl(OUTSIDE)).status).toBe(200);
    let done = false;
    h.during = (t) => { if (/replicator/.test(t) && !done) { done = true; envManager.setEnvVars('b1', { DATA_BACKEND_URL: dbUrl }); } };
    const r: any = await disableFleetReplication(bot());
    expect(r.success).toBe(true);
    expect(r.urlKept).toBe('The Database URL was kept as it is: it changed while Disable ran, and Disable sets back only the value it read when it started.');
    expect(storedUrl()).toBe(dbUrl);
  });
});
