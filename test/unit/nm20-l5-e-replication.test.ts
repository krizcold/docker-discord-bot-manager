import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm20-l5-e-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return {
    dir,
    running: 'true' as string,
    cert: '' as string,
    authid: '' as string,
    prov: [] as any[],
    provCalls: [] as Array<{ t: any; opts: any }>,
    confirmed: [] as boolean[],
    runCall: null as null | ((call: any) => any),
    metaOpts: [] as any[],
    save: 'real' as 'real' | 'false' | 'throw',
    storeThrow: false,
  };
});

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const { EventEmitter } = await import('events');
  const { PassThrough } = await import('stream');
  const answer = (text: string): { code: number; out: string; err: string } => {
    if (text.includes('cat /var/lib/postgresql/data/server.crt')) return h.cert ? { code: 0, out: h.cert, err: '' } : { code: 1, out: '', err: 'cat: no such file' };
    if (text.includes("WHERE line LIKE '%")) return { code: 0, out: '0\n', err: '' };
    if (text.includes('FROM pg_roles WHERE rolname')) return { code: 0, out: '1\n', err: '' };
    if (text.includes("current_setting('ssl')")) return { code: 0, out: 'on|||4096MB\n', err: '' };
    if (text.includes("to_regclass('smdb_manager.addresses') IS NULL")) return { code: 0, out: '[]\n', err: '' };
    return { code: 0, out: '', err: '' };
  };
  const execFile = (cmd: string, args: string[], opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    const text = `${cmd} ${args.join(' ')}`;
    setImmediate(() => {
      if (args[0] === 'inspect') return done(null, `${h.running}\n`, '');
      if (args[0] === 'ps') return done(null, '', '');
      if (text.includes('pg_authid')) return done(null, `${h.authid}\n`, '');
      done(null, '', '');
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
      const a = answer(`${args.join(' ')} ${stdin}`);
      child.stdout.end(a.out);
      child.stderr.end(a.err);
      setTimeout(() => child.emit('close', a.code), 1);
    }, 3);
    return child;
  };
  const routed = (await import('./roles-fake')).rolesExecFile(execFile as any, spawn as any, /pg_authid/);
  return { ...real, execFile: routed, spawn, default: { ...real, execFile: routed, spawn } };
});
vi.mock('../../src/instance/dbLogin', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/instance/dbLogin')>();
  return {
    ...real,
    provisionRoles: async (t: any, opts: any) => {
      h.provCalls.push({ t, opts });
      return h.prov.length > 1 ? h.prov.shift() : h.prov[0];
    },
    isRolesConfirmed: () => (h.confirmed.length > 1 ? h.confirmed.shift()! : h.confirmed[0]),
    runCall: (container: string, call: any, ms?: number) => {
      const r = h.runCall?.(call);
      return r ? Promise.resolve(r) : real.runCall(container, call, ms);
    },
    metaPsql: (container: string, db: string, sql: string, opts?: any) => {
      h.metaOpts.push(opts);
      return real.metaPsql(container, db, sql, opts);
    },
  };
});
vi.mock('../../src/docker/containerManager', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/docker/containerManager')>();
  return {
    ...real,
    updateInstanceFleetDbPassword: (id: string, password: string) => {
      if (h.save === 'throw') throw new Error(`write failed near ${password}`);
      if (h.save === 'false') return false;
      return real.updateInstanceFleetDbPassword(id, password);
    },
  };
});
vi.mock('../../src/env/manager', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/env/manager')>();
  return {
    ...real,
    getEnvVars: (id: string) => {
      if (h.storeThrow) throw new Error('EIO: i/o error');
      return real.getEnvVars(id);
    },
  };
});
vi.mock('../../src/casaos/detector', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/casaos/detector')>()),
  getDeploymentMode: async () => 'docker',
}));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

