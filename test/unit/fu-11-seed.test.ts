import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'fu-11-seed-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir, logs: '' };
});

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const execFile = (_cmd: string, args: string[], opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    if (args[0] === 'inspect') return done(null, 'false\n', '');
    done(null, '', '');
  };
  const exec = (_cmd: string, opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    done(null, { stdout: '', stderr: '' });
  };
  const execFileSync = (_cmd: string, args: string[]) => (args[0] === 'logs' ? h.logs : '');
  const mod = { ...real, execFile, exec, execFileSync };
  return { ...mod, default: mod };
});

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';
import { cancelReplicaSeed } from '../../src/instance/fleetReplica';

const STARTED = 1761350400000;
const seed = (purpose: string) => ({
  purpose, phase: 'copying', startedAt: STARTED, updatedAt: STARTED, publicHost: 'standby.invalid', hostPort: 5440,
  primaryHost: 'primary.invalid', primaryPort: 5433, slot: 'smdb_b1', committed: true, parked: true,
});
const replica = {
  containerName: 'bot1-fleet-db-replica', volume: 'bot1_replica', slot: 'smdb_b1', primaryHost: 'primary.invalid',
  primaryPort: 5433, publicHost: 'standby.invalid', hostPort: 5440, certHost: 'standby.invalid', seededBy: STARTED,
};

const writeRegistry = (b1: Record<string, unknown>): void => {
  fs.writeFileSync(path.join(h.dir, 'instances.json'), JSON.stringify({
    instances: {
      b1: {
        id: 'b1', sanitizedName: 'bot1', displayName: 'Bot 1', titleName: 'Bot 1', status: 'running',
        sourceType: 'git', sourceUrl: 'https://example.invalid/fake/super-modular-discord-bot',
        envVars: { BOT_NODE_ROLE: 'co-worker' },
        createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z',
        ...b1,
      },
    },
  }));
};
const ask = async () => {
  const res = await cancelReplicaSeed(containerManager.getBot('b1')!, { startedAt: STARTED, parked: true, committed: true });
  expect(res.needsConfirm).toBe(true);
  return res.error ?? '';
};

beforeEach(() => {
  fs.mkdirSync(path.join(h.dir, 'bots', 'b1', 'env'), { recursive: true });
});

afterAll(() => {
  fs.rmSync(h.dir, { recursive: true, force: true });
});

describe('FU-11 B22-1x each parked committed seed gets its own Dismiss question', () => {
  it('a partial provision says the volume keeps the copy and nothing else is affected', async () => {
    writeRegistry({ fleetDbReplicaSeed: seed('provision') });
    const text = await ask();
    expect(text).toContain('The partial copy stays in the replica volume, unused; nothing else on this instance is affected.');
    expect(text).not.toContain('already retired');
  });

  it('a partial provision after a failback retire names the retire and the missing standby', async () => {
    writeRegistry({ fleetDbReplicaSeed: seed('provision'), fleetFailbackDeclined: { mode: 'failback', phase: 'seeding' } });
    const text = await ask();
    expect(text).toContain('The partial copy stays in the replica volume, unused. This machine\'s own database was already retired earlier in the failback run');
    expect(text).not.toContain('nothing else on this instance is affected');
  });

  it('a whole stale-primary re-seed names the node now holding the fleet and the container state', async () => {
    writeRegistry({ fleetDbReplicaSeed: seed('reseed-stale-primary'), fleetDbReplica: replica });
    const text = await ask();
    expect(text).toContain("This instance's own database has already been retired. The copy from the node now holding the fleet is complete.");
    expect(text).toContain('Its standby container is not running.');
    expect(text).not.toContain('stand-in');
  });

  it('a whole standby re-seed does not borrow the stale-primary text', async () => {
    writeRegistry({ fleetDbReplicaSeed: seed('reseed-standby'), fleetDbReplica: replica });
    const text = await ask();
    expect(text).toContain('The copy is complete. Its standby container is not running.');
    expect(text).not.toContain('node now holding the fleet');
  });
});

describe('FU-11 B10-1t getBotLogs names an unknown time', () => {
  it('prints [time unknown] for a line docker did not stamp', async () => {
    writeRegistry({ containerIds: ['abcdef1234567890'] });
    h.logs = '2026-10-22T00:00:00.000000000Z hello\na continued line';
    const res = await containerManager.getBotLogs('b1');
    expect(res.logs).toEqual(expect.arrayContaining([
      '[2026-10-22T00:00:00.000000000Z] [abcdef123456] hello',
      '[time unknown] [abcdef123456] a continued line',
    ]));
    expect(res.logs!.join('\n')).not.toContain('[null]');
  });
});
