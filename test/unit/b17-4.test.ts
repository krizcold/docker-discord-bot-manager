import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'b17-4-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir, volume: 'absent' as 'exists' | 'absent' | 'unknown', inspected: [] as string[] };
});

const fail = (stderr: string): Error => Object.assign(new Error(stderr), { stderr });
const answer = (args: string[]): string => {
  if (args[0] === 'volume' && args[1] === 'inspect') {
    h.inspected.push(args[2]);
    if (h.volume === 'exists') return '[{}]';
    if (h.volume === 'absent') throw fail('Error: No such volume: ' + args[2]);
    throw fail('Cannot connect to the Docker daemon');
  }
  return '';
};

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const execFileSync = (_f: string, args: string[]) => answer(args);
  const execFile = (_f: string, args: string[], opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    try { done(null, { stdout: answer(args), stderr: '' }); } catch (e) { done(e); }
  };
  const execSync = () => '';
  const exec = (_cmd: string, opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    done(null, { stdout: '', stderr: '' });
  };
  const mod = { ...real, exec, execFile, execFileSync, execSync };
  return { ...mod, default: mod };
});
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import * as fs from 'fs';
import * as path from 'path';
import YAML from 'yaml';
import * as containerManager from '../../src/docker/containerManager';
import * as envManager from '../../src/env/manager';
import { generateCompose } from '../../src/templates/compose';
import { processComposeForCasaOS } from '../../src/templates/pcsProcessing';

const cm = containerManager as any;
const em = envManager as any;
const registryPath = path.join(h.dir, 'instances.json');
const record = (id: string, name: string): any => ({
  id, sanitizedName: name.toLowerCase().replace(/[^a-z0-9]/g, ''), displayName: name, titleName: name, status: 'stopped',
  sourceType: 'git', sourceUrl: 'https://example.com/a.git', envVars: {},
  createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z',
});
const writeRegistry = (...instances: any[]): void => {
  fs.writeFileSync(registryPath, JSON.stringify({ instances: Object.fromEntries(instances.map((i) => [i.id, i])) }));
};
const deploy = (id: string, compose: string): void => {
  fs.mkdirSync(path.join(h.dir, 'bots', id), { recursive: true });
  fs.writeFileSync(path.join(h.dir, 'bots', id, 'docker-compose.yml'), compose);
};
const backingFile = (id: string) => path.join(h.dir, 'bots', id, 'env', 'backingServices.json');

const bot = (over: Record<string, unknown> = {}): any => ({
  id: 'b1', displayName: 'My Bot', sanitizedName: 'mybot', titleName: 'My Bot', envVars: {}, ...over,
});
const detect = (databases: string[], needsLavalink = false): any => ({ type: 'node', databases, needsLavalink });
const secrets = { postgres: 'pg-secret', mongo: 'mo-secret', mariadb: 'ma-secret', 'mariadb-root': 'mr-secret', redis: 're-secret' };

const savedPass = process.env.APP_DEFAULT_PASSWORD;
beforeEach(() => {
  h.volume = 'absent';
  h.inspected.length = 0;
  process.env.APP_DEFAULT_PASSWORD = 'platform-admin-pw';
  for (const p of ['bots', 'DATA']) fs.rmSync(path.join(h.dir, p), { recursive: true, force: true });
  writeRegistry();
});

afterAll(() => {
  if (savedPass === undefined) delete process.env.APP_DEFAULT_PASSWORD; else process.env.APP_DEFAULT_PASSWORD = savedPass;
  fs.rmSync(h.dir, { recursive: true, force: true });
});

describe('R9-22: the bot addresses its own backing services by their container names', () => {
  it('every generated URL names the per-instance container, never the bare service name', () => {
    const doc = YAML.parse(generateCompose(bot(), detect(['postgres', 'mongo', 'redis'], true), '/tmp/x', 'img', secrets));
    const env = doc.services.bot.environment;
    expect(new URL(env.DATABASE_URL).hostname).toBe('bot-b1-postgres');
    expect(new URL(env.MONGO_URI).hostname).toBe('bot-b1-mongo');
    expect(new URL(env.REDIS_URL).hostname).toBe('bot-b1-redis');
    expect(env.LAVALINK_HOST).toBe('bot-b1-lavalink');
    expect(doc.services.postgres.container_name).toBe('bot-b1-postgres');
    expect(doc.services.redis.container_name).toBe('bot-b1-redis');
  });

  it('the mariadb URL names its container too', () => {
    const doc = YAML.parse(generateCompose(bot(), detect(['mysql']), '/tmp/x', 'img', secrets));
    expect(new URL(doc.services.bot.environment.DATABASE_URL).hostname).toBe('bot-b1-mariadb');
  });

  it('the generated Redis requires a password and the bot URL carries it', () => {
    const doc = YAML.parse(generateCompose(bot(), detect(['redis']), '/tmp/x', 'img', secrets));
    expect(doc.services.redis.command).toEqual(['redis-server', '--requirepass', 're-secret']);
    expect(decodeURIComponent(new URL(doc.services.bot.environment.REDIS_URL).password)).toBe('re-secret');
  });

  it('CasaOS: a main service with no networks keeps the project network beside pcs', () => {
    const compose = 'services:\n  app:\n    image: x\n    ports: ["8080:8080"]\n  db:\n    image: postgres\n';
    const doc = YAML.parse(processComposeForCasaOS(compose, 'mybot', bot(), { mode: 'casaos' }).content);
    expect(doc.services.app.networks).toEqual(['default', 'pcs']);
  });
});

