import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm10-l5-b-env-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir, env: {} as Record<string, Record<string, string>>, envThrows: false };
});

vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));
vi.mock('../../src/env/manager', async (o) => ({
  ...(await o<typeof import('../../src/env/manager')>()),
  getEnvVarsWithStatus: (id: string) => ({ vars: { ...(h.env[id] || {}) }, undecryptable: [], encrypted: [], corrupt: false }),
  getEnvVars: (id: string) => {
    if (h.envThrows) throw new Error('the env store cannot be read');
    return { ...(h.env[id] || {}) };
  },
}));
vi.mock('../../src/docker/dockerClient', async (o) => ({
  ...(await o<typeof import('../../src/docker/dockerClient')>()),
  listComposeContainers: async () => [],
}));

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';
import { APP_CAPABILITIES } from '../../src/config/appCapabilities';
import { MG_URL_FORM } from './migrate-fake';

const SMDB = 'https://github.com/x/fully-modular-discord-bot';
const STORE = 'https://github.com/x/store-app';
const PLAIN = 'https://github.com/x/plain-app';
const VALID = 'postgresql://u:p@db.example.test:5432/app';
const record = (over: Record<string, unknown> = {}) => ({ to: 'file', from: 'postgres', destination: null, companion: false, jobId: 'mgr-a', jobIds: ['mgr-a'], posted: true, started: 1, kept: 0, phase: 'following', loginOpened: true, sharers: ['s1'], sharersStopped: [], openedAt: '2026-10-31T00:00:00.000Z', ...over });
const DEST = { to: 'postgres', from: 'file', phase: 'waiting', resumeAt: 'following', awaiting: 'destination', sharers: [] };
const base = (id: string, over: Record<string, unknown> = {}) => ({
  id, displayName: id.toUpperCase(), sanitizedName: id, titleName: id, sourceUrl: SMDB, sourceId: null, status: 'stopped', containerIds: [],
  envVars: {}, lastBuiltCommit: null, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', ...over,
});
const registryPath = path.join(h.dir, 'instances.json');
const writeRegistry = (instances: Record<string, unknown>) => fs.writeFileSync(registryPath, JSON.stringify({ instances }, null, 2));
const stored = (id: string) => JSON.parse(fs.readFileSync(registryPath, 'utf-8')).instances[id];
const envKey = (x: string, mode: string, url: string) => `A data migration to ${x} is open on this bot, so ${mode} and ${url} cannot change until it ends; nothing was changed`;
const envPort = (x: string) => `A data migration to ${x} is open on this bot, so PGPORT, which the bot's Postgres driver reads for an address with no port, cannot change until it ends; nothing was changed`;
const refuse = (error: string) => ({ success: false, error });

afterAll(() => fs.rmSync(h.dir, { recursive: true, force: true }));
beforeEach(() => {
  h.envThrows = false;
  h.env = { b1: { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: 'postgresql://smdb:pw@b1-fleet-postgres:5432/smdb' } };
  writeRegistry({ b1: base('b1', { migrate: record() }), s1: base('s1') });
});

describe('updateInstanceMigrate', () => {
  it('refuses a registry that cannot be read and leaves the file as it is', () => {
    fs.writeFileSync(registryPath, 'not json');
    expect(() => containerManager.updateInstanceMigrate('b1', record() as any)).toThrow(/instances\.json/);
    expect(fs.readFileSync(registryPath, 'utf-8')).toBe('not json');
  });
  it('refuses a bot that is not in the registry with its text', () => {
    expect(() => containerManager.updateInstanceMigrate('ghost', record() as any)).toThrow(/^the bot is no longer in the registry$/);
  });
  it('keeps the stored migrateLast when no last is given', () => {
    const last = { to: 'file', outcome: 'failed', jobId: 'mgr-a', text: 'Migration failed', at: '2026-10-31T00:00:00.000Z' };
    writeRegistry({ b1: base('b1', { migrate: record(), migrateLast: last }), s1: base('s1') });
    containerManager.updateInstanceMigrate('b1', record({ phase: 'waiting' }) as any);
    expect(stored('b1').migrateLast).toEqual(last);
    expect(stored('b1').migrate.phase).toBe('waiting');
  });
});

