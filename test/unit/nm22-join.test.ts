import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm22-join-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir, loginWriteFail: '', loginWrites: [] as unknown[], order: [] as string[] };
});

vi.mock('child_process', async (importOriginal) => (await import('./join-fake')).childProcessMock(await importOriginal<typeof import('child_process')>()));
vi.mock('../../src/casaos/detector', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/casaos/detector')>()),
  getDeploymentMode: async () => 'docker',
}));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));
vi.mock('../../src/docker/dockerClient', async (importOriginal) => {
  const { docker } = await import('./join-fake');
  return { ...(await importOriginal<typeof import('../../src/docker/dockerClient')>()), volumeState: () => (docker.volumeExists ? 'exists' : 'absent') };
});
vi.mock('../../src/docker/containerManager', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/docker/containerManager')>();
  const { docker } = await import('./join-fake');
  return {
    ...real,
    deployedComposeExists: () => true,
    markPendingApplyIfRunning: async () => undefined,
    applyFleetDbReplicaService: async () => { docker.events.push('apply'); docker.running = 'true'; return { success: true }; },
    removeFleetDbReplicaService: async () => { docker.events.push('service-out'); docker.running = 'false'; return { success: true }; },
    updateInstanceFleetLogin: (id: string, login: any) => {
      h.loginWrites.push(login);
      h.order.push('save');
      if (h.loginWriteFail) throw new Error(h.loginWriteFail);
      return (real as any).updateInstanceFleetLogin(id, login);
    },
  };
});

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';
import { verifierAccepts } from '../../src/config/secretText';
import * as fleetJoin from '../../src/instance/fleetJoin';
import { certSource, joinFleet, mainProbe, peerProbe, primarySql, refreshJoin, registerOwnCopy, seedDsnFor } from '../../src/instance/fleetJoin';
import { computeVerdict } from '../../src/instance/fleetCopyWatch';
import { COPY_SESSION_OPTIONS } from '../../src/instance/dbLogin';
import { copyLogin, copySlot } from '../../src/instance/switchSql';
import { getFleetReplicaStatus, provisionFleetReplica, reseedStandby, startAutoRebuild } from '../../src/instance/fleetReplica';
import { decodeJoinCode } from '../../src/config/joinCode';
import { createBotRoutes } from '../../src/webui/routes/bots';
import { docker, fakeJoin, fakeJoinCode, fakeJoinRecord, FIXTURE_FP, FIXTURE_PEM, resetDocker } from './join-fake';

const fj = fleetJoin as any;
const SMDB = 'https://example.invalid/fake/super-modular-discord-bot';
const REGISTRY = path.join(h.dir, 'instances.json');
const ID = '0f1e2d3c-4b5a-4968-8776-655443322110';
const LOGIN = 'smdb_copy_0f1e2d3c4b5a49688776655443322110';
const OTHER = 'smdb_copy_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const OWN_PW = 'Own-Machine-Secret-01';
const JOIN_PW = 'replpass';
const REPLICA = {
  containerName: 'b-fleet-postgres-replica', volume: 'b-fleet-postgres-replica-data', slot: `fleet_standby_${LOGIN.slice(10)}`,
  primaryHost: 'main.invalid', primaryPort: 15432, publicHost: 'copy.invalid', hostPort: 15433, certHost: 'copy.invalid',
  user: 'smdb', db: 'smdb', seededAt: 1,
};
const base = (over: Record<string, unknown> = {}) => ({
  id: ID, sanitizedName: 'b', displayName: 'B', titleName: 'B', status: 'running', sourceType: 'git', sourceUrl: SMDB,
  envVars: { DATA_BACKEND: 'postgres' }, createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z', ...over,
});
/** Writes the registry as the real writer stores it: through updateInstanceFleetLogin, so the password is encrypted. */
const writeRegistry = (over: Record<string, unknown> = {}, password: string | null = OWN_PW) => {
  fs.writeFileSync(REGISTRY, JSON.stringify({ instances: { [ID]: base(over) } }, null, 2));
  if (password !== null) (containerManager as any).updateInstanceFleetLogin(ID, { password });
  h.loginWrites = [];
  h.order = [];
};
const bot = () => containerManager.getBot(ID)!;
const stored = () => JSON.parse(fs.readFileSync(REGISTRY, 'utf-8')).instances[ID];
const mintCall = () => docker.spawns.find(s => s.stdin.includes('add_copy_login'));
const probeCall = () => docker.spawns.find(s => s.args.join(' ').includes('IDENTIFY_SYSTEM'));
const runOrder = () => docker.spawns.map(s => (s.stdin.includes('add_copy_login') ? 'mint' : s.args.join(' ').includes('IDENTIFY_SYSTEM') ? 'probe' : 'other'));
const dsnUser = (dsn: string) => decodeURIComponent(new URL(dsn).username);

