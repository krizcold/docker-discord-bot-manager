import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm31-l5-a-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir };
});

vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';
import type { KeptOpRecord } from '../../src/types';

const REGISTRY = path.join(h.dir, 'instances.json');
const SMDB = 'https://example.invalid/fake/super-modular-discord-bot';
// Ciphertexts in the v2 shape that no key decrypts: what the registry holds after the key is lost.
const BAD_PW = `v2:${'0'.repeat(24)}:${'0'.repeat(32)}:abcdef`;
const BAD_CODE = `v2:${'1'.repeat(24)}:${'1'.repeat(32)}:fedcba`;
const DB = { containerName: 'x-fleet-postgres', user: 'smdb', db: 'smdb', volume: 'x-fleet-postgres-data' };

const errors: string[] = [];
const decryptFailures = () => errors.filter(e => e.startsWith('[EnvManager] Decryption failed:')).length;

function writeRegistry(id: string, over: Record<string, unknown>): void {
  fs.writeFileSync(REGISTRY, JSON.stringify({
    instances: {
      [id]: {
        id, sanitizedName: id, displayName: id, titleName: id, status: 'stopped', sourceType: 'git', sourceUrl: SMDB,
        createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', ...over,
      },
    },
  }));
}
const raw = (id: string) => JSON.parse(fs.readFileSync(REGISTRY, 'utf-8')).instances[id];
const openOp = (set: string): KeptOpRecord => ({
  op: 'new-start', set, stamp: set, startedAt: '2026-11-17T10:00:00.000Z', parts: ['db'],
  dataDir: path.join(h.dir, 'd'), outDir: path.join(h.dir, 'o'), inDir: path.join(h.dir, 'i'),
  newVolume: 'x-fleet-postgres-data-new', offMessage: '', sharers: [], step: 'db-out',
});
const keyOf = (r: KeptOpRecord) => ({ op: r.op, set: r.set, stamp: r.stamp });
const swapIntoSet = (id: string, r: KeptOpRecord) => containerManager.swapKeptData(id, keyOf(r), (inst) => ({
  add: { id: r.set, keptAt: r.startedAt, by: 'new-start', folder: null, db: inst.fleetDb! },
  fleetDb: { ...DB, volume: r.newVolume!, password: 'new-password-5' },
}), 'swapped');

beforeEach(() => {
  errors.length = 0;
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  fs.rmSync(`${REGISTRY}.tmp`, { recursive: true, force: true });
});
afterEach(() => { vi.restoreAllMocks(); });
afterAll(() => { fs.rmSync(h.dir, { recursive: true, force: true }); });

describe('nm31 l5 a: a kept set at the registry boundary', () => {
  it('a kept database recorded without a password stays without one on load, on save and in the browser copy', () => {
    writeRegistry('a1', { keptSets: [{ id: 's-a1', keptAt: '2026-11-17T10:00:00.000Z', by: 'new-start', folder: null, db: { ...DB } }] });
    expect(containerManager.getBot('a1')!.keptSets![0].db).toEqual(DB);
    expect(containerManager.createKeptOpIf('a1', openOp('s-other'))).toBeNull();
    expect(raw('a1').keptSets[0].db).toEqual(DB);
    expect(containerManager.withoutRecordSecrets(containerManager.getBot('a1'))!.keptSets![0].db).toEqual(DB);
  });

  it('a kept set\'s password and join code that no longer decrypt are logged by name and kept on disk through a save', () => {
    writeRegistry('a2', { keptSets: [{ id: 's-a2', keptAt: '2026-11-17T10:00:00.000Z', by: 'new-start', folder: null,
      db: { ...DB, password: BAD_PW }, join: { code: BAD_CODE, host: 'h', port: 5432, db: 'smdb', fp: 'f', machine: 'm', joinedAt: '2026-11-01T00:00:00.000Z' } }] });
    const set = containerManager.getBot('a2')!.keptSets![0];
    expect(set.db!.password).toBe('');
    expect(set.join!.code).toBe('');
    expect(errors).toContain('[ContainerManager] keptSets.s-a2.db.password for instance a2 no longer decrypts (encryption key changed or lost); its ciphertext stays preserved in the registry - restore the key');
    expect(errors).toContain('[ContainerManager] keptSets.s-a2.join.code for instance a2 no longer decrypts (encryption key changed or lost); its ciphertext stays preserved in the registry - restore the key, or re-provision the value');
    expect(containerManager.createKeptOpIf('a2', openOp('s-other'))).toBeNull();
    expect(raw('a2').keptSets[0].db.password).toBe(BAD_PW);
    expect(raw('a2').keptSets[0].join.code).toBe(BAD_CODE);
  });

  it('a password that no longer decrypts follows its record into the kept set when the swap saves', () => {
    const r = openOp('s-a3');
    writeRegistry('a3', { fleetDb: { ...DB, password: BAD_PW }, keptOp: r });
    expect(containerManager.getBot('a3')!.fleetDb!.password).toBe('');
    expect(swapIntoSet('a3', r)).toBeNull();
    expect(raw('a3').keptSets[0].db.password).toBe(BAD_PW);
    expect(raw('a3').fleetDb.password).toMatch(/^v2:/);
    expect(raw('a3').fleetDb.password).not.toBe(BAD_PW);
  });

  it('a swap whose save fails throws and leaves the lost password where it was: the next load does not decrypt it again', () => {
    const r = openOp('s-a4');
    writeRegistry('a4', { fleetDb: { ...DB, password: BAD_PW }, keptOp: r });
    expect(containerManager.getBot('a4')!.fleetDb!.password).toBe('');
    const failuresAfterLoad = decryptFailures();
    expect(failuresAfterLoad).toBe(1);
    fs.mkdirSync(`${REGISTRY}.tmp`);
    fs.writeFileSync(path.join(`${REGISTRY}.tmp`, 'f'), 'x');
    expect(() => swapIntoSet('a4', r)).toThrow();
    fs.rmSync(`${REGISTRY}.tmp`, { recursive: true, force: true });
    expect(raw('a4').fleetDb.password).toBe(BAD_PW);
    expect(containerManager.getBot('a4')!.fleetDb!.password).toBe('');
    expect(decryptFailures()).toBe(failuresAfterLoad);
  });

  it('the browser copy carries keptLast as recorded', () => {
    const last = { op: 'new-start', set: 's-a5', ok: true, text: 'The bot started on a new database.', at: '2026-11-17T10:05:00.000Z' };
    writeRegistry('a5', { keptLast: last });
    expect(containerManager.withoutRecordSecrets(containerManager.getBot('a5'))!.keptLast).toEqual(last);
  });
});
