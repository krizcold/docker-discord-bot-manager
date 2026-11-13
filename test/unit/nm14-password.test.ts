import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm14-password-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return {
    dir,
    sql: [] as string[],
    running: 'true' as string,
    cert: '' as string,
    authid: '' as string,
    authidFail: '' as string,
    authidReads: 0,
    exec: 'f|||\n' as string,
    runs: [] as Array<{ args: string[]; pw: string | undefined }>,
    openssl: 0,
    onText: null as null | ((text: string) => void),
    refuseSave: false,
  };
});

// A fake docker and openssl. The pg_authid read answers h.authid (or fails with h.authidFail); `docker run` is the
// endpoint probe and answers 1; other execs answer h.exec (the standby status read of the adopt); psql through
// spawn answers the reads Enable, Disable and the status check make. h.onText sees every command before it answers.
vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const { EventEmitter } = await import('events');
  const { PassThrough } = await import('stream');
  const nodeFs = await import('fs');
  const answer = (text: string): { code: number; out: string; err: string } => {
    if (text.includes('cat /var/lib/postgresql/data/server.crt')) return h.cert ? { code: 0, out: h.cert, err: '' } : { code: 1, out: '', err: 'cat: no such file' };
    if (text.includes("WHERE line LIKE '%")) return { code: 0, out: '0\n', err: '' };
    if (text.includes('FROM pg_roles WHERE rolname')) return { code: 0, out: '1\n', err: '' };
    if (text.includes("current_setting('ssl')")) return { code: 0, out: 'on|||4096MB\n', err: '' };
    if (text.includes("to_regclass('smdb_manager.addresses') IS NULL")) return { code: 0, out: '[]\n', err: '' };
    return { code: 0, out: '', err: '' };
  };
  const { FIXTURE_KEY, FIXTURE_PEM } = await import('./join-fake');
  const execFile = (cmd: string, args: string[], opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    const text = `${cmd} ${args.join(' ')}`;
    setImmediate(() => {
      h.onText?.(text);
      if (cmd === 'openssl') {
        h.openssl++;
        nodeFs.writeFileSync(args[args.indexOf('-keyout') + 1], FIXTURE_KEY);
        nodeFs.writeFileSync(args[args.indexOf('-out') + 1], FIXTURE_PEM);
        return done(null, '', '');
      }
      if (args[0] === 'inspect') {
        return h.running === 'ERR' ? done(new Error('fail'), '', 'Cannot connect to the Docker daemon\n') : done(null, `${h.running}\n`, '');
      }
      if (args[0] === 'run') {
        h.runs.push({ args, pw: opts?.env?.PGPASSWORD });
        return done(null, '1\n', '');
      }
      if (args[0] === 'ps') return done(null, '', '');
      if (text.includes('pg_authid')) {
        h.authidReads++;
        return h.authidFail ? done(new Error('fail'), '', `${h.authidFail}\n`) : done(null, `${h.authid}\n`, '');
      }
      if (text.includes("grep '^primary_conninfo'")) return done(null, '', '');
      done(null, h.exec, '');
    });
    return new EventEmitter();
  };
  const spawn = (_cmd: string, args: string[]) => {
    const child: any = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => true;
    let stdin = '';
    child.stdin.on('data', (d: Buffer) => { stdin += d; });
    setTimeout(() => {
      const text = `${args.join(' ')} ${stdin}`;
      h.onText?.(text);
      const a = answer(text);
      if (args.includes('psql')) h.sql.push(text);
      child.stdout.end(a.out);
      child.stderr.end(a.err);
      setTimeout(() => child.emit('close', a.code), 1);
    }, 3);
    return child;
  };
  return { ...real, execFile, spawn, default: { ...real, execFile, spawn } };
});
vi.mock('../../src/docker/containerManager', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/docker/containerManager')>();
  return {
    ...real,
    updateInstanceFleetDbPassword: (id: string, password: string) => {
      if (h.refuseSave) throw new Error('ENOSPC: no space left on device');
      return real.updateInstanceFleetDbPassword(id, password);
    },
  };
});
vi.mock('../../src/casaos/detector', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/casaos/detector')>()),
  getDeploymentMode: async () => 'docker',
}));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as containerManager from '../../src/docker/containerManager';
import * as envManager from '../../src/env/manager';
import { decodeJoinCode } from '../../src/config/joinCode';
import { scramSha256Verifier, verifierAccepts } from '../../src/config/secretText';
import { disableFleetReplication, enableFleetReplication, fleetDbShape, getFleetReplicationStatus, getJoinCode } from '../../src/instance/fleetReplication';
import { composeJoinCode } from '../../src/instance/fleetSwitch';
import { adoptPromotedReplica } from '../../src/instance/fleetReplica';
import { FIXTURE_PEM, fakeJoinRecord } from './join-fake';

