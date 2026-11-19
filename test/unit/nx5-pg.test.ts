// NX5 test 15 against a real Postgres 16: the save-order DDL and grants, the expected-set read, the fence exemption,
// Running on a database without the tables, and the generation's rules. Skipped on Windows and without docker; the
// main session runs it on Linux (swarm/linux_mgr.sh), like the nm*-pg files.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nx5-pg-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir };
});
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import * as fs from 'fs';
import { spawnSync as spawnBytes } from 'child_process';
import * as switchSql from '../../src/instance/switchSql';
import { ensureGenerationSql, parseMetaRows, raiseSql } from '../../src/instance/switchSql';
import { parseAddressRows } from '../../src/instance/fleetJoin';
import { MANAGER_SESSION_OPTIONS, META_LOGIN, WORK_LOGIN } from '../../src/instance/dbLogin';
import { type Cluster, dockerRuns, provisionedCluster } from './pg-cluster';

const sql = switchSql as any;
const ID = `nx5pg${process.pid}`;
const U = 'smdb';
const DB = 'smdb';
const EXEMPT = [`PGOPTIONS=${MANAGER_SESSION_OPTIONS} -c default_transaction_read_only=off`];
const DENIED = /permission denied/i;

const ok = (r: { status: number | null; out: string; err: string }) => {
  expect(r.status, r.err).toBe(0);
  return r.out;
};

const CLAIMS_DDL = `CREATE SCHEMA IF NOT EXISTS smdb_data;
CREATE TABLE IF NOT EXISTS smdb_data.shard_claims (shard_count integer NOT NULL, shard_id integer NOT NULL, claim bigint NOT NULL,
  holder_process text NOT NULL, holder_node text NOT NULL, holder_name text NOT NULL, home_node text NOT NULL,
  released boolean NOT NULL DEFAULT false, reserved boolean NOT NULL DEFAULT false, taken_at timestamptz NOT NULL DEFAULT now(),
  renewed_at timestamptz NOT NULL DEFAULT now(), ttl_ms bigint NOT NULL, expires_up_ms bigint NOT NULL,
  extended boolean NOT NULL DEFAULT false, ready boolean NOT NULL DEFAULT false, PRIMARY KEY (shard_count, shard_id));
CREATE TABLE IF NOT EXISTS smdb_data.claim_clock (id integer PRIMARY KEY CHECK (id = 1), up_ms bigint NOT NULL, ticked_at timestamptz NOT NULL, last_gap_ms bigint NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS smdb_data.reshard (id integer PRIMARY KEY CHECK (id = 1), target integer, target_by text, target_at timestamptz, attempt uuid,
  from_count integer, to_count integer, method text, state text, started_by text, started_at timestamptz, until_at timestamptz,
  flipped_at timestamptz, ended_at timestamptz, reason text, retry_after timestamptz, failures integer NOT NULL DEFAULT 0);
GRANT USAGE ON SCHEMA smdb_data TO ${U};
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA smdb_data TO ${U};`;

const claimRow = (count: number, id: number, holder: string, name: string, expires: number, released = false) =>
  `INSERT INTO smdb_data.shard_claims (shard_count, shard_id, claim, holder_process, holder_node, holder_name, home_node, released, ttl_ms, expires_up_ms) VALUES (${count}, ${id}, ${id + 1}, '${holder}', 'n-${holder}', '${name}', 'n-${holder}', ${released}, 30000, ${expires});`;

