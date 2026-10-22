import { afterAll, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'b03-4-restart-'));
  process.env.DATA_DIR = dir;
  nodeFs.writeFileSync(nodePath.join(dir, 'instances.json'), JSON.stringify({
    instances: { b1: { id: 'b1', name: 'b1', sourceType: 'git', status: 'running', recoveryRescue: { startedAt: 1 } } },
  }));
  return { dir };
});

const detector = vi.hoisted(() => ({ calls: 0 }));
vi.mock('../../src/casaos/detector', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/casaos/detector')>()),
  getDeploymentMode: vi.fn(async () => { detector.calls++; return 'docker'; }),
}));
vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const exec = vi.fn((...args: any[]) => { detector.calls++; args[args.length - 1]?.(null, '', ''); });
  return { ...real, exec, default: { ...real, exec } };
});

import * as fs from 'fs';
import { getBot, restartBot } from '../../src/docker/containerManager';

afterAll(() => { fs.rmSync(tmp.dir, { recursive: true, force: true }); });

describe('B03-4 restartBot refuses a rescued bot before stopping it', () => {
  it('answers the rescue refusal and never reaches the stop', async () => {
    const r = await restartBot('b1');
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/database rescue/);
    expect(detector.calls).toBe(0);
    expect(getBot('b1')?.status).toBe('running');
  });
});