const ROLE_PW = 'Db-Secret-0123456789';
const REC_PW = 'Record-Pw-0123456789';
const OTHER_PW = 'Other-Pw-0123456789';
const SALT = Buffer.alloc(16, 7);
const VERIFIER = scramSha256Verifier(ROLE_PW, SALT, 4096);
const MANAGED_URL = `postgresql://smdb:${ROLE_PW}@m-fleet-postgres:5432/smdb?sslmode=no-verify`;
const OUTSIDE_URL = 'postgresql://u:OUTSIDEPW@db.example.test:5432/app';
const BAD_BLOB = `v2:${'0'.repeat(24)}:${'0'.repeat(32)}:abcdef`;
const fleetDb = { containerName: 'm-fleet-postgres', user: 'smdb', db: 'smdb', volume: 'm-fleet-postgres-data' };
let portSeq = 20000;
const replication = () => ({ role: 'replicator', password: 'Repl-Secret-0123456789', hostPort: portSeq++, publicHost: 'main.invalid', certHost: 'main.invalid', slotWalKeepMb: 4096 });
const REGISTRY = path.join(h.dir, 'instances.json');
const writeRegistry = (extra: Record<string, unknown> = {}): void => {
  fs.writeFileSync(REGISTRY, JSON.stringify({ instances: { m: {
    id: 'm', sanitizedName: 'm', displayName: 'M', titleName: 'M', status: 'running', sourceType: 'git',
    sourceUrl: 'https://example.invalid/fake/super-modular-discord-bot', envVars: { DATA_BACKEND: 'postgres' },
    createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z', ...extra,
  } } }));
};
const editRecord = (fn: (db: any) => void): void => {
  const reg = JSON.parse(fs.readFileSync(REGISTRY, 'utf-8'));
  fn(reg.instances.m.fleetDb);
  fs.writeFileSync(REGISTRY, JSON.stringify(reg));
};
const rawRecord = () => JSON.parse(fs.readFileSync(REGISTRY, 'utf-8')).instances.m.fleetDb;
const bot = () => containerManager.getBot('m')!;
const setUrl = (url: string) => envManager.setEnvVars('m', { DATA_BACKEND_URL: url });
const urlNow = () => envManager.getEnvVars('m').DATA_BACKEND_URL;
const sidecar = (pw: string) => `postgresql://smdb:${encodeURIComponent(pw)}@m-fleet-postgres:5432/smdb?sslmode=no-verify`;
const record = (state: 'present' | 'absent' | 'lost', extra: Record<string, unknown> = {}) =>
  ({ ...fleetDb, ...(state === 'present' ? { password: REC_PW } : state === 'lost' ? { password: BAD_BLOB } : {}), ...extra });

const FILL_NOURL = 'the Database URL holds no password to check';
const MISMATCH_URL = 'the database does not accept the password in the Database URL for smdb';
const MISMATCH_FILE = "the database does not accept the password in the bot's env file for smdb";
const MISMATCH_BOTH = "the database does not accept the password in the Database URL or in the bot's env file for smdb";
const unread = (why: string) => `the password in the Database URL could not be checked against the database: ${why}`;
const JC_ABSENT = (d: string) => `The managed database's password is not on record (${d}), so no join code was made`;
const JC_LOST = "The managed database's password on record no longer decrypts (the manager's encryption key changed or was lost), so no join code was made; restore the key";
const CJ_ABSENT = "the managed database's password is not on record (a join code or Enable records it from a Database URL whose password this database accepts)";
const CJ_LOST = "the managed database's password on record no longer decrypts";
const PE_ABSENT = (d: string) => `the bot's database password is not on record (${d})`;
const PE_LOST = "the bot's database password on record no longer decrypts";
const EN_ABSENT = (d: string) => `The managed database's password is not on record (${d}), so Enable cannot write its address into the Database URL; nothing was changed`;
const EN_LOST = "The managed database's password on record no longer decrypts (the manager's encryption key changed or was lost), so Enable cannot write its address into the Database URL; nothing was changed";
const DS_ABSENT = (d: string) => `The managed database's password is not on record (${d}), so Disable cannot set the Database URL back; nothing was disabled`;
const DS_LOST = "The managed database's password on record no longer decrypts (the manager's encryption key changed or was lost), so Disable cannot set the Database URL back; nothing was disabled";
const VR_ROLE = 'the role smdb does not exist in the database';
const VR_FORM = 'the database keeps no SCRAM-SHA-256 password for smdb';
const VR_ITER = "the database's SCRAM-SHA-256 password for smdb uses 2147483647 iterations, more than the 100000 the manager checks";

