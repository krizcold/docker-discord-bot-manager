import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm31-l5-b-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir };
});

vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';
import { seedBot, stored } from './nm2-harness';
import type { KeptOpRecord } from '../../src/types';

const SET_A = '2026-11-17T10-00-00-000Z';
const SET_B = '2026-11-17T11-00-00-000Z';
const NOW_VOLUME = 'bota-fleet-postgres-data';
const KEPT_VOLUME = 'bota-fleet-postgres-data-kept';
const BROKEN = /^The instance registry \(instances\.json\) cannot be read, so the bot list is unknown and every change is refused/;
const CLOSED = 'the record was closed while this ran';

const fleetDb = (volume: string) => ({ containerName: 'bota-fleet-postgres', user: 'smdb', db: 'smdb', volume, password: 'pw-1' });
const setA = () => ({ id: SET_A, keptAt: '2026-11-17T10:00:00.000Z', by: 'new-start', folder: null, db: fleetDb(KEPT_VOLUME) });
const setB = () => ({ id: SET_B, keptAt: '2026-11-17T11:00:00.000Z', by: 'new-start', folder: path.join(h.dir, 'kept-b') });

const record = (over: Partial<KeptOpRecord> = {}): KeptOpRecord => ({
  op: 'new-start', set: SET_A, stamp: SET_A, startedAt: '2026-11-17T10:00:00.000Z',
  parts: [], dataDir: path.join(h.dir, 'bots', 'a', 'data'), outDir: '', inDir: '', offMessage: '', sharers: [], step: 'recorded', ...over,
});
const keyOf = (r: KeptOpRecord) => ({ op: r.op, set: r.set, stamp: r.stamp });
const regFile = () => path.join(h.dir, 'instances.json');
const breakRegistry = () => fs.writeFileSync(regFile(), '{ not json');
const last = { op: 'new-start' as const, set: SET_A, outcome: 'done' as const, text: 'done' };

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  fs.rmSync(regFile(), { force: true });
});
afterEach(() => { vi.restoreAllMocks(); });
afterAll(() => { fs.rmSync(h.dir, { recursive: true, force: true }); });

describe('nm31 l5 b: createKeptOpIf', () => {
  it('refuses with the registry fault when instances.json cannot be read', () => {
    breakRegistry();
    expect(() => containerManager.createKeptOpIf('a', record())).toThrow(BROKEN);
  });

  it('refuses a bot the registry does not hold with the exact text', () => {
    seedBot({ sanitizedName: 'bota' });
    let err: unknown;
    try { containerManager.createKeptOpIf('zz', record()); } catch (e) { err = e; }
    expect((err as Error).message).toBe('the bot is no longer in the registry');
  });

  it('drops the keptSets field when the dropped part was the last one', () => {
    seedBot({ sanitizedName: 'bota', fleetDb: fleetDb(NOW_VOLUME), keptSets: [setA()] });
    expect(containerManager.createKeptOpIf('a', record({ op: 'delete' }), { set: SET_A, part: 'db' })).toBeNull();
    expect('keptSets' in stored()).toBe(false);
    expect(stored().keptOp.op).toBe('delete');
  });
});

describe('nm31 l5 b: saveKeptOpIf', () => {
  it('refuses with the registry fault when instances.json cannot be read', () => {
    breakRegistry();
    expect(() => containerManager.saveKeptOpIf('a', keyOf(record()), { step: 'db-out' })).toThrow(BROKEN);
  });

  it('refuses a bot the registry does not hold with the exact text', () => {
    seedBot({ sanitizedName: 'bota', keptOp: record() });
    let err: unknown;
    try { containerManager.saveKeptOpIf('zz', keyOf(record()), { step: 'db-out' }); } catch (e) { err = e; }
    expect((err as Error).message).toBe('the bot is no longer in the registry');
  });

  for (const [field, other] of [['op', 'put-back'], ['set', SET_B], ['stamp', SET_B]] as const) {
    it(`answers the closed text and writes nothing when the open record's ${field} differs`, () => {
      seedBot({ sanitizedName: 'bota', keptOp: record() });
      expect(containerManager.saveKeptOpIf('a', { ...keyOf(record()), [field]: other }, { step: 'db-out' })).toBe(CLOSED);
      expect(stored().keptOp.step).toBe('recorded');
    });
  }
});

describe('nm31 l5 b: closeKeptOp matches the open record', () => {
  it('answers the closed text with no open record', () => {
    seedBot({ sanitizedName: 'bota' });
    expect(containerManager.closeKeptOp('a', keyOf(record()), { last })).toBe(CLOSED);
    expect(stored().keptLast).toBeUndefined();
  });

  for (const [field, other] of [['op', 'put-back'], ['set', SET_B], ['stamp', SET_B]] as const) {
    it(`answers the closed text and keeps the record when its ${field} differs`, () => {
      seedBot({ sanitizedName: 'bota', keptOp: record() });
      expect(containerManager.closeKeptOp('a', { ...keyOf(record()), [field]: other }, { last })).toBe(CLOSED);
      expect(stored().keptOp.step).toBe('recorded');
      expect(stored().keptLast).toBeUndefined();
    });
  }
});

describe('nm31 l5 b: keptVolumeReason', () => {
  it('answers can\'t confirm when instances.json cannot be read', () => {
    breakRegistry();
    expect(containerManager.keptVolumeReason(NOW_VOLUME)).toBe("the manager can't confirm it is not kept data (the instance registry cannot be read)");
  });

  it('a put-back record keeps the current volume when its own set holds a database', () => {
    seedBot({ sanitizedName: 'bota', fleetDb: fleetDb(NOW_VOLUME), keptSets: [setB(), setA()], keptOp: record({ op: 'put-back', set: SET_A }) });
    expect(containerManager.keptVolumeReason(NOW_VOLUME)).toBe("it is kept by Bot a's Kept data");
  });

  it('a put-back record of a folder-only set does not keep the current volume', () => {
    seedBot({ sanitizedName: 'bota', fleetDb: fleetDb(NOW_VOLUME), keptSets: [setA(), setB()], keptOp: record({ op: 'put-back', set: SET_B }) });
    expect(containerManager.keptVolumeReason(NOW_VOLUME)).toBeNull();
  });

  it('a delete record does not keep the current volume', () => {
    seedBot({ sanitizedName: 'bota', fleetDb: fleetDb(NOW_VOLUME), keptSets: [setA()], keptOp: record({ op: 'delete', set: SET_A }) });
    expect(containerManager.keptVolumeReason(NOW_VOLUME)).toBeNull();
    expect(containerManager.keptVolumeReason('Stryker was here')).toBeNull();
  });

  it('a new-start record with no new volume keeps no other name', () => {
    seedBot({ sanitizedName: 'bota', fleetDb: fleetDb(NOW_VOLUME), keptOp: record() });
    expect(containerManager.keptVolumeReason('Stryker was here')).toBeNull();
  });
});

describe('nm31 l5 b: migrateEnvRefusal lists the held keys', () => {
  it('names three removed keys as a list', () => {
    seedBot({ sanitizedName: 'bota', keptOp: record() });
    expect(containerManager.migrateEnvRefusal('a', { removed: ['DATA_BACKEND', 'DATA_BACKEND_URL', 'PGPORT'] })).toEqual({
      success: false,
      error: 'Start on a new database did not finish on this bot, so DATA_BACKEND, DATA_BACKEND_URL and PGPORT cannot change until it does; nothing was changed',
    });
  });
});
