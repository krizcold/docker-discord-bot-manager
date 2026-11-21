/**
 * The SQL of the generation row (contract 4), the hand-over and received rows, and the restore record kept in the
 * cluster's postgres database, with the pure rules that compare and raise generations. Pure: no I/O.
 */
import { machineText, sqlLiteral } from '../config/joinCode';
import { FleetDbReceive, InstanceConfig, JoinAddress } from '../types';

export interface GenRow { generation: number; machine: string; since: string | null }

export interface RestoreState { pending: boolean; file: string; at: string; floor: GenRow | null }

/** The name other machines see for this machine: its address when it has one, else the instance's name. */
export function machineNameOf(instance: InstanceConfig): string {
  return machineText(instance.fleetDbReplica?.publicHost || instance.fleetDb?.replication?.publicHost || instance.displayName || '');
}

const SINCE = `to_char(since AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;

const GENERATION_TABLE = `CREATE TABLE IF NOT EXISTS smdb_manager.generation (
  one_row boolean PRIMARY KEY DEFAULT true CHECK (one_row), machine text NOT NULL,
  generation bigint NOT NULL CHECK (generation >= 1), since timestamptz NOT NULL DEFAULT now());`;
const GENERATION_PUBLIC = 'GRANT SELECT ON smdb_manager.generation TO PUBLIC;';

const TABLES = `CREATE SCHEMA IF NOT EXISTS smdb_manager;
${GENERATION_TABLE}
CREATE TABLE IF NOT EXISTS smdb_manager.handover (
  one_row boolean PRIMARY KEY DEFAULT true CHECK (one_row), slot text NOT NULL, machine text NOT NULL,
  generation bigint NOT NULL, at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS smdb_manager.received (
  push_id text PRIMARY KEY, from_system_id text NOT NULL, from_machine text NOT NULL, generation bigint NOT NULL,
  at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS smdb_manager.copies (
  slot text PRIMARY KEY, machine text, client text, seen_at timestamptz NOT NULL DEFAULT now());
GRANT USAGE ON SCHEMA smdb_manager TO PUBLIC, dbm_work;
${GENERATION_PUBLIC}
GRANT SELECT ON smdb_manager.generation, smdb_manager.handover, smdb_manager.received, smdb_manager.copies TO dbm_work;`;

export const GENERATION_SCHEMA_SQL = TABLES;

// ─── Contract 11: the save order ───

const quotedRole = (user: string): string => {
  if (!TAKEOVER_ROLE_RE.test(user)) throw new Error(`the bot's role name ${user} is not a plain identifier`);
  return `"${user}"`;
};

/**
 * The save order's tables and the bot role's grants, run by dbm_meta at the head of every writer of them: the order
 * step, Running's row and the restore's rewrite. Idempotent; it also makes the generation table, which every reader
 * of the order needs.
 */
export function SAVE_ORDER_DDL(user: string): string {
  const role = quotedRole(user);
  return `CREATE SCHEMA IF NOT EXISTS smdb_manager;
${GENERATION_TABLE}
${GENERATION_PUBLIC}
CREATE TABLE IF NOT EXISTS smdb_manager.save_order (
  one_row boolean PRIMARY KEY DEFAULT true CHECK (one_row), order_id text NOT NULL,
  state text NOT NULL CHECK (state IN ('maintenance', 'running')), message text, generation bigint NOT NULL,
  reason text NOT NULL CHECK (reason IN ('order', 'restore')), up_ms bigint, at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS smdb_manager.save_acks (
  process_id text PRIMARY KEY, order_id text NOT NULL, node_id text, node_name text, saved boolean NULL,
  unsaved_guilds integer, unsaved_files integer, unanswered_guilds integer, unconfirmed_files integer, unanswered_files integer,
  resave_guilds integer NOT NULL DEFAULT 0, acked_at timestamptz NOT NULL DEFAULT now());
GRANT USAGE ON SCHEMA smdb_manager TO ${role};
GRANT SELECT ON smdb_manager.save_order TO ${role};
GRANT SELECT, INSERT, UPDATE ON smdb_manager.save_acks TO ${role};`;
}

const CURRENT_GENERATION = 'coalesce((SELECT generation FROM smdb_manager.generation), 0)';

/** The claim clock as `clock|<up_ms>`, `clock|` when the table or its row is missing; run by dbm_work, which reads smdb_data. */
export const CLAIM_CLOCK_READ_SQL = `SELECT to_regclass('smdb_data.claim_clock') IS NOT NULL AS nx5_clock \\gset
\\if :nx5_clock
SELECT 'clock|' || coalesce((SELECT up_ms::text FROM smdb_data.claim_clock WHERE id = 1), '');
\\else
SELECT 'clock|';
\\endif
`;

/** The up_ms of CLAIM_CLOCK_READ_SQL's last line; null for none; undefined when the line does not parse. */
export function parseClaimClock(text: string): number | null | undefined {
  const line = text.trim().split('\n').map(l => l.trim()).filter(Boolean).pop() ?? '';
  const m = /^clock\|(-?\d*)$/.exec(line);
  if (!m) return undefined;
  if (m[1] === '') return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) ? n : undefined;
}

/**
 * The order step's transaction: the standing row and its answers are kept, with the new message, only when the row
 * is current, at 'maintenance', carries `keepId` and has reason 'order' (or 'restore' when `keepRestore`); otherwise
 * `newId` is written with `upMs` and every answer is deleted. Its last line is
 * `<order_id>|<t when kept>|<generation>|<up_ms or empty>`.
 */
export function saveOrderSql(p: { keepId: string | null; keepRestore: boolean; newId: string; message: string; user: string; upMs: number | null }): string {
  if (p.upMs !== null && !Number.isSafeInteger(p.upMs)) throw new Error('the claim clock is not a whole number');
  const keep = p.keepId === null ? 'NULL' : sqlLiteral(p.keepId);
  const match = `order_id = ${keep} AND state = 'maintenance' AND generation = ${CURRENT_GENERATION}${p.keepRestore ? '' : " AND reason = 'order'"}`;
  const standing = `EXISTS (SELECT 1 FROM smdb_manager.save_order WHERE ${match})`;
  return `BEGIN;
${SAVE_ORDER_DDL(p.user)}
UPDATE smdb_manager.save_order SET message = ${sqlLiteral(p.message)} WHERE ${match};
DELETE FROM smdb_manager.save_acks WHERE NOT ${standing};
INSERT INTO smdb_manager.save_order AS o (one_row, order_id, state, message, generation, reason, up_ms, at)
  SELECT true, ${sqlLiteral(p.newId)}, 'maintenance', ${sqlLiteral(p.message)}, ${CURRENT_GENERATION}, 'order', ${p.upMs === null ? 'NULL' : p.upMs}, now() WHERE NOT ${standing}
  ON CONFLICT (one_row) DO UPDATE SET order_id = EXCLUDED.order_id, state = 'maintenance', message = EXCLUDED.message,
    generation = EXCLUDED.generation, reason = 'order', up_ms = EXCLUDED.up_ms, at = now();
COMMIT;
SELECT order_id || '|' || CASE WHEN order_id = ${keep} THEN 't' ELSE 'f' END || '|' || generation || '|' || coalesce(up_ms::text, '') FROM smdb_manager.save_order;
`;
}

export interface SaveOrderWritten { orderId: string; kept: boolean; generation: number; upMs: number | null }

/** saveOrderSql's last line; undefined when it does not parse. */
export function parseSaveOrderWritten(text: string): SaveOrderWritten | undefined {
  const line = text.trim().split('\n').map(l => l.trim()).filter(Boolean).pop() ?? '';
  const m = /^([^|]+)\|([tf])\|(\d+)\|(-?\d*)$/.exec(line);
  if (!m) return undefined;
  const generation = Number(m[3]);
  const upMs = m[4] === '' ? null : Number(m[4]);
  if (!Number.isSafeInteger(generation) || (upMs !== null && !Number.isSafeInteger(upMs))) return undefined;
  return { orderId: m[1], kept: m[2] === 't', generation, upMs };
}

/**
 * Running's row, in one transaction run by dbm_meta before the login opens: 'running', reason 'order', the current
 * generation and no answers; a new order id only when no row exists.
 */
export function runningOpenSql(p: { user: string; newId: string }): string {
  return `BEGIN;
${SAVE_ORDER_DDL(p.user)}
INSERT INTO smdb_manager.save_order AS o (one_row, order_id, state, message, generation, reason, up_ms, at)
  VALUES (true, ${sqlLiteral(p.newId)}, 'running', '', ${CURRENT_GENERATION}, 'order', NULL, now())
  ON CONFLICT (one_row) DO UPDATE SET state = 'running', reason = 'order', generation = EXCLUDED.generation, at = now();
DELETE FROM smdb_manager.save_acks;
COMMIT;
`;
}

/**
 * The restore's rewrite inside its raise (decision 7): the row carries `orderId` at the raised generation with reason
 * 'restore', and no answer stands. `extra` of raiseSql, so the raise's generation is the row's.
 */
export function restoreOrderSql(p: { user: string; orderId: string; message: string }): string {
  return `${SAVE_ORDER_DDL(p.user)}
DELETE FROM smdb_manager.save_acks;
INSERT INTO smdb_manager.save_order AS o (one_row, order_id, state, message, generation, reason, up_ms, at)
  VALUES (true, ${sqlLiteral(p.orderId)}, 'maintenance', ${sqlLiteral(p.message)}, ${CURRENT_GENERATION}, 'restore', NULL, now())
  ON CONFLICT (one_row) DO UPDATE SET order_id = EXCLUDED.order_id, state = 'maintenance', message = EXCLUDED.message,
    generation = EXCLUDED.generation, reason = 'restore', up_ms = NULL, at = now();
`;
}

const ACKS_JSON = `coalesce((SELECT jsonb_agg(jsonb_build_object('process', process_id, 'order', order_id, 'saved', saved,
  'unsavedGuilds', unsaved_guilds, 'unsavedFiles', unsaved_files, 'unansweredGuilds', unanswered_guilds,
  'unconfirmedFiles', unconfirmed_files, 'unansweredFiles', unanswered_files) ORDER BY process_id) FROM smdb_manager.save_acks), '[]'::jsonb)`;
const ORDER_JSON = `(SELECT jsonb_build_object('id', order_id, 'state', state, 'message', message, 'current', generation = ${CURRENT_GENERATION},
  'reason', reason, 'upMs', up_ms) FROM smdb_manager.save_order)`;

function holdersJson(standbyLeftOut: boolean): string {
  const standby = standbyLeftOut
    ? " AND NOT EXISTS (SELECT 1 FROM smdb_data.reshard x WHERE x.state IN ('standby', 'flipped') AND x.to_count = c.shard_count)"
    : '';
  return `WITH u AS (SELECT up_ms FROM smdb_manager.save_order WHERE up_ms IS NOT NULL),
r AS (SELECT c.holder_process AS p, c.holder_name AS n, c.expires_up_ms AS e, c.renewed_at AS t FROM smdb_data.shard_claims c
  WHERE NOT c.released${standby} AND EXISTS (SELECT 1 FROM u)),
h AS (SELECT p, max(n) AS n, max(t) AS t, bool_or(e > (SELECT up_ms FROM u)) AS live FROM r GROUP BY p)
SELECT jsonb_build_object('order', ${ORDER_JSON}, 'claims', true,
  'expected', coalesce((SELECT jsonb_agg(jsonb_build_object('process', p, 'name', n, 'agoMs', greatest(0, (extract(epoch FROM (now() - t)) * 1000)::bigint)) ORDER BY n, p) FROM h WHERE live), '[]'::jsonb),
  'notSeen', coalesce((SELECT jsonb_agg(jsonb_build_object('process', p, 'name', n, 'agoMs', greatest(0, (extract(epoch FROM (now() - t)) * 1000)::bigint)) ORDER BY n, p) FROM h WHERE NOT live), '[]'::jsonb),
  'acks', ${ACKS_JSON})::text;`;
}

