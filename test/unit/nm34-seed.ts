// The NM34 fixtures: an Off on a database with no dbm_admin, made by the real order and the real ensureManagerDbRole
// against psql's answer for a missing role, and the bot role's own reads (S1, S2, S3) answered as psql prints them.
// The test file mocks child_process, fs and dockerClient with nm31-run.ts before importing this.
import { expect } from 'vitest';
import * as dbLogin from '../../src/instance/dbLogin';
import * as maintenance from '../../src/instance/maintenance';
import { docker } from './nm2-docker';
import { run, PsqlAnswer, PsqlCall } from './nm31-run';
import { OFF_MESSAGE, psqlAnswer } from './nm31-seed';

export const NO_ADMIN_STDERR = 'psql: error: connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed: FATAL:  role "dbm_admin" does not exist';

const isAdminCall = (a: string[]) => a[0] === 'exec' && a.includes('psql') && a[a.indexOf('-U') + 1] === dbLogin.MANAGER_DB_ROLE;

/** Every dbm_admin psql call (managerPsql's execFile) answers NO_ADMIN_STDERR; answers the override to remove. */
export function noAdmin(): { match: (a: string[]) => boolean; answer: { ok: boolean; stderr: string } } {
  const over = { match: isAdminCall, answer: { ok: false, stderr: `${NO_ADMIN_STDERR}\n` } };
  docker.overrides.unshift(over);
  return over;
}

export function dropOverride(over: unknown): void {
  const i = docker.overrides.indexOf(over as never);
  if (i >= 0) docker.overrides.splice(i, 1);
}

/** The Off order with the app stopped and the database running, on a cluster with no dbm_admin. */
export async function offOrderNoAdmin(id: string): Promise<maintenance.OrderResult> {
  dbLogin.resetManagerRoleCache();
  const over = noAdmin();
  try {
    const r = await maintenance.runMaintenanceOrder(id, 'off', OFF_MESSAGE);
    expect(r.settled).toBe(false);
    return r;
  } finally {
    dropOverride(over);
  }
}

export type Scripted = PsqlAnswer | 'hang' | ((c: PsqlCall) => PsqlAnswer | 'hang');

/** The bot role's reads: S1's fields, S2's answer, S3's line; a queue in `s1Queue` answers S1 calls first, in order. */
export const owner = {
  superuser: true,
  recovery: 'false',
  admin: 'missing' as 'missing' | 'true' | 'false',
  sessions: [0, 0] as [number, number],
  restorekind: '-',
  restore: '',
  /** S2's stdout: '-' no table, 'r' then the row, or another relkind. */
  gen: '-\n',
  /** S3's copy line after `copy|`. */
  copy: 'true|streaming',
  /** S4's ssl setting after `ssl|`. */
  ssl: 'off',
  s1Queue: [] as Scripted[],
  s1: null as Scripted | null,
  s2: null as Scripted | null,
  s3: null as Scripted | null,
  s4: null as Scripted | null,
  calls: [] as PsqlCall[],
};

export function resetOwner(): void {
  Object.assign(owner, {
    superuser: true, recovery: 'false', admin: 'missing', sessions: [0, 0], restorekind: '-', restore: '', gen: '-\n', copy: 'true|streaming', ssl: 'off',
    s1Queue: [], s1: null, s2: null, s3: null, s4: null, calls: [],
  });
}

/** S1's stdout as psql -tA -q prints it, pg_sleep's empty line included. */
export function s1Stdout(): string {
  if (!owner.superuser) return 'f\n';
  const restore = owner.restorekind === 'r' ? `restore|${owner.restore}\n` : '';
  return `t\nrecovery|${owner.recovery}\nadmin|${owner.admin}\nsessions|${owner.sessions[0]}\nrestorekind|${owner.restorekind}\n${restore}\nsessions2|${owner.sessions[1]}\n`;
}

export const HANG: Promise<PsqlAnswer> = new Promise(() => {});

function play(s: Scripted, c: PsqlCall, fallback: () => PsqlAnswer): PsqlAnswer | Promise<PsqlAnswer> {
  const a = typeof s === 'function' ? s(c) : s;
  if (a === 'hang') return HANG;
  return a ?? fallback();
}

/** Which of the four scripts a call of the bot role runs. */
export function scriptOf(c: PsqlCall): 'S1' | 'S2' | 'S3' | 'S4' | null {
  if (c.input.includes("'sessions2|'")) return 'S1';
  if (c.input.includes("'copy|'")) return 'S3';
  if (c.input.includes("'ssl|'")) return 'S4';
  if (c.input.includes('smdb_manager.generation')) return 'S2';
  return null;
}

export const isOwnerLogin = (c: PsqlCall) => !!c.login && !c.login.startsWith('dbm_') && !c.login.startsWith('smdb_');

/** run.psql for the rows: the bot role's scripts answered from `owner`, every other login as nm31-seed answers it. */
export function ownerPsql(c: PsqlCall): PsqlAnswer | Promise<PsqlAnswer> {
  if (!isOwnerLogin(c)) return psqlAnswer(c);
  owner.calls.push(c);
  const which = scriptOf(c);
  if (which === 'S1') {
    const queued = owner.s1Queue.shift();
    if (queued !== undefined) return play(queued, c, () => ({ code: 0, stdout: s1Stdout() }));
    return owner.s1 ? play(owner.s1, c, () => ({ code: 0, stdout: s1Stdout() })) : { code: 0, stdout: s1Stdout() };
  }
  if (which === 'S2') return owner.s2 ? play(owner.s2, c, () => ({ code: 0, stdout: owner.gen })) : { code: 0, stdout: owner.gen };
  if (which === 'S3') {
    const stdout = owner.superuser ? `t\ncopy|${owner.copy}\n` : 'f\n';
    return owner.s3 ? play(owner.s3, c, () => ({ code: 0, stdout })) : { code: 0, stdout };
  }
  if (which === 'S4') return owner.s4 ? play(owner.s4, c, () => ({ code: 0, stdout: `ssl|${owner.ssl}\n` })) : { code: 0, stdout: `ssl|${owner.ssl}\n` };
  return { code: 1, stderr: 'ERROR: unexpected script for the bot role' };
}

export function useOwner(): void {
  run.psql = ownerPsql;
}

/** The PGOPTIONS ownerReadArgs sends: the read-only default and role=none after the manager's own options that Postgres 16.0 knows. */
export function isOwnerShape(args: string[], user: string): boolean {
  const env = args[args.indexOf('-e') + 1] ?? '';
  return args[0] === 'exec' && env.startsWith(`PGOPTIONS=${dbLogin.OWNER_SESSION_OPTIONS} `) && env.includes('-c default_transaction_read_only=on')
    && env.endsWith('-c role=none') && args[args.indexOf('-U') + 1] === user && args.includes('-X') && args.includes('-w');
}