const logs: string[] = [];
beforeEach(() => {
  h.sql = []; h.running = 'true'; h.cert = FIXTURE_PEM; h.authid = `v|${VERIFIER}`; h.authidFail = ''; h.authidReads = 0;
  h.exec = 'f|||\n'; h.runs = []; h.openssl = 0; h.onText = null; h.refuseSave = false;
  logs.length = 0;
  for (const level of ['log', 'warn', 'error'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')); });
  }
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
  fs.mkdirSync(path.join(h.dir, 'bots', 'm', 'env'), { recursive: true });
  fs.mkdirSync(path.join(h.dir, 'bots', 'b1', 'env'), { recursive: true });
});
afterEach(() => { vi.restoreAllMocks(); });
afterAll(() => fs.rmSync(h.dir, { recursive: true, force: true }));

// Enable reads whether a write fence stands before it checks the password; that read changes nothing.
const changes = () => h.sql.filter(s => !s.includes('# smdb-write-fence'));
const noVerifierShown = (...texts: Array<string | undefined>) => {
  for (const t of [...texts, ...logs]) expect(String(t ?? '')).not.toContain('SCRAM-SHA-256$');
};

const URLS: Array<[string, string]> = [['blank', ''], ['the managed database', MANAGED_URL], ['an outside database', OUTSIDE_URL]];

describe('C1 to C12: the join code, the composed code and the probe read the record only', () => {
  const target = { host: 'copy.invalid', port: 15433, cert: FIXTURE_PEM, machine: 'copy.invalid' };
  describe.each(URLS)('Database URL %s', (_n, url) => {
    beforeEach(() => {
      // The role accepts none of the URL's passwords here: an absent record cannot be filled.
      h.authid = `v|${scramSha256Verifier(OTHER_PW, SALT, 4096)}`;
      if (url) setUrl(url);
    });
    const absentDetail = url ? MISMATCH_URL : FILL_NOURL;

    it('C1, C2: a recorded password goes into the join code; the URL password appears nowhere', async () => {
      writeRegistry({ fleetDb: record('present', { replication: replication() }) });
      const r = await getJoinCode(bot());
      expect(r.success).toBe(true);
      const d = decodeJoinCode(r.joinCode!);
      expect(d.ok && d.code.app).toEqual({ user: 'smdb', password: REC_PW });
      expect(JSON.stringify(d)).not.toContain('OUTSIDEPW');
      expect(JSON.stringify(d)).not.toContain(ROLE_PW);
      expect(h.authidReads).toBe(0);
    });
    it('C3: no record password: JC-ABSENT with the reason, nothing recorded', async () => {
      writeRegistry({ fleetDb: record('absent', { replication: replication() }) });
      expect(await getJoinCode(bot())).toEqual({ success: false, error: JC_ABSENT(absentDetail) });
      expect(rawRecord().password).toBeUndefined();
    });
    it('C4: a record password that no longer decrypts: JC-LOST, no fill', async () => {
      writeRegistry({ fleetDb: record('lost', { replication: replication() }) });
      expect(await getJoinCode(bot())).toEqual({ success: false, error: JC_LOST });
      expect(h.authidReads).toBe(0);
    });
    it('C5: the same code on every call while the record is unchanged', async () => {
      writeRegistry({ fleetDb: record('present', { replication: replication() }) });
      expect((await getJoinCode(bot())).joinCode).toBe((await getJoinCode(bot())).joinCode);
    });
    it('C6 to C8: the composed code', () => {
      writeRegistry({ fleetDb: record('present', { replication: replication() }) });
      const ok = composeJoinCode(bot(), target);
      expect(ok.ok && ok.code.app).toEqual({ user: 'smdb', password: REC_PW });
      expect(ok.ok && ok.text).not.toContain('OUTSIDEPW');
      writeRegistry({ fleetDb: record('absent', { replication: replication() }) });
      expect(composeJoinCode(bot(), target)).toEqual({ ok: false, error: CJ_ABSENT });
      writeRegistry({ fleetDb: record('lost', { replication: replication() }) });
      expect(composeJoinCode(bot(), target)).toEqual({ ok: false, error: CJ_LOST });
      expect(h.authidReads).toBe(0);
    });
    it('C9: the probe runs with the recorded password in its child env', async () => {
      writeRegistry({ fleetDb: record('present', { replication: replication() }) });
      const s = await getFleetReplicationStatus(bot());
      expect(s.reachability).toMatchObject({ ok: true });
      expect(h.runs.map(r => r.pw)).toEqual([REC_PW]);
      expect(h.runs[0].args.join(' ')).not.toContain(REC_PW);
    });
    it('C10, C11: absent or lost: unchecked, no docker run', async () => {
      writeRegistry({ fleetDb: record('absent', { replication: replication() }) });
      expect((await getFleetReplicationStatus(bot())).reachability).toEqual({ ok: false, unchecked: true, error: PE_ABSENT(absentDetail), ageSeconds: 0 });
      writeRegistry({ fleetDb: record('lost', { replication: replication() }) });
      expect((await getFleetReplicationStatus(bot())).reachability).toEqual({ ok: false, unchecked: true, error: PE_LOST, ageSeconds: 0 });
      expect(h.runs).toEqual([]);
    });
  });

  it('C12: a probe answer is kept for 60 s', async () => {
    writeRegistry({ fleetDb: record('present', { replication: replication() }) });
    await getFleetReplicationStatus(bot());
    await getFleetReplicationStatus(bot());
    expect(h.runs.length).toBe(1);
  });
});

describe('T5: for any outside password p and recorded q the join code holds q and never p', () => {
  it('holds over 25 drawn pairs', async () => {
    for (let i = 0; i < 25; i++) {
      const p = `OUTSIDE-${crypto.randomBytes(8).toString('hex')}`;
      const q = `RECORD-${crypto.randomBytes(8).toString('hex')}`;
      writeRegistry({ fleetDb: { ...fleetDb, password: q, replication: replication() } });
      setUrl(`postgresql://u:${p}@db.example.test:5432/app`);
      const d = decodeJoinCode((await getJoinCode(bot())).joinCode!);
      expect(d.ok && d.code.app.password).toBe(q);
      expect(JSON.stringify(d)).not.toContain(p);
    }
  });
});

describe('C13 to C17: Enable and Disable write the recorded password', () => {
  it('C13: an outside URL is kept by Enable and Disable with no password read', async () => {
    writeRegistry({ fleetDb: record('absent') });
    setUrl(OUTSIDE_URL);
    const en = await enableFleetReplication(bot(), 'main.invalid', 15432);
    expect(en.success).toBe(true);
    expect(en.urlKept).toMatch(/^The Database URL was kept as it is: it names db\.example\.test:5432\/app/);
    const dis = await disableFleetReplication(bot());
    expect(dis.success).toBe(true);
    expect(urlNow()).toBe(OUTSIDE_URL);
    expect(h.authidReads).toBe(0);
  });
  it.each([['blank', ''], ['the managed database', MANAGED_URL]])('C14, C15: URL %s: Enable and Disable write the recorded password', async (_n, url) => {
    writeRegistry({ fleetDb: record('present') });
    if (url) setUrl(url);
    expect((await enableFleetReplication(bot(), 'main.invalid', 15432)).success).toBe(true);
    expect(urlNow()).toBe(sidecar(REC_PW));
    setUrl(MANAGED_URL);
    expect((await disableFleetReplication(bot())).success).toBe(true);
    expect(urlNow()).toBe(sidecar(REC_PW));
    expect(h.authidReads).toBe(0);
  });
  it('C16: no record password, the caller\'s password accepted: written and recorded', async () => {
    writeRegistry({ fleetDb: record('absent') });
    const en = await enableFleetReplication(bot(), 'main.invalid', 15432, undefined, { dbPassword: ROLE_PW });
    expect(en.success).toBe(true);
    expect(urlNow()).toBe(sidecar(ROLE_PW));
    expect(bot().fleetDb?.password).toBe(ROLE_PW);
  });
  it.each([
    ['absent', EN_ABSENT(FILL_NOURL), DS_ABSENT(FILL_NOURL)],
    ['lost', EN_LOST, DS_LOST],
  ] as const)('C17b: record %s, no URL and no caller password: refused before any change', async (state, en, ds) => {
    writeRegistry({ fleetDb: record(state) });
    expect(await enableFleetReplication(bot(), 'main.invalid', 15432)).toEqual({ success: false, error: en });
    writeRegistry({ fleetDb: record(state, { replication: replication() }) });
    const before = fs.readFileSync(REGISTRY, 'utf-8');
    expect(await disableFleetReplication(bot())).toEqual({ success: false, error: ds });
    expect(changes()).toEqual([]);
    expect(h.openssl).toBe(0);
    expect(fs.readFileSync(REGISTRY, 'utf-8')).toBe(before);
  });
});

describe('V4: Enable and Disable refuse on a broken store or an undecryptable URL key only', () => {
  const storeFile = path.join(h.dir, 'bots', 'm', 'env', 'storage.json');
  it.each(['present', 'absent'] as const)('C17a-1: a corrupt store refuses, record %s', async (state) => {
    writeRegistry({ fleetDb: record(state) });
    fs.writeFileSync(storeFile, '{not json');
    const r = await enableFleetReplication(bot(), 'main.invalid', 15432);
    expect(r).toEqual({ success: false, error: 'the env store cannot be read (a copy is kept beside it as storage.json.corrupt-<time> when it could be read); restore it first' });
    writeRegistry({ fleetDb: record(state, { replication: replication() }) });
    fs.writeFileSync(storeFile, '{not json');
    const before = fs.readFileSync(REGISTRY, 'utf-8');
    expect((await disableFleetReplication(bot())).error).toBe('the env store cannot be read (a copy is kept beside it as storage.json.corrupt-<time> when it could be read); restore it first');
    expect(changes()).toEqual([]);
    expect(h.openssl).toBe(0);
    expect(h.authidReads).toBe(0);
    expect(fs.readFileSync(REGISTRY, 'utf-8')).toBe(before);
  });
  it.each(['present', 'absent'] as const)('C17a-2: the URL key that no longer decrypts refuses, record %s', async (state) => {
    writeRegistry({ fleetDb: record(state) });
    fs.writeFileSync(storeFile, JSON.stringify({ vars: {}, encrypted: { DATA_BACKEND_URL: BAD_BLOB } }));
    const text = "the env store's value of DATA_BACKEND_URL no longer decrypts; re-enter it or restore the encryption key first";
    expect(await enableFleetReplication(bot(), 'main.invalid', 15432)).toEqual({ success: false, error: text });
    writeRegistry({ fleetDb: record(state, { replication: replication() }) });
    expect(await disableFleetReplication(bot())).toEqual({ success: false, error: text });
    expect(changes()).toEqual([]);
    expect(h.openssl).toBe(0);
    expect(JSON.parse(fs.readFileSync(storeFile, 'utf-8')).encrypted.DATA_BACKEND_URL).toBe(BAD_BLOB);
  });
  it('C17a-3: another key that no longer decrypts does not stop Enable or Disable', async () => {
    writeRegistry({ fleetDb: record('present') });
    setUrl(MANAGED_URL);
    const store = JSON.parse(fs.readFileSync(storeFile, 'utf-8'));
    store.encrypted.OTHER_TOKEN = BAD_BLOB;
    fs.writeFileSync(storeFile, JSON.stringify(store));
    expect((await enableFleetReplication(bot(), 'main.invalid', 15432)).success).toBe(true);
    expect((await disableFleetReplication(bot())).success).toBe(true);
    expect(urlNow()).toBe(sidecar(REC_PW));
  });
});

describe('A1: Copy join code and the probe on a broken store or an undecryptable URL key', () => {
  const storeFile = path.join(h.dir, 'bots', 'm', 'env', 'storage.json');
  const BROKEN = 'the env store cannot be read (a copy is kept beside it as storage.json.corrupt-<time> when it could be read); restore it first';
  const UNDEC = "the env store's value of DATA_BACKEND_URL no longer decrypts; re-enter it or restore the encryption key first";
  it.each([
    ['a corrupt store', () => fs.writeFileSync(storeFile, '{not json'), BROKEN],
    ['an undecryptable URL key', () => fs.writeFileSync(storeFile, JSON.stringify({ vars: {}, encrypted: { DATA_BACKEND_URL: BAD_BLOB } })), UNDEC],
  ])('%s: the texts say the store could not be read, nothing recorded, no docker run', async (_n, breakStore, why) => {
    writeRegistry({ fleetDb: record('absent', { replication: replication() }) });
    breakStore();
    expect(await getJoinCode(bot())).toEqual({ success: false, error: JC_ABSENT(unread(why)) });
    expect((await getFleetReplicationStatus(bot())).reachability).toEqual({ ok: false, unchecked: true, error: PE_ABSENT(unread(why)), ageSeconds: 0 });
    expect(rawRecord().password).toBeUndefined();
    expect(h.authidReads).toBe(0);
    expect(h.runs).toEqual([]);
  });
});

describe('V1: the fill records only a password the role accepts', () => {
  it('V1-1: a recorded password is used with no read and no write', async () => {
    writeRegistry({ fleetDb: record('present', { replication: replication() }) });
    setUrl(MANAGED_URL);
    const before = fs.readFileSync(REGISTRY, 'utf-8');
    expect((await getJoinCode(bot())).success).toBe(true);
    expect(h.authidReads).toBe(0);
    expect(fs.readFileSync(REGISTRY, 'utf-8')).toBe(before);
  });
  it('V1-4: Disable on a stopped database, or a docker that does not answer: FILL-UNREAD', async () => {
    writeRegistry({ fleetDb: record('absent', { replication: replication() }) });
    setUrl(MANAGED_URL);
    h.running = 'false';
    expect(await disableFleetReplication(bot())).toEqual({ success: false, error: DS_ABSENT(unread('the database is not running')) });
    h.running = 'ERR';
    expect(await disableFleetReplication(bot())).toEqual({ success: false, error: DS_ABSENT(unread('Could not probe the database container (Cannot connect to the Docker daemon)')) });
    expect(rawRecord().password).toBeUndefined();
    expect(h.authidReads).toBe(0);
  });
  it.each([
    ['V1-5: the role does not exist', 'missing', '', VR_ROLE],
    ['V1-6: no password kept', 'v|', '', VR_FORM],
    ['V1-6: an md5 password', 'v|md5abcdef0123456789abcdef01234567', '', VR_FORM],
    ['V1-7: the read fails', '', 'psql: error: connection to server failed', 'psql: error: connection to server failed'],
  ])('%s', async (_n, authid, fail, why) => {
    writeRegistry({ fleetDb: record('absent', { replication: replication() }) });
    setUrl(MANAGED_URL);
    h.authid = authid; h.authidFail = fail;
    const before = fs.readFileSync(REGISTRY, 'utf-8');
    const jc = await getJoinCode(bot());
    expect(jc).toEqual({ success: false, error: JC_ABSENT(unread(why)) });
    const probe = (await getFleetReplicationStatus(bot())).reachability;
    expect(probe).toEqual({ ok: false, unchecked: true, error: PE_ABSENT(unread(why)), ageSeconds: 0 });
    const en = await enableFleetReplication(bot(), 'main.invalid');
    expect(en).toEqual({ success: false, error: EN_ABSENT(unread(why)) });
    const ds = await disableFleetReplication(bot());
    expect(ds).toEqual({ success: false, error: DS_ABSENT(unread(why)) });
    expect(fs.readFileSync(REGISTRY, 'utf-8')).toBe(before);
    expect(h.runs).toEqual([]);
    noVerifierShown(jc.error, probe?.error, en.error, ds.error);
  });
  it.each([
    ['a stale password', `postgresql://smdb:${OTHER_PW}@m-fleet-postgres:5432/smdb`],
    ['a host parameter', `postgresql://smdb:${OTHER_PW}@m-fleet-postgres:5432/smdb?host=evil.example`],
    ['another port', `postgresql://smdb:${OTHER_PW}@main.invalid:5999/smdb`],
  ])('V1-8: %s is not accepted: FILL-MISMATCH, nothing recorded', async (_n, url) => {
    writeRegistry({ fleetDb: record('absent', { replication: replication() }) });
    setUrl(url);
    const jc = await getJoinCode(bot());
    expect(jc).toEqual({ success: false, error: JC_ABSENT(MISMATCH_URL) });
    expect(rawRecord().password).toBeUndefined();
    noVerifierShown(jc.error);
  });
  it('V1-9: an accepted password is recorded encrypted and used', async () => {
    writeRegistry({ fleetDb: record('absent', { replication: replication() }) });
    setUrl(`${OUTSIDE_URL},${MANAGED_URL}`);
    const jc = await getJoinCode(bot());
    const d = decodeJoinCode(jc.joinCode!);
    expect(d.ok && d.code.app.password).toBe(ROLE_PW);
    expect(rawRecord().password).toMatch(/^v2:/);
    expect(fs.readFileSync(REGISTRY, 'utf-8')).not.toContain(ROLE_PW);
    expect(bot().fleetDb?.password).toBe(ROLE_PW);
    expect(h.authidReads).toBe(1);
    expect((await getJoinCode(bot())).joinCode).toBeDefined();
    expect(h.authidReads).toBe(1);
  });
  it('V1-10: a save that throws: the accepted password is used, logged, and checked again next time', async () => {
    writeRegistry({ fleetDb: record('absent', { replication: replication() }) });
    setUrl(MANAGED_URL);
    h.refuseSave = true;
    const jc = await getJoinCode(bot());
    expect(jc.success).toBe(true);
    expect(logs).toContain('[FleetReplication] m: the database accepted the password in the Database URL, but it could not be recorded (ENOSPC: no space left on device); the next use checks it again');
    expect(rawRecord().password).toBeUndefined();
    await getJoinCode(bot());
    expect(h.authidReads).toBe(2);
    noVerifierShown();
  });
  it('V1-11: two fills at once both record the same value', async () => {
    writeRegistry({ fleetDb: record('absent', { replication: replication() }) });
    setUrl(MANAGED_URL);
    const [a, b] = await Promise.all([getJoinCode(bot()), getJoinCode(bot())]);
    expect(a.success && b.success).toBe(true);
    expect(bot().fleetDb?.password).toBe(ROLE_PW);
  });
});

describe('W2: the mismatch text names what was tried', () => {
  it.each([
    ['URL only', MANAGED_URL, undefined, MISMATCH_URL],
    ["the caller's password only", '', OTHER_PW, MISMATCH_FILE],
    ['both', MANAGED_URL, OTHER_PW, MISMATCH_BOTH],
  ])('%s', async (_n, url, extra, detail) => {
    h.authid = `v|${scramSha256Verifier('nobody-has-this', SALT, 4096)}`;
    writeRegistry({ fleetDb: record('absent') });
    if (url) setUrl(url);
    expect(await enableFleetReplication(bot(), 'main.invalid', 15432, undefined, { dbPassword: extra })).toEqual({ success: false, error: EN_ABSENT(detail) });
  });
});

describe('W1: the lanes compare the record without its password', () => {
  it('W1-1: Enable fills and runs to its end', async () => {
    writeRegistry({ fleetDb: record('absent') });
    setUrl(MANAGED_URL);
    const en = await enableFleetReplication(bot(), 'main.invalid', 15432);
    expect(en.success).toBe(true);
    expect(bot().fleetDb?.password).toBe(ROLE_PW);
    expect(urlNow()).toBe(sidecar(ROLE_PW));
  });
  it('W1-2: Disable fills and runs to its end', async () => {
    writeRegistry({ fleetDb: record('absent', { replication: replication() }) });
    setUrl(MANAGED_URL);
    expect((await disableFleetReplication(bot())).success).toBe(true);
    expect(bot().fleetDb?.password).toBe(ROLE_PW);
    expect(bot().fleetDb?.replication).toBeUndefined();
    expect(urlNow()).toBe(sidecar(ROLE_PW));
  });
  it('W1-3: a password recorded while Enable runs is no change', async () => {
    writeRegistry({ fleetDb: record('absent') });
    setUrl(OUTSIDE_URL);
    const outcomes: unknown[] = [];
    h.onText = (text) => { if (text.startsWith('openssl')) outcomes.push(containerManager.updateInstanceFleetDbPassword('m', ROLE_PW)?.id); };
    const en = await enableFleetReplication(bot(), 'main.invalid', 15432);
    expect(outcomes).toEqual(['m']);
    expect(en.success).toBe(true);
    expect(bot().fleetDb?.replication?.hostPort).toBe(15432);
  });
  it('W1-4: a password recorded while Disable runs is no change', async () => {
    writeRegistry({ fleetDb: record('absent', { replication: replication() }) });
    setUrl(OUTSIDE_URL);
    const outcomes: unknown[] = [];
    h.onText = (text) => { if (text.includes('ALTER ROLE replicator NOLOGIN')) outcomes.push(containerManager.updateInstanceFleetDbPassword('m', ROLE_PW)?.id); };
    const ds = await disableFleetReplication(bot());
    expect(outcomes).toEqual(['m']);
    expect(ds.success).toBe(true);
    expect(bot().fleetDb?.replication).toBeUndefined();
    expect(bot().fleetDb?.password).toBe(ROLE_PW);
  });
  it('W1-5a: another writer during Enable\'s fill: the existing refusal, nothing written', async () => {
    writeRegistry({ fleetDb: record('absent') });
    setUrl(MANAGED_URL);
    h.onText = (text) => { if (text.includes('pg_authid')) editRecord(db => { db.retiringAt = '2026-11-12T00:00:00.000Z'; }); };
    const en = await enableFleetReplication(bot(), 'main.invalid', 15432);
    expect(en.success).toBe(false);
    expect(en.error).toBe("The instance's database record changed while this Enable ran, so the record and the database URL were not written; the database already has the replication role, ssl, the WAL settings, the server certificate (a new one) and the managed pg_hba. Check the Replication section, then press Enable again");
    expect(rawRecord().replication).toBeUndefined();
    expect(rawRecord().password).toBeUndefined();
    expect(urlNow()).toBe(MANAGED_URL);
  });
  it('W1-5b: another writer during Disable\'s fill: the existing refusal, nothing disabled', async () => {
    writeRegistry({ fleetDb: record('absent', { replication: replication() }) });
    setUrl(MANAGED_URL);
    h.onText = (text) => { if (text.includes('pg_authid')) editRecord(db => { db.retiringAt = '2026-11-12T00:00:00.000Z'; }); };
    const ds = await disableFleetReplication(bot());
    expect(ds).toEqual({ success: false, error: "The instance's database record changed while this Disable ran its checks (nothing was disabled); check the Replication section, then press Disable replication again" });
    expect(h.sql.some(s => s.includes('pg_drop_replication_slot'))).toBe(false);
    expect(h.sql.some(s => s.includes('NOLOGIN'))).toBe(false);
    expect(rawRecord().password).toBeUndefined();
  });
  it('W1-5c: another field changed after the fill: the existing refusal', async () => {
    writeRegistry({ fleetDb: record('absent', { replication: replication() }) });
    setUrl(MANAGED_URL);
    h.onText = (text) => { if (text.includes('ALTER SYSTEM SET ssl = on')) editRecord(db => { db.replication.hostPort = 1; }); };
    const en = await enableFleetReplication(bot(), 'main.invalid');
    expect(en.success).toBe(false);
    expect(en.error).toMatch(/^The instance's database record changed while this Enable ran, so the record and the database URL were not written; /);
  });
  it('W1-6: the probe uses an accepted password and writes nothing', async () => {
    writeRegistry({ fleetDb: record('absent', { replication: replication() }) });
    setUrl(MANAGED_URL);
    const before = fs.readFileSync(REGISTRY, 'utf-8');
    expect((await getFleetReplicationStatus(bot())).reachability).toMatchObject({ ok: true });
    expect(h.runs.map(r => r.pw)).toEqual([ROLE_PW]);
    expect(fs.readFileSync(REGISTRY, 'utf-8')).toBe(before);
  });
  it('W1-7: the probe with no accepted password: unchecked, no docker run', async () => {
    writeRegistry({ fleetDb: record('absent', { replication: replication() }) });
    setUrl(`postgresql://smdb:${OTHER_PW}@m-fleet-postgres:5432/smdb`);
    expect((await getFleetReplicationStatus(bot())).reachability).toEqual({ ok: false, unchecked: true, error: PE_ABSENT(MISMATCH_URL), ageSeconds: 0 });
    expect(h.runs).toEqual([]);
  });
});

describe('fleetDbShape', () => {
  const draw = (): Record<string, unknown> => {
    const r: Record<string, unknown> = { containerName: crypto.randomBytes(3).toString('hex'), user: 'u', db: 'd', volume: 'v' };
    if (crypto.randomInt(2)) r.retiringAt = String(crypto.randomInt(1000));
    if (crypto.randomInt(2)) r.replication = { hostPort: crypto.randomInt(65535), password: crypto.randomBytes(4).toString('hex') };
    if (crypto.randomInt(2)) r.keptPlain = [crypto.randomBytes(2).toString('hex')];
    return r;
  };
  it('equal for records that differ only in password, different for any other field (100 draws)', () => {
    for (let i = 0; i < 100; i++) {
      const a = draw();
      const pw = crypto.randomBytes(6).toString('hex');
      expect(fleetDbShape({ ...a, password: pw } as any)).toBe(fleetDbShape(a as any));
      expect(fleetDbShape({ ...a, password: '' } as any)).toBe(fleetDbShape(a as any));
      const keys = Object.keys(a);
      const k = keys[crypto.randomInt(keys.length)];
      const b = { ...a, [k]: `${JSON.stringify(a[k])}x` };
      expect(fleetDbShape(b as any)).not.toBe(fleetDbShape(a as any));
    }
    expect(fleetDbShape(undefined)).toBe(JSON.stringify(undefined));
  });
});

describe('verifierAccepts', () => {
  const ascii = (): string => Array.from({ length: 1 + crypto.randomInt(24) }, () => String.fromCharCode(32 + crypto.randomInt(95))).join('');
  it('accepts the password a verifier was made from and refuses another (40 draws)', async () => {
    for (let i = 0; i < 40; i++) {
      const p = ascii();
      let q = ascii();
      if (q === p) q = `${p}x`;
      const v = scramSha256Verifier(p, crypto.randomBytes(16), 1 + crypto.randomInt(4096));
      expect(await verifierAccepts(v, p, 'smdb')).toBe(true);
      expect(await verifierAccepts(v, q, 'smdb')).toBe(false);
    }
  });
  it('a string not of the form, or a non-ASCII candidate, answers false', async () => {
    for (const v of ['', 'md5abc', 'SCRAM-SHA-256$', `SCRAM-SHA-256$0:${SALT.toString('base64')}$a:b`, VERIFIER.replace('$4096', '$x'), `${VERIFIER}extra`, VERIFIER.slice(0, -4)]) {
      expect(await verifierAccepts(v, ROLE_PW, 'smdb')).toBe(false);
    }
    expect(await verifierAccepts(VERIFIER, 'päss', 'smdb')).toBe(false);
    for (let i = 0; i < 50; i++) expect(await verifierAccepts(crypto.randomBytes(1 + crypto.randomInt(60)).toString('latin1'), ROLE_PW, 'smdb')).toBe(false);
  });
});

describe('A2: the iteration bound', () => {
  it('2147483647 iterations is refused with VR-ITER and no derivation', async () => {
    const v = VERIFIER.replace("$4096:", "$2147483647:");
    const started = Date.now();
    expect(await verifierAccepts(v, ROLE_PW, 'smdb')).toEqual({ why: VR_ITER });
    // A derivation at this count runs for minutes; a refusal answers at once.
    expect(Date.now() - started).toBeLessThan(1000);
  });
  it('100000 and 4096 still verify', async () => {
    expect(await verifierAccepts(VERIFIER, ROLE_PW, 'smdb')).toBe(true);
    expect(await verifierAccepts(scramSha256Verifier(ROLE_PW, SALT, 100000), ROLE_PW, 'smdb')).toBe(true);
  });
  it('Copy join code carries VR-ITER as its reason', async () => {
    h.authid = `v|${VERIFIER.replace('$4096:', '$2147483647:')}`;
    writeRegistry({ fleetDb: record('absent', { replication: replication() }) });
    setUrl(MANAGED_URL);
    expect(await getJoinCode(bot())).toEqual({ success: false, error: JC_ABSENT(unread(VR_ITER)) });
    expect(rawRecord().password).toBeUndefined();
  });
});

describe('V3: the adopt records a password the copy\'s role accepts', () => {
  const REPLICA = {
    containerName: 'bot1-fleet-postgres-replica', volume: 'bot1-fleet-postgres-replica-data', slot: 'fleet_standby_b1',
    primaryHost: 'primary.invalid', primaryPort: 5433, publicHost: 'standby.invalid', hostPort: 5440, certHost: 'standby.invalid',
    user: 'smdb', db: 'smdb',
  };
  const REG_B1 = path.join(h.dir, 'instances.json');
  const writeB1 = (extra: Record<string, unknown> = {}) => fs.writeFileSync(REG_B1, JSON.stringify({ instances: { b1: {
    id: 'b1', sanitizedName: 'bot1', displayName: 'Bot 1', titleName: 'Bot 1', status: 'running', sourceType: 'git',
    sourceUrl: 'https://example.invalid/fake/super-modular-discord-bot', envVars: { DATA_BACKEND: 'postgres' },
    createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z', fleetDbReplica: { ...REPLICA }, ...extra,
  } } }));
  const b1 = () => containerManager.getBot('b1')!;
  const botEnvFile = (url: string) => {
    fs.mkdirSync(path.join(h.dir, 'bots', 'b1', 'data'), { recursive: true });
    fs.writeFileSync(path.join(h.dir, 'bots', 'b1', 'data', '.env'), `DATA_BACKEND_URL=${url}\n`);
  };
  const appEnvFile = path.posix.join(path.join(h.dir, 'bots', 'b1', 'data'), '.env');
  const b1Url = () => envManager.getEnvVars('b1').DATA_BACKEND_URL;
  const fileUrl = (pw: string) => `postgresql://smdb:${pw}@bot1-fleet-postgres:5432/smdb`;
  const adoptedUrl = (pw: string) => `postgresql://smdb:${encodeURIComponent(pw)}@bot1-fleet-postgres-replica:5432/smdb?sslmode=no-verify`;

  it('V3-1: the join code\'s password, accepted, goes into the record and the URL', async () => {
    writeB1({ fleetJoin: fakeJoinRecord({}, { app: { user: 'smdb', password: ROLE_PW } }) });
    envManager.setEnvVars('b1', { DATA_BACKEND_URL: `postgresql://smdb:${OTHER_PW}@primary.invalid:5433/smdb` });
    const r = await adoptPromotedReplica(b1());
    expect(r.success).toBe(true);
    expect(b1().fleetDb?.password).toBe(ROLE_PW);
    expect(b1Url()).toBe(adoptedUrl(ROLE_PW));
    expect(h.authidReads).toBe(1);
  });
  it('V3-2: the join code\'s rejected, the bot env file\'s accepted', async () => {
    writeB1({ fleetJoin: fakeJoinRecord({}, { app: { user: 'smdb', password: OTHER_PW } }) });
    botEnvFile(fileUrl(ROLE_PW));
    const r = await adoptPromotedReplica(b1());
    expect(r.success).toBe(true);
    expect(b1().fleetDb?.password).toBe(ROLE_PW);
  });
  it('V3-3: the re-seeded old main\'s file password the new cluster does not accept: AD-NONE, nothing changed', async () => {
    writeB1();
    botEnvFile(fileUrl(OTHER_PW));
    const before = fs.readFileSync(REG_B1, 'utf-8');
    const r = await adoptPromotedReplica(b1());
    expect(r).toEqual({ success: false, error: `Could not recover the fleet database credentials from this instance: the database does not accept any password kept in its join code, the manager env or ${appEnvFile} for smdb, so the database cannot be adopted. Put a Database URL with this database's password into the bot's env in the Env editor, then try again` });
    expect(fs.readFileSync(REG_B1, 'utf-8')).toBe(before);
    expect(b1Url()).toBeUndefined();
    noVerifierShown(r.error);
  });
  it('V3-4: no candidate at all: AD-NOSOURCE', async () => {
    writeB1();
    const r = await adoptPromotedReplica(b1());
    expect(r).toEqual({ success: false, error: `Could not recover the fleet database credentials from this instance (no join code is kept, and neither the manager env nor ${appEnvFile} carries a database URL with a password), so the database cannot be adopted` });
    expect(h.authidReads).toBe(0);
  });
  it.each([
    ['the role is missing', 'missing', '', VR_ROLE],
    ['no SCRAM password', 'v|', '', VR_FORM],
    ['the read fails', '', 'psql: error: timeout', 'psql: error: timeout'],
  ])('V3-5: %s: AD-UNREAD, nothing changed', async (_n, authid, fail, why) => {
    writeB1();
    botEnvFile(fileUrl(ROLE_PW));
    h.authid = authid; h.authidFail = fail;
    const before = fs.readFileSync(REG_B1, 'utf-8');
    const r = await adoptPromotedReplica(b1());
    expect(r).toEqual({ success: false, error: `Could not recover the fleet database credentials from this instance: the database's password for smdb could not be read (${why}), so the database cannot be adopted; try again` });
    expect(fs.readFileSync(REG_B1, 'utf-8')).toBe(before);
    expect(b1Url()).toBeUndefined();
  });
  it('V3-6: an outside URL in the manager env is rejected, the file\'s accepted', async () => {
    writeB1();
    envManager.setEnvVars('b1', { DATA_BACKEND_URL: 'postgresql://smdb:OUTSIDEPW@db.example.test:5432/smdb' });
    botEnvFile(fileUrl(ROLE_PW));
    const r = await adoptPromotedReplica(b1());
    expect(r.success).toBe(true);
    expect(b1().fleetDb?.password).toBe(ROLE_PW);
    expect(b1Url()).toBe(adoptedUrl(ROLE_PW));
    expect(JSON.stringify(b1().fleetDb)).not.toContain('OUTSIDEPW');
  });
  it('V3-7: a verifier above the iteration bound: VR-ITER, nothing changed', async () => {
    writeB1();
    botEnvFile(fileUrl(ROLE_PW));
    h.authid = `v|${VERIFIER.replace('$4096:', '$2147483647:')}`;
    const before = fs.readFileSync(REG_B1, 'utf-8');
    const r = await adoptPromotedReplica(b1());
    expect(r).toEqual({ success: false, error: `Could not recover the fleet database credentials from this instance: the database's password for smdb could not be checked (${VR_ITER}), so the database cannot be adopted` });
    expect(fs.readFileSync(REG_B1, 'utf-8')).toBe(before);
    expect(b1Url()).toBeUndefined();
  });
});