/**
 * The read of `acks`, `final` and the lanes, run by dbm_work (smdb_manager through its grants, smdb_data through the
 * bot role): one JSON line with the order row, whether the claim tables exist, the expected set and the processes not
 * seen (decision 3, computed from the row's up_ms at each read), and every answer.
 */
export const SAVE_READ_SQL = `SELECT to_regclass('smdb_manager.save_order') IS NOT NULL AND to_regclass('smdb_manager.save_acks') IS NOT NULL AND to_regclass('smdb_manager.generation') IS NOT NULL AS nx5_order,
  to_regclass('smdb_data.shard_claims') IS NOT NULL AND to_regclass('smdb_data.claim_clock') IS NOT NULL AS nx5_claims,
  to_regclass('smdb_data.reshard') IS NOT NULL AS nx5_reshard \\gset
\\if :nx5_order
\\if :nx5_claims
\\if :nx5_reshard
${holdersJson(true)}
\\else
${holdersJson(false)}
\\endif
\\else
SELECT jsonb_build_object('order', ${ORDER_JSON}, 'claims', false, 'expected', '[]'::jsonb, 'notSeen', '[]'::jsonb, 'acks', ${ACKS_JSON})::text;
\\endif
\\else
SELECT jsonb_build_object('order', NULL, 'claims', :'nx5_claims'::boolean, 'expected', '[]'::jsonb, 'notSeen', '[]'::jsonb, 'acks', '[]'::jsonb)::text;
\\endif
`;

export interface SaveHolder { process: string; name: string; agoMs: number }
export interface SaveAck {
  process: string; order: string; saved: boolean | null;
  unsavedGuilds: number | null; unsavedFiles: number | null; unansweredGuilds: number | null; unconfirmedFiles: number | null; unansweredFiles: number | null;
}
export interface SaveRows {
  order: { id: string; state: 'maintenance' | 'running'; message: string; current: boolean; reason: 'order' | 'restore'; upMs: number | null } | null;
  claims: boolean;
  expected: SaveHolder[];
  notSeen: SaveHolder[];
  acks: SaveAck[];
}

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

function holderOf(v: unknown): SaveHolder | null {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o.process !== 'string' || typeof o.name !== 'string' || typeof o.agoMs !== 'number' || !Number.isFinite(o.agoMs)) return null;
  return { process: o.process, name: o.name, agoMs: Math.max(0, o.agoMs) };
}

function ackOf(v: unknown): SaveAck | null {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o.process !== 'string' || typeof o.order !== 'string' || !(o.saved === true || o.saved === false || o.saved === null)) return null;
  const n = (k: string) => (o[k] === undefined ? null : o[k]);
  const counts = ['unsavedGuilds', 'unsavedFiles', 'unansweredGuilds', 'unconfirmedFiles', 'unansweredFiles'].map(n);
  if (!counts.every(c => c === null || isCount(c))) return null;
  const [unsavedGuilds, unsavedFiles, unansweredGuilds, unconfirmedFiles, unansweredFiles] = counts as Array<number | null>;
  return { process: o.process, order: o.order, saved: o.saved, unsavedGuilds, unsavedFiles, unansweredGuilds, unconfirmedFiles, unansweredFiles };
}

/** SAVE_READ_SQL's last line; undefined for anything that does not have its shape. */
export function parseSaveRows(text: string): SaveRows | undefined {
  const line = text.trim().split('\n').map(l => l.trim()).filter(Boolean).pop() ?? '';
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!v || typeof v !== 'object' || typeof v.claims !== 'boolean' || !Array.isArray(v.expected) || !Array.isArray(v.notSeen) || !Array.isArray(v.acks)) return undefined;
  let order: SaveRows['order'] = null;
  if (v.order !== null) {
    const o = v.order as Record<string, unknown>;
    if (!o || typeof o.id !== 'string' || (o.state !== 'maintenance' && o.state !== 'running') || typeof o.message !== 'string'
      || typeof o.current !== 'boolean' || (o.reason !== 'order' && o.reason !== 'restore') || !(o.upMs === null || (typeof o.upMs === 'number' && Number.isSafeInteger(o.upMs)))) return undefined;
    order = { id: o.id, state: o.state, message: o.message, current: o.current, reason: o.reason, upMs: o.upMs as number | null };
  }
  const expected = v.expected.map(holderOf);
  const notSeen = v.notSeen.map(holderOf);
  const acks = v.acks.map(ackOf);
  if (expected.some(x => !x) || notSeen.some(x => !x) || acks.some(x => !x)) return undefined;
  return { order, claims: v.claims, expected: expected as SaveHolder[], notSeen: notSeen as SaveHolder[], acks: acks as SaveAck[] };
}

/** The ensure: the tables and generation 1, only on a database that is not in recovery. */
export function ensureGenerationSql(machine: string): string {
  return `DO $$ BEGIN
IF NOT pg_is_in_recovery() THEN
${TABLES}
INSERT INTO smdb_manager.generation (one_row, machine, generation) VALUES (true, ${sqlLiteral(machineText(machine))}, 1) ON CONFLICT DO NOTHING;
END IF;
END $$;`;
}

/** The raise to a target fixed in advance: idempotent, and the hand-over row goes with it. Answers the row. */
export function raiseSql(machine: string, target: number, extra = ''): string {
  if (!Number.isSafeInteger(target) || target < 1) throw new Error('the target generation is not a positive whole number');
  return `BEGIN;
${TABLES}
INSERT INTO smdb_manager.generation AS g (one_row, machine, generation, since) VALUES (true, ${sqlLiteral(machineText(machine))}, ${target}, now())
  ON CONFLICT (one_row) DO UPDATE SET machine = EXCLUDED.machine, generation = EXCLUDED.generation, since = now()
  WHERE g.generation < EXCLUDED.generation;
DELETE FROM smdb_manager.handover;
${extra}SELECT generation || '|' || machine || '|' || ${SINCE} FROM smdb_manager.generation;
COMMIT;`;
}

/** The expiry cap of NB4's shard claims: a claim expires at the claim clock it was restored or pushed with. */
export const SHARD_CAP_SET = 'expires_up_ms = LEAST(t.expires_up_ms, k.up_ms)';

/** The cap on every shard claim when the shard claims and the claim clock exist; nothing without them or the clock row. */
export const SHARD_CAP_DO_SQL = `DO $$ BEGIN
IF to_regclass('smdb_data.shard_claims') IS NOT NULL AND to_regclass('smdb_data.claim_clock') IS NOT NULL THEN
  EXECUTE 'UPDATE smdb_data.shard_claims AS t SET ${SHARD_CAP_SET} FROM smdb_data.claim_clock AS k WHERE k.id = 1';
END IF;
END $$;
`;

/** The take-over block (D35): a pg_hba line of its own that refuses the bot role over TCP on the copy. */
export const TAKEOVER_BLOCK_MARK = '# smdb-takeover-block';
export const TAKEOVER_ROLE_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HBA = '/var/lib/postgresql/data/pg_hba.conf';

/** Run as root in the copy: the block line first in the file, any older one of the mark dropped. Rerun-safe. */
export function takeoverBlockScript(user: string): string {
  if (!TAKEOVER_ROLE_RE.test(user)) throw new Error(`the bot's role name ${user} is not a plain identifier`);
  return `f=${HBA}; { printf '%s\\n' 'host all "${user}" all reject ${TAKEOVER_BLOCK_MARK}' && { grep -v '${TAKEOVER_BLOCK_MARK}$' "$f" || [ $? -eq 1 ]; }; } > "$f.tk" && chown postgres:postgres "$f.tk" && chmod 600 "$f.tk" && mv -f "$f.tk" "$f"`;
}

/** Run as root in the copy: every line of the mark removed; nothing when none is there. Rerun-safe. */
export function takeoverLiftScript(): string {
  return `f=${HBA}; [ -e "$f" ] || exit 0; grep -q '${TAKEOVER_BLOCK_MARK}$' "$f"; r=$?; [ $r -eq 1 ] && exit 0; [ $r -eq 0 ] || exit $r; sed -i '/${TAKEOVER_BLOCK_MARK}$/d' "$f" && chown postgres:postgres "$f" && chmod 600 "$f"`;
}

/** The address rows cut to this machine's own: every row but the one at host and port (all rows when null). */
export function cutAddressesSql(own: { host: string; port: number } | null): string {
  const keep = own ? ` WHERE NOT (host = %L AND port = ${Number(own.port)})` : '';
  const args = own ? `, ${sqlLiteral(own.host)}` : '';
  return `DO $$ BEGIN
IF to_regclass('smdb_manager.addresses') IS NOT NULL THEN
  EXECUTE format('DELETE FROM smdb_manager.addresses${keep}'${args});
END IF;
END $$;
`;
}

/** The generation row as `<gen>|<machine>|<since>`; a missing table is read from psql's error (missingTable). Machine logins run it, so its functions are pg_catalog's. */
export const GEN_READ_SQL = `SELECT coalesce((SELECT generation || '|' || machine || '|' || pg_catalog.${SINCE} FROM smdb_manager.generation), '0||')`;

export const HANDOVER_READ_SQL = `SELECT coalesce((SELECT slot || '|' || generation || '|' || machine FROM smdb_manager.handover), '')`;

/** The main's list of its copies (D50): one row per physical slot, named by its address row or its last client address. */
export const COPIES_SYNC_SQL = `DELETE FROM smdb_manager.copies c WHERE NOT EXISTS (SELECT 1 FROM pg_replication_slots s WHERE s.slot_name = c.slot);
INSERT INTO smdb_manager.copies AS c (slot, machine, client)
  SELECT s.slot_name, a.machine, host(r.client_addr) FROM pg_replication_slots s
    LEFT JOIN smdb_manager.addresses a ON a.slot = s.slot_name
    LEFT JOIN pg_stat_replication r ON r.pid = s.active_pid
  WHERE s.slot_type = 'physical'
  ON CONFLICT (slot) DO UPDATE SET machine = coalesce(EXCLUDED.machine, c.machine),
    client = coalesce(EXCLUDED.client, c.client), seen_at = now()
  WHERE c.machine IS DISTINCT FROM coalesce(EXCLUDED.machine, c.machine)
    OR c.client IS DISTINCT FROM coalesce(EXCLUDED.client, c.client);`;

/** The old main's other copies as `<machine>|<client>` entries joined by commas, read on the copy that takes over. */
export function COPIES_READ_SQL(ownSlot: string): string {
  return `SELECT coalesce(string_agg(coalesce(machine, '') || '|' || coalesce(client, ''), ',' ORDER BY slot), '') FROM smdb_manager.copies WHERE slot <> ${sqlLiteral(ownSlot)};`;
}

/** This machine's own copy rows whose slots still exist, as a JSON list (D49). */
export const OWN_COPIES_READ_SQL = `SELECT coalesce(json_agg(json_build_object('host', host, 'port', port, 'slot', slot, 'cert', cert, 'machine', machine) ORDER BY host, port), '[]') FROM smdb_manager.addresses a WHERE slot IS NOT NULL AND EXISTS (SELECT 1 FROM pg_replication_slots s WHERE s.slot_name = a.slot);`;

