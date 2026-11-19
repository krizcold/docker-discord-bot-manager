import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm31-l5-c-'));
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

const SET_ID = '2026-11-17T10-00-00-000Z';
const GONE = 'the bot is no longer in the registry';
const regFile = () => path.join(h.dir, 'instances.json');

const record = (over: Partial<KeptOpRecord> = {}): KeptOpRecord => ({
  op: 'new-start', set: SET_ID, stamp: SET_ID, startedAt: '2026-11-17T10:00:00.000Z',
  parts: ['db', 'folder'], dataDir: path.join(h.dir, 'bots', 'a', 'data'), outDir: path.join(h.dir, 'bots', 'a', 'data.kept-x'),
  inDir: path.join(h.dir, 'bots', 'a', 'data.new-x'), newVolume: 'bota-fleet-postgres-data-x', offMessage: '', sharers: [], step: 'db-out', ...over,
});
const keyOf = (r: KeptOpRecord) => ({ op: r.op, set: r.set, stamp: r.stamp });
const dbOf = (volume: string) => ({ containerName: 'bota-fleet-postgres', user: 'smdb', db: 'smdb', volume, password: 'pw-1' });
const set = (id: string, over: Record<string, unknown> = {}) => ({ id, keptAt: '2026-11-01T00:00:00.000Z', by: 'new-start', ...over });

function breakRegistry(): void {
  fs.writeFileSync(regFile(), '{ not json');
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  fs.rmSync(regFile(), { force: true });
  seedBot({ sanitizedName: 'bota', sourceType: 'git', fleetDb: dbOf('bota-fleet-postgres-data') });
});
afterEach(() => { vi.restoreAllMocks(); });
afterAll(() => { fs.rmSync(h.dir, { recursive: true, force: true }); });

const swap = (id = 'a', r = record()) => containerManager.swapKeptData(id, keyOf(r), () => ({ add: set(r.set, { folder: r.outDir }) as never }), 'swapped');
const close = (id = 'a', r = record()) => containerManager.closeKeptOp(id, keyOf(r), { last: { op: 'new-start', outcome: 'done' } as never });
const drop = (id: string, setId: string, part: 'db' | 'copy') => containerManager.dropKeptPart(id, setId, part);
const closeDel = (id = 'a', r = record({ op: 'delete' })) => containerManager.closeKeptDeleteIf(id, keyOf(r), { op: 'delete', outcome: 'done' } as never);

describe('nm31 l5 c: an unreadable registry and a missing bot', () => {
  for (const [name, call] of [['swapKeptData', () => swap()], ['closeKeptOp', () => close()], ['dropKeptPart', () => drop('a', SET_ID, 'db')], ['closeKeptDeleteIf', () => closeDel()]] as const) {
    it(`${name} refuses an unreadable instances.json with the registry text`, () => {
      breakRegistry();
      let err: Error | null = null;
      try { call(); } catch (e) { err = e as Error; }
      expect(err).not.toBeNull();
      expect(err!.message).not.toBe(GONE);
      expect(err!.message).toContain('instances.json');
      expect(fs.readFileSync(regFile(), 'utf-8')).toBe('{ not json');
    });
  }

  for (const [name, call] of [['swapKeptData', () => swap('zz')], ['closeKeptOp', () => close('zz')], ['dropKeptPart', () => drop('zz', SET_ID, 'db')], ['closeKeptDeleteIf', () => closeDel('zz')]] as const) {
    it(`${name} throws the exact text for a bot no longer in the registry`, () => {
      expect(call).toThrow(new Error(GONE));
    });
  }
});

describe('nm31 l5 c: swapKeptData keeps the other sets', () => {
  it('replaces the set with the same id, drops the removed set and keeps every other set in order', () => {
    expect(containerManager.createKeptOpIf('a', record())).toBeNull();
    const before = stored();
    const file = JSON.parse(fs.readFileSync(regFile(), 'utf-8'));
    file.instances.a = { ...before, keptSets: [set('other-1', { folder: '/x1' }), set(SET_ID, { folder: '/old' }), set('gone-1', { folder: '/x2' }), set('other-2', { folder: '/x3' })] };
    fs.writeFileSync(regFile(), JSON.stringify(file));
    const r = record();
    expect(containerManager.swapKeptData('a', keyOf(r), () => ({ add: set(SET_ID, { folder: '/new' }) as never, remove: 'gone-1' }), 'swapped')).toBeNull();
    expect(stored().keptSets.map((s: { id: string; folder: string }) => `${s.id}:${s.folder}`)).toEqual(['other-1:/x1', 'other-2:/x3', `${SET_ID}:/new`]);
  });
});

