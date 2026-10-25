import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const st = vi.hoisted(() => ({
  bots: [] as any[],
  calls: [] as string[][],
  live: [] as string[] | null,
  fetched: 0,
  // A docker call that matches waits for the gate to open.
  gate: null as { match: (args: string[]) => boolean; open: Promise<void> } | null,
}));

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const execFile = (_cmd: string, args: string[], _opts: any, cb: (err: any, stdout: string, stderr: string) => void) => {
    st.calls.push(args);
    const sql = args.join(' ');
    const out = sql.includes("to_regclass('smdb_data.guild_ownership')") || sql.includes("to_regclass('smdb_control.term')") ? 't\n'
      : sql.includes('UPDATE smdb_control.term') ? '1\n'
        : sql.includes('then echo partial') ? 'empty\n'
          : sql.includes('SELECT system_identifier FROM pg_control_system()') ? '7001\n'
            : sql.includes('pg_is_in_recovery(), GREATEST') ? 't|0\n'
            : '';
    const gate = st.gate && st.gate.match(args) ? st.gate.open : Promise.resolve();
    void gate.then(() => setImmediate(() => cb(null, out, '')));
    return { stdin: null };
  };
  return { ...real, execFile };
});
vi.mock('../../src/config/appCapabilities', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/config/appCapabilities')>()),
  findAppCapabilities: () => ({ companionDb: { env: { url: 'DATABASE_URL' } } }),
}));
vi.mock('../../src/env/manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/env/manager')>()),
  getEnvVars: () => ({ DATABASE_URL: 'postgres://u:pw@bot1-db:5432/d' }),
  setEnvVars: () => {},
}));
vi.mock('../../src/instance/fleetReplication', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/fleetReplication')>()),
  enableFleetReplication: async () => { st.calls.push(['enable-replication']); return { success: true }; },
}));
vi.mock('../../src/docker/containerManager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/docker/containerManager')>()),
  getAllBots: () => st.bots,
  getBot: (id: string) => st.bots.find(b => b.id === id) ?? null,
  runningNonSidecarContainers: async () => st.live,
  startFleetDbSidecar: async () => ({ success: true }),
  startBot: async (id: string) => { st.calls.push(['startBot', id]); return { success: true }; },
  updateInstanceRecoveryRescue: (id: string, rec: any) => {
    const b = st.bots.find(x => x.id === id);
    if (b) b.recoveryRescue = rec ?? undefined;
  },
}));

import * as rescue from '../../src/instance/recoveryRescue';

function receiver(id: string, rescueRecord: Record<string, unknown>, extra: Record<string, unknown> = {}): any {
  return {
    id, sanitizedName: id, displayName: id, status: 'stopped', sourceUrl: 'x', updateToken: 'tok',
    fleetDb: { containerName: `${id}-db`, user: 'u', db: 'd', volume: `${id}-vol` },
    recoveryChannel: { mode: 'receiver', containerName: `${id}-recovery-relay`, token: 't', createdAt: 1, tunnelPort: 15433, publicHost: 'h', tlsKey: 'k', tlsCert: 'c' },
    recoveryRescue: { startedAt: 1, updatedAt: 1, ...rescueRecord },
    ...extra,
  };
}

const stale = { caughtUp: true, senderAttached: true, lagBytes: 5_000_000, probedAt: 1 };

beforeEach(() => {
  st.bots = [];
  st.calls.length = 0;
  st.live = [];
  st.fetched = 0;
  st.gate = null;
  vi.stubGlobal('fetch', async () => {
    st.fetched++;
    return new Response(JSON.stringify({ success: false, error: 'source busy' }), { status: 409 });
  });
});
afterEach(() => {
  for (const b of st.bots) b.recoveryRescue = undefined;
  vi.unstubAllGlobals();
});