/** The copy rows written back: only rows whose slot exists, none overwritten. Empty for an empty list. */
export function copiesInsertSql(rows: JoinAddress[]): string {
  return rows.map(r => `INSERT INTO smdb_manager.addresses (host, port, slot, cert, machine) SELECT ${sqlLiteral(r.host)}, ${Number(r.port)}, ${sqlLiteral(r.slot ?? '')}, ${sqlLiteral(r.cert)}, ${sqlLiteral(r.machine)} WHERE EXISTS (SELECT 1 FROM pg_replication_slots WHERE slot_name = ${sqlLiteral(r.slot ?? '')}) ON CONFLICT (host, port) DO NOTHING;\n`).join('');
}

/** The bot database's oid as text, run on `postgres`; the empty line when the database is missing (D42). */
export function DB_OID_SQL(db: string): string {
  return `SELECT coalesce((SELECT oid::text FROM pg_database WHERE datname = ${sqlLiteral(db)}), '');`;
}

/** The newest received row of any of these push ids as `<machine>|<generation>`; the empty line for none (D53). */
export function RECEIVED_OF_SQL(ids: string[]): string {
  return `SELECT coalesce((SELECT from_machine || '|' || generation FROM smdb_manager.received WHERE push_id IN (${ids.map(sqlLiteral).join(', ')}) ORDER BY at DESC LIMIT 1), '');`;
}

/** The receive logins take no new session (D54); run on `postgres`. */
export const RECEIVE_NOLOGIN_SQL = `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'smdb_receive') THEN ALTER ROLE smdb_receive NOLOGIN; END IF; IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'smdb_receive_meta') THEN ALTER ROLE smdb_receive_meta NOLOGIN; END IF; END $$;`;

/** One round of ending both receive logins' sessions; the last line is the sessions left. */
export const RECEIVE_END_SQL = `SELECT count(pg_terminate_backend(pid, 5000)) FROM pg_stat_activity WHERE usename IN ('smdb_receive', 'smdb_receive_meta') AND pid <> pg_backend_pid(); SELECT count(*) FROM pg_stat_activity WHERE usename IN ('smdb_receive', 'smdb_receive_meta');`;

export const RECEIVE_DROP_SQL = 'DROP ROLE IF EXISTS smdb_receive, smdb_receive_meta;';

export const JOIN_LOGIN = 'smdb_join';
export const COPY_GROUP = 'smdb_copies';
export const MINTER = 'smdb_minter';
export const COPY_LOGIN_RE = /^smdb_copy_[0-9a-f]{32}$/;
const COPY_SLOT_RE = /^fleet_standby_([0-9a-f]{32})$/;
const VERIFIER_RE = /^SCRAM-SHA-256\$[0-9]+:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/;

/** This machine's own replication login on every database of its lineage: the instance id without its dashes. */
export function copyLogin(instanceId: string): string {
  return `smdb_copy_${instanceId.replace(/-/g, '')}`;
}

/** The slot of copyLogin(instanceId): the same 32 hex characters. */
export function copySlot(instanceId: string): string {
  return `fleet_standby_${instanceId.replace(/-/g, '')}`;
}

/** The machine login a slot belongs to; null for a name that is not a machine's slot. */
export function loginOfSlot(slot: string): string | null {
  const m = COPY_SLOT_RE.exec(slot);
  return m ? `smdb_copy_${m[1]}` : null;
}

function machineLoginOnly(login: string): string {
  if (!COPY_LOGIN_RE.test(login)) throw new Error(`${login} is not a machine login name`);
  return login;
}

function verifierOnly(verifier: string): string {
  if (!VERIFIER_RE.test(verifier)) throw new Error('the password is not a SCRAM-SHA-256 verifier');
  return verifier;
}

/** C3: every membership that breaks Invariant L, revoked as the role that granted it. */
export const MEMBERSHIP_REPAIR_SQL = `DO $$ DECLARE r record; BEGIN
  FOR r IN
    SELECT pg_catalog.pg_get_userbyid(m.roleid) AS role, pg_catalog.pg_get_userbyid(m.member) AS member,
           pg_catalog.pg_get_userbyid(m.grantor) AS grantor,
           (pg_catalog.pg_get_userbyid(m.member) ~ '^smdb_copy_[0-9a-f]{32}$' AND m.roleid = 'smdb_copies'::regrole AND m.admin_option) AS admin_only,
           (m.member = 'smdb_minter'::regrole AND m.roleid = 'smdb_copies'::regrole) AS minter
    FROM pg_catalog.pg_auth_members m
    WHERE (m.roleid = 'smdb_copies'::regrole
            AND pg_catalog.pg_get_userbyid(m.member) !~ '^smdb_copy_[0-9a-f]{32}$'
            AND NOT (m.member = 'smdb_minter'::regrole AND m.grantor = 10))
       OR (m.roleid = 'smdb_copies'::regrole AND m.admin_option AND pg_catalog.pg_get_userbyid(m.member) ~ '^smdb_copy_[0-9a-f]{32}$')
       OR (pg_catalog.pg_get_userbyid(m.member) ~ '^smdb_copy_[0-9a-f]{32}$' AND m.roleid <> 'smdb_copies'::regrole)
       OR (pg_catalog.pg_get_userbyid(m.roleid) ~ '^smdb_copy_[0-9a-f]{32}$' AND m.member <> 'smdb_minter'::regrole)
       OR m.member IN (pg_catalog.to_regrole('smdb_join'), 'smdb_copies'::regrole)
       OR (m.member = 'smdb_minter'::regrole AND m.roleid <> 'smdb_copies'::regrole AND pg_catalog.pg_get_userbyid(m.roleid) !~ '^smdb_copy_[0-9a-f]{32}$')
  LOOP
    IF r.admin_only THEN
      EXECUTE pg_catalog.format('REVOKE ADMIN OPTION FOR %I FROM %I GRANTED BY %I CASCADE', r.role, r.member, r.grantor);
    ELSIF r.minter THEN
      EXECUTE pg_catalog.format('REVOKE %I FROM %I GRANTED BY %I', r.role, r.member, r.grantor);
    ELSE
      EXECUTE pg_catalog.format('REVOKE %I FROM %I GRANTED BY %I CASCADE', r.role, r.member, r.grantor);
    END IF;
  END LOOP;
END $$;
`;

/** R18: the session settings anyone put on the join login, the minter, the group or a machine login. */
export const SETTINGS_REPAIR_SQL = `DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT pg_catalog.pg_get_userbyid(s.setrole) AS role, db.datname AS d
           FROM pg_catalog.pg_db_role_setting s LEFT JOIN pg_catalog.pg_database db ON db.oid = s.setdatabase
           WHERE pg_catalog.pg_get_userbyid(s.setrole) IN ('smdb_join', 'smdb_minter', 'smdb_copies')
              OR pg_catalog.pg_get_userbyid(s.setrole) ~ '^smdb_copy_[0-9a-f]{32}$' LOOP
    IF r.d IS NULL THEN EXECUTE pg_catalog.format('ALTER ROLE %I RESET ALL', r.role);
    ELSE EXECUTE pg_catalog.format('ALTER ROLE %I IN DATABASE %I RESET ALL', r.role, r.d); END IF;
  END LOOP;
END $$;
`;

/** G1: the rights COPY_ROLES_READ_SQL's login-rights reads, taken off every role on the machine-login pattern; LOGIN and REPLICATION are left. */
export const LOGIN_RIGHTS_REPAIR_SQL = `DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT p.rolname AS n FROM pg_catalog.pg_roles p
           WHERE p.rolname ~ '^smdb_copy_[0-9a-f]{32}$' AND (p.rolsuper OR p.rolcreatedb OR p.rolcreaterole OR p.rolbypassrls) LOOP
    EXECUTE pg_catalog.format('ALTER ROLE %I NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS', r.n);
  END LOOP;
END $$;
`;

/** G2: every grantee of add_copy_login but its owner revoked, with what it passed on; a NULL ACL reads as PUBLIC's default. */
export const FUNCTION_ACL_REPAIR_SQL = `DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT DISTINCT a.grantee FROM pg_catalog.pg_proc p, pg_catalog.aclexplode(COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
           WHERE p.oid = pg_catalog.to_regprocedure('smdb_manager.add_copy_login(text, text)') AND a.grantee <> p.proowner LOOP
    IF r.grantee = 0 THEN
      EXECUTE 'REVOKE ALL ON FUNCTION smdb_manager.add_copy_login(text, text) FROM PUBLIC CASCADE';
    ELSE
      EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION smdb_manager.add_copy_login(text, text) FROM %I CASCADE', pg_catalog.pg_get_userbyid(r.grantee));
    END IF;
  END LOOP;
END $$;
`;

/** 3.3: the group, the minter and the minting function, run by Enable as the superuser on postgres inside its transaction. */
export const COPY_ROLES_SQL = `DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'smdb_copies') THEN CREATE ROLE smdb_copies NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'smdb_minter') THEN CREATE ROLE smdb_minter NOLOGIN CREATEROLE REPLICATION; END IF;
END $$;
ALTER ROLE smdb_copies NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE smdb_minter NOLOGIN NOSUPERUSER NOCREATEDB CREATEROLE REPLICATION NOBYPASSRLS;
${MEMBERSHIP_REPAIR_SQL}${SETTINGS_REPAIR_SQL}${LOGIN_RIGHTS_REPAIR_SQL}GRANT smdb_copies TO smdb_minter WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;
CREATE SCHEMA IF NOT EXISTS smdb_manager;
CREATE OR REPLACE FUNCTION smdb_manager.add_copy_login(p_name text, p_verifier text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $f$
BEGIN
  IF p_name IS NULL OR p_name !~ '^smdb_copy_[0-9a-f]{32}$' THEN
    RAISE EXCEPTION 'smdb-join: % is not a machine login name', p_name;
  END IF;
  IF p_verifier IS NULL OR p_verifier !~ '^SCRAM-SHA-256\\$[0-9]+:[A-Za-z0-9+/=]+\\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$' THEN
    RAISE EXCEPTION 'smdb-join: the password is not a SCRAM-SHA-256 verifier';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = p_name) THEN
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m
               WHERE m.member = pg_catalog.to_regrole(p_name) AND m.roleid = pg_catalog.to_regrole('smdb_copies')) THEN
      RETURN 'exists';
    END IF;
    RETURN 'blocked';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_roles WHERE rolname ~ '^smdb_copy_') >= 100 THEN
    RAISE EXCEPTION 'smdb-join: this database already has 100 machine logins; remove the ones no longer used in the main''s Database window';
  END IF;
  EXECUTE pg_catalog.format('CREATE ROLE %I LOGIN REPLICATION NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS INHERIT PASSWORD %L IN ROLE smdb_copies', p_name, p_verifier);
  RETURN 'created';
END $f$;
ALTER FUNCTION smdb_manager.add_copy_login(text, text) OWNER TO smdb_minter;
${FUNCTION_ACL_REPAIR_SQL}GRANT EXECUTE ON FUNCTION smdb_manager.add_copy_login(text, text) TO smdb_join;
GRANT USAGE ON SCHEMA smdb_manager TO smdb_join;
`;

/** 3.3: the join login's statement, CREATE when missing and ALTER when present. */
export function joinLoginSql(exists: boolean, verifier: string): string {
  return `${exists ? 'ALTER' : 'CREATE'} ROLE smdb_join LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${verifierOnly(verifier)}';\n`;
}

/** 3.3: this machine's own login on its main, in the group. */
export function ownLoginSql(login: string, exists: boolean, verifier: string): string {
  const name = machineLoginOnly(login);
  const v = verifierOnly(verifier);
  return exists
    ? `ALTER ROLE ${name} LOGIN REPLICATION PASSWORD '${v}';\nGRANT smdb_copies TO ${name};\n`
    : `CREATE ROLE ${name} LOGIN REPLICATION NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS INHERIT PASSWORD '${v}' IN ROLE smdb_copies;\n`;
}