const PROBE_REFUSED = `psql: error: connection to server at "main.invalid" (192.0.2.10), port 15432 failed: FATAL:  password authentication failed for user "${LOGIN}"`;
const PROBE_REASON = `connection to server at "main.invalid" (192.0.2.10), port 15432 failed: FATAL:  password authentication failed for user "${LOGIN}"`;
const MINT_REFUSED = 'psql: error: connection to server at "main.invalid" (192.0.2.10), port 15432 failed: FATAL:  password authentication failed for user "smdb_join"';
const MINT_REFUSED_REASON = 'connection to server at "main.invalid" (192.0.2.10), port 15432 failed: FATAL:  password authentication failed for user "smdb_join"';
const CAP = "this database already has 100 machine logins; remove the ones no longer used in the main's Database window";
const MINT_CAP = `psql:<stdin>:2: ERROR:  smdb-join: ${CAP}\nCONTEXT:  PL/pgSQL function smdb_manager.add_copy_login(text,text) line 14 at RAISE`;
const MINT_NOFN = 'psql:<stdin>:2: ERROR:  schema "smdb_manager" does not exist\nLINE 1: SELECT smdb_manager.add_copy_login($1, $2);\n               ^';
const NO_OWN_LOGIN = "this machine's own login to the main is not stored; press Re-seed (or Join, on a machine without a copy) to get a new one; if the main still has this machine's earlier login, the answer names it";

const JOIN_TAKEN = (reason: string) => `The main at main.invalid:15432 already has a login for this machine (${LOGIN}), and it refused this manager's password for it (${reason}); nothing was changed. In the main's Database window, remove the login ${LOGIN}, then join again.`;
const JOIN_BLOCKED = `The main at main.invalid:15432 has a login for this machine (${LOGIN}), but the main blocked it: a Remove there did not finish, or the main found it streaming on another machine's slot. Nothing was changed. In the main's Database window, remove the login ${LOGIN}, then join again.`;
const JOIN_CODE_OLD = (reason: string) => `The main at main.invalid:15432 refused the join code's login (${reason}), and it has no login for this machine that opens with this manager's password; nothing was changed. Copy a new join code from the main's manager.`;
const JOIN_MINT = (reason: string) => `The main at main.invalid:15432 could not make a login for this machine (${reason}); nothing was changed.`;
const LOGIN_REFUSED = (reason: string) => `The main at main.invalid:15432 refused this machine's login (${reason}); nothing was changed. Replication may have been disabled there, or the main's operator removed this machine's login: join again with the main's current join code.`;
const JOIN_SAVE = (error: string) => `The password of this machine's own login to the main could not be saved (${error}); nothing was changed.`;
const ADDR_TAKEN = `its address copy.invalid:15433 is listed on the main for the machine login ${OTHER}. If no machine uses that address under that login any more, remove the login ${OTHER} in the main's Database window; this machine then adds its address at its next hourly check`;
const ADDR_TAKEN_MAIN = "its address copy.invalid:15433 is listed on the main as the main's own address. If that is the main's current address, give this copy another one; otherwise the main's operator presses Enable replication there, which keeps only the main's current entry";

const realFetch = certSource.fetch;
let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  resetDocker();
  h.loginWriteFail = '';
  certSource.fetch = async () => ({ ok: true, pem: FIXTURE_PEM, fp: FIXTURE_FP });
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
  fs.mkdirSync(path.join(h.dir, 'bots', ID, 'env'), { recursive: true });
  writeRegistry();
  warn = vi.spyOn(console, 'warn');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
afterAll(() => {
  certSource.fetch = realFetch;
  fs.rmSync(h.dir, { recursive: true, force: true });
});

describe('seedDsnFor (R1 as R18 and R33 amend it)', () => {
  it('asks for scram once and carries COPY_SESSION_OPTIONS as its options', () => {
    const dsn = seedDsnFor({ user: 'u s', password: 'pw', host: 'h.invalid', port: 5433, db: 'd' });
    expect(dsn.startsWith('postgresql://u%20s@h.invalid:5433/d?sslmode=verify-full&sslrootcert=/primary-ca.crt&require_auth=scram-sha-256&options=')).toBe(true);
    const params = new URL(dsn).searchParams;
    expect(params.getAll('require_auth')).toEqual(['scram-sha-256']);
    expect(params.getAll('options')).toEqual([COPY_SESSION_OPTIONS]);
    expect(dsn).not.toContain('pw');
  });
});

