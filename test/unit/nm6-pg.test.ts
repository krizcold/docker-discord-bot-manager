import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// NM6's slot query against a real Postgres 16: a physical slot with no copy connected has no replay position.
// Skipped on Windows and without docker; the main session runs it with linux_pg.sh.
const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm6-pg-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir };
});
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { ensureManagerDbRole } from '../../src/instance/dbLogin';
import { getFleetReplicationStatus } from '../../src/instance/fleetReplication';

const dockerRuns = (() => {
  try {
    return spawnSync('docker', ['version'], { stdio: 'ignore', timeout: 10000 }).status === 0;
  } catch {
    return false;
  }
})();

// The container and its volume are named here and removed by exact name.
const ID = `nm6pg${process.pid}`;
const MAIN = `${ID}-main`;
const VOL = `${ID}-main-data`;
const SLOT = 'fleet_standby_nm6pg';

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

describe.skipIf(process.platform === 'win32' || !dockerRuns)('NM6 slot query against a real Postgres 16 (Linux with docker)', () => {
  const inst = {
    id: 'nm6bot', sanitizedName: ID, displayName: 'NM6', sourceUrl: 'https://example.invalid/x', status: 'stopped', createdAt: 'x', updatedAt: 'x',
    fleetDb: { containerName: MAIN, user: 'smdb', db: 'smdb', volume: VOL, replication: { publicHost: 'main.example', hostPort: 5433 } },
  } as any;

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
    fs.writeFileSync(path.join(h.dir, 'instances.json'), JSON.stringify({ instances: { [inst.id]: inst } }));
    expect(await ensureManagerDbRole({ container: MAIN, user: 'smdb' })).toEqual({ ok: true });
    ok(`SELECT pg_create_physical_replication_slot('${SLOT}', true);`);
  }, 300000);

  afterAll(() => {
    run(['rm', '-f', '-v', MAIN]);
    run(['volume', 'rm', '-f', VOL]);
    fs.rmSync(h.dir, { recursive: true, force: true });
  }, 120000);

  it('PG1 a slot with no copy connected: behindBytes null, and the probe runs without an error', async () => {
    const st = await getFleetReplicationStatus(inst, { probeEndpoint: false });
    expect(st.probeError).toBeUndefined();
    const slot = st.live?.slots.find(s => s.slot === SLOT);
    expect(slot).toMatchObject({ slot: SLOT, fleet: true, active: false, state: null, behindBytes: null });
  });
});
