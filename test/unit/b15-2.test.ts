import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'b15-2-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir, volumes: new Set<string>(), failRm: new Set<string>() };
});

const fail = (stderr: string): Error => Object.assign(new Error(stderr), { stderr });
const answer = (args: string[]): string => {
  const line = args.join(' ');
  if (line.startsWith('image inspect')) throw fail('Error: No such image: x');
  if (args[0] === 'volume' && args[1] === 'ls') {
    const prefix = args[args.indexOf('--filter') + 1].replace(/^name=/, '');
    return [...h.volumes].filter((v) => v.includes(prefix)).join('\n');
  }
  if (args[0] === 'volume' && (args[1] === 'inspect' || args[1] === 'rm')) {
    if (!h.volumes.has(args[2])) throw fail(`Error: No such volume: ${args[2]}`);
    if (args[1] === 'rm' && h.failRm.has(args[2])) throw fail('Error: volume is in use');
    if (args[1] === 'rm') h.volumes.delete(args[2]);
    return '';
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
  const exec = (cmd: string, opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    if (cmd.startsWith('docker inspect')) done(new Error('Error: No such object'));
    else if (cmd.startsWith('docker rm')) done(new Error('Error: No such container'));
    else done(null, { stdout: '', stderr: '' });
  };
  const mod = { ...real, exec, execFile, execFileSync, execSync };
  return { ...mod, default: mod };
});
vi.mock('../../src/casaos/detector', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/casaos/detector')>()),
  getDeploymentMode: async () => 'docker',
}));
vi.mock('../../src/docker/dockerClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/docker/dockerClient')>()),
  composeUp: async () => {},
  verifyComposeProjectRunning: async () => ({ allRunning: true, problems: [] }),
}));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';

const FIRST = 'bot1_bot-first-postgres-data';
const OWN = 'bot1_bot-b2-postgres-data';
const botDir = path.join(h.dir, 'bots', 'b2');
const composePath = path.join(botDir, 'docker-compose.yml');
const registered = (): boolean =>
  'b2' in JSON.parse(fs.readFileSync(path.join(h.dir, 'instances.json'), 'utf-8')).instances;