describe('O1 ensureCopyLogin through Join (L1 to L18, L24, L25)', () => {
  it('L1: no stored password: a new one is generated and saved encrypted before the mint, then the probe', async () => {
    writeRegistry({}, null);
    const r = await joinFleet(bot(), fakeJoinCode());
    expect(r.success).toBe(true);
    const pw = bot().fleetLogin!.password;
    expect(pw).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(stored().fleetLogin.password.startsWith('v2:')).toBe(true);
    expect(stored().fleetLogin.password).not.toContain(pw);
    expect(h.order[0]).toBe('save');
    expect(runOrder().filter(x => x !== 'other').slice(0, 2)).toEqual(['mint', 'probe']);
    expect(await verifierAccepts(mintCall()!.env.SMDB_COPY_VERIFIER!, pw, LOGIN)).toBe(true);
    const read = docker.spawns.find(s => s.args.join(' ').includes('FROM smdb_manager.addresses a'))!;
    expect(read.env.PGPASSWORD).toBe(pw);
    expect((r as { message: string }).message).not.toContain('could not be read');
  });

  it('L1: the mint runs as the join login on postgres; the verifier and both passwords are in no argv element', async () => {
    writeRegistry({}, null);
    await joinFleet(bot(), fakeJoinCode());
    const pw = bot().fleetLogin!.password;
    const mint = mintCall()!;
    const dsn = mint.args[mint.args.length - 2];
    expect(mint.args).toEqual(['run', '--rm', '-i', '--name', 'b-fleet-join-login', '-e', 'PGPASSWORD', '-e', 'SMDB_COPY_VERIFIER',
      '-v', expect.stringMatching(/fleet-join\/[0-9a-f]{16}\.crt:\/primary-ca\.crt:ro$/), '--entrypoint', 'sh', 'postgres:16-alpine',
      '-c', 'psql "$1" -v ON_ERROR_STOP=1 -qAt -v name="$2" -f -', 'sh', dsn, LOGIN]);
    expect(dsnUser(dsn)).toBe('replicator');
    expect(new URL(dsn).pathname).toBe('/postgres');
    expect(mint.stdin).toBe("\\getenv v SMDB_COPY_VERIFIER\nSELECT smdb_manager.add_copy_login(:'name', :'v');\n");
    expect(mint.env.PGPASSWORD).toBe(JOIN_PW);
    expect(mint.env.SMDB_COPY_VERIFIER).toMatch(/^SCRAM-SHA-256\$4096:/);
    for (const a of mint.args) {
      expect(a).not.toContain(pw);
      expect(a).not.toContain(JOIN_PW);
      expect(a).not.toContain(mint.env.SMDB_COPY_VERIFIER!);
    }
  });

  it('L25: the mint session carries COPY_SESSION_OPTIONS, which outrank the join login\'s own settings', async () => {
    await joinFleet(bot(), fakeJoinCode());
    const mint = mintCall()!;
    expect(new URL(mint.args[mint.args.length - 2]).searchParams.get('options')).toBe(COPY_SESSION_OPTIONS);
  });

  it('L2: the save fails: JOIN-SAVE, and no mint or probe ran', async () => {
    writeRegistry({}, null);
    h.loginWriteFail = 'ENOSPC: no space left on device';
    const before = fs.readFileSync(REGISTRY, 'utf-8');
    const r = await joinFleet(bot(), fakeJoinCode());
    expect(r).toEqual({ success: false, error: JOIN_SAVE('ENOSPC: no space left on device') });
    expect(docker.events).not.toContain('mint');
    expect(docker.events).not.toContain('main-probe');
    expect(fs.readFileSync(REGISTRY, 'utf-8')).toBe(before);
  });

  it('L3 and L4: a stored password is reused, nothing is saved, and the mint carries its verifier', async () => {
    const r = await joinFleet(bot(), fakeJoinCode());
    expect(r.success).toBe(true);
    expect(h.loginWrites).toEqual([]);
    expect(bot().fleetLogin!.password).toBe(OWN_PW);
    expect(await verifierAccepts(mintCall()!.env.SMDB_COPY_VERIFIER!, OWN_PW, LOGIN)).toBe(true);
    expect(probeCall()!.env.PGPASSWORD).toBe(OWN_PW);
    expect(dsnUser(probeCall()!.args[probeCall()!.args.length - 2])).toBe(LOGIN);
  });

  it('L5: a composed code (its repl user is a machine login) mints nothing', async () => {
    const r = await joinFleet(bot(), fakeJoinCode({ repl: { user: OTHER, password: 'x' } }));
    expect(r.success).toBe(true);
    expect(docker.events).not.toContain('mint');
    expect(docker.events).toContain('main-probe');
  });

  it.each([
    ['L6 created', { out: 'created', fail: '' }],
    ['L7 failed, the probe decides', { out: '', fail: MINT_CAP }],
    ['L8 and L9 exists', { out: 'exists', fail: '' }],
    ['L10 the join login refused', { out: '', fail: MINT_REFUSED }],
  ])('%s, and the machine login works: joined (L11)', async (_n, mint) => {
    docker.mint = mint;
    const r = await joinFleet(bot(), fakeJoinCode());
    expect(r.success).toBe(true);
    expect(runOrder().filter(x => x !== 'other').slice(0, 2)).toEqual(['mint', 'probe']);
    expect(bot().fleetJoin).toMatchObject({ host: 'main.invalid', port: 15432 });
  });

  it.each([
    ['L12 exists: JOIN-TAKEN with the probe reason', { out: 'exists', fail: '' }, JOIN_TAKEN(PROBE_REASON)],
    ['L13 the join login refused: JOIN-CODE-OLD with the mint reason', { out: '', fail: MINT_REFUSED }, JOIN_CODE_OLD(MINT_REFUSED_REASON)],
    ['L14 failed: JOIN-MINT with the reason, smdb-join cut', { out: '', fail: MINT_CAP }, JOIN_MINT(CAP)],
    ['L14 failed for another reason', { out: '', fail: MINT_NOFN }, JOIN_MINT('psql:<stdin>:2: ERROR:  schema "smdb_manager" does not exist')],
    ['L15 created: loginRefusedText', { out: 'created', fail: '' }, LOGIN_REFUSED(PROBE_REASON)],
  ])('%s', async (_n, mint, text) => {
    docker.mint = mint;
    docker.main.fail = PROBE_REFUSED;
    const before = fs.readFileSync(REGISTRY, 'utf-8');
    const r = await joinFleet(bot(), fakeJoinCode());
    expect(r).toEqual({ success: false, error: text });
    expect(fs.readFileSync(REGISTRY, 'utf-8')).toBe(before);
  });

  it('L15 for a composed code: skipped gives loginRefusedText', async () => {
    docker.main.fail = PROBE_REFUSED;
    const r = await joinFleet(bot(), fakeJoinCode({ repl: { user: OTHER, password: 'x' } }));
    expect(r).toEqual({ success: false, error: LOGIN_REFUSED(PROBE_REASON) });
  });

  it('a probe failure that is not a refused login keeps today\'s text', async () => {
    docker.main.fail = 'psql: error: connection to server at "main.invalid" (192.0.2.10), port 15432 failed: Connection refused';
    const r = await joinFleet(bot(), fakeJoinCode());
    expect(r.success).toBe(false);
    expect((r as any).error).toMatch(/^Can't reach the main at main\.invalid:15432 \(connection to server/);
  });

  it('L16: a password that no longer decrypts is replaced and saved; an existing login then gives JOIN-TAKEN', async () => {
    const raw = JSON.parse(fs.readFileSync(REGISTRY, 'utf-8'));
    raw.instances[ID].fleetLogin = { password: 'v2:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' };
    fs.writeFileSync(REGISTRY, JSON.stringify(raw));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    docker.mint = { out: 'exists', fail: '' };
    docker.main.fail = PROBE_REFUSED;
    const r = await joinFleet(containerManager.getBot(ID)!, fakeJoinCode());
    expect(errors.mock.calls.map(c => String(c[0]))).toContain(`[ContainerManager] fleetLogin.password for instance ${ID} no longer decrypts (encryption key changed or lost); its ciphertext stays preserved in the registry - restore the key; a Join or Re-seed instead makes a new password, which the main accepts only after its operator removes this machine's login there`);
    expect(r).toEqual({ success: false, error: JOIN_TAKEN(PROBE_REASON) });
    expect(h.loginWrites).toHaveLength(1);
    const pw = (h.loginWrites[0] as { password: string }).password;
    expect(pw).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(stored().fleetLogin.password.startsWith('v2:')).toBe(true);
    expect(stored().fleetLogin.password).not.toBe('v2:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
  });

  it('L24: the mint answers blocked: JOIN-BLOCKED, no probe, nothing saved but step 1\'s password', async () => {
    writeRegistry({}, null);
    docker.mint = { out: 'blocked', fail: '' };
    const r = await joinFleet(bot(), fakeJoinCode());
    expect(r).toEqual({ success: false, error: JOIN_BLOCKED });
    expect(docker.events).not.toContain('main-probe');
    expect(h.loginWrites).toHaveLength(1);
    expect(bot().fleetJoin).toBeUndefined();
  });

  it('L17 and L18: the hourly refresh mints nothing, saves no password, and keeps today\'s refused-login text', async () => {
    writeRegistry({ fleetJoin: fakeJoinRecord() });
    docker.main.fail = PROBE_REFUSED;
    await refreshJoin(bot());
    expect(docker.events).not.toContain('mint');
    expect(h.loginWrites).toEqual([]);
    expect(bot().fleetJoin!.addressesError).toBe(LOGIN_REFUSED(PROBE_REASON));
    expect(probeCall()!.env.PGPASSWORD).toBe(OWN_PW);
  });
});

describe('the mint\'s time limit and stderr (L26, L27)', () => {
  it('L26: a mint that ends on its time limit gives JOIN-MINT naming the main', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    docker.hang = ['mint'];
    docker.main.fail = PROBE_REFUSED;
    const p = joinFleet(bot(), fakeJoinCode());
    await vi.advanceTimersByTimeAsync(61_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await p).toEqual({ success: false, error: JOIN_MINT('the database at main.invalid:15432 did not answer within 60 seconds') });
  });

  it.each([
    ['a WARNING before the ERROR gives the ERROR line', `WARNING:  permission denied to set parameter "plpgsql.variable_conflict"\n${MINT_CAP}`, CAP],
    ['only a WARNING gives psql failed', 'WARNING:  permission denied to set parameter "plpgsql.variable_conflict"', 'psql failed'],
    ['a prefixed WARNING is skipped too', 'psql:<stdin>:2: WARNING:  something\n', 'psql failed'],
  ])('L27: %s', async (_n, stderr, reason) => {
    docker.mint = { out: '', fail: stderr };
    docker.main.fail = PROBE_REFUSED;
    expect(await joinFleet(bot(), fakeJoinCode())).toEqual({ success: false, error: JOIN_MINT(reason) });
  });
});

describe('the probers with no stored password (L21)', () => {
  it('mainProbe answers nologin, peerProbe unanswered, primarySql the text; no docker call', async () => {
    writeRegistry({}, null);
    const code = fakeJoin();
    expect(await mainProbe(bot(), code, FIXTURE_PEM)).toEqual({ ok: false, kind: 'nologin', reason: NO_OWN_LOGIN });
    expect(await peerProbe(bot(), code, FIXTURE_PEM)).toEqual({ kind: 'unreachable', reason: NO_OWN_LOGIN });
    expect(await primarySql(bot(), code, FIXTURE_PEM, 'list', 'SELECT 1')).toEqual({ ok: false, stdout: '', stderr: NO_OWN_LOGIN });
    expect(docker.calls).toEqual([]);
  });

  it('an empty stored password counts as none', async () => {
    writeRegistry({}, null);
    const inst = { ...bot(), fleetLogin: { password: '' } };
    expect(await mainProbe(inst, fakeJoin(), FIXTURE_PEM)).toEqual({ ok: false, kind: 'nologin', reason: NO_OWN_LOGIN });
    expect(docker.calls).toEqual([]);
  });

  it('the copy watcher treats nologin as an unanswered main and rebuilds nothing', async () => {
    writeRegistry({ fleetJoin: fakeJoinRecord(), fleetDbReplica: { ...REPLICA, copyCleared: true } }, null);
    const v = await computeVerdict(bot(), Date.now());
    expect(v).toEqual({ kind: 'unknown', reason: NO_OWN_LOGIN });
    expect(docker.events).not.toContain('main-probe');
  });

  it('the hourly refresh records the text and keeps the list', async () => {
    writeRegistry({ fleetJoin: fakeJoinRecord({ addresses: [] }) }, null);
    await refreshJoin(bot());
    expect(bot().fleetJoin!.addressesError).toBe("This machine's own login to the main is not stored; press Re-seed (or Join, on a machine without a copy) to get a new one; if the main still has this machine's earlier login, the answer names it.");
    expect(docker.spawns).toEqual([]);
  });
});

describe('the probes and reads run as this machine\'s login', () => {
  it('mainProbe, peerProbe and primarySql use copyLogin(id) and the stored password', async () => {
    const code = fakeJoin();
    await mainProbe(bot(), code, FIXTURE_PEM);
    await peerProbe(bot(), code, FIXTURE_PEM);
    await primarySql(bot(), code, FIXTURE_PEM, 'list', 'SELECT 1');
    expect(docker.spawns).toHaveLength(3);
    for (const s of docker.spawns) {
      expect(s.env.PGPASSWORD).toBe(OWN_PW);
      const dsns = s.args.filter(a => a.startsWith('postgresql://'));
      expect(dsns.length).toBeGreaterThan(0);
      for (const d of dsns) expect(dsnUser(d)).toBe(copyLogin(ID));
    }
  });

  it('R44: a peerProbe that ends on its time limit names the copy it went to', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    docker.hang = ['main-probe'];
    const p = peerProbe(bot(), fakeJoin({ host: 'copy.invalid', port: 15433 }), FIXTURE_PEM);
    await vi.advanceTimersByTimeAsync(61_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await p).toEqual({ kind: 'unreachable', reason: 'the database at copy.invalid:15433 did not answer within 60 seconds' });
  });
});

