import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A fake docker CLI that records each call with the options it was given. st.answer decides each call's reply.
const st = vi.hoisted(() => ({
  bots: [] as any[],
  calls: [] as Array<{ args: string[]; opts: any }>,
  live: [] as Array<string[] | null>,
  answer: (_args: string[]): { ok: boolean; stdout?: string; stderr?: string } => ({ ok: true }),
}));

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const execFile = (cmd: string, args: string[], opts: any, maybeCb?: (err: any, stdout: string, stderr: string) => void) => {
    const cb = typeof opts === 'function' ? opts : maybeCb!;
    if (cmd !== 'docker') throw new Error(`unexpected execFile ${cmd}`);
    st.calls.push({ args, opts: typeof opts === 'function' ? undefined : opts });
    const a = st.answer(args);
    setImmediate(() => cb(a.ok ? null : Object.assign(new Error('docker failed'), { code: 1 }), a.stdout ?? '', a.stderr ?? ''));
    return { stdin: null };
  };
  const spawn = () => { throw new Error('no backup session in this test'); };
  return { ...real, execFile, spawn };
});
vi.mock('../../src/instance/appHookClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/appHookClient')>()),
  hasAppHooks: () => false,
}));
vi.mock('../../src/docker/containerManager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/docker/containerManager')>()),
  getAllBots: () => st.bots,
  getBot: (id: string) => st.bots.find(b => b.id === id) ?? null,
  registryFault: () => null,
  isShuttingDown: () => false,
  runningNonSidecarContainers: async () => (st.live.length > 1 ? st.live.shift()! : st.live[0] ?? []),
  stopBotInOp: async () => ({ success: true }),
  startFleetDbSidecar: async () => ({ success: true }),
  updateInstanceRecoverySwappedAway: (id: string, rec: any) => {
    const b = st.bots.find(x => x.id === id);
    if (b) b.recoverySwappedAway = rec ?? undefined;
  },
  updateInstanceRecoveryChannel: (id: string, rec: any) => {
    const b = st.bots.find(x => x.id === id);
    if (b) b.recoveryChannel = rec ?? undefined;
    return true;
  },
}));
vi.mock('../../src/casaos/detector', () => ({ getDeploymentMode: async () => 'docker' }));

import * as recoveryControl from '../../src/instance/recoveryControl';
import * as recoveryChannel from '../../src/instance/recoveryChannel';
import * as fleetBackupGuards from '../../src/instance/fleetBackupGuards';

const bounded = (opts: any) => typeof opts?.timeout === 'number' && opts.timeout > 0;
const callsOf = (match: (args: string[]) => boolean) => st.calls.filter(c => match(c.args));
const sqlOf = (args: string[]) => args.join(' ');

function source(extra: Record<string, unknown> = {}): any {
  return {
    id: 's1', sanitizedName: 'src1', displayName: 'Source 1', status: 'stopped', sourceUrl: 'x',
    fleetDb: { containerName: 'src1-db', user: 'u', db: 'd', volume: 'src1-vol' },
    recoveryChannel: { mode: 'source', containerName: 'src1-recovery-relay', token: 'tok', createdAt: 1 },
    ...extra,
  };
}

async function call(action: string): Promise<{ code: number; body: any }> {
  let code = 0;
  let text = '';
  await recoveryControl.handleRecoveryControl({ url: `/control/${action}${action === 'quiesce' ? '?systemId=7001' : ''}`, headers: { 'x-recovery-token': 'tok' } } as any, {
    writeHead: (c: number) => { code = c; },
    end: (t: string) => { text = t; },
  } as any);
  return { code, body: JSON.parse(text) };
}

beforeEach(() => {
  recoveryControl.releaseQuiesceSlot('s1');
  fleetBackupGuards.releaseFleetBackupBusy('s1');
  st.bots = [source()];
  st.calls.length = 0;
  st.live = [[]];
  st.answer = (args) => {
    const sql = sqlOf(args);
    if (sql.includes('system_identifier FROM pg_control_system()')) return { ok: true, stdout: '7001\n' };
    if (sql.includes('SELECT pg_current_wal_lsn()')) return { ok: true, stdout: '0/3000000\n' };
    if (sql.includes('pg_create_physical_replication_slot')) return { ok: true, stdout: 'reserved\n' };
    if (args[0] === 'inspect' && args.includes('{{.State.Running}}')) return { ok: true, stdout: 'true\n' };
    if (args[0] === 'inspect') return { ok: true, stdout: 'net1\n' };
    return { ok: true, stdout: '' };
  };
  process.env.RECOVERY_RELAY_IMAGE = 'img';
});
afterEach(() => {
  delete process.env.RECOVERY_RELAY_IMAGE;
});