/**
 * G3: Enable's role step without its BEGIN, QUIET_ROLE_SESSION_SQL and COMMIT: the join login first (COPY_ROLES_SQL
 * grants to it), then COPY_ROLES_SQL, this machine's own login (it needs smdb_copies), then the reopening loop.
 */
export function copyRolesStepSql(o: { joinExists: boolean; joinVerifier: string; ownLogin: string; ownExists: boolean; ownVerifier: string }): string {
  return `${joinLoginSql(o.joinExists, o.joinVerifier)}${COPY_ROLES_SQL}${ownLoginSql(o.ownLogin, o.ownExists, o.ownVerifier)}${copyLoginsLoopSql('LOGIN')}`;
}

/** 3.3 and 3.6.2: every member of the group opened (Enable) or closed (Disable). */
export function copyLoginsLoopSql(attr: 'LOGIN' | 'NOLOGIN'): string {
  return `DO $$ DECLARE r record; BEGIN FOR r IN SELECT m.member::regrole::text AS n FROM pg_catalog.pg_auth_members m WHERE m.roleid = 'smdb_copies'::regrole AND m.member::regrole::text ~ '^smdb_copy_[0-9a-f]{32}$' LOOP EXECUTE pg_catalog.format('ALTER ROLE %I ${attr === 'LOGIN' ? 'LOGIN' : 'NOLOGIN'}', r.n); END LOOP; END $$;\n`;
}

export const COPY_ROLES_KEYS = ['join-missing', 'join-rights', 'join-member', 'group-missing', 'group-rights', 'minter-missing',
  'minter-rights', 'minter-grant', 'minter-member', 'login-rights', 'login-member', 'login-admin', 'login-granted', 'group-member',
  'function-missing', 'function-owner', 'function-acl', 'function-path', 'function-definer', 'role-settings'] as const;
export type CopyRolesKey = (typeof COPY_ROLES_KEYS)[number];

/** 3.6.4 with C3 and R18: `copyroles|ok`, or the keys of every finding against Invariant L's postgres half, in COPY_ROLES_KEYS order. */
export const COPY_ROLES_READ_SQL = `WITH f AS (SELECT p.proowner, p.prosecdef, p.proconfig, p.proacl FROM pg_catalog.pg_proc p
    WHERE p.oid = pg_catalog.to_regprocedure('smdb_manager.add_copy_login(text, text)')),
  m AS (SELECT pg_catalog.pg_get_userbyid(m.roleid) AS role, pg_catalog.pg_get_userbyid(m.member) AS mem, m.grantor, m.admin_option,
      m.inherit_option, m.set_option FROM pg_catalog.pg_auth_members m),
  r AS (SELECT * FROM pg_catalog.pg_roles),
  k(o, key, hit) AS (VALUES
    (1, 'join-missing', NOT EXISTS (SELECT 1 FROM r WHERE r.rolname = 'smdb_join')),
    (2, 'join-rights', EXISTS (SELECT 1 FROM r WHERE r.rolname = 'smdb_join'
      AND (NOT r.rolcanlogin OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls))),
    (3, 'join-member', EXISTS (SELECT 1 FROM m WHERE m.mem = 'smdb_join')),
    (4, 'group-missing', NOT EXISTS (SELECT 1 FROM r WHERE r.rolname = 'smdb_copies')),
    (5, 'group-rights', EXISTS (SELECT 1 FROM r WHERE r.rolname = 'smdb_copies'
      AND (r.rolcanlogin OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls))
      OR EXISTS (SELECT 1 FROM m WHERE m.mem = 'smdb_copies')),
    (6, 'minter-missing', NOT EXISTS (SELECT 1 FROM r WHERE r.rolname = 'smdb_minter')),
    (7, 'minter-rights', EXISTS (SELECT 1 FROM r WHERE r.rolname = 'smdb_minter'
      AND (r.rolcanlogin OR NOT r.rolcreaterole OR NOT r.rolreplication OR r.rolsuper OR r.rolcreatedb OR r.rolbypassrls))),
    (8, 'minter-grant', EXISTS (SELECT 1 FROM r WHERE r.rolname = 'smdb_minter') AND EXISTS (SELECT 1 FROM r WHERE r.rolname = 'smdb_copies')
      AND NOT (EXISTS (SELECT 1 FROM m WHERE m.mem = 'smdb_minter' AND m.role = 'smdb_copies' AND m.admin_option
                       AND NOT m.inherit_option AND NOT m.set_option AND m.grantor = 10)
               AND (SELECT pg_catalog.count(*) FROM m WHERE m.mem = 'smdb_minter' AND m.role = 'smdb_copies') = 1)),
    (9, 'minter-member', EXISTS (SELECT 1 FROM m WHERE m.mem = 'smdb_minter' AND m.role <> 'smdb_copies' AND m.role !~ '^smdb_copy_[0-9a-f]{32}$')),
    (10, 'login-rights', EXISTS (SELECT 1 FROM r WHERE r.rolname ~ '^smdb_copy_[0-9a-f]{32}$'
      AND (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolbypassrls))),
    (11, 'login-member', EXISTS (SELECT 1 FROM m WHERE m.mem ~ '^smdb_copy_[0-9a-f]{32}$' AND m.role <> 'smdb_copies')),
    (12, 'login-admin', EXISTS (SELECT 1 FROM m WHERE m.mem ~ '^smdb_copy_[0-9a-f]{32}$' AND m.role = 'smdb_copies' AND m.admin_option)),
    (13, 'login-granted', EXISTS (SELECT 1 FROM m WHERE m.role ~ '^smdb_copy_[0-9a-f]{32}$' AND m.mem <> 'smdb_minter')),
    (14, 'group-member', EXISTS (SELECT 1 FROM m WHERE m.role = 'smdb_copies' AND m.mem !~ '^smdb_copy_[0-9a-f]{32}$' AND m.mem <> 'smdb_minter')),
    (15, 'function-missing', NOT EXISTS (SELECT 1 FROM f)),
    (16, 'function-owner', EXISTS (SELECT 1 FROM f WHERE f.proowner IS DISTINCT FROM pg_catalog.to_regrole('smdb_minter')::oid)),
    (17, 'function-acl', EXISTS (SELECT 1 FROM f, pg_catalog.aclexplode(COALESCE(f.proacl, pg_catalog.acldefault('f', f.proowner))) a
      WHERE a.privilege_type = 'EXECUTE' AND a.grantee <> f.proowner AND a.grantee IS DISTINCT FROM pg_catalog.to_regrole('smdb_join')::oid)),
    (18, 'function-path', EXISTS (SELECT 1 FROM f WHERE f.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']::text[])),
    (19, 'function-definer', EXISTS (SELECT 1 FROM f WHERE NOT f.prosecdef)),
    (20, 'role-settings', EXISTS (SELECT 1 FROM pg_catalog.pg_db_role_setting s
      WHERE pg_catalog.pg_get_userbyid(s.setrole) IN ('smdb_join', 'smdb_minter', 'smdb_copies')
         OR pg_catalog.pg_get_userbyid(s.setrole) ~ '^smdb_copy_[0-9a-f]{32}$')))
SELECT 'copyroles|' || COALESCE(pg_catalog.string_agg(k.key, ',' ORDER BY k.o), 'ok') FROM k WHERE k.hit;`;

/** The keys of COPY_ROLES_READ_SQL's one line ([] for ok); null for any other answer. */
export function parseCopyRoles(out: string): CopyRolesKey[] | null {
  const m = /^copyroles\|([a-z,-]+)$/.exec(out.replace(/\n$/, ''));
  if (!m) return null;
  if (m[1] === 'ok') return [];
  const keys = m[1].split(',');
  let at = -1;
  for (const key of keys) {
    const i = (COPY_ROLES_KEYS as readonly string[]).indexOf(key);
    if (i <= at) return null;
    at = i;
  }
  return keys as CopyRolesKey[];
}

/** 3.4 with R10: the address table and the two functions a machine login writes its own row through, run as dbm_meta inside the caller's transaction. */
export const ADDRESS_DDL_SQL = `CREATE SCHEMA IF NOT EXISTS smdb_manager;
CREATE TABLE IF NOT EXISTS smdb_manager.addresses (
  host text NOT NULL, port integer NOT NULL, slot text, cert text NOT NULL, machine text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (host, port));
CREATE OR REPLACE FUNCTION smdb_manager.set_copy_address(p_host text, p_port integer, p_cert text, p_machine text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $f$
DECLARE v_login text := session_user; v_slot text; v_n integer; v_holder text;
BEGIN
  IF v_login !~ '^smdb_copy_[0-9a-f]{32}$' OR NOT pg_catalog.pg_has_role(v_login, 'smdb_copies', 'MEMBER') THEN
    RAISE EXCEPTION 'smdb-address: % is not a machine login', v_login;
  END IF;
  v_slot := 'fleet_standby_' || pg_catalog.substr(v_login, 11);
  IF p_host IS NULL OR pg_catalog.length(p_host) > 253 OR p_host !~ '^[A-Za-z0-9][A-Za-z0-9.-]*$' THEN
    RAISE EXCEPTION 'smdb-address: the host is not a bare hostname or IPv4 address';
  END IF;
  IF p_port IS NULL OR p_port < 1 OR p_port > 65535 THEN RAISE EXCEPTION 'smdb-address: the port is not a port number'; END IF;
  IF p_cert IS NULL OR pg_catalog.octet_length(p_cert) > 65536 OR p_cert !~ '^-----BEGIN CERTIFICATE-----.+-----END CERTIFICATE-----$' THEN
    RAISE EXCEPTION 'smdb-address: the certificate is not a PEM certificate block';
  END IF;
  IF p_machine IS NULL OR p_machine !~ '^[ -~]{1,64}$' THEN RAISE EXCEPTION 'smdb-address: the machine name is not 1 to 64 printable characters'; END IF;
  IF NOT EXISTS (SELECT 1 FROM smdb_manager.addresses WHERE slot = v_slot)
     AND (SELECT count(*) FROM smdb_manager.addresses) >= 1000 THEN
    RAISE EXCEPTION 'smdb-address: the address list already holds 1000 rows';
  END IF;
  DELETE FROM smdb_manager.addresses WHERE slot = v_slot AND NOT (host = p_host AND port = p_port);
  INSERT INTO smdb_manager.addresses AS a (host, port, slot, cert, machine) VALUES (p_host, p_port, v_slot, p_cert, p_machine)
    ON CONFLICT (host, port) DO UPDATE SET cert = EXCLUDED.cert, machine = EXCLUDED.machine, updated_at = pg_catalog.now()
    WHERE a.slot = v_slot;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN
    SELECT a.slot INTO v_holder FROM smdb_manager.addresses a WHERE a.host = p_host AND a.port = p_port;
    IF v_holder IS NULL THEN RAISE EXCEPTION 'smdb-address-taken: %:% is listed as the main''s own address', p_host, p_port; END IF;
    RAISE EXCEPTION 'smdb-address-taken: %:% is listed with the slot %', p_host, p_port, v_holder;
  END IF;
END $f$;
CREATE OR REPLACE FUNCTION smdb_manager.drop_copy_address() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $f$
DECLARE v_n integer;
BEGIN
  IF session_user !~ '^smdb_copy_[0-9a-f]{32}$' THEN RAISE EXCEPTION 'smdb-address: % is not a machine login', session_user; END IF;
  DELETE FROM smdb_manager.addresses WHERE slot = 'fleet_standby_' || pg_catalog.substr(session_user, 11);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END $f$;
REVOKE ALL ON FUNCTION smdb_manager.set_copy_address(text, integer, text, text), smdb_manager.drop_copy_address() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION smdb_manager.set_copy_address(text, integer, text, text), smdb_manager.drop_copy_address() TO smdb_copies;
GRANT USAGE ON SCHEMA smdb_manager TO smdb_copies;
GRANT SELECT ON smdb_manager.addresses TO smdb_copies, dbm_work;
`;

