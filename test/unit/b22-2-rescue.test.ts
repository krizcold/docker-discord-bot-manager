import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const st = vi.hoisted(() => ({
  bots: [] as any[],
  refuse: false,
  quiesce: null as any,
}));

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const execFile = (_cmd: string, args: string[], _opts: any, cb: (err: any, stdout: string, stderr: string) => void) => {
    const sql = args.join(' ');
    if (sql.includes('pg_control_system')) setImmediate(() => cb(null, '7001\n', ''));
    else setImmediate(() => cb(new Error('exit 1'), '', 'standby down'));
    return { stdin: null };
  };
  return { ...real, execFile };
});
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));
vi.mock('../../src/docker/containerManager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/docker/containerManager')>()),
  getAllBots: () => st.bots,
  getBot: (id: string) => st.bots.find(b => b.id === id) ?? null,
  runningNonSidecarContainers: async () => [],
  updateInstanceRecoveryRescue: (id: string, rec: any) => {
    if (st.refuse) throw new Error('ENOSPC: no space left on device');
    const b = st.bots.find(x => x.id === id);
    if (b) b.recoveryRescue = rec ?? undefined;
    return b ?? null;
  },
}));

import * as rescue from '../../src/instance/recoveryRescue';
import { databaseLaneBlocker } from '../../src/instance/fleetBackup';

function receiver(id: string, rescueRecord: Record<string, unknown>): any {
  return {
    id, sanitizedName: id, displayName: id, status: 'stopped', sourceUrl: 'x',
    fleetDb: { containerName: `${id}-db`, user: 'u', db: 'd', volume: `${id}-vol` },
    recoveryChannel: { mode: 'receiver', containerName: `${id}-relay`, token: 't', createdAt: 1, tunnelPort: 15433, publicHost: 'h', tlsKey: 'k', tlsCert: 'c' },
    recoveryRescue: { startedAt: 1, updatedAt: 1, ...rescueRecord },
  };
}

const flush = async (n = 20): Promise<void> => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout'] });
  st.bots = [];
  st.refuse = false;
  st.quiesce = null;
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify(st.quiesce ?? { success: false, error: 'busy' }), { status: st.quiesce ? 409 : 409 }));
});
afterEach(async () => {
  for (const b of st.bots) b.recoveryRescue = undefined;
  st.refuse = false;
  await vi.runOnlyPendingTimersAsync();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('R39-J2: a rescue whose record write is refused keeps its runner and says so', () => {
  it('keeps the 30 s retry alive and names the refused write in the status', async () => {
    st.bots = [receiver('r1', { phase: 'promote' })];
    const started = await rescue.startRescue(st.bots[0], true);
    expect(started.success).toBe(true);
    st.refuse = true;
    await flush();
    expect(rescue.rescueRunnerLive('r1')).toBe(true);
    const status = rescue.getRescueStatus(st.bots[0])!;
    expect(status.lastError).toMatch(/standby unreachable at promote/);
    expect(status.lastError).toMatch(/its record could not be written \(ENOSPC/);
  });

  it('holds a refused park in memory, stops the runner, and writes it on the next health tick', async () => {
    st.bots = [receiver('r2', { phase: 'quiesce' })];
    st.quiesce = { success: false, error: 'not the copy I armed', identityMismatch: true };
    const started = await rescue.startRescue(st.bots[0], true);
    expect(started.success).toBe(true);
    st.refuse = true;
    await flush();
    expect(rescue.rescueRunnerLive('r2')).toBe(false);
    const status = rescue.getRescueStatus(st.bots[0])!;
    expect(status.parked).toBe(true);
    expect(status.lastError).toMatch(/^the run stopped at quiesce: The sender refused the swap/);
    expect(status.lastError).toMatch(/its record could not be written/);
    expect(st.bots[0].recoveryRescue.parked).toBeUndefined();
    st.refuse = false;
    rescue.retryHeldRescueRecords();
    expect(st.bots[0].recoveryRescue.parked).toBe(true);
    expect(st.bots[0].recoveryRescue.lastError).toMatch(/The sender refused the swap/);
  });

  it('offers Continue on a record that reads live with no runner', async () => {
    st.bots = [receiver('r3', { phase: 'streaming' })];
    const status = rescue.getRescueStatus(st.bots[0])!;
    expect(status.runnerStopped).toBe(true);
    expect(status.parked).toBe(true);
    expect(status.lastError).toMatch(/runner stopped/);
  });
});

describe('R39-J2: a boot resume whose telemetry clear is refused still starts the runner', () => {
  it('does not throw out of resumeRecoveryRescues and starts the runner', async () => {
    st.bots = [receiver('r4', { phase: 'promote', caughtUp: true })];
    st.refuse = true;
    expect(() => rescue.resumeRecoveryRescues()).not.toThrow();
    expect(rescue.rescueRunnerLive('r4')).toBe(true);
    await flush();
  });
});

describe('R39-J2: the self-update reads a held rescue park as stopped', () => {
  it('does not name a running rescue', async () => {
    st.bots = [receiver('r5', { phase: 'quiesce' })];
    st.quiesce = { success: false, error: 'not the copy I armed', identityMismatch: true };
    expect((await rescue.startRescue(st.bots[0], true)).success).toBe(true);
    st.refuse = true;
    await flush();
    expect(st.bots[0].recoveryRescue.parked).toBeUndefined();
    expect(databaseLaneBlocker()).toBeNull();
  });
});