beforeEach(() => {
  h.volumes = new Set([FIRST, OWN]);
  h.failRm = new Set();
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
  fs.mkdirSync(botDir, { recursive: true });
  fs.writeFileSync(composePath, [
    'services:',
    '  postgres:',
    '    image: postgres:16-alpine',
    '    volumes:',
    '      - type: volume',
    '        source: bot-b2-postgres-data',
    '        target: /var/lib/postgresql/data',
    'volumes:',
    '  bot-b2-postgres-data: {}',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(h.dir, 'instances.json'), JSON.stringify({
    instances: {
      b2: {
        id: 'b2', sanitizedName: 'bot1', displayName: 'Bot 1', titleName: 'Bot 1', status: 'stopped',
        sourceType: 'docker-image', envVars: {},
        createdAt: '2026-10-22T00:00:00.000Z', updatedAt: '2026-10-22T00:00:00.000Z',
      },
    },
  }));
});

afterAll(() => {
  fs.rmSync(h.dir, { recursive: true, force: true });
});

describe('B15-2 a data-deleting Remove deletes only its own instance volumes', () => {
  it('a same-name reinstall removed with its data leaves the first install kept volume', async () => {
    await expect(containerManager.deleteBot('b2', false, false)).resolves.toBe(true);
    expect(h.volumes.has(OWN)).toBe(false);
    expect(h.volumes.has(FIRST)).toBe(true);
    expect(registered()).toBe(false);
  });

  it('an instance never deployed (no compose) deletes no project volume', async () => {
    h.volumes = new Set([FIRST]);
    fs.rmSync(composePath);
    await expect(containerManager.deleteBot('b2', false, false)).resolves.toBe(true);
    expect(h.volumes.has(FIRST)).toBe(true);
  });

  it('a retry after a failed volume removal still removes the own volume', async () => {
    h.failRm.add(OWN);
    await expect(containerManager.deleteBot('b2', false, false)).rejects.toThrow(/uninstall incomplete/);
    expect(registered()).toBe(true);
    h.failRm.clear();
    await expect(containerManager.deleteBot('b2', false, false)).resolves.toBe(true);
    expect(h.volumes.has(OWN)).toBe(false);
    expect(h.volumes.has(FIRST)).toBe(true);
  });

  it('a retry after an unreadable compose stays in error', async () => {
    fs.writeFileSync(composePath, 'services: [unclosed\n  : :');
    await expect(containerManager.deleteBot('b2', false, false)).rejects.toThrow(/uninstall incomplete/);
    await expect(containerManager.deleteBot('b2', false, false)).rejects.toThrow(/uninstall incomplete/);
    expect(registered()).toBe(true);
    expect(h.volumes.has(FIRST)).toBe(true);
  });

  it('a volume an earlier deploy recorded but the current compose dropped is removed', async () => {
    const CACHE = 'bot1_cache';
    h.volumes.add(CACHE);
    const reg = JSON.parse(fs.readFileSync(path.join(h.dir, 'instances.json'), 'utf-8'));
    reg.instances.b2.projectVolumes = [CACHE];
    fs.writeFileSync(path.join(h.dir, 'instances.json'), JSON.stringify(reg));
    await expect(containerManager.deleteBot('b2', false, false)).resolves.toBe(true);
    expect(h.volumes.has(CACHE)).toBe(false);
    expect(h.volumes.has(OWN)).toBe(false);
    expect(h.volumes.has(FIRST)).toBe(true);
  });

  it('a volume recorded by a start then dropped from the compose is removed', async () => {
    h.volumes.add('bot1_cache');
    const reg = JSON.parse(fs.readFileSync(path.join(h.dir, 'instances.json'), 'utf-8'));
    reg.instances.b2.imageRef = 'example/bot:1';
    fs.writeFileSync(path.join(h.dir, 'instances.json'), JSON.stringify(reg));
    const original = fs.readFileSync(composePath, 'utf-8');
    fs.writeFileSync(composePath, original + '  cache: {}\n');
    await containerManager.startBot('b2');
    fs.writeFileSync(composePath, original);
    await expect(containerManager.deleteBot('b2', false, false)).resolves.toBe(true);
    expect(h.volumes.has('bot1_cache')).toBe(false);
    expect(h.volumes.has(FIRST)).toBe(true);
  });

  it('a recorded volume another instance claims is left in place', async () => {
    h.volumes.add('bot1_data');
    const reg = JSON.parse(fs.readFileSync(path.join(h.dir, 'instances.json'), 'utf-8'));
    reg.instances.b2.sanitizedName = 'bot2';
    reg.instances.b2.projectVolumes = ['bot1_data'];
    reg.instances.b3 = { ...reg.instances.b2, id: 'b3', sanitizedName: 'bot1', projectVolumes: ['bot1_data'] };
    fs.writeFileSync(path.join(h.dir, 'instances.json'), JSON.stringify(reg));
    await expect(containerManager.deleteBot('b2', false, false)).resolves.toBe(true);
    expect(h.volumes.has('bot1_data')).toBe(true);
  });

  it('an unconfirmed volume list is reported as unconfirmed, not as incomplete', async () => {
    fs.writeFileSync(composePath, 'services: [unclosed\n  : :');
    await expect(containerManager.deleteBot('b2', false, false)).rejects.toThrow(/could not be confirmed complete/);
  });

  it('an unreadable compose deletes no volume and keeps the instance registered', async () => {
    fs.writeFileSync(composePath, 'services: [unclosed\n  : :');
    await expect(containerManager.deleteBot('b2', false, false)).rejects.toThrow(/uninstall incomplete.*volumes/);
    expect(h.volumes.has(FIRST)).toBe(true);
    expect(h.volumes.has(OWN)).toBe(true);
    expect(registered()).toBe(true);
  });

  it('control: a keep-data Remove deletes no volume', async () => {
    await expect(containerManager.deleteBot('b2', true, true)).resolves.toBe(true);
    expect(h.volumes.size).toBe(2);
  });
});