describe('R16-38: generated backing services get per-instance passwords, never the platform password', () => {
  it('the platform password appears nowhere in the generated compose', () => {
    const out = generateCompose(bot(), detect(['postgres', 'mongo', 'mariadb', 'redis']), '/tmp/x', 'img', secrets);
    expect(out).not.toContain('platform-admin-pw');
    const doc = YAML.parse(out);
    expect(doc.services.postgres.environment.POSTGRES_PASSWORD).toBe('pg-secret');
    expect(doc.services.mongo.environment.MONGO_INITDB_ROOT_PASSWORD).toBe('mo-secret');
    expect(doc.services.mariadb.environment.MARIADB_PASSWORD).toBe('ma-secret');
    expect(doc.services.mariadb.environment.MARIADB_ROOT_PASSWORD).toBe('mr-secret');
    expect(decodeURIComponent(new URL(doc.services.bot.environment.DATABASE_URL).password)).toBe('pg-secret');
  });

  it('a detected database with no password on record refuses instead of falling back', () => {
    expect(() => generateCompose(bot(), detect(['postgres']), '/tmp/x', 'img', {})).toThrow(/No password is on record for the generated postgres service/);
  });

  it('a password holding $ and @ reaches the server and the URL literally', () => {
    const doc = YAML.parse(generateCompose(bot(), detect(['postgres']), '/tmp/x', 'img', { postgres: 'a$b@c' }));
    expect(doc.services.postgres.environment.POSTGRES_PASSWORD).toBe('a$$b@c');
    expect(decodeURIComponent(new URL(doc.services.bot.environment.DATABASE_URL).password)).toBe('a$b@c');
  });

  it('a new instance gets random passwords, recorded encrypted and stable across builds', () => {
    writeRegistry(record('b1', 'My Bot'));
    const first = cm.generatedBackingPasswords(record('b1', 'My Bot'), detect(['postgres', 'redis']));
    expect(first.passwords.postgres).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(first.passwords.redis).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(first.passwords.postgres).not.toBe(first.passwords.redis);
    expect(h.inspected).toEqual(['mybot_bot-b1-postgres-data']);
    const raw = fs.readFileSync(backingFile('b1'), 'utf-8');
    expect(raw).not.toContain(first.passwords.postgres);
    const second = cm.generatedBackingPasswords(record('b1', 'My Bot'), detect(['postgres', 'redis']));
    expect(second.passwords).toEqual(first.passwords);
  });

  it('a deployed database keeps the password its volume was created with', () => {
    deploy('b1', [
      'services:',
      '  postgres:',
      '    image: postgres:16-alpine',
      '    environment:',
      '      POSTGRES_PASSWORD: casaos',
      '    volumes:',
      '      - type: volume',
      '        source: bot-b1-postgres-data',
      '        target: /var/lib/postgresql/data',
      '',
    ].join('\n'));
    h.volume = 'exists';
    const out = cm.generatedBackingPasswords(record('b1', 'My Bot'), detect(['postgres']));
    expect(out.passwords.postgres).toBe('casaos');
    expect(out.notes.join(' ')).toMatch(/Recorded the password the postgres database was created with/);
    expect(em.getBackingPasswords('b1')).toEqual({ postgres: 'casaos' });
  });

  it('an existing volume whose password is not on record refuses and records nothing', () => {
    h.volume = 'exists';
    expect(() => cm.generatedBackingPasswords(record('b1', 'My Bot'), detect(['postgres'])))
      .toThrow(/mybot_bot-b1-postgres-data already holds the postgres database.*not on record/);
    expect(fs.existsSync(backingFile('b1'))).toBe(false);
  });

  it('an unanswered volume probe refuses as unconfirmed and records nothing', () => {
    h.volume = 'unknown';
    expect(() => cm.generatedBackingPasswords(record('b1', 'My Bot'), detect(['mongo'])))
      .toThrow(/Could not confirm whether volume mybot_bot-b1-mongo-data/);
    expect(fs.existsSync(backingFile('b1'))).toBe(false);
  });

  it('a deployed password set through a variable cannot be confirmed', () => {
    deploy('b1', 'services:\n  postgres:\n    image: p\n    environment:\n      POSTGRES_PASSWORD: ${PW}\n    volumes: ["bot-b1-postgres-data:/var/lib/postgresql/data"]\n');
    expect(() => cm.generatedBackingPasswords(record('b1', 'My Bot'), detect(['postgres'])))
      .toThrow(/Could not confirm the password the postgres database was created with/);
    expect(fs.existsSync(backingFile('b1'))).toBe(false);
  });

  it('an unreadable password file refuses and stays as it was', () => {
    fs.mkdirSync(path.dirname(backingFile('b1')), { recursive: true });
    fs.writeFileSync(backingFile('b1'), '{not json');
    expect(() => cm.generatedBackingPasswords(record('b1', 'My Bot'), detect(['postgres']))).toThrow(/cannot be read/);
    expect(fs.readFileSync(backingFile('b1'), 'utf-8')).toBe('{not json');
  });

  it('a password on record is never replaced', () => {
    em.addBackingPasswords('b1', { postgres: 'one' });
    expect(() => em.addBackingPasswords('b1', { postgres: 'two' })).toThrow(/already on record/);
    expect(em.getBackingPasswords('b1')).toEqual({ postgres: 'one' });
  });
});

