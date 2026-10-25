import { beforeEach, describe, expect, it, vi } from 'vitest';

// The swap's quiesce on the SOURCE manager, driven through its control handler with a fake docker and app.
const st = vi.hoisted(() => ({
  bots: [] as any[],
  events: [] as string[],
  live: [] as string[] | null,
  reset: { success: true } as { success: boolean; error?: string; unknown?: boolean },
  saveFails: false,
  termTables: 't|t',
  term: '41',
  // The fence's settings read; null answers the shared fake's default.
  fenceSettings: null as string | null,
}));

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const execFile = (_cmd: string, args: string[], _opts: any, cb: (err: any, stdout: string, stderr: string) => void) => {
    const sql = args.join(' ');
    let out = '';
    if (args[0] === 'stop') st.events.push(`docker-stop:${args[1]}`);
    if (sql.includes('ALTER SYSTEM SET default_transaction_read_only = on')) st.events.push('fence');
    if (sql.includes('SELECT pg_current_wal_lsn()')) { st.events.push('lsn'); out = '0/3000000'; }
    if (sql.includes('SELECT system_identifier FROM pg_control_system()')) out = '7001';
    if (sql.includes("to_regclass('smdb_control.term')")) out = st.termTables;
    if (sql.includes('SELECT coalesce(GREATEST(')) out = st.term;
    setImmediate(() => cb(null, `${out}\n`, ''));
    return { stdin: null };
  };
  const fenced = (await import('./fence-fake')).withFence(execFile as any);
  const outer = (cmd: string, args: string[], opts: any, cb: (err: any, stdout: string, stderr: string) => void) => {
    const sql = args.join(' ');
    if (sql.includes("current_setting('hba_file') ||") && st.fenceSettings !== null) {
      setImmediate(() => cb(null, `${st.fenceSettings}\n`, ''));
      return { stdin: null };
    }
    if (args[1] === '-u' && args[2] === 'root' && sql.includes('printf') && sql.includes('smdb-write-fence')) st.events.push('hba-write');
    if (args.includes('127.0.0.1')) st.events.push('probe');
    return fenced(cmd, args, opts, cb);
  };
  return { ...real, execFile: outer };
});
vi.mock('../../src/instance/appHookClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/appHookClient')>()),
  hasAppHooks: () => true,
}));
vi.mock('../../src/instance/appLifecycle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/appLifecycle')>()),
  resetRole: async () => { st.events.push('reset'); return st.reset; },
}));
vi.mock('../../src/docker/containerManager', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/docker/containerManager')>();
  const stop = async (id: string) => {
    st.events.push(`stop:${id}`);
    st.live = [];
    return { success: true };
  };
  return {
    ...real,
    getAllBots: () => st.bots,
    getBot: (id: string) => st.bots.find(b => b.id === id) ?? null,
    runningNonSidecarContainers: async () => st.live,
    stopBot: stop,
    stopBotInOp: stop,
    startFleetDbSidecar: async () => { st.events.push('sidecar-up'); return { success: true }; },
    updateInstanceRecoverySwappedAway: (id: string, rec: any) => {
      if (st.saveFails) throw new Error('ENOSPC: no space left on device');
      st.events.push('swapped-away');
      const b = st.bots.find(x => x.id === id);
      if (b) b.recoverySwappedAway = rec ?? undefined;
    },
  };
});

import * as containerManager from '../../src/docker/containerManager';
import * as fleetBackupGuards from '../../src/instance/fleetBackupGuards';
import * as recoveryControl from '../../src/instance/recoveryControl';

function source(extra: Record<string, unknown> = {}): any {
  return {
    id: 's1', sanitizedName: 'src1', displayName: 'Source 1', status: 'stopped', sourceUrl: 'x',
    fleetDb: { containerName: 'src1-db', user: 'u', db: 'd', volume: 'src1-vol' },
    recoveryChannel: { mode: 'source', containerName: 'src1-recovery-dialer', token: 'tok', createdAt: 1 },
    ...extra,
  };
}

