import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// NM35 against a real Postgres 16: a .psqlrc in the container does not change what the manager's psql calls print.
const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm35-pg-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir };
});

vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import * as fs from 'fs';
import { adminReadArgs, clusterPsql, MANAGER_DB_ROLE, runCall, WORK_LOGIN, workArgs, workPsql } from '../../src/instance/dbLogin';
import { type Cluster, docker, dockerRuns, provisionedCluster } from './pg-cluster';

const ID = `nm35pg${process.pid}`;
const U = 'app';
const DB = 'app';
const PW = 'nm35-pg-bot-password';
const PSQLRC = '\\pset format aligned\n\\pset tuples_only off\n\\timing on\n';

describe.skipIf(process.platform === 'win32' || !dockerRuns)('NM35 psql calls with a .psqlrc in the container (Linux with docker)', () => {
  let c: Cluster;

  beforeAll(async () => {
    c = await provisionedCluster({ name: `${ID}-main`, user: U, db: DB, password: PW });
    const wrote = docker(['exec', '-i', c.name, 'sh', '-c', 'cat > /root/.psqlrc'], PSQLRC);
    expect(wrote.status, wrote.err).toBe(0);
    expect(docker(['exec', c.name, 'cat', '/root/.psqlrc']).out).toBe(PSQLRC.trim());
  }, 300000);

  afterAll(() => {
    c?.remove();
    fs.rmSync(h.dir, { recursive: true, force: true });
  });

  it('the .psqlrc reaches a psql started without -X (the setup works)', () => {
    const r = docker(['exec', c.name, 'psql', '-U', 'dbm_admin', '-d', 'postgres', '-tA', '-c', 'SELECT 1']);
    expect(r.out).not.toBe('1');
  });

  it('dbm_admin through clusterPsql answers SELECT 1 with 1', async () => {
    const r = await runCall(c.name, clusterPsql(c.name, 'SELECT 1'));
    expect(r).toMatchObject({ ok: true, stdout: '1\n' });
  });

  it('dbm_work through workPsql answers SELECT 1 with 1', async () => {
    const r = await runCall(c.name, workPsql(c.name, DB, 'SELECT 1'));
    expect(r).toMatchObject({ ok: true, stdout: '1\n' });
  });

  it('dbm_work through workArgs with psql answers SELECT 1 with 1', async () => {
    const r = await runCall(c.name, { login: WORK_LOGIN, args: workArgs(c.name, DB, 'psql', ['-tA', '-v', 'ON_ERROR_STOP=1', '-c', 'SELECT 1']) });
    expect(r).toMatchObject({ ok: true, stdout: '1\n' });
  });

  it('the read-only admin call (adminReadArgs) answers SELECT 1 with 1', async () => {
    const r = await runCall(c.name, { login: MANAGER_DB_ROLE, args: adminReadArgs(c.name, DB), input: 'SELECT 1;\n' });
    expect(r).toMatchObject({ ok: true, stdout: '1\n' });
  });
});
