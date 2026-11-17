import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm31-records-'));
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

const KEPT_PW = 'kept-db-password-1';
const KEPT_REPL_PW = 'kept-repl-password-2';
const KEPT_FORMER_CODE = 'kept-former-main-code-3';
const KEPT_JOIN_CODE = 'kept-join-code-value-4';
const SET_ID = '2026-11-17T10-00-00-000Z';

// The data in use before the swap, with every secret a kept set carries: the fleetDb record and the join.
const fleetDb = () => ({
  containerName: 'bota-fleet-postgres', user: 'smdb', db: 'smdb', volume: 'bota-fleet-postgres-data', password: KEPT_PW,
  replication: { role: 'smdb_join', password: KEPT_REPL_PW, hostPort: 15432, publicHost: 'main.example', certHost: 'main.example' },
  formerMain: { code: KEPT_FORMER_CODE, slot: 's', machine: 'm', host: 'h', port: 5432, generation: 1, at: '2026-11-01T00:00:00.000Z' },
});
const fleetJoin = () => ({ code: KEPT_JOIN_CODE, host: 'h', port: 5432, db: 'smdb', fp: 'f', machine: 'm', joinedAt: '2026-11-01T00:00:00.000Z' });

const record = (over: Partial<KeptOpRecord> = {}): KeptOpRecord => ({
  op: 'new-start', set: SET_ID, stamp: SET_ID, startedAt: '2026-11-17T10:00:00.000Z',
  parts: ['db', 'folder'], dataDir: path.join(h.dir, 'bots', 'a', 'data'), outDir: path.join(h.dir, 'bots', 'a', 'data.kept-x'),
  inDir: path.join(h.dir, 'bots', 'a', 'data.new-x'), newVolume: 'bota-fleet-postgres-data-x', offMessage: '', sharers: [], step: 'db-out', ...over,
});
const keyOf = (r: KeptOpRecord) => ({ op: r.op, set: r.set, stamp: r.stamp });

/**
 * swapKeptData as N3 calls it: the fleetDb record and the join as they stood become the kept set, the new record
 * holds none of their secrets, and the join leaves the data in use (as a put-back of a set without one leaves it).
 */
function swapIntoKeptSet(r: KeptOpRecord): void {
  expect(containerManager.swapKeptData('a', keyOf(r), (inst) => ({
    add: { id: r.set, keptAt: r.startedAt, by: 'new-start', folder: r.outDir, db: inst.fleetDb!, join: inst.fleetJoin! },
    fleetDb: { containerName: inst.fleetDb!.containerName, user: 'smdb', db: 'smdb', volume: r.newVolume!, password: 'new-password-5' },
    fleetJoin: null,
  }), 'swapped')).toBeNull();
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  fs.rmSync(path.join(h.dir, 'instances.json'), { force: true });
  seedBot({ sanitizedName: 'bota', sourceType: 'git', fleetDb: fleetDb(), fleetJoin: fleetJoin() });
  expect(containerManager.createKeptOpIf('a', record())).toBeNull();
});
afterEach(() => { vi.restoreAllMocks(); });
afterAll(() => { fs.rmSync(h.dir, { recursive: true, force: true }); });

describe('nm31 records: the secrets of a kept set', () => {
  it('records (1 of 6): a kept set\'s db and join secrets are encrypted on disk after a save', () => {
    swapIntoKeptSet(record());
    const set = stored().keptSets[0];
    for (const value of [set.db.password, set.db.replication.password, set.db.formerMain.code, set.join.code]) {
      expect(value).toMatch(/^v2:/);
    }
    const text = fs.readFileSync(path.join(h.dir, 'instances.json'), 'utf-8');
    for (const secret of [KEPT_PW, KEPT_REPL_PW, KEPT_FORMER_CODE, KEPT_JOIN_CODE]) expect(text).not.toContain(secret);
    expect(stored().keptOp.step).toBe('swapped');
  });

  it('records (2 of 6): the same secrets read plain after a load', () => {
    swapIntoKeptSet(record());
    const set = containerManager.getBot('a')!.keptSets![0];
    expect(set.db!.password).toBe(KEPT_PW);
    expect(set.db!.replication!.password).toBe(KEPT_REPL_PW);
    expect(set.db!.formerMain!.code).toBe(KEPT_FORMER_CODE);
    expect(set.join!.code).toBe(KEPT_JOIN_CODE);
  });

  it('records (3 of 6): withoutRecordSecrets blanks them and keeps the rest of the set', () => {
    swapIntoKeptSet(record());
    const out = containerManager.withoutRecordSecrets(containerManager.getBot('a'))!;
    const set = out.keptSets![0];
    expect(set.db!.password).toBe('');
    expect(set.db!.replication!.password).toBe('');
    expect(set.db!.formerMain!.code).toBe('');
    expect(set.join!.code).toBe('');
    expect(set.db!.volume).toBe('bota-fleet-postgres-data');
    expect(out.keptOp!.step).toBe('swapped');
    const loaded = containerManager.getBot('a')!.keptSets![0];
    expect(loaded.db!.password).toBe(KEPT_PW);
  });

  it('records (4 of 6): recordSecrets lists them', () => {
    swapIntoKeptSet(record());
    const inst = containerManager.getBot('a')!;
    expect(inst.fleetDb!.password).toBe('new-password-5');
    expect(inst.fleetJoin).toBeUndefined();
    const secrets = containerManager.recordSecrets(inst);
    for (const secret of [KEPT_PW, KEPT_REPL_PW, KEPT_FORMER_CODE, KEPT_JOIN_CODE]) expect(secrets).toContain(secret);
  });
});

describe('nm31 records: stored texts are scrubbed', () => {
  it('records (5 of 6): keptOp.lastError is written with a kept set\'s secret replaced', () => {
    const r = record();
    swapIntoKeptSet(r);
    expect(containerManager.saveKeptOpIf('a', keyOf(r), { lastError: `psql failed for postgres://smdb:${KEPT_PW}@h/smdb` })).toBeNull();
    const lastError: string = stored().keptOp.lastError;
    expect(lastError).not.toContain(KEPT_PW);
    expect(lastError).toContain('***');
    expect(lastError).toContain('psql failed for');
  });

  it('records (6 of 6): keptLast.text is written with a kept set\'s secret replaced', () => {
    const r = record();
    swapIntoKeptSet(r);
    expect(containerManager.closeKeptOp('a', keyOf(r), { last: { op: 'delete', set: SET_ID, outcome: 'failed', text: `the dump failed: join ${KEPT_JOIN_CODE}` } })).toBeNull();
    const text: string = stored().keptLast.text;
    expect(text).not.toContain(KEPT_JOIN_CODE);
    expect(text).toBe('the dump failed: join ***');
  });
});