// fleetReplication loads first: dbLogin imports it back, and a module loaded inside dbLogin's mock factory gets the real dbLogin.
import { dropFleetSlot, enableFleetReplication, getJoinCode, provisionManagedRoles, provisionTarget } from '../../src/instance/fleetReplication';
import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';
import * as envManager from '../../src/env/manager';
import { scramSha256Verifier } from '../../src/config/secretText';
import { parseRolesRead } from '../../src/instance/dbLogin';
import { FIXTURE_PEM } from './join-fake';
import { SET_UP_ROLES_READ } from './roles-fake';

const ROLE_PW = 'Db-Secret-0123456789';
const REC_PW = 'Record-Pw-0123456789';
const VERIFIER = scramSha256Verifier(ROLE_PW, Buffer.alloc(16, 7), 4096);
const MANAGED_URL = `postgresql://smdb:${ROLE_PW}@m-fleet-postgres:5432/smdb?sslmode=no-verify`;
const fleetDb = { containerName: 'm-fleet-postgres', user: 'smdb', db: 'smdb', volume: 'm-fleet-postgres-data' };
const replication = () => ({ role: 'replicator', password: 'Repl-Secret-0123456789', hostPort: 15433, publicHost: 'main.invalid', certHost: 'main.invalid', slotWalKeepMb: 4096 });
const REGISTRY = path.join(h.dir, 'instances.json');
const writeRegistry = (extra: Record<string, unknown> = {}): void => {
  fs.writeFileSync(REGISTRY, JSON.stringify({ instances: { m: {
    id: 'm', sanitizedName: 'm', displayName: 'M', titleName: 'M', status: 'running', sourceType: 'git',
    sourceUrl: 'https://example.invalid/fake/super-modular-discord-bot', envVars: { DATA_BACKEND: 'postgres' },
    createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z', ...extra,
  } } }));
};
const bot = () => containerManager.getBot('m')!;
const OK = { ok: true, wrote: [] };
const ADMIN_LEFT = 'the roles did not read back as set (dbm_admin still has a password)';
const JC_ROLES = (why: string) => `The bot's database login could not be confirmed as limited to its own database (${why}), so no join code was made`;
const callText = (call: any) => JSON.stringify(call);

beforeEach(() => {
  h.running = 'true'; h.cert = FIXTURE_PEM; h.authid = `v|${VERIFIER}`;
  h.prov = [OK]; h.provCalls = []; h.confirmed = [true]; h.runCall = null; h.metaOpts = []; h.save = 'real'; h.storeThrow = false;
  for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => {});
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
  fs.mkdirSync(path.join(h.dir, 'bots', 'm', 'env'), { recursive: true });
});
afterEach(() => { vi.restoreAllMocks(); });
afterAll(() => fs.rmSync(h.dir, { recursive: true, force: true }));

describe('provisionTarget: the Database URL passwords are candidates only when no password is recorded', () => {
  it('a recorded password: no candidates, even with a password in the Database URL', () => {
    writeRegistry({ fleetDb: { ...fleetDb, password: REC_PW } });
    envManager.setEnvVars('m', { DATA_BACKEND_URL: MANAGED_URL });
    const t = provisionTarget(bot())!;
    expect(t.password).toBe(REC_PW);
    expect(t.candidates).toEqual([]);
  });
  it('no recorded password: the Database URL password is the candidate', () => {
    writeRegistry({ fleetDb });
    envManager.setEnvVars('m', { DATA_BACKEND_URL: MANAGED_URL });
    const t = provisionTarget(bot())!;
    expect(t.password).toBeNull();
    expect(t.candidates).toEqual([ROLE_PW]);
  });
  it('an env store read that throws gives no candidates', () => {
    writeRegistry({ fleetDb });
    envManager.setEnvVars('m', { DATA_BACKEND_URL: MANAGED_URL });
    h.storeThrow = true;
    expect(provisionTarget(bot())!.candidates).toEqual([]);
  });
});

