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

import * as containerManager from '../../src/docker/containerManager';
import * as fleetBackup from '../../src/instance/fleetBackup';
import * as rescue from '../../src/instance/recoveryRescue';

function receiver(extra: Record<string, unknown> = {}): any {
  return {
    id: 'b1', sanitizedName: 'bot1', displayName: 'Bot 1', status: 'stopped', sourceUrl: 'x', updateToken: 'tok',
    fleetDb: { containerName: 'bot1-db', user: 'u', db: 'd', volume: 'bot1-vol' },
    recoveryChannel: { mode: 'receiver', containerName: 'bot1-recovery-relay', token: 't', createdAt: 1, tunnelPort: 15433, publicHost: 'h', tlsKey: 'k', tlsCert: 'c' },
    ...extra,
  };
}

beforeEach(() => {
  st.bots = [receiver()];
  st.calls.length = 0;
  st.live = [];
  st.fetched = 0;
  st.gate = null;
  vi.stubGlobal('fetch', async () => {
    st.fetched++;
    return new Response(JSON.stringify({ success: false, error: 'not reached in these rows' }), { status: 409 });
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('R8-J1: a fresh rescue refuses while another lane holds the database', () => {
  it('refuses while a dump, restore or replication change holds the backup slot', async () => {
    expect(fleetBackup.claimFleetBackupBusy('b1')).toBe(true);
    try {
      const r = await rescue.startRescue(st.bots[0], true);
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/dump, restore or replication change is running on this instance.*nothing was changed/);
    } finally {
      fleetBackup.releaseFleetBackupBusy('b1');
    }
    expect(st.fetched).toBe(0);
    expect(st.bots[0].recoveryRescue).toBeUndefined();
  });

  it('refuses while an op lock is held and names the op', async () => {
    let release: () => void = () => {};
    const held = containerManager.withExternalBotOp('b1', 'update', () => new Promise<void>(r => { release = r; }));
    const r = await rescue.startRescue(st.bots[0], true);
    release();
    await held;
    expect(r.error).toMatch(/Operation 'update' is in progress on this instance/);
    expect(st.fetched).toBe(0);
  });

  it('refuses when docker runs the app although the record says stopped', async () => {
    st.live = ['bot1-app'];
    const r = await rescue.startRescue(st.bots[0], true);
    expect(r.error).toBe('Stop the instance first: the rescue replaces the database it runs on');
    expect(st.fetched).toBe(0);
  });

  it('refuses when docker cannot say', async () => {
    st.live = null;
    const r = await rescue.startRescue(st.bots[0], true);
    expect(r.error).toMatch(/^Docker could not say whether the instance is running/);
    expect(st.fetched).toBe(0);
  });

  const runs: Array<[string, Record<string, unknown>, RegExp]> = [
    ['a failback run', { fleetFailback: { mode: 'failback', phase: 'wipe-consent', parked: true } }, /failback run is on this instance/],
    ['a transfer run', { fleetTransfer: { phase: 'seeding', startedAt: 1, updatedAt: 1, retireOldMaster: false } }, /transfer is recorded/],
    ['a standby seed', { fleetDbReplicaSeed: { phase: 'seeding' } }, /Provisioning of a standby is running/],
  ];
  for (const [name, extra, text] of runs) {
    it(`refuses on ${name}`, async () => {
      st.bots = [receiver(extra)];
      const r = await rescue.startRescue(st.bots[0], true);
      expect(r.error).toMatch(text);
      expect(st.fetched).toBe(0);
    });
  }

  it('a record that says running with nothing running in docker reaches the source', async () => {
    st.bots = [receiver({ status: 'running' })];
    const r = await rescue.startRescue(st.bots[0], true);
    expect(st.fetched).toBe(1);
    expect(r.error).toBe('The source refused: not reached in these rows');
  });
});

describe('R8-J1: the phases that rewrite the volume hold the backup slot', () => {
  it('a rescue at bulk holds the slot, and frees it once the rescue ends', async () => {
    let open: () => void = () => {};
    st.gate = { match: args => args.includes('k1-recovery-rsync'), open: new Promise<void>(r => { open = r; }) };
    st.bots = [receiver({ id: 'k1', sanitizedName: 'k1', recoveryRescue: { phase: 'bulk', startedAt: 1, updatedAt: 1 } })];
    rescue.resumeRecoveryRescues();
    await vi.waitFor(() => expect(st.calls.some(a => a.includes('k1-recovery-rsync'))).toBe(true));
    expect(fleetBackup.claimFleetBackupBusy('k1')).toBe(false);
    expect(fleetBackup.databaseLaneBlocker()).toMatch(/dump, restore or replication change is running on Bot 1/);
    st.bots[0].recoveryRescue = undefined;
    open();
    await vi.waitFor(() => expect(fleetBackup.isFleetBackupBusy('k1')).toBe(false));
  });

  it('a rescue at standby holds the slot and frees it at streaming', async () => {
    let open: () => void = () => {};
    const prepared = new Promise<void>(r => { open = r; });
    vi.stubGlobal('fetch', async (url: string) => {
      if (String(url).endsWith('/prepare')) await prepared;
      return new Response(JSON.stringify({ success: true, slot: 'recovery_channel', replicator: { user: 'r', password: 'p' } }), { status: 200 });
    });
    st.bots = [receiver({ id: 'k2', sanitizedName: 'k2', recoveryRescue: { phase: 'standby', startedAt: 1, updatedAt: 1 } })];
    rescue.resumeRecoveryRescues();
    await vi.waitFor(() => expect(fleetBackup.isFleetBackupBusy('k2')).toBe(true));
    expect(fleetBackup.claimFleetBackupBusy('k2')).toBe(false);
    open();
    await vi.waitFor(() => expect(st.bots[0].recoveryRescue?.phase).toBe('streaming'));
    await vi.waitFor(() => expect(fleetBackup.isFleetBackupBusy('k2')).toBe(false));
    st.bots[0].recoveryRescue = undefined;
  });

  it('a preflight that finds the instance running in docker throws and never stops the database', async () => {
    st.live = ['k3-app'];
    st.bots = [receiver({ id: 'k3', sanitizedName: 'k3', recoveryRescue: { phase: 'preflight', startedAt: 1, updatedAt: 1 } })];
    rescue.resumeRecoveryRescues();
    await vi.waitFor(() => expect(st.bots[0].recoveryRescue?.lastError).toMatch(/the instance is running \(k3-app\); stop it, and the rescue retries/));
    expect(st.calls.some(a => a[0] === 'stop')).toBe(false);
    expect(st.bots[0].recoveryRescue.phase).toBe('preflight');
    st.bots[0].recoveryRescue = undefined;
  });
});

describe('R9-J3: the swap floors the copy\'s term above the sender\'s', () => {
  it('the quiesce answer\'s control term is kept in the rescue record', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ success: true, sourceLsn: '0/3000000', sourceTerm: 41 }), { status: 200 }));
    st.bots = [receiver({ id: 'q1', recoveryRescue: { phase: 'quiesce', startedAt: 1, updatedAt: 1 } })];
    rescue.resumeRecoveryRescues();
    await vi.waitFor(() => expect(st.bots[0].recoveryRescue?.phase).toBe('catchup'));
    expect(st.bots[0].recoveryRescue.swapSourceTerm).toBe(41);
    st.bots[0].recoveryRescue = undefined;
  });

  it('a quiesce answer without a control term is not taken', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ success: true, sourceLsn: '0/3000000' }), { status: 200 }));
    st.bots = [receiver({ id: 'q2', recoveryRescue: { phase: 'quiesce', startedAt: 1, updatedAt: 1 } })];
    rescue.resumeRecoveryRescues();
    await vi.waitFor(() => expect(st.bots[0].recoveryRescue?.lastError).toMatch(/did not report its control term/));
    expect(st.bots[0].recoveryRescue.phase).toBe('quiesce');
    st.bots[0].recoveryRescue = undefined;
  });

  it('the flip raises the control term and every guild lease above the sender\'s term before the fleet starts', async () => {
    st.bots = [receiver({ id: 'f1', recoveryChannel: undefined, recoveryRescue: { phase: 'flip', startedAt: 1, updatedAt: 1, swapSourceTerm: 41, swapPublicHost: 'h' } })];
    rescue.resumeRecoveryRescues();
    await vi.waitFor(() => expect(st.bots[0].recoveryRescue).toBeUndefined());
    const sql = st.calls.map(a => a.join(' '));
    const control = sql.findIndex(s => s.includes('UPDATE smdb_control.term SET term = GREATEST(term, 42)'));
    const leases = sql.findIndex(s => s.includes('UPDATE smdb_data.guild_ownership SET term = 42') && s.includes('WHERE term <= 41'));
    const started = st.calls.findIndex(a => a[0] === 'startBot');
    expect(control).toBeGreaterThanOrEqual(0);
    expect(leases).toBeGreaterThanOrEqual(0);
    expect(started).toBeGreaterThan(Math.max(control, leases));
    expect(sql[control]).toContain('PGOPTIONS=-c default_transaction_read_only=off');
  });
});
