// The save order (contract 11) as each fake database of the kept-data rows holds it: the claim clock read, the order
// step's transaction, the read of the order and its answers, Running's row and a restore's rewrite, recognised by the
// SQL maintenance.ts and fleetBackup.ts send (switchSql.ts) and answered as Postgres would. State lives on globalThis
// so a vi.mock factory and the test share it.
import * as fs from 'fs';
import * as path from 'path';
import * as switchSql from '../../src/instance/switchSql';

type Call = { login: string; db: string; input: string; args: string[] };
type Answer = { code: number; stdout?: string; stderr?: string };

export interface SoRow { id: string; state: 'maintenance' | 'running'; message: string; generation: number; reason: 'order' | 'restore'; upMs: number | null }
export interface SoAck { process: string; order: string; saved: boolean | null; unsavedGuilds?: number | null; unsavedFiles?: number | null; unansweredGuilds?: number | null; unconfirmedFiles?: number | null; unansweredFiles?: number | null }
export interface SoDb { order: SoRow | null; acks: SoAck[]; writes: Array<'order' | 'running' | 'restore'>; reads: number }
export interface SoHolder { process: string; name: string; expires: number; agoMs?: number }

export interface So {
  /** smdb_data's claim tables exist. */
  claims: boolean;
  /** The claim clock's up_ms; null: no row. */
  clock: number | null;
  /** The processes holding an unreleased shard claim, each with its expiry on the claim clock. */
  holders: SoHolder[];
  /** What each process answers at a read while a current maintenance row stands; by default the bot confirms its save. */
  answers: Record<string, Omit<SoAck, 'process' | 'order'>>;
  /** Each database's rows, keyed by soKeyOf. */
  dbs: Record<string, SoDb>;
}

const fresh = (): So => ({ claims: true, clock: 100_000, holders: [{ process: 'p1', name: 'main', expires: 200_000 }], answers: { p1: { saved: true } }, dbs: {} });

export const so: So = ((globalThis as { __nm31So?: So }).__nm31So ??= fresh());

export function resetSo(): void {
  Object.assign(so, fresh());
}

/** The database a container serves: its fleetDb's volume in the registry, else the container's name (a new database starts empty). */
export function soKeyOf(container: string): string {
  try {
    const reg = JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR as string, 'instances.json'), 'utf-8'));
    for (const inst of Object.values(reg.instances ?? {}) as Array<{ fleetDb?: { containerName?: string; volume?: string } }>) {
      if (inst.fleetDb?.containerName === container && inst.fleetDb.volume) return inst.fleetDb.volume;
    }
  } catch { /* no registry yet */ }
  return container;
}

export function soDbOf(containerOrKey: string): SoDb {
  const key = so.dbs[containerOrKey] ? containerOrKey : soKeyOf(containerOrKey);
  return (so.dbs[key] ??= { order: null, acks: [], writes: [], reads: 0 });
}

/** The generation of a GEN_READ_SQL answer (`<generation>|<machine>|<since>`). */
export const generationOf = (stdout: string | undefined): number => Number(String(stdout ?? '').split('|')[0]) || 0;

const LIT = "'(?:[^']|'')*'";
const unlit = (s: string): string => s.slice(1, -1).replace(/''/g, "'");
const GEN = 'coalesce\\(\\(SELECT generation FROM smdb_manager\\.generation\\), 0\\)';
const ORDER_KEEP = new RegExp(`WHERE order_id = (NULL|${LIT}) AND state = 'maintenance' AND generation = ${GEN}( AND reason = 'order')?;`);
const ORDER_NEW = new RegExp(`SELECT true, (${LIT}), 'maintenance', (${LIT}), ${GEN}, 'order', (NULL|-?\\d+), now\\(\\) WHERE NOT`);
const RUNNING = new RegExp(`VALUES \\(true, (${LIT}), 'running', '', ${GEN}, 'order', NULL, now\\(\\)\\)`);
const RESTORE = new RegExp(`VALUES \\(true, (${LIT}), 'maintenance', (${LIT}), ${GEN}, 'restore', NULL, now\\(\\)\\)`);

