import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'b22-2-env-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir };
});

vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';
import * as envManager from '../../src/env/manager';

const registryTmp = () => path.join(h.dir, 'instances.json.tmp');
const writeRegistry = (): void => {
  fs.writeFileSync(path.join(h.dir, 'instances.json'), JSON.stringify({
    instances: {
      b1: {
        id: 'b1', sanitizedName: 'bot1', displayName: 'Bot 1', titleName: 'Bot 1', status: 'stopped',
        sourceType: 'git', sourceUrl: 'https://example.invalid/fake/other',
        envVars: { FOO: 'old' },
        createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z',
      },
    },
  }));
};

beforeEach(() => {
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
  fs.mkdirSync(path.join(h.dir, 'bots', 'b1', 'env'), { recursive: true });
  writeRegistry();
  envManager.setEnvVars('b1', { FOO: 'old', API_TOKEN: 'keep-me' });
});
afterEach(() => {
  fs.rmSync(registryTmp(), { recursive: true, force: true });
});
afterAll(() => {
  fs.rmSync(h.dir, { recursive: true, force: true });
});

// A directory where the registry writes its temporary file refuses the save
// on every platform, while instances.json still reads.
const refuseRegistry = () => fs.mkdirSync(registryTmp(), { recursive: true });

describe('R43-J1: an env save whose record write is refused leaves the store as it was', () => {
  it('puts the store back and says nothing was saved', async () => {
    refuseRegistry();
    await expect(containerManager.updateBot('b1', { envVars: { FOO: 'new', BAR: 'added', API_TOKEN: 'replaced' } })).rejects.toThrow(/nothing was saved.*put back/);
    const stored = envManager.getEnvVars('b1');
    expect(stored.FOO).toBe('old');
    expect(stored.API_TOKEN).toBe('keep-me');
    expect(Object.prototype.hasOwnProperty.call(stored, 'BAR')).toBe(false);
  });

  it('a key removal whose record write is refused keeps the key in the store', () => {
    refuseRegistry();
    expect(() => containerManager.removeEnvKeyEverywhere('b1', 'FOO')).toThrow(/FOO was not removed/);
    expect(envManager.getEnvVars('b1').FOO).toBe('old');
    expect(containerManager.getBot('b1')?.envVars?.FOO).toBe('old');
  });
});
