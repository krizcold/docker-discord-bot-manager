import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// NM13's connection reading against a real Postgres 16. Skipped on Windows and without docker; the main session runs it with linux_pg.sh.
const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm13-pg-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir };
});
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { ensureManagerDbRole } from '../../src/instance/dbLogin';
import { connectionReading } from '../../src/instance/fleetReplication';

const dockerRuns = (() => {
  try {
    return spawnSync('docker', ['version'], { stdio: 'ignore', timeout: 10000 }).status === 0;
  } catch {
    return false;
  }
})();

// The container and its volume are named here and removed by exact name.
const ID = `nm13pg${process.pid}`;
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

const SHARD_NODES_DDL = `CREATE SCHEMA IF NOT EXISTS smdb_data;
CREATE TABLE IF NOT EXISTS smdb_data.shard_nodes (
  node_id          text PRIMARY KEY,
  node_name        text        NOT NULL,
  process_id       text        NOT NULL,
  capacity         integer     NOT NULL,
  takeover_seconds integer     NOT NULL,
  fit              boolean     NOT NULL,
  restartable      boolean     NOT NULL,
  returns          boolean     NOT NULL,
  started_at       timestamptz NOT NULL,
  healthy_since    timestamptz,
  seen_at          timestamptz NOT NULL,
  count_setting    integer,
  reshard_overlap  boolean     NOT NULL DEFAULT true,
  memory_room      boolean,
  memory_free_mb   integer,
  memory_use_mb    integer,
  memory_error     text,
  memory_at        timestamptz
);`;
const row = (id: string, restartable: boolean, overlap: boolean, seen: string) =>
  `INSERT INTO smdb_data.shard_nodes (node_id, node_name, process_id, capacity, takeover_seconds, fit, restartable, returns, started_at, seen_at, reshard_overlap)
   VALUES ('${id}', '${id}', 'p-${id}', 1, 30, true, ${restartable}, true, now(), ${seen}, ${overlap});`;

describe.skipIf(process.platform === 'win32' || !dockerRuns)('NM13 connection reading against a real Postgres 16 (Linux with docker)', () => {
  const inst = {
    id: 'nm13bot', sanitizedName: ID, displayName: 'NM13', sourceUrl: 'https://example.invalid/x', status: 'stopped', createdAt: 'x', updatedAt: 'x',
    fleetDb: { containerName: MAIN, user: 'smdb', db: 'smdb', volume: VOL },
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
  }, 300000);

  afterAll(() => {
    run(['rm', '-f', '-v', MAIN]);
    run(['volume', 'rm', '-f', VOL]);
    fs.rmSync(h.dir, { recursive: true, force: true });
  }, 120000);

  it('PG1 no shard_nodes table: none', async () => {
    expect(await connectionReading(inst)).toEqual({ state: 'none' });
  });

  it('PG2 the rows of the last 7 days against max_connections 100 less 3 reserved', async () => {
    ok(SHARD_NODES_DDL);
    ok(row('n1', true, true, 'now()') + row('n2', true, true, "now() - interval '1 day'") + row('n3', true, true, "now() - interval '6 days'")
      + row('old', false, false, "now() - interval '8 days'"));
    expect(await connectionReading(inst)).toEqual({ state: 'read', machines: 3, count: 132, overlap: true, max: 100, reserved: 3, allowed: 97 });
  });
});