describe('R10-6: named networks are namespaced, a shared external network is refused', () => {
  const repo = [
    'services:',
    '  app:',
    '    image: x',
    '    ports: ["8080:8080"]',
    '    networks: [backend, ext]',
    '  db:',
    '    image: postgres',
    '    networks: [backend]',
    'networks:',
    '  backend:',
    '    name: shared-backend',
    '  ext:',
    '    external: true',
    '    name: lan',
    '',
  ].join('\n');

  for (const mode of ['casaos', 'docker'] as const) {
    it(`${mode}: an explicitly named network becomes <app>_<key> and is logged; external ones keep their name`, () => {
      const out = processComposeForCasaOS(repo, 'mybot', bot(), { mode, hostBotDir: mode === 'docker' ? '/srv/bots/b1' : undefined }) as any;
      const doc = YAML.parse(out.content);
      expect(doc.networks.backend.name).toBe('mybot_backend');
      expect(doc.networks.ext.name).toBe('lan');
      expect(out.networkNotes).toEqual(['[Compose] Network backend -> mybot_backend']);
      if (mode === 'casaos') expect(doc.networks.pcs).toEqual({ name: 'pcs', external: true });
      else expect(doc.networks.dbm_internal).toEqual({ name: 'dbm_internal', external: true });
    });
  }

  it('an external network another deployed bot declares is a conflict naming that bot', () => {
    writeRegistry(record('b1', 'Cool Bot'), record('b2', 'Second'));
    deploy('b1', 'services:\n  app:\n    image: x\n    networks: [lan]\nnetworks:\n  lan:\n    external: true\n');
    const own = 'services:\n  app:\n    image: x\n    networks: [ext]\nnetworks:\n  ext:\n    external: true\n    name: lan\n';
    expect(cm.sharedNetworkConflicts('b2', own)).toEqual(['network lan is also used by Cool Bot; services named db or redis would answer for both bots']);
    expect(() => cm.refuseUnownedStorage(record('b2', 'Second'), 'second', own, false)).toThrow(/Network shared with another bot: network lan/);
  });

  it('the manager\'s own shared networks are not conflicts', () => {
    writeRegistry(record('b1', 'Cool Bot'), record('b2', 'Second'));
    const platform = 'services:\n  app:\n    image: x\nnetworks:\n  pcs:\n    name: pcs\n    external: true\n  dbm_internal:\n    name: dbm_internal\n    external: true\n';
    deploy('b1', platform);
    expect(cm.sharedNetworkConflicts('b2', platform)).toEqual([]);
  });

  it('an unreadable compose of another bot is a conflict, since its networks cannot be checked', () => {
    writeRegistry(record('b1', 'Cool Bot'), record('b2', 'Second'));
    deploy('b1', 'services: [\n');
    const own = 'services:\n  app:\n    image: x\nnetworks:\n  lan:\n    external: true\n';
    expect(cm.sharedNetworkConflicts('b2', own).join(' ')).toMatch(/Cool Bot's compose .* cannot be parsed/);
  });
});