describe('sharerRefusal', () => {
  it('names the bot by its id when a record lists a sharer that is no longer in the registry', () => {
    writeRegistry({ b1: base('b1', { migrate: record({ sharers: ['ghost'] }) }) });
    expect(containerManager.sharerRefusal('ghost')).toEqual(refuse("ghost is held by B1's open data migration to JSON files, since it uses the same database; try again once that migration ends; nothing was changed"));
  });
});

describe('migrateKeys defaults, for an app with no companionDb', () => {
  beforeEach(() => {
    writeRegistry({ p1: base('p1', { sourceUrl: PLAIN, migrate: record({ sharers: [] }) }) });
  });
  it('a DATA_BACKEND that reads as Postgres over none stored is refused, naming DATA_BACKEND and DATA_BACKEND_URL', () => {
    h.env.p1 = {};
    expect(containerManager.migrateEnvRefusal('p1', { vars: { DATA_BACKEND: 'postgres' } })).toEqual(refuse(envKey('JSON files', 'DATA_BACKEND', 'DATA_BACKEND_URL')));
  });
  it('a null DATA_BACKEND_URL over none stored reads as blank and passes', () => {
    h.env.p1 = {};
    expect(containerManager.migrateEnvRefusal('p1', { vars: { DATA_BACKEND_URL: null } })).toBeNull();
    expect(containerManager.migrateEnvUnchanged('p1', { DATA_BACKEND_URL: null })).toEqual(['DATA_BACKEND_URL']);
  });
});

describe('migrateEnvRefusal on the default keys', () => {
  it('a null vars with a removal is refused', () => {
    expect(containerManager.migrateEnvRefusal('b1', { vars: null as any, removed: ['DATA_BACKEND'] })).toEqual(refuse(envKey('JSON files', 'DATA_BACKEND', 'DATA_BACKEND_URL')));
  });
  it('a vars that is not an object reads as none given', () => {
    const fn = Object.assign(() => {}, { DATA_BACKEND: 'file' });
    expect(containerManager.migrateEnvRefusal('b1', { vars: fn as any })).toBeNull();
  });
  it('a rename of a held key is refused', () => {
    expect(containerManager.migrateEnvRefusal('b1', { vars: {}, renamed: { DATA_BACKEND: 'OLD' } })).toEqual(refuse(envKey('JSON files', 'DATA_BACKEND', 'DATA_BACKEND_URL')));
  });
  it('a null renamed reads as no rename', () => {
    expect(containerManager.migrateEnvRefusal('b1', { vars: {}, renamed: null })).toBeNull();
  });
  it('a renamed that is not an object reads as no rename', () => {
    const fn = Object.assign(() => {}, { DATA_BACKEND: 'OLD' });
    expect(containerManager.migrateEnvRefusal('b1', { vars: {}, renamed: fn })).toBeNull();
  });
  it('with the env store unreadable, a given held key counts as a change', () => {
    h.envThrows = true;
    expect(containerManager.migrateEnvRefusal('b1', { vars: { DATA_BACKEND: 'postgres' } })).toEqual(refuse(envKey('JSON files', 'DATA_BACKEND', 'DATA_BACKEND_URL')));
  });
  it('the mode compare folds case by lower case: ss over a stored ß is refused', () => {
    h.env.b1.DATA_BACKEND = 'ß';
    expect(containerManager.migrateEnvRefusal('b1', { vars: { DATA_BACKEND: 'ss' } })).toEqual(refuse(envKey('JSON files', 'DATA_BACKEND', 'DATA_BACKEND_URL')));
  });
  it('a stored mode of spaces reads as none stored: file passes', () => {
    h.env.b1.DATA_BACKEND = '   ';
    expect(containerManager.migrateEnvRefusal('b1', { vars: { DATA_BACKEND: 'file' } })).toBeNull();
  });
});

describe('migrateEnvUnchanged', () => {
  it('answers none for a bot with no record', () => {
    expect(containerManager.migrateEnvUnchanged('s1', { DATA_BACKEND: 'postgres' })).toEqual([]);
  });
  it('answers none when the env store cannot be read', () => {
    h.envThrows = true;
    expect(containerManager.migrateEnvUnchanged('b1', { DATA_BACKEND: 'postgres' })).toEqual([]);
  });
});

describe('updateBotInOp', () => {
  it('a lane holding another op may not change a held key', async () => {
    const r = containerManager.withExternalBotOp('b1', 'build', () => containerManager.updateBotInOp('b1', { envVars: { DATA_BACKEND: 'file' } } as any, 'build'));
    await expect(r).rejects.toThrow(envKey('JSON files', 'DATA_BACKEND', 'DATA_BACKEND_URL'));
    expect(h.env.b1.DATA_BACKEND).toBe('postgres');
  });
});

