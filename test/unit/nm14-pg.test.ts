import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// NM14's verifier read and check against a real Postgres 16. Skipped on Windows and without docker; the main session runs it with linux_pg.sh.
const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm14-pg-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir };
});
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import { ensureManagerDbRole, readRoleVerifier } from '../../src/instance/dbLogin';
import { scramSha256Verifier, verifierAccepts } from '../../src/config/secretText';

const dockerRuns = (() => {
  try {
    return spawnSync('docker', ['version'], { stdio: 'ignore', timeout: 10000 }).status === 0;
  } catch {
    return false;
  }
})();

// The container and its volume are named here and removed by exact name.
const ID = `nm14pg${process.pid}`;
const MAIN = `${ID}-main`;
const VOL = `${ID}-main-data`;

const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const run = (args: string[], input?: string) => {
  const r = spawnSync('docker', args, { encoding: 'utf-8', timeout: 600000, input });
  return { status: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
};
const ok = (sql: string) => {
  const r = run(['exec', '-i', MAIN, 'psql', '-X', '-U', 'smdb', '-d', 'smdb', '-tA', '-v', 'ON_ERROR_STOP=1'], sql);
  expect(r.status, r.err).toBe(0);
  return r.out;
};
// Over TCP on the container's own address: the image trusts 127.0.0.1 and the socket, so only this checks the password.
const tcpLogin = (user: string, password: string) =>
  run(['exec', '-e', `PGPASSWORD=${password}`, MAIN, 'sh', '-c', `psql -X -h "$(hostname -i | cut -d' ' -f1)" -U ${user} -d smdb -tAc 'SELECT 1'`]);

describe.skipIf(process.platform === 'win32' || !dockerRuns)('NM14 role verifiers against a real Postgres 16 (Linux with docker)', () => {
  beforeAll(async () => {
    const r = run(['run', '-d', '--name', MAIN, '-v', `${VOL}:/var/lib/postgresql/data`,
      '-e', 'POSTGRES_USER=smdb', '-e', 'POSTGRES_PASSWORD=app-pw', '-e', 'POSTGRES_DB=smdb', 'postgres:16-alpine']);
    expect(r.status, r.err).toBe(0);
    let ready = false;
    for (let i = 0; i < 240 && !ready; i++) {
      ready = run(['exec', MAIN, 'pg_isready', '-h', '127.0.0.1', '-q']).status === 0;
      if (!ready) pause(500);
    }
    expect(ready).toBe(true);
    expect(await ensureManagerDbRole({ container: MAIN, user: 'smdb' })).toEqual({ ok: true });
  }, 300000);

  afterAll(() => {
    run(['rm', '-f', '-v', MAIN]);
    run(['volume', 'rm', '-f', VOL]);
    fs.rmSync(h.dir, { recursive: true, force: true });
  }, 120000);

  it('PG0 the bootstrap role: its POSTGRES_PASSWORD is accepted', async () => {
    const read = await readRoleVerifier({ container: MAIN, user: 'smdb' });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(await verifierAccepts(read.verifier, 'app-pw', 'u')).toBe(true);
    expect(await verifierAccepts(read.verifier, 'app-px', 'u')).toBe(false);
  });

  it('PG1 a password Postgres hashed itself', async () => {
    ok("CREATE ROLE r1 LOGIN PASSWORD 'pw-abc';");
    const read = await readRoleVerifier({ container: MAIN, user: 'r1' });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(await verifierAccepts(read.verifier, 'pw-abc', 'u')).toBe(true);
    expect(await verifierAccepts(read.verifier, 'pw-abd', 'u')).toBe(false);
  });

  it('PG2 a verifier the manager made: Postgres accepts the TCP login and verifierAccepts takes it', async () => {
    ok(`CREATE ROLE r2 LOGIN PASSWORD '${scramSha256Verifier('pw-xyz')}';`);
    const login = tcpLogin('r2', 'pw-xyz');
    expect(login.status, login.err).toBe(0);
    expect(login.out).toBe('1');
    expect(tcpLogin('r2', 'pw-xyw').status).not.toBe(0);
    const read = await readRoleVerifier({ container: MAIN, user: 'r2' });
    expect(read.ok && await verifierAccepts(read.verifier, 'pw-xyz', 'r2')).toBe(true);
  });

  it('PG3 a role without a password, and a role that does not exist', async () => {
    ok('CREATE ROLE r3 LOGIN;');
    expect(await readRoleVerifier({ container: MAIN, user: 'r3' })).toEqual({ ok: false, why: 'the database keeps no SCRAM-SHA-256 password for r3' });
    expect(await readRoleVerifier({ container: MAIN, user: 'r4' })).toEqual({ ok: false, why: 'the role r4 does not exist in the database' });
  });
});