describe.skipIf(process.platform === 'win32' || !dockerRuns)('NX5 the save order against a real Postgres 16 (Linux with docker)', () => {
  let c: Cluster;
  let n = 0;
  const meta = (text: string, env: string[] = []) => c.psql(META_LOGIN, text, DB, env);
  const work = (text: string, env: string[] = []) => c.psql(WORK_LOGIN, text, DB, env);
  const bot = (text: string) => c.psql(U, text, DB);
  const admin = (text: string, db = DB) => c.psql('dbm_admin', text, db);
  // The manager reads the claim clock as dbm_work and writes the row as dbm_meta (build note: NM20's logins).
  const order = (keepId: string | null = null, env: string[] = [], keepRestore = false) => {
    const id = `o${++n}`;
    const clock = sql.parseClaimClock(ok(work(sql.CLAIM_CLOCK_READ_SQL, env)));
    const out = ok(meta(sql.saveOrderSql({ keepId, keepRestore, newId: id, message: 'Back soon', user: U, upMs: clock }), env));
    const [orderId, kept, generation, upMs] = out.split('\n').pop()!.split('|');
    return { orderId, kept: kept === 't', generation: Number(generation), upMs: upMs === '' ? null : Number(upMs) };
  };
  const read = (env: string[] = []) => sql.parseSaveRows(ok(work(sql.SAVE_READ_SQL, env)));
  const answer = (process: string, orderId: string) =>
    bot(`INSERT INTO smdb_manager.save_acks (process_id, order_id, node_id, node_name, saved) VALUES ('${process}', '${orderId}', 'n-${process}', 'host', true)
      ON CONFLICT (process_id) DO UPDATE SET order_id = EXCLUDED.order_id, saved = EXCLUDED.saved;`);

  beforeAll(async () => {
    c = await provisionedCluster({ name: `${ID}-a`, user: U, db: DB, password: 'nx5-bot-password' });
    ok(admin(CLAIMS_DDL));
    ok(admin(`INSERT INTO smdb_data.claim_clock (id, up_ms, ticked_at) VALUES (1, 100000, now());`));
    ok(meta(ensureGenerationSql('main.example')));
  }, 240_000);
  afterAll(() => {
    c?.remove();
    fs.rmSync(tmp.dir, { recursive: true, force: true });
  });

  it('the DDL and grants: the bot role reads save_order and writes its own answer, and cannot write save_order', () => {
    ok(meta(sql.SAVE_ORDER_DDL(U)));
    const o = order();
    expect(ok(bot('SELECT order_id FROM smdb_manager.save_order;'))).toBe(o.orderId);
    ok(answer('p1', o.orderId));
    const ins = bot(`INSERT INTO smdb_manager.save_order (one_row, order_id, state, message, generation, reason) VALUES (true, 'z', 'maintenance', '', 1, 'order');`);
    expect(ins.status).not.toBe(0);
    expect(ins.err).toMatch(DENIED);
    const upd = bot(`UPDATE smdb_manager.save_order SET state = 'running';`);
    expect(upd.status).not.toBe(0);
    expect(upd.err).toMatch(DENIED);
  });

  it('the expected set over real shard_claims, claim_clock and reshard rows', () => {
    ok(admin(`DELETE FROM smdb_data.shard_claims;
${claimRow(2, 0, 'p1', 'host-a', 200000)}
${claimRow(2, 1, 'p2', 'host-b', 50000)}
${claimRow(4, 0, 'p9', 'host-s', 200000)}
${claimRow(4, 1, 'p3', 'host-c', 200000, true)}
INSERT INTO smdb_data.reshard (id, to_count, state) VALUES (1, 4, 'standby') ON CONFLICT (id) DO UPDATE SET to_count = 4, state = 'standby';`));
    const o = order();
    expect(o.upMs).toBe(100000);
    let rows = read();
    expect(rows.expected.map((e: any) => e.process)).toEqual(['p1']);
    expect(rows.notSeen.map((e: any) => [e.process, e.name])).toEqual([['p2', 'host-b']]);
    ok(admin(`UPDATE smdb_data.reshard SET state = 'done';`));
    rows = read();
    expect(rows.expected.map((e: any) => e.process).sort()).toEqual(['p1', 'p9']);
    ok(answer('p1', o.orderId));
    rows = read();
    expect(rows.acks.find((a: any) => a.process === 'p1')).toMatchObject({ order: o.orderId, saved: true });
    expect(rows.order).toMatchObject({ id: o.orderId, state: 'maintenance', current: true, reason: 'order', upMs: 100000 });
  });

  it('order and final succeed on a database with default_transaction_read_only on', () => {
    ok(admin(`ALTER DATABASE ${DB} SET default_transaction_read_only = on;`, 'postgres'));
    try {
      const o = order(null, EXEMPT);
      expect(read(EXEMPT).order.id).toBe(o.orderId);
    } finally {
      ok(admin(`ALTER DATABASE ${DB} RESET default_transaction_read_only;`, 'postgres'));
    }
  });

  it('after NOLOGIN and the terminate, the final read equals the read before', () => {
    const o = order();
    ok(answer('p1', o.orderId));
    const before = read();
    ok(admin(`ALTER ROLE "${U}" NOLOGIN; SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = '${U}';`, 'postgres'));
    try {
      // agoMs counts from now() at each read, so it only grows between the two; the rest must not change.
      const after = read();
      const held = (r: any) => ({ ...r, expected: r.expected.map(({ agoMs: _a, ...e }: any) => e), notSeen: r.notSeen.map(({ agoMs: _a, ...e }: any) => e) });
      expect(held(after)).toEqual(held(before));
      after.expected.forEach((e: any, i: number) => expect(e.agoMs).toBeGreaterThanOrEqual(before.expected[i].agoMs));
    } finally {
      ok(admin(`ALTER ROLE "${U}" LOGIN;`, 'postgres'));
    }
  });

  it('a kept row keeps its answers and takes the new message', () => {
    const o = order();
    ok(answer('p1', o.orderId));
    const again = order(o.orderId);
    expect(again).toMatchObject({ orderId: o.orderId, kept: true });
    expect(read().acks).toHaveLength(1);
  });

  it("review 2 finding 1: a real pg_dump as dbm_work after the order holds both tables' blocks, and the meta read passes over them", () => {
    const o = order();
    ok(answer('p1', o.orderId));
    const r = spawnBytes('docker', ['exec', c.name, 'sh', '-c',
      `pg_dump -U ${WORK_LOGIN} -d ${DB} -Fc -f /tmp/nx5-order.dump && pg_restore --data-only -n smdb_manager -f - /tmp/nx5-order.dump`], { timeout: 120000 });
    expect(r.status, String(r.stderr)).toBe(0);
    const text = (r.stdout as Buffer).toString('utf-8');
    expect(text).toMatch(/^COPY smdb_manager\.save_order \(/m);
    expect(text).toMatch(/^COPY smdb_manager\.save_acks \(/m);
    const parsed = parseMetaRows(r.stdout as Buffer, row => parseAddressRows(JSON.stringify([row]))[0] ?? null);
    expect(parsed).toMatchObject({ ok: true, counts: { generation: 1 } });
    expect((parsed as { script: string }).script).not.toMatch(/save_order|save_acks/);
  });

  it("a standing row of reason 'restore' is kept only with keepRestore; without it a new id of reason 'order' replaces it and its answers", () => {
    ok(meta(sql.restoreOrderSql({ user: U, orderId: 'rs1', message: 'm' })));
    ok(answer('p1', 'rs1'));
    expect(order('rs1', [], true)).toMatchObject({ orderId: 'rs1', kept: true });
    expect(read().order).toMatchObject({ id: 'rs1', reason: 'restore' });
    expect(read().acks).toHaveLength(1);
    const fresh = order('rs1');
    expect(fresh).toMatchObject({ kept: false });
    expect(fresh.orderId).not.toBe('rs1');
    expect(read().order).toMatchObject({ id: fresh.orderId, reason: 'order' });
    expect(read().acks).toEqual([]);
  });

  it('G8-5: the tables refuse a half row', () => {
    const o = order();
    for (const col of ['order_id', 'state', 'generation', 'reason', 'at']) {
      const r = admin(`UPDATE smdb_manager.save_order SET ${col} = NULL;`);
      expect(r.status).not.toBe(0);
      expect(r.err).toMatch(/null value in column/);
    }
    ok(admin(`UPDATE smdb_manager.save_order SET message = NULL, up_ms = NULL;`));
    ok(admin(`UPDATE smdb_manager.save_order SET message = 'm';`));
    ok(answer('p1', o.orderId));
    for (const col of ['order_id', 'acked_at', 'resave_guilds']) {
      const r = admin(`UPDATE smdb_manager.save_acks SET ${col} = NULL;`);
      expect(r.status).not.toBe(0);
      expect(r.err).toMatch(/null value in column/);
    }
    ok(admin(`UPDATE smdb_manager.save_acks SET node_id = NULL, node_name = NULL, saved = NULL, unsaved_guilds = NULL, unsaved_files = NULL, unanswered_guilds = NULL, unconfirmed_files = NULL, unanswered_files = NULL;`));
    expect(ok(admin(`SELECT resave_guilds FROM smdb_manager.save_acks;`))).toBe('0');
  });

  it('raiseSql leaves the row void', () => {
    const o = order();
    const g = read().order;
    expect(g.current).toBe(true);
    ok(meta(raiseSql('main.example', o.generation + 1)));
    expect(read().order).toMatchObject({ id: o.orderId, current: false });
  });

  it('Running succeeds on a database that has the generation row and neither new table, and leaves both with the grants', () => {
    ok(admin(`DROP TABLE IF EXISTS smdb_manager.save_acks; DROP TABLE IF EXISTS smdb_manager.save_order;`));
    ok(meta(sql.runningOpenSql({ user: U, newId: 'r1' })));
    expect(ok(bot('SELECT state || \'|\' || reason FROM smdb_manager.save_order;'))).toBe('running|order');
    expect(ok(bot('SELECT count(*) FROM smdb_manager.save_acks;'))).toBe('0');
  });

  it('after a restore without the tables, and one without privileges, the bot role can answer once the next order ran', () => {
    ok(admin(`DROP TABLE IF EXISTS smdb_manager.save_acks; DROP TABLE IF EXISTS smdb_manager.save_order;`));
    let o = order();
    ok(answer('p1', o.orderId));
    ok(admin(`REVOKE ALL ON smdb_manager.save_acks, smdb_manager.save_order FROM ${U}; REVOKE USAGE ON SCHEMA smdb_manager FROM ${U};`));
    expect(answer('p1', o.orderId).status).not.toBe(0);
    o = order();
    ok(answer('p1', o.orderId));
  });

  it('order with no claim_clock writes up_ms NULL', () => {
    ok(admin(`ALTER TABLE smdb_data.claim_clock RENAME TO claim_clock_away;`));
    try {
      expect(order().upMs).toBeNull();
      expect(read().order.upMs).toBeNull();
    } finally {
      ok(admin(`ALTER TABLE smdb_data.claim_clock_away RENAME TO claim_clock;`));
    }
  });

  it('Running and order succeed with no generation table (made empty, generation 0); a later ensure inserts 1 and voids the row', () => {
    ok(admin(`DROP SCHEMA smdb_manager CASCADE;`));
    ok(meta(sql.runningOpenSql({ user: U, newId: 'r2' })));
    expect(ok(admin('SELECT count(*) FROM smdb_manager.generation;'))).toBe('0');
    const o = order();
    expect(o.generation).toBe(0);
    expect(read().order).toMatchObject({ id: o.orderId, current: true });
    ok(meta(ensureGenerationSql('main.example')));
    expect(read().order).toMatchObject({ id: o.orderId, current: false });
  });
});