/** The main's own row (slot NULL), every other main row taken off first: a database has one main (R10). */
export function OWN_ADDRESS_SQL(host: string, port: number, certPem: string, machine: string): string {
  const h = sqlLiteral(host);
  const p = Number(port);
  return `DELETE FROM smdb_manager.addresses WHERE slot IS NULL AND NOT (host = ${h} AND port = ${p});
INSERT INTO smdb_manager.addresses (host, port, slot, cert, machine) VALUES (${h}, ${p}, NULL, ${sqlLiteral(certPem)}, ${sqlLiteral(machine)})
  ON CONFLICT (host, port) DO UPDATE SET slot = NULL, cert = EXCLUDED.cert, machine = EXCLUDED.machine, updated_at = now();
`;
}

/** The machine logins' group, made when this cluster lacks it, so ADDRESS_DDL_SQL's grants and a dump's apply (3.10). */
export function copyGroupEnsureSql(): string {
  return `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'smdb_copies') THEN CREATE ROLE smdb_copies NOLOGIN; END IF; END $$;`;
}

/** R3 step 1: streams on a machine's slot by any login but that slot's own, as `<slot>|<user>|<pid>`. */
export const FOREIGN_READ_SQL = `SELECT s.slot_name || '|' || r.usename || '|' || r.pid
FROM pg_catalog.pg_replication_slots s JOIN pg_catalog.pg_stat_replication r ON r.pid = s.active_pid
WHERE s.slot_name ~ '^fleet_standby_[0-9a-f]{32}$'
  AND r.usename IS DISTINCT FROM 'smdb_copy_' || pg_catalog.substr(s.slot_name, 15);`;

export interface ForeignStream { slot: string; user: string; pid: number }

/** FOREIGN_READ_SQL's lines; a non-empty line of another shape is unread. */
export function parseForeignStreams(out: string): { streams: ForeignStream[]; unread: string[] } {
  const streams: ForeignStream[] = [];
  const unread: string[] = [];
  for (const line of out.split('\n')) {
    if (line === '') continue;
    const m = /^(fleet_standby_[0-9a-f]{32})\|([^|]{1,63})\|([0-9]{1,10})$/.exec(line);
    if (m) streams.push({ slot: m[1], user: m[2], pid: Number(m[3]) });
    else unread.push(line);
  }
  return { streams, unread };
}

/** R3 step 1b: the stream on a machine's slot ended, the slot dropped once inactive; the last line is `slot|kept` or `slot|dropped`. */
export function TAINTED_SLOT_SQL(slot: string): string {
  if (!COPY_SLOT_RE.test(slot)) throw new Error(`${slot} is not a machine's slot name`);
  return `SELECT pg_catalog.pg_terminate_backend(active_pid, 5000)::text FROM pg_catalog.pg_replication_slots WHERE slot_name = '${slot}' AND active_pid IS NOT NULL;
DO $$ BEGIN
  PERFORM pg_catalog.pg_drop_replication_slot(slot_name) FROM pg_catalog.pg_replication_slots WHERE slot_name = '${slot}' AND NOT active;
EXCEPTION WHEN object_in_use THEN NULL;
END $$;
SELECT 'slot|' || coalesce((SELECT 'kept' FROM pg_catalog.pg_replication_slots WHERE slot_name = '${slot}'), 'dropped');`;
}

/** R3 step 2: the TCP sessions of machine logins outside the group, ended, as `<login>|<true or false>`. */
export const BLOCKED_SESSIONS_SQL = `SELECT a.usename || '|' || pg_catalog.pg_terminate_backend(a.pid, 5000)::text
FROM pg_catalog.pg_stat_activity a
WHERE a.usename ~ '^smdb_copy_[0-9a-f]{32}$' AND a.client_addr IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member = a.usesysid AND m.roleid = pg_catalog.to_regrole('smdb_copies'));`;

/** R3 step 3: the large objects in postgres, counted per owner, then unlinked. */
export const LOBJ_SWEEP_SQL = `SELECT pg_catalog.pg_get_userbyid(l.lomowner) || '|' || pg_catalog.count(*) FROM pg_catalog.pg_largeobject_metadata l GROUP BY l.lomowner ORDER BY 1;
SELECT 'unlinked|' || pg_catalog.count(pg_catalog.lo_unlink(l.oid)) FROM pg_catalog.pg_largeobject_metadata l;`;

/** R3 step 4: the members of the group, joined by commas. */
export const NEW_LOGINS_READ_SQL = "SELECT string_agg(m.member::regrole::text, ',' ORDER BY 1) FROM pg_auth_members m WHERE m.roleid = to_regrole('smdb_copies')";

function settingsRoleOnly(role: string): string {
  if (role !== JOIN_LOGIN && role !== MINTER && role !== COPY_GROUP && !COPY_LOGIN_RE.test(role)) throw new Error(`${role} is not a role whose settings the manager clears`);
  return role;
}

/** R18: every setting of a role, per database and role-wide. */
export function ROLE_SETTINGS_RESET_SQL(role: string): string {
  const name = settingsRoleOnly(role);
  return `DO $$ DECLARE d text; BEGIN
  FOR d IN SELECT db.datname FROM pg_catalog.pg_db_role_setting s JOIN pg_catalog.pg_database db ON db.oid = s.setdatabase
           WHERE s.setrole = pg_catalog.to_regrole('${name}') LOOP
    EXECUTE pg_catalog.format('ALTER ROLE %I IN DATABASE %I RESET ALL', '${name}', d);
  END LOOP;
END $$;
ALTER ROLE "${name}" RESET ALL;
`;
}

/** The first statement after BEGIN of every transaction that writes roles: a lock it waits on fails it after 5 s. */
export const ROLE_LOCK_LIMIT_SQL = "SET LOCAL lock_timeout = '5s';\n";

/** 3.6.2: Disable closes the join login and every member of the group in one transaction; only smdb_join's sessions are ended. */
export const DISABLE_CLOSE_SQL = `BEGIN;\n${lockedRoleWriteSql([JOIN_LOGIN])}ALTER ROLE ${JOIN_LOGIN} NOLOGIN;\n${copyLoginsLoopSql('NOLOGIN')}COMMIT;\n`;

/** lockedRoleWriteSql's count of the sessions it ended, from a run's stdout; 0 when the line is absent. */
export function closedCount(stdout: string): number {
  const m = /^closed\|(\d+)$/m.exec(stdout);
  return m ? Number(m[1]) : 0;
}

/**
 * Opens a role-writing transaction: a 5 s lock limit, then the sessions of the logins whose role rows it writes ended,
 * so an open ALTER ROLE of theirs cannot hold the transaction.
 */
export function lockedRoleWriteSql(logins: string[]): string {
  const names = logins.map(l => (l === JOIN_LOGIN ? l : machineLoginOnly(l)));
  return `${ROLE_LOCK_LIMIT_SQL}SELECT 'closed|' || pg_catalog.count(*) FILTER (WHERE pg_catalog.pg_terminate_backend(a.pid, 5000)) FROM pg_catalog.pg_stat_activity a WHERE a.usename IN (${names.map(n => `'${n}'`).join(', ')}) AND a.pid <> pg_catalog.pg_backend_pid();
`;
}

/**
 * The last statement before a role transaction's COMMIT. psql sends a statement only after the previous one's result
 * and ON_ERROR_STOP stops it at an error, so its `committing` line shows that COMMIT was sent.
 */
export const COMMITTING_SQL = "SELECT 'committing';\n";

/** R4 step 1 with R18 and R31: the login blocked in one transaction, then `blocked|<not a member>|<NOLOGIN>|<no password, no setting>`. */
export function REMOVE_BLOCK_SQL(login: string): string {
  const name = machineLoginOnly(login);
  return `BEGIN;
${lockedRoleWriteSql([name])}DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT pg_catalog.pg_get_userbyid(m.grantor) AS g FROM pg_catalog.pg_auth_members m
           WHERE m.roleid = pg_catalog.to_regrole('smdb_copies') AND m.member = pg_catalog.to_regrole('${name}') LOOP
    EXECUTE pg_catalog.format('REVOKE smdb_copies FROM %I GRANTED BY %I', '${name}', r.g);
  END LOOP;
END $$;
ALTER ROLE "${name}" NOLOGIN PASSWORD NULL;
${ROLE_SETTINGS_RESET_SQL(name)}${COMMITTING_SQL}COMMIT;
SELECT 'blocked|' || (NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member = r.oid AND m.roleid = pg_catalog.to_regrole('smdb_copies')))::text
  || '|' || (NOT r.rolcanlogin)::text
  || '|' || (r.rolpassword IS NULL AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_db_role_setting s WHERE s.setrole = r.oid))::text
FROM pg_catalog.pg_authid r WHERE r.rolname = '${name}';
`;
}

export type BlockAnswer = { state: 'blocked'; clean: boolean } | { state: 'again'; line: string } | { state: 'unconfirmed' } | { state: 'none' };

// The error line psql prints when it stops: a server ERROR, FATAL or PANIC, or psql's own error.
const PSQL_STOP_LINE = /^psql:[^ ]*: (?:(?:ERROR|FATAL|PANIC):|error:) |^psql: error: /;

/** Whether stderr holds the error line psql prints when it stops. */
export function hasPsqlStopLine(stderr: string): boolean {
  return stderr.split('\n').some(l => PSQL_STOP_LINE.test(l));
}

/**
 * psql's own word that it stopped before COMMIT was sent: the run failed by itself (not on its time limit), printed
 * no `committing` line, and its stderr holds psql's error line. Any other run with no result line may have committed.
 */
export function stoppedBeforeCommit(stdout: string, run: { ok: boolean; stderr: string; timedOut?: boolean }): boolean {
  return !run.ok && !run.timedOut && !stdout.split('\n').some(l => l.trim() === 'committing')
    && hasPsqlStopLine(run.stderr);
}

/**
 * R31 and R40: go on when the membership and LOGIN fields are true; another `blocked|` line was undone. Without one,
 * none when psql stopped before COMMIT (stoppedBeforeCommit), else unconfirmed: the block may have committed.
 */
export function parseRemoveBlock(out: string, run: { ok: boolean; stderr: string; timedOut?: boolean } = { ok: true, stderr: '' }): BlockAnswer {
  const lines = out.split('\n').filter(l => l.startsWith('blocked|'));
  const line = lines[lines.length - 1];
  if (line === undefined) return stoppedBeforeCommit(out, run) ? { state: 'none' } : { state: 'unconfirmed' };
  const m = /^blocked\|true\|true\|(true|false)$/.exec(line);
  return m ? { state: 'blocked', clean: m[1] === 'true' } : { state: 'again', line };
}

/** R32: which of smdb_join, smdb_minter, smdb_copies and the machine logins hold session settings, joined by commas. */
export const SETTINGS_HOLDERS_SQL = `SELECT coalesce(pg_catalog.string_agg(DISTINCT pg_catalog.pg_get_userbyid(s.setrole), ',' ORDER BY pg_catalog.pg_get_userbyid(s.setrole)), '')
FROM pg_catalog.pg_db_role_setting s
WHERE pg_catalog.pg_get_userbyid(s.setrole) IN ('smdb_join', 'smdb_minter', 'smdb_copies')
   OR pg_catalog.pg_get_userbyid(s.setrole) ~ '^smdb_copy_[0-9a-f]{32}$';`;