describe('provisionManagedRoles', () => {
  it('an instance with no managed database is refused with its text', async () => {
    writeRegistry();
    expect(await provisionManagedRoles(bot())).toEqual({ ok: false, cls: 'other', error: 'This instance hosts no managed fleet database' });
    expect(h.provCalls).toEqual([]);
  });
  it('a recorded password skips the fill even while the roles are unconfirmed', async () => {
    writeRegistry({ fleetDb: { ...fleetDb, password: REC_PW } });
    h.confirmed = [false];
    expect(await provisionManagedRoles(bot())).toEqual(OK);
    expect(h.provCalls).toHaveLength(1);
  });
  it('the fill records the URL password and provisions again with it, rereading, with no candidates', async () => {
    writeRegistry({ fleetDb });
    envManager.setEnvVars('m', { DATA_BACKEND_URL: MANAGED_URL });
    h.confirmed = [false];
    expect(await provisionManagedRoles(bot())).toEqual(OK);
    expect(bot().fleetDb?.password).toBe(ROLE_PW);
    expect(h.provCalls).toHaveLength(2);
    expect(h.provCalls[1].t.password).toBe(ROLE_PW);
    expect(h.provCalls[1].t.candidates).toEqual([]);
    expect(h.provCalls[1].opts).toEqual({ reread: true });
  });
  it('a record gone from the registry at the save is named', async () => {
    writeRegistry({ fleetDb });
    envManager.setEnvVars('m', { DATA_BACKEND_URL: MANAGED_URL });
    h.confirmed = [false];
    h.save = 'false';
    expect(await provisionManagedRoles(bot())).toEqual({ ok: false, cls: 'other', rolesSet: true,
      error: "the role smdb was created, but its password could not be recorded (the bot's record is no longer in the registry); it is recorded at the next check" });
  });
  it('a save error is shown without the password', async () => {
    writeRegistry({ fleetDb });
    envManager.setEnvVars('m', { DATA_BACKEND_URL: MANAGED_URL });
    h.confirmed = [false];
    h.save = 'throw';
    const r = await provisionManagedRoles(bot());
    expect(r.ok).toBe(false);
    expect((r as any).error).not.toContain(ROLE_PW);
    expect((r as any).error).toMatch(/^the role smdb was created, but its password could not be recorded \(write failed near .+\); it is recorded at the next check$/);
  });
});

describe('getJoinCode: the roles confirmed after the fill (confirmedAfterFill) and the pending push read', () => {
  const withRepl = (extra: Record<string, unknown> = {}) => writeRegistry({ fleetDb: { ...fleetDb, password: REC_PW, replication: replication(), ...extra } });
  it('unconfirmed after the second provisioning: refused with the admin password text', async () => {
    withRepl();
    h.confirmed = [false];
    expect(await getJoinCode(bot())).toEqual({ success: false, error: JC_ROLES(ADMIN_LEFT) });
    expect(h.provCalls).toHaveLength(2);
  });
  it('confirmed after the second provisioning: the code is made, and that provisioning rereads', async () => {
    withRepl();
    h.confirmed = [false, true];
    const r = await getJoinCode(bot());
    expect(r.success).toBe(true);
    expect(h.provCalls).toHaveLength(2);
    expect(h.provCalls[1].opts).toEqual({ reread: true });
  });
  it('the second provisioning failing: its own error, not the admin password text', async () => {
    withRepl();
    h.confirmed = [false];
    h.prov = [OK, { ok: false, cls: 'other', error: 'the roles could not be written' }];
    expect(await getJoinCode(bot())).toEqual({ success: false, error: JC_ROLES('the roles could not be written') });
  });
  describe('a push left unfinished (Receive\'s own code)', () => {
    const pending = () => withRepl({ pushBroken: { at: '2026-11-01T00:00:00.000Z', safetyDump: 'safety.dump' } });
    const rolesRead = (answer: any) => { h.runCall = call => (callText(call).includes('pg_is_in_recovery') ? answer : null); };
    it('reads the roles only: no provisioning, even while unconfirmed', async () => {
      pending();
      h.confirmed = [false];
      expect(parseRolesRead(`${SET_UP_ROLES_READ}\n`)).not.toBeNull();
      rolesRead({ ok: true, stdout: `${SET_UP_ROLES_READ}\n`, stderr: '' });
      expect((await getJoinCode(bot(), { forReceive: true })).success).toBe(true);
      expect(h.provCalls).toEqual([]);
    });
    it('a failed read is named', async () => {
      pending();
      rolesRead({ ok: false, stdout: '', stderr: 'x', error: 'psql: connection refused' });
      expect(await getJoinCode(bot(), { forReceive: true })).toEqual({ success: false, error: JC_ROLES('reading the roles failed (psql: connection refused)') });
    });
    it('an unreadable answer is shown trimmed and cut at 200 characters', async () => {
      pending();
      rolesRead({ ok: true, stdout: `  ${'x'.repeat(300)}\n`, stderr: '' });
      expect(await getJoinCode(bot(), { forReceive: true })).toEqual({ success: false, error: JC_ROLES(`the database's roles read back as ${'x'.repeat(200)}`) });
    });
    it('a database in recovery makes no code', async () => {
      pending();
      const recovery = `true${SET_UP_ROLES_READ.slice('false'.length)}`;
      expect(parseRolesRead(recovery)?.recovery).toBe(true);
      rolesRead({ ok: true, stdout: `${recovery}\n`, stderr: '' });
      expect(await getJoinCode(bot(), { forReceive: true })).toEqual({ success: false, error: "This database is a live copy, so it makes no join code; copy the code from the main's manager" });
    });
  });
});