describe('FU-W the source control plane runs its writing docker calls with no timeout', () => {
  it('starts the rsync daemon (rm, then run) with no timeout, and reads its state with one', async () => {
    const answer = st.answer;
    st.answer = (args) => (args[0] === 'inspect' && args.includes('src1-recovery-rsyncd')
      ? { ok: false, stderr: 'Error: No such object: src1-recovery-rsyncd' } : answer(args));
    const r = await recoveryControl.ensureRsyncDaemon(st.bots[0], 'img', 'net1');
    expect(r.ok).toBe(true);
    const inspect = callsOf(a => a[0] === 'inspect');
    const rm = callsOf(a => a[0] === 'rm');
    const run = callsOf(a => a[0] === 'run');
    expect(inspect.length).toBe(1);
    expect(bounded(inspect[0].opts)).toBe(true);
    expect(rm.length).toBe(1);
    expect(run.length).toBe(1);
    expect(rm[0].opts?.timeout).toBeUndefined();
    expect(run[0].opts?.timeout).toBeUndefined();
  });

  it('stops a leftover source container with no timeout', async () => {
    st.live = [['src1-app'], ['src1-app'], []];
    const r = await call('quiesce');
    const stop = callsOf(a => a[0] === 'stop' && a[1] === 'src1-app');
    expect(stop.length).toBe(1);
    expect(stop[0].opts?.timeout).toBeUndefined();
    expect(r.body.error ?? '').not.toMatch(/still running after the stop/);
    const idRead = callsOf(a => sqlOf(a).includes('system_identifier FROM pg_control_system()'));
    expect(idRead.length).toBe(1);
    expect(bounded(idRead[0].opts)).toBe(true);
  });

  it('drops a stale recovery slot and creates the slot with no timeout in backup-start', async () => {
    await call('backup-start');
    const drop = callsOf(a => sqlOf(a).includes('pg_drop_replication_slot'));
    const create = callsOf(a => sqlOf(a).includes('pg_create_physical_replication_slot'));
    expect(drop.length).toBe(1);
    expect(create.length).toBe(1);
    expect(drop[0].opts?.timeout).toBeUndefined();
    expect(create[0].opts?.timeout).toBeUndefined();
  });

  it('keeps the timeout on the status read', async () => {
    await call('status');
    const probe = callsOf(a => sqlOf(a).includes('pg_replication_slots'));
    expect(probe.length).toBe(1);
    expect(bounded(probe[0].opts)).toBe(true);
  });
});

const PEM = '-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----\n';

describe('FU-W the recovery channel runs its writing docker calls with no timeout', () => {
  it('removes and runs the relay with no timeout when a source arms, and reads with one', async () => {
    const bot = source({ recoveryChannel: undefined });
    st.bots = [bot];
    const r = await recoveryChannel.armSource(bot, { host: 'rcv.invalid', port: 15433, cert: PEM, token: 't' });
    expect(r.success).toBe(true);
    const relayRm = callsOf(a => a[0] === 'rm' && a.includes('src1-recovery-relay'));
    const relayRun = callsOf(a => a[0] === 'run' && a.includes('src1-recovery-relay'));
    expect(relayRm.length).toBe(1);
    expect(relayRun.length).toBe(1);
    expect(relayRm[0].opts?.timeout).toBeUndefined();
    expect(relayRun[0].opts?.timeout).toBeUndefined();
    expect(relayRun[0].opts?.env?.RELAY_TOKEN).toBe('t');
    const reads = callsOf(a => a[0] === 'inspect');
    expect(reads.length).toBeGreaterThan(0);
    for (const c of reads) expect(bounded(c.opts)).toBe(true);
  });

  it('runs the disarm\'s removals, fence lift, strip and slot drop with no timeout', async () => {
    const answer = st.answer;
    st.answer = (args) => {
      const sql = sqlOf(args);
      if (sql.includes('ALTER SYSTEM RESET default_transaction_read_only')) return { ok: false, stderr: 'ERROR: lift' };
      if (args[0] === 'run' && sql.includes('postgresql.auto.conf')) return { ok: true, stdout: '' };
      return answer(args);
    };
    await recoveryChannel.disarmRecoveryChannel(st.bots[0]);
    const writes = [
      ...callsOf(a => a[0] === 'rm'),
      ...callsOf(a => a[0] === 'exec' && a[1] === '-u' && a[2] === 'root'),
      ...callsOf(a => sqlOf(a).includes('ALTER SYSTEM RESET default_transaction_read_only')),
      ...callsOf(a => a[0] === 'run' && sqlOf(a).includes('postgresql.auto.conf')),
      ...callsOf(a => sqlOf(a).includes('pg_terminate_backend(active_pid)')),
      ...callsOf(a => sqlOf(a).includes('pg_drop_replication_slot')),
    ];
    expect(writes.length).toBe(7);
    for (const c of writes) expect(c.opts?.timeout).toBeUndefined();
    const reads = callsOf(a => a[0] === 'inspect' || (a[0] === 'volume' && a[1] === 'inspect'));
    expect(reads.length).toBeGreaterThan(0);
    for (const c of reads) expect(bounded(c.opts)).toBe(true);
  });

  it('starts a stopped relay with no timeout', async () => {
    const answer = st.answer;
    st.answer = (args) => (args[0] === 'inspect' && args.includes('src1-recovery-relay') ? { ok: true, stdout: 'false\n' } : answer(args));
    await recoveryChannel.reconcileRecoveryChannels();
    const start = callsOf(a => a[0] === 'start');
    expect(start.length).toBe(1);
    expect(start[0].opts?.timeout).toBeUndefined();
  });
});
