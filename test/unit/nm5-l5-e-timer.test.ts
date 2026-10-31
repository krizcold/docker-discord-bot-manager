import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm5-l5-e-timer-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir, passes: 0 };
});

vi.mock('child_process', async (o) => (await import('./switch-harness')).childProcessMock(await o()));
vi.mock('../../src/instance/dbLogin', async (o) => (await import('./switch-harness')).dbLoginMock(await o()));
vi.mock('../../src/docker/containerManager', async (o) => {
  const m = (await import('./switch-harness')).containerManagerMock(await o()) as any;
  const inner = m.getAllBots;
  return { ...m, getAllBots: () => { tmp.passes++; return inner(); } };
});

import * as fs from 'fs';
import { startFleetSwitchTick, stopFleetSwitchTick, SWITCH_TIMING } from '../../src/instance/fleetSwitch';
import { writeRegistry } from './switch-harness';

afterEach(() => { stopFleetSwitchTick(); vi.useRealTimers(); });
afterAll(() => fs.rmSync(tmp.dir, { recursive: true, force: true }));

describe('L5 e: the tick timers', () => {
  it('a second start adds no timer; the first and each interval run a pass; stop clears them', async () => {
    writeRegistry({});
    vi.useFakeTimers();
    tmp.passes = 0;
    startFleetSwitchTick();
    startFleetSwitchTick();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(SWITCH_TIMING.firstMs);
    expect(tmp.passes).toBe(1);
    startFleetSwitchTick();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(SWITCH_TIMING.tickMs);
    expect(tmp.passes).toBe(2);
    stopFleetSwitchTick();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('stop before the first pass clears the first timer', () => {
    vi.useFakeTimers();
    startFleetSwitchTick();
    stopFleetSwitchTick();
    expect(vi.getTimerCount()).toBe(0);
  });
});
