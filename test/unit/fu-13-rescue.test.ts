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

beforeEach(() => {
  st.bots = [];
  st.calls.length = 0;
  st.live = [];
  st.fetched = 0;
  st.gate = null;
});
afterEach(() => {
  for (const b of st.bots) b.recoveryRescue = undefined;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('B21-4s: a probe from the current run that reads caught up lets the swap start', () => {
  it('a healthy probe asks for the confirm, then the confirmed swap hands the rescue to quiesce', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    st.bots = [receiver('w1', { phase: 'streaming' })];
    vi.stubGlobal('fetch', async (url: string) => {
      st.fetched++;
      if (String(url).includes('/control/status')) return new Response(JSON.stringify({ success: true, sourceLsn: '0/10', slotActive: true }), { status: 200 });
      return new Promise(() => {});
    });
    rescue.resumeRecoveryRescues();
    await vi.waitFor(() => expect(st.bots[0].recoveryRescue.probedAt).toBeDefined());
    expect(st.bots[0].recoveryRescue).toMatchObject({ caughtUp: true, senderAttached: true, lagBytes: 0 });
    expect(rescue.startSwap(st.bots[0], false)).toEqual({ success: false, needsConfirm: true });
    expect(st.bots[0].recoveryRescue.phase).toBe('streaming');
    expect(rescue.startSwap(st.bots[0], true)).toEqual({ success: true });
    expect(st.bots[0].recoveryRescue).toMatchObject({ phase: 'quiesce', swapPublicHost: 'h' });
    expect(st.bots[0].recoveryRescue.lastError).toBeUndefined();
  });
});