describe('R37-J13: a CAUGHT UP from before a resume or Continue never starts the swap', () => {
  it('refuses the swap on telemetry no running driver measured', () => {
    st.bots = [receiver('s1', { phase: 'streaming', ...stale })];
    const r = rescue.startSwap(st.bots[0], true);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/not been probed since the rescue last started or continued/);
    expect(st.bots[0].recoveryRescue.phase).toBe('streaming');
  });

  it('a resume drops the old figure when the first status read goes unanswered', async () => {
    st.bots = [receiver('s2', { phase: 'streaming', ...stale })];
    rescue.resumeRecoveryRescues();
    await vi.waitFor(() => expect(st.fetched).toBeGreaterThan(0));
    await vi.waitFor(() => expect(st.bots[0].recoveryRescue.lastError).toMatch(/status read/));
    expect(st.bots[0].recoveryRescue.caughtUp).toBe(false);
    expect(st.bots[0].recoveryRescue.lagBytes).toBeUndefined();
    expect(rescue.startSwap(st.bots[0], false).success).toBe(false);
  });

  it('a Continue of a parked rescue drops the old telemetry', async () => {
    st.bots = [receiver('s3', { phase: 'streaming', parked: true, lastError: 'x', ...stale })];
    st.gate = { match: () => true, open: new Promise(() => {}) };
    let seen: any = null;
    vi.stubGlobal('fetch', async () => {
      seen = { ...st.bots[0].recoveryRescue };
      return new Promise(() => {});
    });
    expect((await rescue.startRescue(st.bots[0], true)).success).toBe(true);
    await vi.waitFor(() => expect(seen).not.toBeNull());
    expect(seen.parked).toBe(false);
    expect(seen.caughtUp).toBeUndefined();
    expect(seen.lagBytes).toBeUndefined();
    expect(seen.probedAt).toBeUndefined();
  });
});

describe('R38-J4: the lag figure belongs to the phase that measured it', () => {
  const streamingProbed = async (id: string) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    st.bots = [receiver(id, { phase: 'streaming' })];
    vi.stubGlobal('fetch', async (url: string) => {
      st.fetched++;
      if (String(url).includes('/control/status')) return new Response(JSON.stringify({ success: true, sourceLsn: '0/10', slotActive: true }), { status: 200 });
      return new Response(JSON.stringify({ success: false, error: 'source busy' }), { status: 409 });
    });
    rescue.resumeRecoveryRescues();
    await vi.waitFor(() => expect(st.bots[0].recoveryRescue.probedAt).toBeDefined());
    expect(st.bots[0].recoveryRescue).toMatchObject({ caughtUp: true, lagBytes: 0, senderAttached: true });
  };
  afterEach(() => { vi.useRealTimers(); });

  it('a park clears the streaming telemetry', async () => {
    await streamingProbed('s4');
    st.bots[0].recoveryChannel = undefined;
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(st.bots[0].recoveryRescue.parked).toBe(true));
    expect(st.bots[0].recoveryRescue.caughtUp).toBeUndefined();
    expect(st.bots[0].recoveryRescue.lagBytes).toBeUndefined();
    expect(st.bots[0].recoveryRescue.probedAt).toBeUndefined();
  });

  it('a swap start and a failed quiesce show no lag figure carried over', async () => {
    await streamingProbed('s5');
    expect(rescue.startSwap(st.bots[0], true).success).toBe(true);
    expect(st.bots[0].recoveryRescue.phase).toBe('quiesce');
    expect(st.bots[0].recoveryRescue.caughtUp).toBeUndefined();
    expect(st.bots[0].recoveryRescue.lagBytes).toBeUndefined();
    Object.assign(st.bots[0].recoveryRescue, { caughtUp: true, lagBytes: 7 });
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(st.bots[0].recoveryRescue.lastError).toMatch(/source busy/));
    expect(st.bots[0].recoveryRescue.caughtUp).toBeUndefined();
    expect(st.bots[0].recoveryRescue.lagBytes).toBeUndefined();
  });
});