describe('the address row (O3 R1, R2, R8; O2 S6, S8 at fj:696 and fj:827)', () => {
  it('R1: registerOwnCopy sends set_copy_address as this machine\'s login, with no slot', async () => {
    writeRegistry({ fleetJoin: fakeJoinRecord(), fleetDbReplica: REPLICA });
    expect(await registerOwnCopy(bot(), FIXTURE_PEM)).toBeNull();
    const reg = docker.spawns.find(s => s.args.join(' ').includes('set_copy_address'))!;
    const sql = reg.args[reg.args.length - 1];
    expect(sql.startsWith("SELECT smdb_manager.set_copy_address('copy.invalid', 15433, '-----BEGIN CERTIFICATE-----")).toBe(true);
    expect(sql.endsWith("-----END CERTIFICATE-----', 'copy.invalid');")).toBe(true);
    expect(sql).not.toContain('fleet_standby');
    expect(reg.env.PGPASSWORD).toBe(OWN_PW);
    expect(dsnUser(reg.args.find(a => a.startsWith('postgresql://'))!)).toBe(LOGIN);
  });

  it('R8: deleteAddress sends drop_copy_address() as this machine\'s login', async () => {
    expect(await fj.deleteAddress(bot(), fakeJoin(), FIXTURE_PEM)).toBeNull();
    const del = docker.spawns.find(s => s.args.join(' ').includes('drop_copy_address'))!;
    expect(del.args[del.args.length - 1]).toBe('SELECT smdb_manager.drop_copy_address();');
    expect(del.env.PGPASSWORD).toBe(OWN_PW);
  });

  it.each([
    ['S6 / R2: another machine\'s row', `ERROR:  smdb-address-taken: copy.invalid:15433 is listed with the slot fleet_standby_${OTHER.slice(10)}\nCONTEXT:  PL/pgSQL function smdb_manager.set_copy_address(text,integer,text,text) line 28 at RAISE`, ADDR_TAKEN],
    ['S8: the main\'s own row', "ERROR:  smdb-address-taken: copy.invalid:15433 is listed as the main's own address\nCONTEXT:  PL/pgSQL function smdb_manager.set_copy_address(text,integer,text,text) line 27 at RAISE", ADDR_TAKEN_MAIN],
  ])('%s: Join logs ADDR-TAKEN at fj:696 and the refresh at fj:827', async (_n, stderr, text) => {
    writeRegistry({ fleetJoin: fakeJoinRecord(), fleetDbReplica: REPLICA });
    docker.registerFail = stderr;
    expect(await registerOwnCopy(bot(), FIXTURE_PEM)).toBe(text);
    const r = await joinFleet(bot(), fakeJoinCode());
    expect(r.success).toBe(true);
    await refreshJoin(bot());
    const lines = warn.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(lines.filter((l: string) => l === `[FleetCopy] B: the copy's address could not be added to the main's list: ${text}`)).toHaveLength(2);
    for (const l of lines) expect(l).not.toContain('every hour');
  });

  it('a slot that is not a machine\'s slot is named as it is', async () => {
    writeRegistry({ fleetJoin: fakeJoinRecord(), fleetDbReplica: REPLICA });
    docker.registerFail = 'ERROR:  smdb-address-taken: copy.invalid:15433 is listed with the slot handmade_slot';
    expect(await registerOwnCopy(bot(), FIXTURE_PEM)).toBe('its address copy.invalid:15433 is listed on the main for the machine login handmade_slot. If no machine uses that address under that login any more, remove the login handmade_slot in the main\'s Database window; this machine then adds its address at its next hourly check');
  });
});