/** R4: every machine login with its membership, its slot and the client streaming on it, as a JSON list. */
export const LOGINS_READ_SQL = `SELECT coalesce(pg_catalog.json_agg(pg_catalog.json_build_object('login', r.rolname,
  'member', EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member = r.oid AND m.roleid = pg_catalog.to_regrole('smdb_copies')),
  'canLogin', r.rolcanlogin, 'slot', s.slot_name, 'active', s.active, 'walStatus', s.wal_status, 'client', pg_catalog.host(st.client_addr)) ORDER BY r.rolname), '[]')
FROM pg_catalog.pg_roles r
LEFT JOIN pg_catalog.pg_replication_slots s ON s.slot_name = 'fleet_standby_' || pg_catalog.substr(r.rolname, 11)
LEFT JOIN pg_catalog.pg_stat_replication st ON st.pid = s.active_pid
WHERE r.rolname ~ '^smdb_copy_[0-9a-f]{32}$';`;

/** Whether the old main's host and port are listed as this main's copy, with a slot that exists (D56). */
export function FORMER_LISTED_SQL(host: string, port: number): string {
  return `SELECT count(*) FROM smdb_manager.addresses a WHERE slot IS NOT NULL AND host = ${sqlLiteral(host)} AND port = ${Number(port)} AND EXISTS (SELECT 1 FROM pg_replication_slots s WHERE s.slot_name = a.slot);`;
}

const RECEIVE_MARK_TABLE = `CREATE SCHEMA IF NOT EXISTS smdb_manager;
CREATE TABLE IF NOT EXISTS smdb_manager.receive_mark (
  one_row boolean PRIMARY KEY DEFAULT true CHECK (one_row), mark_id text NOT NULL, push_ids text NOT NULL,
  db_oid text NOT NULL, at timestamptz NOT NULL DEFAULT now());
GRANT USAGE ON SCHEMA smdb_manager TO PUBLIC;
GRANT SELECT ON smdb_manager.receive_mark TO PUBLIC;`;

/** The receive mark (D62), run on `postgres`: one row, replaced at every Receive. */
export function receiveMarkSql(markId: string, pushIds: string[], dbOid: string): string {
  return `${RECEIVE_MARK_TABLE}
INSERT INTO smdb_manager.receive_mark AS m (one_row, mark_id, push_ids, db_oid, at)
  VALUES (true, ${sqlLiteral(markId)}, ${sqlLiteral(pushIds.join(','))}, ${sqlLiteral(dbOid)}, now())
  ON CONFLICT (one_row) DO UPDATE SET mark_id = EXCLUDED.mark_id, push_ids = EXCLUDED.push_ids,
    db_oid = EXCLUDED.db_oid, at = now();`;
}

export const RECEIVE_MARK_READ_SQL = `SELECT coalesce((SELECT mark_id || '|' || push_ids || '|' || db_oid FROM smdb_manager.receive_mark), '')`;
export const RECEIVE_MARK_COUNT_SQL = 'SELECT pg_catalog.count(*) FROM smdb_manager.receive_mark';

/** The mark removed: only the row of this mark id, or any row when null. Rerun-safe; nothing without the table. */
export function receiveMarkClearSql(markId: string | null): string {
  return `DO $$ BEGIN
IF to_regclass('smdb_manager.receive_mark') IS NOT NULL THEN
  DELETE FROM smdb_manager.receive_mark${markId === null ? '' : ` WHERE mark_id = ${sqlLiteral(markId)}`};
END IF;
END $$;`;
}

export interface ReceiveMark { markId: string; pushIds: string[]; dbOid: string }

/** The mark from RECEIVE_MARK_READ_SQL's line; null when absent; undefined when it does not parse. */
export function parseReceiveMark(text: string): ReceiveMark | null | undefined {
  const line = text.trim().split('\n').map(l => l.trim()).filter(Boolean).pop() ?? '';
  if (line === '') return null;
  const m = /^([0-9a-f]+)\|([0-9a-f]+(?:,[0-9a-f]+)*)\|([0-9]*)$/.exec(line);
  return m ? { markId: m[1], pushIds: m[2].split(','), dbOid: m[3] } : undefined;
}

/** The mark's id: its first push id, the same across Receive again. */
export function markIdOf(r: FleetDbReceive): string {
  return r.priorIds?.[0] ?? r.pushId;
}

/** Whether a push replaced this database and did not finish (D42). */
export function pushBrokenOf(dbOid: string, oidNow: string, received: boolean): boolean {
  if (received) return false;
  return oidNow === '' || oidNow !== dbOid;
}

/** D63: what a copy's take-over reads from the receive mark its cluster replayed. */
export function receiveMarkVerdict(mark: ReceiveMark | null, oidNow: string, received: boolean): 'none' | 'checked' | 'unchecked' | 'untouched' {
  if (!mark) return 'none';
  if (received) return 'checked';
  return pushBrokenOf(mark.dbOid, oidNow, false) ? 'unchecked' : 'untouched';
}

/** A psql error that says an smdb_manager table or the schema does not exist: the row reads as absent. */
export function missingTable(stderr: string): boolean {
  return /relation "smdb_manager\.[a-z_]+" does not exist|schema "smdb_manager" does not exist/.test(stderr);
}

/** The row from `<gen>|<machine>|<since>`; null for generation 0; undefined for an answer that does not parse. */
export function parseGenRow(text: string): GenRow | null | undefined {
  const line = text.trim().split('\n').map(l => l.trim()).filter(Boolean).pop() ?? '';
  const m = /^(\d+)\|([^|]*)\|([^|]*)$/.exec(line);
  if (!m) return undefined;
  const generation = Number(m[1]);
  if (!Number.isSafeInteger(generation)) return undefined;
  if (generation === 0) return null;
  return { generation, machine: m[2], since: m[3] || null };
}

/**
 * The restore record's upsert under the fence, before the drop: the floor only rises. Answers two lines: the record as
 * it stood before (`<pending>|<file>`, empty when there was none), then the kept floor. Sent as one -c string, which
 * runs as one transaction.
 */
export function restoreStateUpsertSql(file: string, live: GenRow | null): string {
  const g = live?.generation ?? 0;
  const machine = live ? sqlLiteral(machineText(live.machine)) : "''";
  const since = live?.since ? `${sqlLiteral(live.since)}::timestamptz` : 'NULL::timestamptz';
  return `CREATE SCHEMA IF NOT EXISTS smdb_manager;
CREATE TABLE IF NOT EXISTS smdb_manager.restore_state (
  one_row boolean PRIMARY KEY DEFAULT true CHECK (one_row), pending boolean NOT NULL, file text NOT NULL,
  at timestamptz NOT NULL, generation bigint NOT NULL CHECK (generation >= 0), machine text NOT NULL,
  since timestamptz);
WITH was AS (SELECT pending, file FROM smdb_manager.restore_state)
INSERT INTO smdb_manager.restore_state AS r (one_row, pending, file, at, generation, machine, since)
  VALUES (true, true, ${sqlLiteral(file)}, now(), ${g}, ${machine}, ${since})
  ON CONFLICT (one_row) DO UPDATE SET pending = true, file = EXCLUDED.file, at = EXCLUDED.at,
    generation = GREATEST(r.generation, EXCLUDED.generation),
    machine = CASE WHEN EXCLUDED.generation > r.generation THEN EXCLUDED.machine ELSE r.machine END,
    since = CASE WHEN EXCLUDED.generation > r.generation THEN EXCLUDED.since ELSE r.since END
  RETURNING coalesce((SELECT was.pending::text || '|' || was.file FROM was), '') || chr(10)
    || generation || '|' || machine || '|'
    || coalesce(to_char(since AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), '');`;
}

/** The record as it stood before restoreStateUpsertSql ran, from the first of its two lines; null when there was none. */
export function parseRestoreStateBefore(text: string): { pending: boolean; file: string } | null {
  const lines = text.split('\n').map(l => l.trim());
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  if (lines.length < 2) return null;
  const m = /^(true|false)\|(.*)$/.exec(lines[lines.length - 2]);
  return m ? { pending: m[1] === 'true', file: m[2] } : null;
}

/** The record's pending flag and file put back as parseRestoreStateBefore read them; with none before, not pending. The floor stays. */
export function restoreStateBackSql(before: { pending: boolean; file: string } | null): string {
  return `UPDATE smdb_manager.restore_state SET (pending, file) = (${before?.pending ? 'true' : 'false'}, ${before ? sqlLiteral(before.file) : 'file'})`;
}

export const RESTORE_STATE_CLEAR = `DO $$ BEGIN
IF to_regclass('smdb_manager.restore_state') IS NOT NULL THEN
  UPDATE smdb_manager.restore_state SET pending = false WHERE pending;
END IF;
END $$;`;

export const RESTORE_STATE_READ = `SELECT coalesce((SELECT pending::text || '|' || file || '|' || to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  || '|' || generation || '|' || machine || '|' || coalesce(${SINCE}, '') FROM smdb_manager.restore_state), '')`;

/** The record from RESTORE_STATE_READ's line; null when absent; undefined when it does not parse. */
export function parseRestoreState(text: string): RestoreState | null | undefined {
  const line = text.trim().split('\n').map(l => l.trim()).filter(Boolean).pop() ?? '';
  if (line === '') return null;
  const parts = line.split('|');
  if (parts.length !== 6 || (parts[0] !== 'true' && parts[0] !== 'false')) return undefined;
  const floor = parseGenRow(`${parts[3]}|${parts[4]}|${parts[5]}`);
  if (floor === undefined) return undefined;
  return { pending: parts[0] === 'true', file: parts[1], at: parts[2], floor };
}

/** The higher of the live row and the floor (the live one on a tie); null when both are absent or 0. */
export function generationBefore(live: GenRow | null | undefined, floor: GenRow | null | undefined): GenRow | null {
  const l = live && live.generation > 0 ? live : null;
  const f = floor && floor.generation > 0 ? floor : null;
  if (!l) return f;
  if (!f) return l;
  return f.generation > l.generation ? f : l;
}

// The guards' texts, read by maintenance.ts and containerManager.ts, which fleetSwitch.ts imports.

type Handover = NonNullable<NonNullable<InstanceConfig['fleetDb']>['handover']>;

export function handoverMachine(h: Handover): string {
  return h.machine || 'another machine';
}

/** A stream hand-over whose record lacks part of the copy's address: this manager cannot read that copy. */
export function handoverNoAddress(h: Handover | null | undefined): boolean {
  return !!h && h.mode === 'stream' && !(h.host && h.port && h.cert);
}

/** Such a hand-over once it stopped this database: the rejoin cannot run, and Receive takes the main back. */
export function handedOverNoAddress(h: Handover | null | undefined): boolean {
  return handoverNoAddress(h) && h?.phase === 'stopped';
}

const moveBack = (machine: string) => `Receive a main here, then Push the main in ${machine}'s manager`;
const NO_ADDRESS = (h: Handover) => `This machine handed its main database to ${handoverMachine(h)}, which has no address for other machines`;

const UNFINISHED = (h: Handover) => `This machine's hand-over of its main database to ${handoverMachine(h)} did not finish, and ${handoverMachine(h)} has no address for other machines`;
const unfinishedNoAddress = (h: Handover | null | undefined): h is Handover => handoverNoAddress(h) && h?.phase === 'waiting';
const UNFINISHED_ENDS = (h: Handover) => `Hand over again finishes it while ${handoverMachine(h)}'s copy streams from this database, and Cancel the hand-over or the move back (${moveBack(handoverMachine(h))}) ends it`;

/** A restore refused under a hand-over to a copy with no address: Cancel refuses after a push that did not finish, so it is named only without one. */
export function noAddressRestoreRefusal(db: NonNullable<InstanceConfig['fleetDb']>): string {
  const h = db.handover!;
  if (unfinishedNoAddress(h)) return `${UNFINISHED(h)}; a restore is refused while the hand-over is recorded: ${UNFINISHED_ENDS(h)}`;
  return `${NO_ADDRESS(h)}; a restore is refused until the main is moved back (${moveBack(handoverMachine(h))})${db.pushBroken ? '' : ' or the hand-over is cancelled in the Database window'}`;
}

