// The NM31 Put back fixtures: a kept set made by a real forward run on the fakes, then Off ordered again, and the
// database calls of the orders answered with the login's state. The test file mocks child_process, fs, dockerClient
// and appHookClient before importing this.
import * as fs from 'fs';
import { expect, vi } from 'vitest';
import * as containerManager from '../../src/docker/containerManager';
import * as dbLogin from '../../src/instance/dbLogin';
import * as maintenance from '../../src/instance/maintenance';
import { newStartNames, putBack, startOnNewDatabase } from '../../src/instance/keptData';
import { stampOf } from '../../src/instance/backupFiles';
import { run } from './nm31-run';
import { answerDatabase, composePathOf, COPY_VOLUME, dataDirOf, db, offOrder, patchRegistry, seedCopy, seedExternal, seedMain, stored, treeOf } from './nm31-seed';
import { fakeJoinRecord } from './join-fake';
import type { InstanceConfig } from '../../src/types';

export const NOW = Date.parse('2026-11-17T12:00:00.000Z');
export const LATER = Date.parse('2026-11-17T13:00:00.000Z');
export const fwd = () => newStartNames({ sanitizedName: 'bota' }, dataDirOf('a'), NOW);
export const LATER_STAMP = stampOf(LATER);
export const asideDir = () => `${dataDirOf('a')}.kept-${LATER_STAMP}`;
export const bot = (): InstanceConfig => containerManager.getBot('a')!;

/** The bot's login as the database holds it, across the orders and runs of a row. */
export const login = { canLogin: false };

/** The results of every Off order a run ran under its lock, in order. */
export const orders: Array<maintenance.OrderResult | { refused: true; error: string }> = [];

/** The database calls of the runs and orders, the login kept across them; spied again after each fixture's Off order. */
export function answerOrders(): void {
  answerDatabase();
  vi.spyOn(dbLogin, 'blockBotLogin').mockImplementation(async () => { login.canLogin = false; return { ok: true } as any; });
  vi.spyOn(dbLogin, 'endBotSessions').mockResolvedValue({ ok: true } as any);
  vi.spyOn(dbLogin, 'openBotLogin').mockImplementation(async () => {
    if (db.open.ok) login.canLogin = true;
    return db.open;
  });
  vi.spyOn(dbLogin, 'readBotLogin').mockImplementation(async () => ({ ok: true, login: { inRecovery: false, canLogin: login.canLogin, sessions: 0 } }));
  if (!vi.isMockFunction(maintenance.runOrderInOp)) {
    const real = maintenance.runOrderInOp;
    vi.spyOn(maintenance, 'runOrderInOp').mockImplementation(async (...args) => {
      const r = await real(...args);
      orders.push(r);
      return r;
    });
  }
}

export function resetBack(): void {
  login.canLogin = false;
  orders.length = 0;
}

export type Variant = 'main' | 'copy' | 'folder';

/** The bot before the forward run, the set it made, and the state the reverse of a put-back returns to. */
export type Before = { inst: InstanceConfig; folder: Record<string, string>; compose: string };

/** A kept set as a forward run of `variant` leaves it, then Off ordered again an hour later, as an operator does before Put back. */
export async function keptAfterStart(variant: Variant, opts: { off?: boolean; join?: boolean } = {}): Promise<Before> {
  if (variant === 'main') await seedMain();
  else if (variant === 'copy') await seedCopy();
  else await seedExternal('a', { certs: true });
  if (opts.join) patchRegistry('a', { fleetJoin: fakeJoinRecord() });
  answerOrders();
  const before: Before = { inst: bot(), folder: treeOf(dataDirOf('a')), compose: fs.readFileSync(composePathOf('a'), 'utf-8') };
  expect(await startOnNewDatabase('a')).toMatchObject({ success: true });
  if (variant === 'main') {
    run.volumes[before.inst.fleetDb!.volume] = 'exists';
    run.volumes[fwd().newVolume] = 'exists';
  }
  if (variant === 'copy') run.volumes[COPY_VOLUME] = 'exists';
  vi.mocked(Date.now).mockReturnValue(LATER);
  if (opts.off === false) return before;
  await offOrder('a');
  login.canLogin = false;
  answerOrders();
  orders.length = 0;
  return before;
}

export async function pressBack(set = fwd().stamp, opts: { reverse?: boolean } = {}) {
  return putBack('a', set, opts);
}

export { stored };