/** Every word directly before '(' outside a string literal (R6). */
function calledNames(text: string): string[] {
  const bare = text.replace(/'(?:[^']|'')*'/g, "''");
  return [...bare.matchAll(/([A-Za-z_][A-Za-z0-9_.]*)\s*\(/g)].map(m => m[1]);
}
const ALLOWED = new Set(['COALESCE', 'EXISTS', 'IN', 'VALUES', 'AND', 'OR', 'NOT', 'CASE', 'WHEN']);

describe('pg_catalog names in fleetJoin\'s SQL (R6)', () => {
  const texts = (): Array<[string, string]> => [
    ['ADDRESS_READ_SQL', fj.ADDRESS_READ_SQL],
    ['mainStateSql with a slot', fj.mainStateSql('fleet_standby_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')],
    ['mainStateSql without one', fj.mainStateSql('')],
    ['PEER_RECOVERY_SQL', fj.PEER_RECOVERY_SQL],
    ['MINT_SQL', fj.MINT_SQL],
    ['addressUpsertSql', fj.addressUpsertSql({ host: 'copy.invalid', port: 15433, cert: FIXTURE_PEM, machine: 'x (y)' })],
    ['DROP_ADDRESS_SQL', fj.DROP_ADDRESS_SQL],
  ];
  it('each exported text names only pg_catalog, smdb_manager or SQL words before a parenthesis', () => {
    for (const [name, text] of texts()) {
      expect(typeof text, name).toBe('string');
      const names = calledNames(text);
      expect(names.length, name).toBeGreaterThan(0);
      for (const n of names) expect(n.startsWith('pg_catalog.') || n.startsWith('smdb_manager.') || ALLOWED.has(n.toUpperCase()), `${name}: ${n}`).toBe(true);
    }
  });

  it('ADDRESS_READ_SQL lists a slot row only for a member login that can log in (R6, R4)', () => {
    expect(fj.ADDRESS_READ_SQL).toContain("WHERE r.rolname = 'smdb_copy_' || pg_catalog.substr(a.slot, 15) AND r.rolcanlogin");
    expect(fj.ADDRESS_READ_SQL).toContain("AND m.roleid = pg_catalog.to_regrole('smdb_copies')");
  });
});

