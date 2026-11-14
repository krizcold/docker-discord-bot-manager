import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// NM20 part 4: the take-over's cap against a real Postgres 16 whose bot table forces row security (Z4, Q3, P2, Y7).
// Skipped on Windows and without docker; the main session runs it on Linux.
const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm20-pg4-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir };
});
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import * as fs from 'fs';
import { rowSecurityRefusal, workSql } from '../../src/instance/fleetSwitch';
import { SHARD_CAP_DO_SQL } from '../../src/instance/switchSql';
import { type Cluster, docker, dockerRuns, provisionedCluster } from './pg-cluster';

const ID = `nm20pg4${process.pid}`;
const NET = `${ID}-net`;
const U = 'smdb';
const DB = 'smdb';
const PW = 'nm20-pg4-bot-password';

const ok = (r: { status: number | null; out: string; err: string }) => {
  expect(r.status, r.err).toBe(0);
  return r.out;
};

describe.skipIf(process.platform === 'win32' || !dockerRuns)('NM20 part 4 TK-RLS against a real Postgres 16 (Linux with docker)', () => {
  let main: Cluster;

  beforeAll(async () => {
    docker(['network', 'create', NET]);
    main = await provisionedCluster({ name: `${ID}-main`, user: U, db: DB, password: PW, network: NET });
  }, 300000);

  afterAll(() => {
    main?.remove();
    docker(['network', 'rm', NET]);
    fs.rmSync(h.dir, { recursive: true, force: true });
  }, 180000);

  it("PG4-1 the take-over's cap on a table with forced row security answers TK-RLS from psql's stderr", async () => {
    ok(main.psql(U, `CREATE SCHEMA smdb_data;
CREATE TABLE smdb_data.shard_claims (shard int PRIMARY KEY, expires_up_ms bigint NOT NULL);
CREATE TABLE smdb_data.claim_clock (id int PRIMARY KEY, up_ms bigint NOT NULL);
INSERT INTO smdb_data.shard_claims VALUES (1, 9000), (2, 9000);
INSERT INTO smdb_data.claim_clock VALUES (1, 100);
ALTER TABLE smdb_data.shard_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE smdb_data.shard_claims FORCE ROW LEVEL SECURITY;
CREATE POLICY hide_two ON smdb_data.shard_claims USING (shard <> 2);`));
    const copy = { container: main.name, db: DB, user: U };
    const cap = await workSql({ container: main.name, user: U }, DB, SHARD_CAP_DO_SQL);
    console.log(`[nm20-pg4] the cap's stderr:\n${cap.stderr}`);
    expect(cap.ok).toBe(false);
    expect(rowSecurityRefusal(cap.stderr, copy)).toBe(`The copy is promoted, but its shard claims could not be capped: row-level security is forced on smdb_data.shard_claims, so Take over fails the same way until it is lifted. The generation was not raised, so bots may not choose this copy over the old main, and the bot's login to it stays blocked. The manager has no SQL console; on this machine, run docker exec -it ${main.name} psql -U dbm_work -d ${DB} -c 'SET ROLE "${U}"; ALTER TABLE smdb_data.shard_claims NO FORCE ROW LEVEL SECURITY'. Then press Take over again.`);
    expect(ok(main.psql('dbm_admin', 'SELECT expires_up_ms FROM smdb_data.shard_claims ORDER BY shard'))).toBe('9000\n9000');

    // TK-RLS's own command, run as it reads, lifts the refusal.
    ok(docker(['exec', main.name, 'psql', '-X', '-U', 'dbm_work', '-d', DB, '-c', `SET ROLE "${U}"; ALTER TABLE smdb_data.shard_claims NO FORCE ROW LEVEL SECURITY`]));
    const again = await workSql({ container: main.name, user: U }, DB, SHARD_CAP_DO_SQL);
    expect(again.ok, again.stderr).toBe(true);
    expect(ok(main.psql('dbm_admin', 'SELECT expires_up_ms FROM smdb_data.shard_claims ORDER BY shard'))).toBe('100\n100');
  }, 300000);
});