describe('enableFleetReplication', () => {
  it('passes the caller\'s password to the fill of the first provisioning', async () => {
    writeRegistry({ fleetDb });
    h.confirmed = [false];
    const r = await enableFleetReplication(bot(), 'main.invalid', 15432, undefined, { dbPassword: ROLE_PW });
    expect(r).toEqual({ success: false, error: `Enable was refused: the database's roles could not be set up (${ADMIN_LEFT}); replication was not set up` });
    expect(bot().fleetDb?.password).toBe(ROLE_PW);
  });
  it('a failed read of the clients without TLS refuses with its text', async () => {
    writeRegistry({ fleetDb: { ...fleetDb, password: REC_PW } });
    h.runCall = call => (callText(call).includes('pg_stat_ssl') ? { ok: false, stdout: '', stderr: 'ERROR:  permission denied\n', error: 'psql failed' } : null);
    expect(await enableFleetReplication(bot(), 'main.invalid', 15432)).toEqual({ success: false,
      error: 'could not read which clients connect without TLS (replication was not set up): ERROR:  permission denied' });
  });
});

describe('dropFleetSlot: the error psql printed', () => {
  const SLOT = 'fleet_standby_a1';
  const dropFails = (stderr: string) => {
    h.runCall = call => (callText(call).includes('pg_drop_replication_slot') ? { ok: false, stdout: '', stderr, error: 'x' } : null);
  };
  beforeEach(() => writeRegistry({ fleetDb: { ...fleetDb, password: REC_PW, replication: replication() } }));
  it.each([
    ['the ERROR line, not a NOTICE before it', 'NOTICE:  checking\nERROR:  no slot named fleet_standby_a1\n', 'no slot named fleet_standby_a1'],
    ['the last line when none starts with ERROR', 'psql: warning: the server is old\n', 'psql: warning: the server is old'],
    ['the last line kept whole when ERROR: is inside it', 'FATAL:  the reply said ERROR: denied', 'FATAL:  the reply said ERROR: denied'],
    ['psql failed when nothing was printed', '', 'psql failed'],
  ])('%s', async (_n, stderr, error) => {
    dropFails(stderr);
    expect(await dropFleetSlot(bot(), SLOT)).toEqual({ success: false, error });
  });
  it('the address row is removed as dbm_meta with the SQL as an argument, not on stdin', async () => {
    expect(await dropFleetSlot(bot(), SLOT)).toEqual({ success: true });
    expect(h.metaOpts).toEqual([{ stdin: false }]);
  });
});