const settled = async () => {
  for (let i = 0; i < 500; i++) {
    const seed = containerManager.getBot(ID)?.fleetDbReplicaSeed;
    if (!seed || seed.parked) return containerManager.getBot(ID)!;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error('the seed did not settle');
};
const spawnWith = (text: string) => docker.spawns.filter(s => s.args.join(' ').includes(text));
const dsnOf = (s: { args: string[] }) => s.args.find(a => a.startsWith('postgresql://'))!;
const SLOT = copySlot(ID);
const CONNINFO = `primary_conninfo = 'user=${LOGIN} password=${OWN_PW} host=main.invalid port=15432 sslmode=verify-full sslrootcert=/var/lib/postgresql/data/primary-ca.crt require_auth=scram-sha-256 application_name=${SLOT}'\n`;
const L19 = "this machine's own login to the main is not stored; press Re-seed";

describe('O2 the seed and its slot as this machine\'s login (S1 to S8)', () => {
  it('S1 and S4: provision mints, then the seed probe, the slot reset, pg_basebackup and primary_conninfo use this machine\'s login', async () => {
    writeRegistry({ fleetJoin: fakeJoinRecord() });
    expect(provisionFleetReplica(bot(), 'copy.invalid', 15433)).toEqual({ success: true, started: true });
    const after = await settled();
    expect(after.fleetDbReplicaSeed).toBeUndefined();
    expect(after.fleetDbReplica).toMatchObject({ slot: SLOT, primaryHost: 'main.invalid', primaryPort: 15432 });
    expect(docker.events.filter(e => ['mint', 'seed-probe', 'slot', 'basebackup'].includes(e))).toEqual(['mint', 'seed-probe', 'slot', 'basebackup']);
    const runs = [...spawnWith('SELECT pg_is_in_recovery()'), ...spawnWith('pg_create_physical_replication_slot'), ...spawnWith('pg_basebackup')];
    expect(runs).toHaveLength(3);
    for (const s of runs) {
      expect(s.env.PGPASSWORD).toBe(OWN_PW);
      expect(dsnUser(dsnOf(s))).toBe(LOGIN);
    }
    const seed = spawnWith('pg_basebackup')[0].args;
    expect(seed[seed.indexOf('-S') + 1]).toBe(SLOT);
    expect(docker.spawns.filter(s => s.stdin.startsWith('primary_conninfo')).map(s => s.stdin)).toEqual([CONNINFO]);
  });

  it('S1: the slot reset names pg_catalog\'s functions, creates only a missing slot and replaces only an inactive lost or unreserved one (S3)', async () => {
    writeRegistry({ fleetJoin: fakeJoinRecord() });
    provisionFleetReplica(bot(), 'copy.invalid', 15433);
    await settled();
    const reset = spawnWith('pg_create_physical_replication_slot')[0].args;
    const sql = reset[reset.length - 1];
    for (const n of calledNames(sql)) expect(n.startsWith('pg_catalog.') || ALLOWED.has(n.toUpperCase()), n).toBe(true);
    expect(sql).toContain(`FROM pg_catalog.pg_replication_slots WHERE slot_name = '${SLOT}'`);
    expect(sql).toContain(`IF NOT FOUND THEN\n          PERFORM pg_catalog.pg_create_physical_replication_slot('${SLOT}');`);
    expect(sql).toContain("ELSIF NOT s.active AND s.wal_status IN ('lost', 'unreserved') THEN");
  });

  it('a slot reset refused by the main names its first error line, not a WARNING', async () => {
    writeRegistry({ fleetJoin: fakeJoinRecord() });
    docker.slotFail = 'WARNING:  something\nERROR:  permission denied to create replication slot';
    provisionFleetReplica(bot(), 'copy.invalid', 15433);
    const after = await settled();
    expect(after.fleetDbReplicaSeed?.lastError).toBe('could not prepare the replication slot on the primary: ERROR:  permission denied to create replication slot');
    expect(docker.events).not.toContain('wipe');
  });

  it('S2: a stream by another login on the slot fails pg_basebackup as today; the inactive-slot drop runs as this machine\'s login', async () => {
    writeRegistry({ fleetJoin: fakeJoinRecord() });
    docker.basebackupFail = `pg_basebackup: error: could not send replication command "START_REPLICATION": ERROR:  replication slot "${SLOT}" is active for PID 4242`;
    provisionFleetReplica(bot(), 'copy.invalid', 15433);
    const after = await settled();
    expect(after.fleetDbReplicaSeed?.lastError).toBe(`pg_basebackup failed: pg_basebackup: error: could not send replication command "START_REPLICATION": ERROR:  replication slot "${SLOT}" is active for PID 4242`);
    const drops = spawnWith('pg_drop_replication_slot(slot_name)');
    expect(drops.length).toBeGreaterThan(0);
    for (const d of drops) {
      expect(dsnUser(dsnOf(d))).toBe(LOGIN);
      expect(d.env.PGPASSWORD).toBe(OWN_PW);
      const sql = d.args[d.args.length - 1];
      expect(sql).toBe(`SELECT pg_catalog.pg_drop_replication_slot(slot_name) FROM pg_catalog.pg_replication_slots WHERE slot_name = '${SLOT}' AND NOT active;`);
    }
  });

  it('S5: the copy\'s own row is written with set_copy_address as this machine\'s login', async () => {
    writeRegistry({ fleetJoin: fakeJoinRecord() });
    provisionFleetReplica(bot(), 'copy.invalid', 15433);
    await settled();
    const reg = spawnWith('smdb_manager.set_copy_address(');
    expect(reg).toHaveLength(1);
    expect(dsnUser(dsnOf(reg[0]))).toBe(LOGIN);
    expect((await getFleetReplicaStatus(bot())).seedNote ?? '').not.toContain('could not be added');
  });

  it.each([
    ['S6 another machine\'s row', `ERROR:  smdb-address-taken: copy.invalid:15433 is listed with the slot fleet_standby_${OTHER.slice(10)}`, `The copy runs, but its address could not be added to the main's list (${ADDR_TAKEN}).`],
    ['S8 the main\'s own row', "ERROR:  smdb-address-taken: copy.invalid:15433 is listed as the main's own address", `The copy runs, but its address could not be added to the main's list (${ADDR_TAKEN_MAIN}).`],
    ['any other failure', 'ERROR:  permission denied for function set_copy_address', "The copy runs, but its address could not be added to the main's list (ERROR:  permission denied for function set_copy_address). The manager tries again every hour."],
  ])('%s at rp:1155: the seed\'s note, with the hourly sentence only outside ADDR-TAKEN', async (_n, stderr, note) => {
    writeRegistry({ fleetJoin: fakeJoinRecord() });
    docker.registerFail = stderr;
    provisionFleetReplica(bot(), 'copy.invalid', 15433);
    await settled();
    const text = (await getFleetReplicaStatus(bot())).seedNote ?? '';
    expect(text.startsWith(note)).toBe(true);
    expect(text.slice(note.length)).not.toContain('every hour');
  });

  it('L19: the automatic rebuild with no stored password stops before the wipe, mints nothing and saves nothing', async () => {
    writeRegistry({ fleetJoin: fakeJoinRecord(), fleetDbReplica: { ...REPLICA, copyCleared: true } }, null);
    expect(startAutoRebuild(bot(), 'absent', async () => true)).toEqual({ started: true });
    const after = await settled();
    expect(after.fleetDbReplicaSeed?.lastError).toBe(L19);
    expect(docker.events.filter(e => ['mint', 'seed-probe', 'slot', 'wipe', 'basebackup'].includes(e))).toEqual([]);
    expect(h.loginWrites).toEqual([]);
  });

  it('L17: the automatic rebuild with a stored password mints nothing and seeds as this machine\'s login', async () => {
    writeRegistry({ fleetJoin: fakeJoinRecord(), fleetDbReplica: { ...REPLICA, copyCleared: true } });
    expect(startAutoRebuild(bot(), 'absent', async () => true)).toEqual({ started: true });
    const after = await settled();
    expect(after.fleetDbReplicaSeed).toBeUndefined();
    expect(docker.events).not.toContain('mint');
    expect(h.loginWrites).toEqual([]);
    expect(dsnUser(dsnOf(spawnWith('pg_basebackup')[0]))).toBe(LOGIN);
  });
});

describe('L20: Re-seed mints before its first probe', () => {
  const copy = () => writeRegistry({ fleetJoin: fakeJoinRecord(), fleetDbReplica: { ...REPLICA, copyCleared: true } });

  it('the mint, then the probe as this machine\'s login; the seed mints nothing more', async () => {
    copy();
    expect(await reseedStandby(bot())).toEqual({ success: true, started: true });
    await settled();
    expect(runOrder().filter(x => x !== 'other').slice(0, 2)).toEqual(['mint', 'probe']);
    expect(docker.events.filter(e => e === 'mint')).toHaveLength(1);
    expect(probeCall()!.env.PGPASSWORD).toBe(OWN_PW);
  });

  it('with no stored password, the new one is saved before the mint and the probe and the seed use it', async () => {
    writeRegistry({ fleetJoin: fakeJoinRecord(), fleetDbReplica: { ...REPLICA, copyCleared: true } }, null);
    expect(await reseedStandby(bot())).toEqual({ success: true, started: true });
    await settled();
    const pw = bot().fleetLogin!.password;
    expect(h.order[0]).toBe('save');
    expect(probeCall()!.env.PGPASSWORD).toBe(pw);
    expect(spawnWith('pg_basebackup')[0].env.PGPASSWORD).toBe(pw);
  });

  it.each([
    ['exists: JOIN-TAKEN', { out: 'exists', fail: '' }, JOIN_TAKEN(PROBE_REASON)],
    ['the join login refused: JOIN-CODE-OLD', { out: '', fail: MINT_REFUSED }, JOIN_CODE_OLD(MINT_REFUSED_REASON)],
    ['failed: JOIN-MINT', { out: '', fail: MINT_CAP }, JOIN_MINT(CAP)],
    ['created: loginRefusedText', { out: 'created', fail: '' }, LOGIN_REFUSED(PROBE_REASON)],
  ])('a refused probe after %s, with nothing changed', async (_n, mint, text) => {
    copy();
    docker.mint = mint;
    docker.main.fail = PROBE_REFUSED;
    const before = fs.readFileSync(REGISTRY, 'utf-8');
    expect(await reseedStandby(bot())).toEqual({ success: false, error: text });
    expect(fs.readFileSync(REGISTRY, 'utf-8')).toBe(before);
  });

  it('a blocked login: JOIN-BLOCKED and no probe', async () => {
    copy();
    docker.mint = { out: 'blocked', fail: '' };
    expect(await reseedStandby(bot())).toEqual({ success: false, error: JOIN_BLOCKED });
    expect(docker.events).not.toContain('main-probe');
  });
});

describe('R21: the Rejoin as a copy route answers the awaited object', () => {
  const router = createBotRoutes({ clients: new Set() } as any);
  const post = async (body: unknown) => {
    const layer = (router as any).stack.find((l: any) => l.route?.path === '/:id/fleet-reseed' && l.route.methods.post);
    const res: any = { statusCode: 200 };
    res.status = (c: number) => { res.statusCode = c; return res; };
    res.json = (b: unknown) => { res.body = b; return res; };
    await layer.route.stack[layer.route.stack.length - 1].handle({ params: { id: ID }, query: {}, body }, res);
    return { status: res.statusCode, body: res.body };
  };

  it('with replaced true', async () => {
    expect(await post({ replaced: true })).toEqual({ status: 200, body: { success: false, error: 'This instance holds no main database to rebuild' } });
  });

  it('with a join code', async () => {
    writeRegistry({ status: 'stopped', fleetDb: { containerName: 'b-fleet-postgres', user: 'smdb', db: 'smdb', volume: 'b-pgdata', replication: { role: 'smdb_join', password: '', hostPort: 15440, publicHost: 'b.invalid', certHost: 'b.invalid' } } });
    const why = (decodeJoinCode('nope') as { ok: false; why: string }).why;
    expect(await post({ joinCode: 'nope' })).toEqual({ status: 200, body: { success: false, error: `This is not a join code: ${why}` } });
  });
});

describe('P3-1: a composed code with no stored password', () => {
  const NO_LOGIN_TEXT = `${NO_OWN_LOGIN.charAt(0).toUpperCase()}${NO_OWN_LOGIN.slice(1)}.`;
  const composed = { repl: { user: OTHER, password: 'x' } };

  it('Join answers NO-OWN-LOGIN, saves no password and makes no call to the main', async () => {
    writeRegistry({}, null);
    const before = fs.readFileSync(REGISTRY, 'utf-8');
    expect(await joinFleet(bot(), fakeJoinCode(composed))).toEqual({ success: false, error: NO_LOGIN_TEXT });
    expect(h.loginWrites).toEqual([]);
    expect(docker.spawns).toEqual([]);
    expect(fs.readFileSync(REGISTRY, 'utf-8')).toBe(before);
  });

  it('Re-seed answers the same, saves no password and makes no call to the main', async () => {
    writeRegistry({ fleetJoin: fakeJoinRecord({}, composed), fleetDbReplica: { ...REPLICA, copyCleared: true } }, null);
    expect(await reseedStandby(bot())).toEqual({ success: false, error: NO_LOGIN_TEXT });
    expect(h.loginWrites).toEqual([]);
    expect(docker.spawns).toEqual([]);
  });

  it('with a stored password the path is unchanged: no mint, the probe as this machine', async () => {
    expect((await joinFleet(bot(), fakeJoinCode(composed))).success).toBe(true);
    expect(h.loginWrites).toEqual([]);
    expect(docker.events).not.toContain('mint');
    expect(probeCall()!.env.PGPASSWORD).toBe(OWN_PW);
  });

  it('a code with the join login still makes and saves a password, then mints', async () => {
    writeRegistry({}, null);
    expect((await joinFleet(bot(), fakeJoinCode())).success).toBe(true);
    expect(h.loginWrites).toHaveLength(1);
    expect(docker.events).toContain('mint');
  });
});
