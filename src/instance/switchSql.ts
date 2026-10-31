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
GRANT USAGE ON SCHEMA smdb_manager TO PUBLIC;
GRANT SELECT ON smdb_manager.generation TO PUBLIC;`;

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

/** The receive login takes no new session (D54); run on `postgres`. */
export const RECEIVE_NOLOGIN_SQL = `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'smdb_receive') THEN ALTER ROLE smdb_receive NOLOGIN; END IF; END $$;`;

/** One round of ending the receive login's sessions; the last line is the sessions left. */
export const RECEIVE_END_SQL = `SELECT count(pg_terminate_backend(pid, 5000)) FROM pg_stat_activity WHERE usename = 'smdb_receive' AND pid <> pg_backend_pid(); SELECT count(*) FROM pg_stat_activity WHERE usename = 'smdb_receive';`;

export const RECEIVE_DROP_SQL = 'DROP ROLE IF EXISTS smdb_receive;';

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