describe('nm31 l5 c: closeKeptOp with a record that no longer matches', () => {
  it('answers KEPT_RECORD_CLOSED and writes nothing when the stamp differs', () => {
    expect(containerManager.createKeptOpIf('a', record())).toBeNull();
    const text = fs.readFileSync(regFile(), 'utf-8');
    expect(containerManager.closeKeptOp('a', { ...keyOf(record()), stamp: 'other' }, { last: { op: 'new-start', outcome: 'done' } as never })).toBe(containerManager.KEPT_RECORD_CLOSED);
    expect(fs.readFileSync(regFile(), 'utf-8')).toBe(text);
    expect(stored().keptOp.stamp).toBe(SET_ID);
  });
});

describe('nm31 l5 c: dropKeptPart', () => {
  const seedSets = (sets: unknown[]) => seedBot({ sanitizedName: 'bota', sourceType: 'git', fleetDb: dbOf('v'), keptSets: sets });

  it('answers the exact text for a set that is not recorded and writes nothing', () => {
    seedSets([set('s1', { folder: '/f' })]);
    const text = fs.readFileSync(regFile(), 'utf-8');
    expect(drop('a', 'nope', 'db')).toBe('the kept data is no longer recorded');
    expect(fs.readFileSync(regFile(), 'utf-8')).toBe(text);
  });

  it('drops the part from the named set only and keeps the others', () => {
    seedSets([set('s1', { db: dbOf('v1'), folder: '/f1' }), set('s2', { db: dbOf('v2'), folder: '/f2' }), set('s3', { folder: '/f3' })]);
    expect(drop('a', 's2', 'db')).toBeNull();
    const sets = stored().keptSets;
    expect(sets.map((s: { id: string }) => s.id)).toEqual(['s1', 's2', 's3']);
    expect(sets[0].db.volume).toBe('v1');
    expect(sets[1].db).toBeUndefined();
    expect(sets[1].folder).toBe('/f2');
  });

  it('drops restoreNotice with the db part', () => {
    seedSets([set('s1', { db: dbOf('v1'), copy: { volume: 'c1' }, restoreNotice: { at: 'x' } })]);
    expect(drop('a', 's1', 'db')).toBeNull();
    const s = stored().keptSets[0];
    expect(s.db).toBeUndefined();
    expect(s.restoreNotice).toBeUndefined();
    expect(s.copy).toEqual({ volume: 'c1' });
  });

  it('keeps restoreNotice when the copy part goes', () => {
    seedSets([set('s1', { db: dbOf('v1'), copy: { volume: 'c1' }, restoreNotice: { at: 'x' } })]);
    expect(drop('a', 's1', 'copy')).toBeNull();
    const s = stored().keptSets[0];
    expect(s.copy).toBeUndefined();
    expect(s.restoreNotice).toEqual({ at: 'x' });
    expect(s.db.volume).toBe('v1');
  });

  it('keeps a set left with only its db', () => {
    seedSets([set('s1', { db: dbOf('v1'), copy: { volume: 'c1' } })]);
    expect(drop('a', 's1', 'copy')).toBeNull();
    expect(stored().keptSets.map((s: { id: string }) => s.id)).toEqual(['s1']);
  });

  it('keeps a set left with only its copy', () => {
    seedSets([set('s1', { db: dbOf('v1'), copy: { volume: 'c1' } })]);
    expect(drop('a', 's1', 'db')).toBeNull();
    expect(stored().keptSets[0].copy).toEqual({ volume: 'c1' });
  });

  it('removes a set left naming nothing and deletes keptSets', () => {
    seedSets([set('s1', { db: dbOf('v1') })]);
    expect(drop('a', 's1', 'db')).toBeNull();
    expect(stored().keptSets).toBeUndefined();
  });
});

describe('nm31 l5 c: closeKeptDeleteIf', () => {
  it('answers removing and leaves the record while the delete is removing', () => {
    const r = record({ op: 'delete', step: 'removing' as never });
    seedBot({ sanitizedName: 'bota', sourceType: 'git', keptOp: r });
    const text = fs.readFileSync(regFile(), 'utf-8');
    expect(containerManager.closeKeptDeleteIf('a', keyOf(r), { op: 'delete', outcome: 'done' } as never)).toBe('removing');
    expect(fs.readFileSync(regFile(), 'utf-8')).toBe(text);
  });

  it('closes a delete record before removing', () => {
    const r = record({ op: 'delete', step: 'db-out' });
    seedBot({ sanitizedName: 'bota', sourceType: 'git', keptOp: r });
    expect(containerManager.closeKeptDeleteIf('a', keyOf(r), { op: 'delete', outcome: 'done' } as never)).toBeNull();
    expect(stored().keptOp).toBeUndefined();
    expect(stored().keptLast.op).toBe('delete');
  });
});
