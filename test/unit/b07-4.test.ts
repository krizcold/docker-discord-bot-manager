import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'b07-4-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir };
});

vi.mock('../../src/casaos/detector', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/casaos/detector')>()),
  getDeploymentMode: async () => 'docker',
}));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import * as containerManager from '../../src/docker/containerManager';

const registryPath = path.join(h.dir, 'instances.json');
const sent: Array<{ type: string; payload: any }> = [];

beforeEach(() => {
  sent.length = 0;
  fs.writeFileSync(registryPath, JSON.stringify({
    instances: {
      b1: {
        id: 'b1', sanitizedName: 'bot1', displayName: 'Bot 1', titleName: 'Bot 1', status: 'running',
        sourceType: 'docker-image', envVars: {}, containerIds: [],
        createdAt: '2026-10-22T00:00:00.000Z', updatedAt: '2026-10-22T00:00:00.000Z',
      },
    },
  }));
  containerManager.setContainerBroadcast((type: string, payload: any) => { sent.push({ type, payload }); });
});

afterAll(() => {
  fs.rmSync(h.dir, { recursive: true, force: true });
});

const pageHtml = fs.readFileSync(path.resolve(__dirname, '../../src/webui/public/index.html'), 'utf8');
const pageFunction = (name: string): string => {
  const start = pageHtml.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`no function ${name}`);
  let i = pageHtml.indexOf('(', start);
  for (let depth = 0; ; i++) {
    if (pageHtml[i] === '(') depth++;
    else if (pageHtml[i] === ')' && --depth === 0) break;
  }
  i = pageHtml.indexOf('{', i);
  for (let depth = 0; ; i++) {
    if (pageHtml[i] === '{') depth++;
    else if (pageHtml[i] === '}' && --depth === 0) return pageHtml.slice(start, i + 1);
  }
};
const runPage = (names: string[], globals: Record<string, unknown>): vm.Context => {
  const ctx = vm.createContext({ ...globals });
  vm.runInContext(names.map(pageFunction).join('\n'), ctx);
  return ctx;
};

const last = () => sent.filter((m) => m.payload?.id === 'b1').pop();

describe('B07-4: every tab is told when an op lock is released', () => {
  it('an op that throws ends with a status push carrying activeOp null', async () => {
    await expect(containerManager.withExternalBotOp('b1', 'stop', async () => {
      expect(containerManager.isBotBusy('b1')).toBe('stop');
      throw new Error('docker stop failed');
    })).rejects.toThrow('docker stop failed');
    expect(containerManager.isBotBusy('b1')).toBeNull();
    expect(last()).toEqual({ type: 'bot:status', payload: { id: 'b1', status: 'running', activeOp: null, cutOp: null } });
  });

  it('an op that returns ends with the same closing push', async () => {
    await containerManager.withExternalBotOp('b1', 'delete', async () => ({ success: false }));
    expect(last()).toEqual({ type: 'bot:status', payload: { id: 'b1', status: 'running', activeOp: null, cutOp: null } });
  });

  it('an unreadable registry still clears the lock in every tab without naming a status', async () => {
    await containerManager.withExternalBotOp('b1', 'stop', async () => {
      fs.writeFileSync(registryPath, '{not json');
    }).catch(() => {});
    expect(last()).toEqual({ type: 'bot:status', payload: { id: 'b1', activeOp: null, cutOp: null } });
  });

  it('a bot removed by the op gets no closing push', async () => {
    await containerManager.withExternalBotOp('b1', 'delete', async () => {
      fs.writeFileSync(registryPath, JSON.stringify({ instances: {} }));
    });
    expect(last()).toBeUndefined();
  });

  it('a logged op that fails ends with the same closing push', async () => {
    const reg = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
    reg.instances.b1.recoveryRescue = { startedAt: '2026-10-22T00:00:00.000Z' };
    fs.writeFileSync(registryPath, JSON.stringify(reg));
    const result = await containerManager.startBot('b1');
    expect(result.success).toBe(false);
    expect(containerManager.isBotBusy('b1')).toBeNull();
    expect(last()).toEqual({ type: 'bot:status', payload: { id: 'b1', status: 'running', activeOp: null, cutOp: null } });
  });

  it('the UI keeps the card status when a push carries none', () => {
    const bots = [{ id: 'b1', status: 'stopping', activeOp: 'stop' as string | null }];
    const ctx = runPage(['setBotStatus'], {
      bots, renderBots: () => {}, renderBotCards: () => {}, updateBotCard: () => {}, renderBotCard: () => {},
      document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
    });
    ctx.setBotStatus('b1', undefined, null);
    expect(bots[0].status).toBe('stopping');
    expect(bots[0].activeOp).toBeNull();
  });
});