/** `a hand-over to <machine>`, `a push to <machine>`, `a backup made for a move`. */
export function moveModeText(h: Handover): string {
  return h.mode === 'stream' ? `a hand-over to ${handoverMachine(h)}` : h.mode === 'push' ? `a push to ${handoverMachine(h)}` : 'a backup made for a move';
}

/** R15: the state order a switch mark refuses; null when none does. */
export function switchStateRefusal(instance: InstanceConfig, to: 'running' | 'maintenance' | 'off'): string | null {
  const db = instance.fleetDb;
  if (!db) return null;
  if (handedOverNoAddress(db.handover)) {
    const h = db.handover!;
    return `${NO_ADDRESS(h)}, so its state cannot change until the main is moved back (${moveBack(handoverMachine(h))})${db.pushBroken ? '' : ' or the hand-over is cancelled'}; nothing was changed`;
  }
  if (unfinishedNoAddress(db.handover)) return `${UNFINISHED(db.handover)}, so its state cannot change while the hand-over is recorded: ${UNFINISHED_ENDS(db.handover)}; nothing was changed`;
  if (db.handover) {
    return `This machine handed its main database to ${handoverMachine(db.handover)} (${moveModeText(db.handover)}), so its state cannot change until it rejoins as a copy or the move is cancelled; nothing was changed`;
  }
  if (to !== 'running') return null;
  if (db.replacedBy) return `${db.replacedBy.machine} replaced this database as the main, so Running would start the bot on an old database. Rejoin this machine as a copy; nothing was changed`;
  if (db.receive) return 'This database is waiting to receive a main from another machine; choose Running after the push, or Stop receiving first; nothing was changed';
  if (db.mainConflict) return 'Two databases of this bot are mains with the same generation, so Running would let the bot write to one of them before you choose. Keep this machine as the main, or rejoin it as a copy; nothing was changed';
  if (db.pushBroken) return `A push replaced this database and did not finish, so Running would start the bot on an empty or unchecked database. Restore the dump ${db.pushBroken.safetyDump}, or receive a push again; nothing was changed`;
  return null;
}

/** G4, G5, G17, G19: a start of the bot refused under a switch mark; null when none. */
export function switchStartRefusal(instance: InstanceConfig): string | null {
  const db = instance.fleetDb;
  if (db && handedOverNoAddress(db.handover)) {
    const h = db.handover!;
    return `${NO_ADDRESS(h)}, so the bot does not start here; move the main back (${moveBack(handoverMachine(h))})${db.pushBroken ? '' : ', or cancel the hand-over'}`;
  }
  if (unfinishedNoAddress(db?.handover)) return `${UNFINISHED(db!.handover!)}, so the bot does not start here while the hand-over is recorded: ${UNFINISHED_ENDS(db!.handover!)}`;
  if (db?.handover) return `This machine handed its main database to ${handoverMachine(db.handover)}, so the bot does not start here; rejoin it as a copy, or cancel the move`;
  if (db?.replacedBy) return `${db.replacedBy.machine} replaced this database as the main, so the bot does not start here; rejoin it as a copy`;
  if (db?.mainConflict) return 'Two databases of this bot are mains with the same generation, so the bot does not start here; keep this machine as the main, or rejoin it as a copy';
  if (db?.pushBroken) return `A push replaced this database and did not finish, so the bot does not start here; restore the dump ${db.pushBroken.safetyDump}, or receive a push again`;
  return null;
}

/** G6: a start of the database alone refused on a handed-over main; null when none. */
export function switchDbStartRefusal(instance: InstanceConfig): string | null {
  const h = instance.fleetDb?.handover;
  if (h && handedOverNoAddress(h)) {
    if (instance.fleetDb?.receive) return `${NO_ADDRESS(h)}; while it waits to receive the main back, only Receive a main starts its database`;
    return `${NO_ADDRESS(h)}; the database stays stopped until Receive a main starts it${instance.fleetDb?.pushBroken ? '' : ' or the hand-over is cancelled'}`;
  }
  if (unfinishedNoAddress(h)) return `${UNFINISHED(h)}; Hand over again, Cancel the hand-over and Receive a main start its database when they need it`;
  return h ? `This machine handed its main database to ${handoverMachine(h)}; the database stays stopped until it rejoins as a copy or the hand-over is cancelled` : null;
}

export function hasSwitchMark(instance: InstanceConfig): boolean {
  const db = instance.fleetDb;
  return !!(db?.handover || db?.replacedBy || db?.receive || db?.mainConflict || db?.pushBroken);
}

export type RestoreKind = 'ordinary' | 'moved';

export function restoreKindOf(file: string): RestoreKind {
  return file.startsWith('moved-') ? 'moved' : 'ordinary';
}

/** What every whole-bot restore writes: one above both the row before it and the restored row, with this machine. */
export function generationAfterRestore(before: GenRow | null, restored: GenRow | null, machine: string, now: string): GenRow {
  return { generation: Math.max(before?.generation ?? 0, restored?.generation ?? 0) + 1, machine, since: now };
}

// X1: a dump's smdb_manager rows are read as text from `pg_restore --data-only -n smdb_manager -f -` and never run;
// the manager writes them back with its own INSERTs.

export type MetaTable = 'generation' | 'handover' | 'received' | 'copies' | 'addresses';
type MetaKind = 'bool' | 'bigint' | 'int' | 'text' | 'time';
interface MetaColumn { name: string; kind: MetaKind; nullable: boolean }
export type MetaValue = string | number | boolean | null;
export type MetaRow = Record<string, MetaValue>;
export type MetaRows = Record<MetaTable, MetaRow[]>;
/** fleetJoin's validAddress, passed in: fleetJoin imports this module. */
export type AddressCheck = (row: unknown) => JoinAddress | null;
export type MetaParse =
  | { ok: true; script: string; counts: Record<MetaTable, number>; skipped: { check: number; cap: number } }
  | { ok: false; problem: string };

export const META_ROW_LIMIT = 10000;
export const META_ADDRESS_CAP = 1000;
export const META_TEXT_CAP = 16 * 1024 * 1024;
export const META_ADDRESS_LINE_CAP = 64 * 1024;
export const META_ADDRESS_TEXT_CAP = 4 * 1024 * 1024;

const mc = (name: string, kind: MetaKind, nullable = false): MetaColumn => ({ name, kind, nullable });
const META_TABLES: Record<MetaTable, MetaColumn[]> = {
  generation: [mc('one_row', 'bool'), mc('machine', 'text'), mc('generation', 'bigint'), mc('since', 'time')],
  handover: [mc('one_row', 'bool'), mc('slot', 'text'), mc('machine', 'text'), mc('generation', 'bigint'), mc('at', 'time')],
  received: [mc('push_id', 'text'), mc('from_system_id', 'text'), mc('from_machine', 'text'), mc('generation', 'bigint'), mc('at', 'time')],
  copies: [mc('slot', 'text'), mc('machine', 'text', true), mc('client', 'text', true), mc('seen_at', 'time')],
  addresses: [mc('host', 'text'), mc('port', 'int'), mc('slot', 'text', true), mc('cert', 'text'), mc('machine', 'text'), mc('updated_at', 'time')],
};
const META_ORDER: MetaTable[] = ['generation', 'handover', 'received', 'copies', 'addresses'];
const META_KEYS: Record<MetaTable, string[]> = { generation: ['one_row'], handover: ['one_row'], received: ['push_id'], copies: ['slot'], addresses: ['host', 'port'] };
/** The save order's tables: a dump's rows of them are read past and never written back (decision 7, the raise rewrites the order). */
export const SAVE_ORDER_TABLES = ['save_order', 'save_acks'] as const;
const COPY_RE = /^COPY smdb_manager\.(generation|handover|received|copies|addresses|save_order|save_acks) \(([a-z_, ]+)\) FROM stdin;$/;
const ENTRY_RE = /^-- (?:Data for )?Name: (.+?); Type: (.+?); Schema: ([^;]+)(?:;|$)/;
const TIME_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?[+-](\d{2})(?::(\d{2})(?::(\d{2}))?)?$/;
const COPY_ESCAPES: Record<string, number> = { b: 8, f: 12, n: 10, r: 13, t: 9, v: 11 };

/** Why a timestamp is refused; null for pg_dump's ISO form of a real calendar time with an offset within 15 hours. */
function timeProblem(text: string): string | null {
  const m = TIME_RE.exec(text);
  if (!m) return 'is not a timestamp with an offset';
  const [y, mo, d, hh, mi, ss, oh, om, os] = m.slice(1).map(v => Number(v ?? 0));
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
  const real = y >= 1 && days !== undefined && d >= 1 && d <= days && hh < 24 && mi < 60 && ss < 60 && om < 60 && os < 60
    && oh * 3600 + om * 60 + os <= 15 * 3600;
  return real ? null : 'is not a real calendar time';
}

type CopyField = { value: string | null } | { problem: string };

