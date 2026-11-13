import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm14-l5-lanes-'));
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
    noAppEnvFile: false,
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
vi.mock('../../src/config/appCapabilities', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/config/appCapabilities')>();
  return {
    ...real,
    findAppCapabilities: (url: string | null | undefined) => {
      const m = real.findAppCapabilities(url);
      return m && h.noAppEnvFile && m.companionDb ? { ...m, companionDb: { ...m.companionDb, appEnvFile: undefined } } : m;
    },
  };
});

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as containerManager from '../../src/docker/containerManager';
import * as envManager from '../../src/env/manager';
import { decodeJoinCode } from '../../src/config/joinCode';
import { scramSha256Verifier, verifierAccepts } from '../../src/config/secretText';
import { disableFleetReplication, enableFleetReplication, fleetDbShape, getFleetReplicationStatus, getJoinCode } from '../../src/instance/fleetReplication';
import { composeJoinCode } from '../../src/instance/fleetSwitch';
import { adoptPromotedReplica, fleetDbPasswordFallback } from '../../src/instance/fleetReplica';
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
  h.exec = 'f|||\n'; h.runs = []; h.openssl = 0; h.onText = null; h.refuseSave = false; h.noAppEnvFile = false;
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

describe('L5: the registry boundary', () => {
  it('an update token that no longer decrypts is logged with the default next step', () => {
    writeRegistry({ updateToken: BAD_BLOB, fleetDb: record('present') });
    bot();
    expect(logs).toContain('[ContainerManager] updateToken for instance m no longer decrypts (encryption key changed or lost); its ciphertext stays preserved in the registry - restore the key, or re-provision the value');
  });
});

describe('L5: the fill and the probe', () => {
  it('a URL with its password as a parameter and no host is a candidate', async () => {
    writeRegistry({ fleetDb: record('absent', { replication: replication() }) });
    setUrl(`postgresql:///smdb?password=${ROLE_PW}`);
    const r = await getJoinCode(bot());
    expect(r.success).toBe(true);
    expect(bot().fleetDb?.password).toBe(ROLE_PW);
  });
  it('a record changed while Disable revokes the login: the refusal, nothing written', async () => {
    writeRegistry({ fleetDb: record('present', { replication: replication() }) });
    setUrl(sidecar(REC_PW));
    h.onText = (text) => { if (text.includes('ALTER ROLE replicator NOLOGIN')) editRecord(db => { db.retiringAt = '2026-11-12T00:00:00.000Z'; }); };
    const ds = await disableFleetReplication(bot());
    expect(ds).toEqual({ success: false, error: "The instance's database record changed while this Disable ran, so the record and the database URL were not written; the slots are dropped and the replication login is revoked. Check the Replication section, then press Disable replication again to finish it" });
    expect(rawRecord().replication).toBeDefined();
  });
  it('a kept unchecked answer stays unchecked and gives its age in seconds', async () => {
    writeRegistry({ fleetDb: record('absent', { replication: replication() }) });
    const t0 = Date.now();
    const now = vi.spyOn(Date, 'now').mockReturnValue(t0);
    expect((await getFleetReplicationStatus(bot())).reachability).toEqual({ ok: false, unchecked: true, error: PE_ABSENT(FILL_NOURL), ageSeconds: 0 });
    now.mockReturnValue(t0 + 5000);
    expect((await getFleetReplicationStatus(bot())).reachability).toEqual({ ok: false, unchecked: true, error: PE_ABSENT(FILL_NOURL), ageSeconds: 5 });
  });
});

describe('L5: the adopt\'s candidates', () => {
  const REPLICA = {
    containerName: 'bot1-fleet-postgres-replica', volume: 'bot1-fleet-postgres-replica-data', slot: 'fleet_standby_b1',
    primaryHost: 'primary.invalid', primaryPort: 5433, publicHost: 'standby.invalid', hostPort: 5440, certHost: 'standby.invalid',
    user: 'smdb', db: 'smdb',
  };
  const writeB1 = () => fs.writeFileSync(REGISTRY, JSON.stringify({ instances: { b1: {
    id: 'b1', sanitizedName: 'bot1', displayName: 'Bot 1', titleName: 'Bot 1', status: 'running', sourceType: 'git',
    sourceUrl: 'https://example.invalid/fake/super-modular-discord-bot', envVars: { DATA_BACKEND: 'postgres' },
    createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z', fleetDbReplica: { ...REPLICA },
  } } }));
  const b1 = () => containerManager.getBot('b1')!;
  const botEnv = (text: string) => {
    fs.mkdirSync(path.join(h.dir, 'bots', 'b1', 'data'), { recursive: true });
    fs.writeFileSync(path.join(h.dir, 'bots', 'b1', 'data', '.env'), text);
  };
  const fileUrl = (pw: string) => `postgresql://smdb:${pw}@bot1-fleet-postgres:5432/smdb`;

  it('a URL line with no password is passed over for a later one', async () => {
    writeB1();
    botEnv(`DATA_BACKEND_URL=postgresql://smdb@bot1-fleet-postgres:5432/smdb\nDATA_BACKEND_URL=${fileUrl(ROLE_PW)}\n`);
    const r = await adoptPromotedReplica(b1());
    expect(r.success).toBe(true);
    expect(b1().fleetDb?.password).toBe(ROLE_PW);
  });
  it('a URL naming another database is still tried', async () => {
    writeB1();
    botEnv(`DATA_BACKEND_URL=postgresql://smdb:${ROLE_PW}@elsewhere.invalid:5432/smdb\n`);
    const r = await adoptPromotedReplica(b1());
    expect(r.success).toBe(true);
    expect(b1().fleetDb?.password).toBe(ROLE_PW);
  });
  it('the fallback reads the bot env file\'s password', async () => {
    writeB1();
    botEnv(`DATA_BACKEND_URL=${fileUrl(ROLE_PW)}\n`);
    expect(await fleetDbPasswordFallback(b1())).toBe(ROLE_PW);
  });
  it('an app with no env file declared: the refusal says so', async () => {
    writeB1();
    h.noAppEnvFile = true;
    const r = await adoptPromotedReplica(b1());
    expect(r).toEqual({ success: false, error: 'Could not recover the fleet database credentials from this instance (no join code is kept, and neither the manager env nor no app env file is declared carries a database URL with a password), so the database cannot be adopted' });
  });
});
