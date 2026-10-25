import { afterAll, describe, expect, it, vi } from 'vitest';

// The documented handback after a recovery swap: the old sender is re-seeded as a standby of the new primary.
const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'b16-1-handback-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir };
});

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const exec = (_cmd: string, opts: any, cb?: any) => (typeof opts === 'function' ? opts : cb)(null, { stdout: '', stderr: '' });
  const execFileSync = () => '';
  return { ...real, exec, execFileSync, default: { ...real, exec, execFileSync } };
});
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import * as containerManager from '../../src/docker/containerManager';

afterAll(() => fs.rmSync(tmp.dir, { recursive: true, force: true }));

const REGISTRY = path.join(tmp.dir, 'instances.json');

describe('R9-J3: re-seeding a swapped-away sender as a standby ends the swap refusal', () => {
  it('Start is not refused once the stale-primary re-seed retired the old database', async () => {
    fs.writeFileSync(REGISTRY, JSON.stringify({ instances: {
      a: {
        id: 'a', displayName: 'a', sanitizedName: 'bot-a', status: 'stopped', sourceUrl: 'https://example.invalid/fake/app',
        fleetDb: { containerName: 'bot-a-postgres', user: 'app', db: 'app', volume: 'bot-a-pgdata' },
        recoverySwappedAway: { at: Date.UTC(2026, 9, 24) },
      },
    } }, null, 2));
    expect(containerManager.startPreflightRefusal('a')?.error).toMatch(/recovery swap on 2026-10-24/);
    const retired = await containerManager.retireFleetDbSidecar('a');
    expect(retired).toEqual({ success: true, volumeRemoved: true });
    expect(containerManager.getBot('a')?.fleetDb).toBeUndefined();
    expect(containerManager.getBot('a')?.recoverySwappedAway).toBeUndefined();
    expect(containerManager.startPreflightRefusal('a')).toBeNull();
    expect(containerManager.updatePreflightRefusal('a')).toBeNull();
  });
});

const pageHtml = fs.readFileSync(path.join(__dirname, '../../src/webui/public/index.html'), 'utf-8');
const pageFunction = (name: string): string => {
  let start = pageHtml.indexOf(`function ${name}(`);
  if (start < 0) return '';
  if (pageHtml.slice(start - 6, start) === 'async ') start -= 6;
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

describe('R9-J3: the swap record can be cleared from the replica view too', () => {
  it('the Database modal of an instance with no own database shows the swap notice and its clear button', async () => {
    const content: any = { innerHTML: '' };
    const ctx: any = vm.createContext({
      bots: [{ id: 'b1', displayName: 'B1', fleetDbReplica: { containerName: 'r' }, recoverySwappedAway: { at: Date.UTC(2026, 9, 24) } }],
      fleetBackupBotId: null,
      document: { getElementById: (id: string) => id === 'fleet-backup-content' ? content : { classList: { remove: () => {} } } },
      escapeHtml: (s: string) => String(s),
      renderFleetReplica: () => {}, renderPastFleetBackups: () => {},
    });
    for (const fn of ['showFleetBackups', 'swappedAwayHtml']) vm.runInContext(pageFunction(fn), ctx);
    await ctx.showFleetBackups('b1');
    expect(content.innerHTML).toContain('Database Replica: B1');
    expect(content.innerHTML).toContain('A recovery swap on 2026-10-24 handed this database to another machine');
    expect(content.innerHTML).toContain(`clearSwappedAway('b1')`);
  });
});