/**
 * A save-order script answered from `so` at the database's current `generation`; null for any other script. A
 * restore's rewrite is recorded and left to the caller to answer, since it runs inside the generation raise.
 */
export function saveOrderAnswer(c: Call, generation: number): Answer | null {
  const container = c.args[c.args.indexOf('psql') - 1];
  if (c.login === 'dbm_work' && c.input === switchSql.CLAIM_CLOCK_READ_SQL) {
    return { code: 0, stdout: `clock|${so.claims && so.clock !== null ? so.clock : ''}\n` };
  }
  if (c.login === 'dbm_work' && c.input === switchSql.SAVE_READ_SQL) {
    const d = soDbOf(container);
    d.reads++;
    const o = d.order;
    const current = !!o && o.generation === generation;
    if (o && current && o.state === 'maintenance') {
      for (const [p, a] of Object.entries(so.answers)) {
        if (!so.holders.some(x => x.process === p)) continue;
        d.acks = d.acks.filter(x => x.process !== p);
        d.acks.push({ process: p, order: o.id, ...a });
      }
    }
    const up = o?.upMs;
    const counted = so.claims && up !== null && up !== undefined ? so.holders : [];
    const holder = (x: SoHolder) => ({ process: x.process, name: x.name, agoMs: x.agoMs ?? 4000 });
    const line = {
      order: o ? { id: o.id, state: o.state, message: o.message, current, reason: o.reason, upMs: o.upMs } : null,
      claims: so.claims,
      expected: counted.filter(x => x.expires > (up as number)).map(holder),
      notSeen: counted.filter(x => x.expires <= (up as number)).map(holder),
      acks: o ? d.acks.map(a => ({ unsavedGuilds: 0, unsavedFiles: 0, unansweredGuilds: 0, unconfirmedFiles: 0, unansweredFiles: 0, ...a })) : [],
    };
    return { code: 0, stdout: `${JSON.stringify(line)}\n` };
  }
  if (c.login !== 'dbm_meta') return null;
  const keep = ORDER_KEEP.exec(c.input);
  const written = ORDER_NEW.exec(c.input);
  if (c.input.startsWith('BEGIN;') && keep && written) {
    const d = soDbOf(container);
    d.writes.push('order');
    const keepId = keep[1] === 'NULL' ? null : unlit(keep[1]);
    const keepRestore = !keep[2];
    const message = unlit(written[2]);
    const o = d.order;
    const kept = !!o && keepId !== null && o.id === keepId && o.state === 'maintenance' && o.generation === generation && (keepRestore || o.reason === 'order');
    if (kept) o!.message = message;
    else {
      d.order = { id: unlit(written[1]), state: 'maintenance', message, generation, reason: 'order', upMs: written[3] === 'NULL' ? null : Number(written[3]) };
      d.acks = [];
    }
    const r = d.order!;
    return { code: 0, stdout: `${r.id}|${r.id === keepId ? 't' : 'f'}|${r.generation}|${r.upMs ?? ''}\n` };
  }
  const running = RUNNING.exec(c.input);
  if (c.input.startsWith('BEGIN;') && running && c.input.includes('DELETE FROM smdb_manager.save_acks;')) {
    const d = soDbOf(container);
    d.writes.push('running');
    const o = d.order;
    d.order = o ? { ...o, state: 'running', reason: 'order', generation } : { id: unlit(running[1]), state: 'running', message: '', generation, reason: 'order', upMs: null };
    d.acks = [];
    return { code: 0, stdout: '' };
  }
  const restore = RESTORE.exec(c.input);
  if (restore) {
    const d = soDbOf(container);
    d.writes.push('restore');
    d.order = { id: unlit(restore[1]), state: 'maintenance', message: unlit(restore[2]), generation, reason: 'restore', upMs: null };
    d.acks = [];
  }
  return null;
}
