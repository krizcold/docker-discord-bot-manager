import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'rm2-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir };
});

vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';
import * as envManager from '../../src/env/manager';
import { buildBotEnvList } from '../../src/env/envList';

const WITH_CREDS = 'postgres://u:pw@h:5432/db';
const NO_CREDS = 'postgres://h:5432/db';
const registryPath = path.join(tmp.dir, 'instances.json');
const envDir = path.join(tmp.dir, 'bots', 'r1', 'env');

const readTree = (dir: string): string => {
  if (!fs.existsSync(dir)) return '';
  return fs.readdirSync(dir, { withFileTypes: true }).map(e => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? readTree(p) : fs.readFileSync(p, 'utf-8');
  }).join('\n');
};

beforeEach(() => {
  fs.rmSync(path.join(tmp.dir, 'bots'), { recursive: true, force: true });
  fs.mkdirSync(envDir, { recursive: true });
  fs.writeFileSync(registryPath, JSON.stringify({
    instances: {
      r1: {
        id: 'r1', sanitizedName: 'rbot', displayName: 'R Bot', titleName: 'R Bot', status: 'stopped',
        sourceType: 'docker-image', envVars: { LINK_A: WITH_CREDS, LINK_B: NO_CREDS },
        createdAt: '2026-10-27T00:00:00.000Z', updatedAt: '2026-10-27T00:00:00.000Z',
      },
    },
  }));
});

afterAll(() => fs.rmSync(tmp.dir, { recursive: true, force: true }));

describe('a value holding a URL with a password is sensitive whatever its key', () => {
  it('is encrypted on save, and a URL without credentials stays plain', () => {
    envManager.setEnvVars('r1', { LINK_A: WITH_CREDS, LINK_B: NO_CREDS });
    const stored = readTree(path.join(tmp.dir, 'bots', 'r1'));
    expect(stored).not.toContain('pw@');
    expect(stored).toContain(NO_CREDS);
    expect(envManager.getEnvVars('r1')).toMatchObject({ LINK_A: WITH_CREDS, LINK_B: NO_CREDS });
  });

  it('is masked in the env list', () => {
    envManager.setEnvVars('r1', { LINK_A: WITH_CREDS, LINK_B: NO_CREDS });
    const rows = buildBotEnvList(null, 'r1');
    const a = rows.find(r => r.key === 'LINK_A')!;
    const b = rows.find(r => r.key === 'LINK_B')!;
    expect(a.sensitive).toBe(true);
    expect(a.value).toBe('');
    expect(b.sensitive).toBe(false);
    expect(b.value).toBe(NO_CREDS);
  });

  it('is stripped from the registry record on save', () => {
    containerManager.updateInstanceAutoUpdate('r1', true);
    const rec = JSON.parse(fs.readFileSync(registryPath, 'utf-8')).instances.r1;
    expect(rec.envVars.LINK_A).toBeUndefined();
    expect(rec.envVars.LINK_B).toBe(NO_CREDS);
  });
});

describe('a value held in the encrypted store stays sensitive when it no longer decrypts', () => {
  it('is marked sensitive in the env list, and a blank editor save keeps its ciphertext', () => {
    envManager.setEnvVars('r1', { LINK_A: WITH_CREDS });
    const storePath = path.join(envDir, 'storage.json');
    const store = JSON.parse(fs.readFileSync(storePath, 'utf-8'));
    const dead = 'v2:000000000000000000000000:00000000000000000000000000000000:00';
    store.encrypted.LINK_A = dead;
    fs.writeFileSync(storePath, JSON.stringify(store));
    const row = buildBotEnvList(null, 'r1').find(r => r.key === 'LINK_A')!;
    expect(row.undecryptable).toBe(true);
    expect(row.sensitive).toBe(true);
    const sent: Record<string, string> = {};
    for (const r of buildBotEnvList(null, 'r1')) if (!(r.sensitive && r.value === '')) sent[r.key] = r.value;
    envManager.setEnvVars('r1', sent);
    expect(JSON.parse(fs.readFileSync(storePath, 'utf-8')).encrypted.LINK_A).toBe(dead);
  });
});

describe('the credential URL check is linear', () => {
  it('answers for a 100 KB value with no "://" within 500 ms', () => {
    const value = 'a'.repeat(100 * 1024);
    const started = Date.now();
    expect(envManager.isSensitive('PLAIN_KEY', value)).toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
  });
});