function decodedField(bytes: Buffer): CopyField {
  if (bytes.includes(0)) return { problem: 'holds a NUL character' };
  try {
    return { value: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  } catch {
    return { problem: 'is not valid UTF-8' };
  }
}

/** One data line in COPY's text format: fields split at unescaped tabs, `\N` as NULL, the backslash escapes decoded. */
function copyFields(line: string): CopyField[] {
  const out: CopyField[] = [];
  const special = /[\t\\\r]/g;
  let parts: Buffer[] = [];
  let problem: string | null = null;
  let start = 0;
  const close = (end: number) => {
    const isNull = end - start === 2 && line.startsWith('\\N', start);
    out.push(problem ? { problem } : isNull ? { value: null } : decodedField(Buffer.concat(parts)));
    parts = [];
    problem = null;
    start = end + 1;
  };
  let i = 0;
  for (;;) {
    special.lastIndex = i;
    const j = special.exec(line)?.index ?? line.length;
    if (j > i) parts.push(Buffer.from(line.slice(i, j), 'utf-8'));
    if (j === line.length) break;
    const ch = line[j];
    if (ch === '\t') {
      close(j);
      i = j + 1;
      continue;
    }
    if (ch === '\r') {
      problem ??= 'holds a carriage return that is not escaped';
      i = j + 1;
      continue;
    }
    if (j + 1 >= line.length) {
      problem ??= 'ends with a lone backslash';
      i = j + 1;
      continue;
    }
    const next = String.fromCodePoint(line.codePointAt(j + 1)!);
    const oct = /^[0-7]{1,3}/.exec(line.slice(j + 1, j + 4));
    const hex = next === 'x' ? /^[0-9A-Fa-f]{1,2}/.exec(line.slice(j + 2, j + 4)) : null;
    if (oct) {
      parts.push(Buffer.from([parseInt(oct[0], 8) & 0xff]));
      i = j + 1 + oct[0].length;
    } else if (hex) {
      parts.push(Buffer.from([parseInt(hex[0], 16)]));
      i = j + 2 + hex[0].length;
    } else {
      parts.push(next in COPY_ESCAPES ? Buffer.from([COPY_ESCAPES[next]]) : Buffer.from(next, 'utf-8'));
      i = j + 1 + next.length;
    }
  }
  close(line.length);
  return out;
}

function columnValue(c: MetaColumn, v: string | null): { value: MetaValue } | { problem: string } {
  if (v === null) return c.nullable ? { value: null } : { problem: 'is NULL' };
  if (c.kind === 'bool') return v === 't' ? { value: true } : v === 'f' ? { value: false } : { problem: 'is not t or f' };
  if (c.kind === 'bigint' || c.kind === 'int') {
    const n = /^-?\d{1,16}$/.test(v) ? Number(v) : NaN;
    if (c.kind === 'int') return Number.isInteger(n) && n >= -2147483648 && n <= 2147483647 ? { value: n } : { problem: 'is not a whole number in the integer range' };
    return Number.isSafeInteger(n) ? { value: n } : { problem: 'is not a whole number in the safe-integer range' };
  }
  if (c.kind === 'time') {
    const why = timeProblem(v);
    return why ? { problem: why } : { value: v };
  }
  return { value: v };
}

function metaLiteral(t: MetaTable, c: MetaColumn, v: MetaValue | undefined): string {
  const bad = () => new Error(`column ${c.name} of smdb_manager.${t} is not a ${c.kind} value`);
  if (v === null || v === undefined) {
    if (c.nullable) return 'NULL';
    throw new Error(`column ${c.name} of smdb_manager.${t} is NULL`);
  }
  if (c.kind === 'bool') {
    if (typeof v !== 'boolean') throw bad();
    return v ? 'true' : 'false';
  }
  if (c.kind === 'bigint' || c.kind === 'int') {
    if (typeof v !== 'number' || !Number.isSafeInteger(v)) throw bad();
    return String(v);
  }
  if (typeof v !== 'string') throw bad();
  if (c.kind === 'time') {
    if (timeProblem(v)) throw bad();
    return `${sqlLiteral(v)}::timestamptz`;
  }
  return sqlLiteral(v);
}

/** X1 rule 3: one INSERT per row, every value a literal of its column's kind; throws on a value that is not. */
export function metaRowsSql(rows: MetaRows): string {
  return META_ORDER.flatMap(t => rows[t].map(row => {
    const cols = META_TABLES[t];
    return `INSERT INTO smdb_manager.${t} (${cols.map(c => c.name).join(', ')}) VALUES (${cols.map(c => metaLiteral(t, c, row[c.name])).join(', ')});\n`;
  })).join('');
}

/**
 * X1 rule 2 with Y1, Y2 and Y5, fed while the dump is read: only the five tables' COPY blocks are read, the save
 * order's two blocks are passed over unread, every other line is ignored, and the first problem refuses. No addresses row refuses: one longer than 64 KiB is dropped as it
 * is read, and kept addresses rows have their own 4 MiB, outside the other tables' 16 MiB.
 */
export class MetaRowsReader {
  private pending: Uint8Array[] = [];
  private pendingSize = 0;
  private skippingLine = false;
  private lineNo = 0;
  private problem: string | null = null;
  private block: { table: MetaTable; order: MetaColumn[] } | null = null;
  private passing: string | null = null;
  private entry: string | null = null;
  private kept = 0;
  private keptAddresses = 0;
  private readonly seen = new Set<string>();
  private readonly rows: MetaRows = { generation: [], handover: [], received: [], copies: [], addresses: [] };
  private readonly keys: Record<MetaTable, Set<string>> = {
    generation: new Set(), handover: new Set(), received: new Set(), copies: new Set(), addresses: new Set(),
  };
  private readonly skipped = { check: 0, cap: 0 };
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });

  constructor(private readonly checkAddress: AddressCheck) {}

  push(chunk: Uint8Array): void {
    let start = 0;
    for (let i = 0; i < chunk.length && !this.problem; i++) {
      if (chunk[i] !== 0x0a) continue;
      if (this.overlongAddress(i - start)) {
        this.endSkippedLine();
      } else {
        this.pending.push(Uint8Array.prototype.slice.call(chunk, start, i));
        this.takeLine();
      }
      start = i + 1;
    }
    if (this.problem || start >= chunk.length || this.overlongAddress(chunk.length - start)) return;
    this.pending.push(Uint8Array.prototype.slice.call(chunk, start));
    this.pendingSize += chunk.length - start;
    if (this.pendingSize > META_TEXT_CAP) this.fail(`line ${this.lineNo + 1} is longer than 16 MiB`);
  }

  end(): MetaParse {
    if (!this.problem && this.skippingLine) this.endSkippedLine();
    if (!this.problem && this.pendingSize > 0) this.takeLine();
    if (!this.problem && (this.block || this.passing)) this.fail(`the dump ends inside the rows of smdb_manager.${this.block?.table ?? this.passing}`);
    if (!this.problem && this.entry !== null) this.notFollowed();
    if (this.problem) return { ok: false, problem: this.problem };
    let script: string;
    try {
      script = metaRowsSql(this.rows);
    } catch (e) {
      return { ok: false, problem: `the rows could not be written as SQL (${(e as Error).message})` };
    }
    const counts = Object.fromEntries(META_ORDER.map(t => [t, this.rows[t].length])) as Record<MetaTable, number>;
    return { ok: true, script, counts, skipped: { ...this.skipped } };
  }

  private fail(problem: string): void {
    this.problem ??= problem;
  }

  /** Whether the line being read is an addresses row past 64 KiB with `more` bytes added; its bytes so far are dropped. */
  private overlongAddress(more: number): boolean {
    if (!this.skippingLine && !(this.block?.table === 'addresses' && this.pendingSize + more > META_ADDRESS_LINE_CAP)) return false;
    this.skippingLine = true;
    this.pending = [];
    this.pendingSize = 0;
    return true;
  }

  private endSkippedLine(): void {
    this.skippingLine = false;
    this.lineNo++;
    this.skipped.check++;
  }

  private notFollowed(): void {
    this.fail(`line ${this.lineNo}: the table data entry ${this.entry!.slice(0, 64)} in smdb_manager is not followed by its COPY line`);
  }

  private keep(size: number): void {
    this.kept += size;
    if (this.kept > META_TEXT_CAP) this.fail('the smdb_manager rows are larger than 16 MiB');
  }

  private takeLine(): void {
    const bytes = this.pending.length === 1 ? this.pending[0] : Buffer.concat(this.pending);
    this.pending = [];
    this.pendingSize = 0;
    this.lineNo++;
    let text: string;
    try {
      text = this.decoder.decode(bytes);
    } catch {
      this.fail(`line ${this.lineNo} is not valid UTF-8 text`);
      return;
    }
    if (this.passing) {
      if (text === '\\.') this.passing = null;
    } else if (this.block) this.dataLine(text, bytes.length + 1);
    else this.otherLine(text, bytes.length + 1);
  }

  private otherLine(text: string, size: number): void {
    const n = this.lineNo;
    const header = ENTRY_RE.exec(text);
    if (header) {
      if (this.entry !== null) return this.notFollowed();
      if (header[3] !== 'smdb_manager') return;
      if (header[2] !== 'TABLE DATA') return this.fail(`line ${n}: the entry ${header[1].slice(0, 64)} in smdb_manager is ${header[2].slice(0, 32)}, not table data`);
      this.entry = header[1];
      return;
    }
    if (text === '' || text.startsWith('--')) return;
    if (!text.startsWith('COPY ')) {
      if (this.entry !== null) this.notFollowed();
      return;
    }
    const m = COPY_RE.exec(text);
    if (!m || (this.entry !== null && this.entry !== m[1])) {
      if (this.entry !== null) return this.notFollowed();
      return this.fail(`line ${n}: a COPY line that is not for one of the manager's five tables in smdb_manager`);
    }
    this.entry = null;
    if (this.seen.has(m[1])) return this.fail(`line ${n}: smdb_manager.${m[1]} has a second block of rows`);
    this.seen.add(m[1]);
    if ((SAVE_ORDER_TABLES as readonly string[]).includes(m[1])) {
      this.passing = m[1];
      return;
    }
    const table = m[1] as MetaTable;
    const want = META_TABLES[table];
    const names = m[2].split(',').map(s => s.trim());
    const order = names.map(name => want.find(c => c.name === name));
    if (names.length !== want.length || new Set(names).size !== names.length || order.some(c => !c)) {
      return this.fail(`line ${n}: the COPY line of smdb_manager.${table} names the columns (${names.join(', ')}), not (${want.map(c => c.name).join(', ')})`);
    }
    this.block = { table, order: order as MetaColumn[] };
    this.keep(size);
  }

  private dataLine(text: string, size: number): void {
    const { table, order } = this.block!;
    if (text === '\\.') {
      this.block = null;
      return;
    }
    const fields = copyFields(text);
    if (table === 'addresses') return this.addressLine(fields, order, size);
    const n = this.lineNo;
    const at = (c: MetaColumn, why: string) => `line ${n}: column ${c.name} of smdb_manager.${table} ${why}`;
    if (fields.length !== order.length) return this.fail(`line ${n}: a row of smdb_manager.${table} has ${fields.length} values for ${order.length} columns`);
    const row: MetaRow = {};
    for (let i = 0; i < order.length; i++) {
      const f = fields[i];
      if ('problem' in f) return this.fail(at(order[i], f.problem));
      const v = columnValue(order[i], f.value);
      if ('problem' in v) return this.fail(at(order[i], v.problem));
      row[order[i].name] = v.value;
    }
    const col = (name: string) => order.find(c => c.name === name)!;
    if ((table === 'generation' || table === 'handover') && row.one_row !== true) return this.fail(at(col('one_row'), 'is not t'));
    if (table === 'generation' && (row.generation as number) < 1) return this.fail(at(col('generation'), 'is below 1'));
    const key = JSON.stringify(META_KEYS[table].map(k => row[k]));
    if (this.keys[table].has(key)) {
      return this.fail(table === 'generation' || table === 'handover'
        ? `line ${n}: smdb_manager.${table} has more than one row`
        : `line ${n}: smdb_manager.${table} has a second row with the same ${META_KEYS[table].join(' and ')}`);
    }
    if (this.rows[table].length >= META_ROW_LIMIT) return this.fail(`line ${n}: smdb_manager.${table} has more than ${META_ROW_LIMIT} rows`);
    this.keys[table].add(key);
    this.rows[table].push(row);
    this.keep(size);
  }

  /** Y1, B1: a row that fails a check, repeats a host and port, or comes past the 1000 kept or the 4 MiB kept is skipped, never refused. */
  private addressLine(fields: CopyField[], order: MetaColumn[], size: number): void {
    if (fields.length !== order.length) {
      this.skipped.check++;
      return;
    }
    const row: MetaRow = {};
    for (let i = 0; i < order.length; i++) {
      const f = fields[i];
      const v = 'problem' in f ? f : columnValue(order[i], f.value);
      if ('problem' in v) {
        this.skipped.check++;
        return;
      }
      row[order[i].name] = v.value;
    }
    const checked = this.checkAddress({ host: row.host, port: row.port, slot: row.slot, cert: row.cert, machine: row.machine });
    const key = checked ? JSON.stringify([checked.host, checked.port]) : '';
    if (!checked || this.keys.addresses.has(key)) {
      this.skipped.check++;
      return;
    }
    if (this.rows.addresses.length >= META_ADDRESS_CAP) {
      this.skipped.cap++;
      return;
    }
    if (this.keptAddresses + size > META_ADDRESS_TEXT_CAP) {
      this.skipped.check++;
      return;
    }
    this.keys.addresses.add(key);
    this.rows.addresses.push({ host: checked.host, port: checked.port, slot: checked.slot, cert: checked.cert, machine: checked.machine, updated_at: row.updated_at });
    this.keptAddresses += size;
  }
}

/** The whole text at once; the restore and the push feed MetaRowsReader while they read. */
export function parseMetaRows(text: string | Uint8Array, checkAddress: AddressCheck): MetaParse {
  const reader = new MetaRowsReader(checkAddress);
  reader.push(typeof text === 'string' ? Buffer.from(text, 'utf-8') : text);
  return reader.end();
}
