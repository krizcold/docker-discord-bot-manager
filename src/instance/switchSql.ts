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

const TABLES = `CREATE SCHEMA IF NOT EXISTS smdb_manager;
CREATE TABLE IF NOT EXISTS smdb_manager.generation (
  one_row boolean PRIMARY KEY DEFAULT true CHECK (one_row), machine text NOT NULL,
  generation bigint NOT NULL CHECK (generation >= 1), since timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS smdb_manager.handover (
  one_row boolean PRIMARY KEY DEFAULT true CHECK (one_row), slot text NOT NULL, machine text NOT NULL,
  generation bigint NOT NULL, at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS smdb_manager.received (
  push_id text PRIMARY KEY, from_system_id text NOT NULL, from_machine text NOT NULL, generation bigint NOT NULL,
  at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS smdb_manager.copies (
  slot text PRIMARY KEY, machine text, client text, seen_at timestamptz NOT NULL DEFAULT now());
GRANT USAGE ON SCHEMA smdb_manager TO PUBLIC, dbm_work;
GRANT SELECT ON smdb_manager.generation TO PUBLIC;
GRANT SELECT ON smdb_manager.generation, smdb_manager.handover, smdb_manager.received, smdb_manager.copies TO dbm_work;`;

export const GENERATION_SCHEMA_SQL = TABLES;

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

/** The generation row as `<gen>|<machine>|<since>`; a missing table is read from psql's error (missingTable). */
export const GEN_READ_SQL = `SELECT coalesce((SELECT generation || '|' || machine || '|' || ${SINCE} FROM smdb_manager.generation), '0||')`;

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

/** The replication role, made NOLOGIN when this cluster lacks it, so a dump that grants to it restores (D59). */
export function replicationRoleEnsureSql(role: string): string {
  return `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${sqlLiteral(role)}) THEN CREATE ROLE ${role} NOLOGIN REPLICATION; END IF; END $$;`;
}

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
export const RECEIVE_MARK_COUNT_SQL = 'SELECT count(*) FROM smdb_manager.receive_mark';

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

/** The restore record's upsert under the fence, before the drop: the floor only rises. Answers the kept floor; sent as one -c string, which runs as one transaction. */
export function restoreStateUpsertSql(file: string, live: GenRow | null): string {
  const g = live?.generation ?? 0;
  const machine = live ? sqlLiteral(machineText(live.machine)) : "''";
  const since = live?.since ? `${sqlLiteral(live.since)}::timestamptz` : 'NULL::timestamptz';
  return `CREATE SCHEMA IF NOT EXISTS smdb_manager;
CREATE TABLE IF NOT EXISTS smdb_manager.restore_state (
  one_row boolean PRIMARY KEY DEFAULT true CHECK (one_row), pending boolean NOT NULL, file text NOT NULL,
  at timestamptz NOT NULL, generation bigint NOT NULL CHECK (generation >= 0), machine text NOT NULL,
  since timestamptz);
INSERT INTO smdb_manager.restore_state AS r (one_row, pending, file, at, generation, machine, since)
  VALUES (true, true, ${sqlLiteral(file)}, now(), ${g}, ${machine}, ${since})
  ON CONFLICT (one_row) DO UPDATE SET pending = true, file = EXCLUDED.file, at = EXCLUDED.at,
    generation = GREATEST(r.generation, EXCLUDED.generation),
    machine = CASE WHEN EXCLUDED.generation > r.generation THEN EXCLUDED.machine ELSE r.machine END,
    since = CASE WHEN EXCLUDED.generation > r.generation THEN EXCLUDED.since ELSE r.since END
  RETURNING generation || '|' || machine || '|'
    || coalesce(to_char(since AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), '');`;
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

/** `a hand-over to <machine>`, `a push to <machine>`, `a backup made for a move`. */
export function moveModeText(h: Handover): string {
  return h.mode === 'stream' ? `a hand-over to ${handoverMachine(h)}` : h.mode === 'push' ? `a push to ${handoverMachine(h)}` : 'a backup made for a move';
}

/** R15: the state order a switch mark refuses; null when none does. */
export function switchStateRefusal(instance: InstanceConfig, to: 'running' | 'maintenance' | 'off'): string | null {
  const db = instance.fleetDb;
  if (!db) return null;
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
  if (db?.handover) return `This machine handed its main database to ${handoverMachine(db.handover)}, so the bot does not start here; rejoin it as a copy, or cancel the move`;
  if (db?.replacedBy) return `${db.replacedBy.machine} replaced this database as the main, so the bot does not start here; rejoin it as a copy`;
  if (db?.mainConflict) return 'Two databases of this bot are mains with the same generation, so the bot does not start here; keep this machine as the main, or rejoin it as a copy';
  if (db?.pushBroken) return `A push replaced this database and did not finish, so the bot does not start here; restore the dump ${db.pushBroken.safetyDump}, or receive a push again`;
  return null;
}

/** G6: a start of the database alone refused on a handed-over main; null when none. */
export function switchDbStartRefusal(instance: InstanceConfig): string | null {
  const h = instance.fleetDb?.handover;
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
const COPY_RE = /^COPY smdb_manager\.(generation|handover|received|copies|addresses) \(([a-z_, ]+)\) FROM stdin;$/;
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
 * X1 rule 2 with Y1, Y2 and Y5, fed while the dump is read: only the five tables' COPY blocks are read, every other
 * line is ignored, and the first problem refuses. No addresses row refuses: one longer than 64 KiB is dropped as it
 * is read, and kept addresses rows have their own 4 MiB, outside the other tables' 16 MiB.
 */
export class MetaRowsReader {
  private pending: Uint8Array[] = [];
  private pendingSize = 0;
  private skippingLine = false;
  private lineNo = 0;
  private problem: string | null = null;
  private block: { table: MetaTable; order: MetaColumn[] } | null = null;
  private entry: string | null = null;
  private kept = 0;
  private keptAddresses = 0;
  private readonly seen = new Set<MetaTable>();
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
    if (!this.problem && this.block) this.fail(`the dump ends inside the rows of smdb_manager.${this.block.table}`);
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
    if (this.block) this.dataLine(text, bytes.length + 1);
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
    const table = m[1] as MetaTable;
    const want = META_TABLES[table];
    const names = m[2].split(',').map(s => s.trim());
    const order = names.map(name => want.find(c => c.name === name));
    if (names.length !== want.length || new Set(names).size !== names.length || order.some(c => !c)) {
      return this.fail(`line ${n}: the COPY line of smdb_manager.${table} names the columns (${names.join(', ')}), not (${want.map(c => c.name).join(', ')})`);
    }
    if (this.seen.has(table)) return this.fail(`line ${n}: smdb_manager.${table} has a second block of rows`);
    this.seen.add(table);
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