async function call(action: string): Promise<{ code: number; body: any }> {
  const handle = (recoveryControl as any).handleRecoveryControl as (req: any, res: any) => Promise<void>;
  let code = 0;
  let text = '';
  await handle({ url: `/control/${action}${action === 'quiesce' ? '?systemId=7001' : ''}`, headers: { 'x-recovery-token': 'tok' } }, {
    writeHead: (c: number) => { code = c; },
    end: (t: string) => { text = t; },
  });
  return { code, body: JSON.parse(text) };
}

beforeEach(() => {
  recoveryControl.releaseQuiesceSlot?.('s1');
  fleetBackupGuards.releaseFleetBackupBusy('s1');
  st.bots = [source()];
  st.events.length = 0;
  st.live = ['src1-app'];
  st.reset = { success: true };
  st.saveFails = false;
  st.termTables = 't|t';
  st.term = '41';
  st.fenceSettings = null;
});

describe('R9-J3: the quiesce holds the database lanes off and decides from docker', () => {
  it('refuses while a dump, restore or replication change holds the backup slot, and stops nothing', async () => {
    expect(fleetBackupGuards.claimFleetBackupBusy('s1')).toBe(true);
    const r = await call('quiesce');
    fleetBackupGuards.releaseFleetBackupBusy('s1');
    expect(r.code).toBe(409);
    expect(r.body.error).toMatch(/dump, restore or replication change is running/);
    expect(st.events).toEqual([]);
  });

  it('refuses while an op lock is held and names the op', async () => {
    let release: () => void = () => {};
    const held = containerManager.withExternalBotOp('s1', 'update', () => new Promise<void>(r => { release = r; }));
    const r = await call('quiesce');
    release();
    await held;
    expect(r.code).toBe(409);
    expect(r.body.error).toMatch(/Operation 'update' is already in progress/);
    expect(st.events).toEqual([]);
    expect(fleetBackupGuards.claimFleetBackupBusy('s1')).toBe(true);
    fleetBackupGuards.releaseFleetBackupBusy('s1');
  });

  it('holds the op lock while it runs', async () => {
    let seen: string | null = 'unset';
    st.reset = { success: true };
    const orig = st.events.push.bind(st.events);
    st.events.push = (...items: string[]) => {
      if (items[0] === 'reset') seen = containerManager.isBotBusy('s1');
      return orig(...items);
    };
    const r = await call('quiesce');
    delete (st.events as any).push;
    expect(r.code).toBe(200);
    expect(seen).toBe('quiesce');
    expect(containerManager.isBotBusy('s1')).toBeNull();
  });

  it('a record that says stopped with the app running in docker is reset and stopped', async () => {
    const r = await call('quiesce');
    expect(r.code).toBe(200);
    expect(st.events.indexOf('reset')).toBeGreaterThanOrEqual(0);
    expect(st.events.indexOf('stop:s1')).toBeGreaterThan(st.events.indexOf('reset'));
  });

  it('docker that cannot answer refuses before anything is stopped', async () => {
    st.live = null;
    const r = await call('quiesce');
    expect(r.code).toBe(500);
    expect(r.body.error).toMatch(/could not tell whether the source instance is running/);
    expect(st.events).toEqual([]);
    expect(fleetBackupGuards.claimFleetBackupBusy('s1')).toBe(true);
    fleetBackupGuards.releaseFleetBackupBusy('s1');
  });

  it('refuses until the role reset lands, and stops nothing', async () => {
    st.reset = { success: false, error: 'the app did not answer' };
    const r = await call('quiesce');
    expect(r.code).toBe(500);
    expect(r.body.error).toMatch(/did not confirm its return to its configured role \(the app did not answer\)/);
    expect(st.events).toEqual(['reset']);
  });

  it('claims the backup slot from the quiesce until the teardown', async () => {
    const r = await call('quiesce');
    expect(r.code).toBe(200);
    expect(fleetBackupGuards.claimFleetBackupBusy('s1')).toBe(false);
    const again = await call('quiesce');
    expect(again.code).toBe(200);
    const bye = await call('teardown');
    expect(bye.code).toBe(200);
    expect(fleetBackupGuards.claimFleetBackupBusy('s1')).toBe(true);
    fleetBackupGuards.releaseFleetBackupBusy('s1');
  });

  it('a re-entry that refuses after an earlier quiesce stopped the source keeps the slot', async () => {
    expect((await call('quiesce')).code).toBe(200);
    st.live = null;
    const again = await call('quiesce');
    expect(again.code).toBe(500);
    expect(fleetBackupGuards.claimFleetBackupBusy('s1')).toBe(false);
  });
});