describe('migrateEnvRefusal on an app whose keys are STORE_MODE and STORE_URL', () => {
  beforeEach(() => {
    APP_CAPABILITIES.unshift({ match: { urlContains: 'store-app' }, companionDb: { ...APP_CAPABILITIES[0].companionDb!, env: { url: 'STORE_URL', mode: { key: 'STORE_MODE', value: 'postgres' } } }, hooks: APP_CAPABILITIES[0].hooks });
    h.env.c1 = { STORE_MODE: 'postgres', STORE_URL: 'postgresql://smdb:pw@c1-fleet-postgres:5432/smdb', DATA_BACKEND: 'postgres' };
  });
  afterEach(() => { APP_CAPABILITIES.shift(); });
  const open = (over: Record<string, unknown>) => writeRegistry({ c1: base('c1', { sourceUrl: STORE, migrate: record({ sharers: [], ...over }) }), s1: base('s1', { fleetDb: { containerName: 's1-fleet-postgres', user: 'smdb', db: 'smdb', volume: 's1-v' } }) });
  const refusal = (vars: Record<string, unknown>, more: Record<string, unknown> = {}) => containerManager.migrateEnvRefusal('c1', { vars, ...more });

  describe('while the record runs', () => {
    beforeEach(() => open({}));
    it('a DATA_BACKEND_URL change is held too', () => {
      expect(refusal({ DATA_BACKEND_URL: VALID })).toEqual(refuse(envKey('JSON files', 'STORE_MODE', 'STORE_URL')));
    });
    it('DATA_BACKEND reads as a mode key: Postgres over a stored postgres passes', () => {
      expect(refusal({ DATA_BACKEND: 'Postgres' })).toBeNull();
    });
    it('PGPORT with STORE_MODE answers MG-ENVKEY', () => {
      expect(refusal({ PGPORT: '5433', STORE_MODE: 'file' })).toEqual(refuse(envKey('JSON files', 'STORE_MODE', 'STORE_URL')));
    });
    it('PGPORT with STORE_URL answers MG-ENVKEY when no destination is awaited', () => {
      expect(refusal({ PGPORT: '5433', STORE_URL: VALID })).toEqual(refuse(envKey('JSON files', 'STORE_MODE', 'STORE_URL')));
    });
  });

  describe('while the record awaits a destination', () => {
    beforeEach(() => open(DEST));
    it('STORE_URL alone passes', () => {
      expect(refusal({ STORE_URL: VALID })).toBeNull();
    });
    it('DATA_BACKEND_URL alone passes', () => {
      expect(refusal({ DATA_BACKEND_URL: VALID })).toBeNull();
    });
    it('STORE_URL with PGPORT answers MG-ENVKEY-PORT', () => {
      expect(refusal({ STORE_URL: VALID, PGPORT: '5433' })).toEqual(refuse(envPort('Postgres')));
    });
    it('DATA_BACKEND_URL with PGPORT answers MG-ENVKEY-PORT', () => {
      expect(refusal({ DATA_BACKEND_URL: VALID, PGPORT: '5433' })).toEqual(refuse(envPort('Postgres')));
    });
    it('STORE_URL with STORE_MODE answers MG-ENVKEY', () => {
      expect(refusal({ STORE_URL: VALID, STORE_MODE: 'file' })).toEqual(refuse(envKey('Postgres', 'STORE_MODE', 'STORE_URL')));
    });
    it('PGPORT with STORE_MODE answers MG-ENVKEY', () => {
      expect(refusal({ PGPORT: '5433', STORE_MODE: 'file' })).toEqual(refuse(envKey('Postgres', 'STORE_MODE', 'STORE_URL')));
    });
    it('a null STORE_URL over a stored one reads as blank and passes', () => {
      expect(refusal({ STORE_URL: null })).toBeNull();
    });
    it('a URL with no port under a stored PGPORT answers MG-URL-FORM pgport', () => {
      h.env.c1.PGPORT = '5433';
      expect(refusal({ STORE_URL: 'postgresql://u:p@db.example.test/app' })).toEqual(refuse(MG_URL_FORM('pgport')));
    });
  });
});
