import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// AD-LOG in the copy watcher's tick: an offer the running bot did not take is warned once per change of its outcome.
const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm5-l5-i-offer-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir, addresses: undefined as unknown };
});

vi.mock('child_process', async (o) => (await import('./join-fake')).childProcessMock(await o<typeof import('child_process')>()));
vi.mock('../../src/instance/backupCheck', async (o) => ({
  ...(await o<typeof import('../../src/instance/backupCheck')>()),
  notifyOwner: async () => ({ dm: 'sent' }),
}));
vi.mock('../../src/instance/fleetJoin', async (o) => ({
  ...(await o<typeof import('../../src/instance/fleetJoin')>()),
  writeEnvList: async () => ({ changed: true, addresses: h.addresses }),
  refreshJoin: async () => undefined,
}));
vi.mock('../../src/instance/fleetReplica', async (o) => ({
  ...(await o<typeof import('../../src/instance/fleetReplica')>()),
  sendRebuiltAlert: async () => undefined,
}));

import * as fs from 'fs';
import * as path from 'path';
import { runFleetCopyTick } from '../../src/instance/fleetCopyWatch';
import { fakeJoinRecord } from './join-fake';

const REGISTRY = path.join(h.dir, 'instances.json');
let n = 0;
let name = '';
let warn: ReturnType<typeof vi.spyOn>;
const switchWarns = () => warn.mock.calls.map((c: unknown[]) => String(c[0])).filter((l: string) => l.startsWith('[Switch]'));
const tick = async (addresses: unknown) => { h.addresses = addresses; await runFleetCopyTick(Date.now()); };

beforeEach(() => {
  n++;
  name = `Bot${n}`;
  const id = `b${n}`;
  fs.writeFileSync(REGISTRY, JSON.stringify({ instances: { [id]: {
    id, sanitizedName: id, displayName: name, titleName: name, status: 'running', sourceType: 'git',
    sourceUrl: 'https://example.invalid/fake/super-modular-discord-bot', envVars: { DATA_BACKEND: 'postgres' },
    createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z', fleetJoin: fakeJoinRecord(),
  } } }, null, 2));
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); });
afterAll(() => fs.rmSync(h.dir, { recursive: true, force: true }));

describe('logOffer through the tick', () => {
  it('a refused offer is warned with its words once while its outcome stays the same', async () => {
    await tick({ state: 'refused', error: 'bad list' });
    await tick({ state: 'refused', error: 'bad list' });
    expect(switchWarns()).toEqual([`[Switch] ${name}: the running bot refused the new database list (bad list)`]);
  });
  it('a new outcome is warned again', async () => {
    await tick({ state: 'refused', error: 'bad list' });
    await tick({ state: 'unsupported' });
    expect(switchWarns()).toEqual([
      `[Switch] ${name}: the running bot refused the new database list (bad list)`,
      `[Switch] ${name}: the running bot has no hook for a new database list`,
    ]);
  });
  it('a bot that is not running is not logged', async () => {
    await tick({ state: 'not-running' });
    expect(switchWarns()).toEqual([]);
  });
  it('an applied offer is not warned, and a later refusal is', async () => {
    await tick({ state: 'applied' });
    expect(switchWarns()).toEqual([]);
    await tick({ state: 'refused', error: 'x' });
    expect(switchWarns()).toEqual([`[Switch] ${name}: the running bot refused the new database list (x)`]);
  });
});