describe('B14-2Lb: the quiesce uses the shared write fence', () => {
  it('writes the pg_hba lines and sees the reject before it captures the LSN', async () => {
    const r = await call('quiesce');
    expect(r.code).toBe(200);
    const fence = st.events.indexOf('fence');
    expect(fence).toBeGreaterThan(st.events.indexOf('sidecar-up'));
    expect(st.events.indexOf('hba-write')).toBeGreaterThan(fence);
    expect(st.events.indexOf('probe')).toBeGreaterThan(st.events.indexOf('hba-write'));
    expect(st.events.indexOf('lsn')).toBeGreaterThan(st.events.indexOf('probe'));
  });

  it('a fence refused before it changed anything names the stopped source, not "nothing was changed"', async () => {
    st.fenceSettings = '/var/lib/postgresql/data/pg_hba.conf|on|0|1|off||0|';
    const r = await call('quiesce');
    expect(r.code).toBe(500);
    expect(r.body.error).toMatch(/^could not fence the source database: the database has 1 enabled subscription/);
    expect(r.body.error).not.toMatch(/nothing was changed/);
    expect(r.body.error).toMatch(/the source instance is stopped and its database was not fenced/);
    expect(st.events).toContain('stop:s1');
    expect(st.events).not.toContain('fence');
    expect(st.events).not.toContain('lsn');
  });
});

describe('R9-J3: the quiesce records the sender as swapped away and hands back its term', () => {
  it('records the swap before the stop and answers the control term', async () => {
    const r = await call('quiesce');
    expect(r.code).toBe(200);
    expect(r.body.sourceLsn).toBe('0/3000000');
    expect(r.body.sourceTerm).toBe(41);
    expect(st.events.indexOf('swapped-away')).toBeLessThan(st.events.indexOf('stop:s1'));
    expect(st.bots[0].recoverySwappedAway?.at).toEqual(expect.any(Number));
  });

  it('a swap record that cannot be saved refuses before the stop', async () => {
    st.saveFails = true;
    const r = await call('quiesce');
    expect(r.code).toBe(500);
    expect(r.body.error).toMatch(/could not be recorded/);
    expect(st.events).not.toContain('stop:s1');
  });

  it('a database without the term tables answers a null term', async () => {
    st.termTables = 'f|f';
    const r = await call('quiesce');
    expect(r.code).toBe(200);
    expect(r.body.sourceTerm).toBeNull();
  });
});

// Last in the file: the shutdown flag stays set for the rest of the process.
describe('R13-J15: a shutting-down source refuses a quiesce', () => {
  it('answers 503 and stops, records and claims nothing', async () => {
    (containerManager as any).beginShutdown();
    const r = await call('quiesce');
    expect(r.code).toBe(503);
    expect(r.body.error).toMatch(/^The manager is shutting down/);
    expect(st.events).toEqual([]);
    expect(st.bots[0].recoverySwappedAway).toBeUndefined();
    expect(fleetBackupGuards.isFleetBackupBusy('s1')).toBe(false);
  });
});
