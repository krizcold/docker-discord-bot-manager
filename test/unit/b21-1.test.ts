import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The rescue on the receiver (and the quiesce on the sender) with a fake docker, a fake control lane and a fake dump.
const st = vi.hoisted(() => ({
  bots: [] as any[],
  calls: [] as string[][],
  events: [] as string[],
  vol: 'database' as string | null,
  control: '' as string | null,
  localStore: '"S1"' as string,
  sourceIdentity: {} as Record<string, unknown>,
  identityError: undefined as string | undefined,
  dump: { success: true, file: 'pre-rescue-1.dump' } as { success: boolean; file?: string; error?: string },
  sidecar: { success: true } as { success: boolean; error?: string },
  quiesce: { code: 200, body: {} as Record<string, unknown> },
  left: undefined as any,
  // Runs before a docker call is answered; may hold it.
  onCall: null as ((args: string[]) => Promise<void> | void) | null,
  onFetch: null as ((action: string) => Promise<void> | void) | null,
}));

const CONTROLDATA = (id: string, tl: number) => `pg_control version number:            1300\nDatabase system identifier:           ${id}\nLatest checkpoint location:           0/2000060\nLatest checkpoint's TimeLineID:       ${tl}\n`;

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const execFile = (_cmd: string, args: string[], _opts: any, cb: (err: any, stdout: string, stderr: string) => void) => {
    st.calls.push(args);
    const sql = args.join(' ');
    const answer = (): [boolean, string] => {
      if (sql.includes('then echo partial')) return st.vol === null ? [false, 'Cannot connect to the Docker daemon'] : [true, `${st.vol}\n`];
      if (sql.includes('pg_controldata')) return st.control === null ? [false, 'pg_controldata: fatal: could not open file'] : [true, st.control];
      if (sql.includes("to_regclass('smdb_data.meta')")) return [true, 't\n'];
      if (sql.includes("WHERE key = 'store_id'")) return [true, `${st.localStore}\n`];
      if (sql.includes('SELECT system_identifier FROM pg_control_system()')) return [true, '7001\n'];
      if (sql.includes(`touch /var/lib/postgresql/data/rescue.inprogress`)) {
        const rec = st.bots[0]?.recoveryRescue;
        st.events.push(`mark:${rec?.passStartedAt ? 'stamped' : 'unstamped'}`);
        return [true, ''];
      }
      if (sql.includes('backup_label')) { st.events.push('label'); return [true, '']; }
      if (args[0] === 'stop') { st.events.push(`docker-stop:${args[1]}`); return [true, '']; }
      if (args[0] === 'ps') return [true, ''];
      if (args[0] === 'inspect' && args.includes('{{.Config.Image}}')) return [true, 'relay:1\n'];
      if (args[0] === 'inspect' && args.some(a => a.includes('.NetworkSettings.Networks'))) return [true, 'pcs\n'];
      if (args[0] === 'inspect' && args.includes('{{.State.Running}} {{.State.ExitCode}}')) return [true, 'false 0\n'];
      if (args[0] === 'inspect') return [false, `Error: No such object: ${args[args.length - 1]}`];
      if (args[0] === 'rm' && args[2]?.endsWith('-db')) st.events.push(`rm:${args[2]}`);
      return [true, ''];
    };
    void Promise.resolve(st.onCall?.(args)).then(() => {
      const [ok, out] = answer();
      setImmediate(() => (ok ? cb(null, out, '') : cb(new Error(out), '', out)));
    });
    return { stdin: null };
  };
  return { ...real, execFile };
});
vi.mock('../../src/instance/fleetBackup', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/instance/fleetBackup')>();
  return { ...real, runFleetDump: async () => { st.events.push('dump'); return st.dump; } };
});
vi.mock('../../src/instance/appHookClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/appHookClient')>()),
  hasAppHooks: () => false,
}));
vi.mock('../../src/docker/containerManager', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/docker/containerManager')>();
  return {
    ...real,
    getAllBots: () => st.bots,
    getBot: (id: string) => st.bots.find(b => b.id === id) ?? null,
    isBotBusy: () => null,
    withExternalBotOp: async (_id: string, _op: string, fn: () => Promise<any>) => fn(),
    runningNonSidecarContainers: async () => [],
    startFleetDbSidecar: async () => { st.events.push('sidecar-up'); return st.sidecar; },
    holdFleetDbForLane: () => { st.events.push('hold'); return { success: true }; },
    releaseFleetDbFromLane: () => { st.events.push('release'); return { success: true }; },
    fleetDbHeldForLane: () => false,
    stopBotInOp: async () => { st.events.push('stop-source'); return { success: true }; },
    updateInstanceRecoverySwappedAway: () => { st.events.push('swapped-away'); },
    updateInstanceRecoveryRescue: (id: string, rec: any, _swap?: any, left?: any) => {
      const b = st.bots.find(x => x.id === id);
      if (b) b.recoveryRescue = rec ?? undefined;
      if (!rec) st.left = left;
    },
  };
});

import * as rescue from '../../src/instance/recoveryRescue';
import * as fleetBackup from '../../src/instance/fleetBackup';
import * as recoveryControl from '../../src/instance/recoveryControl';

const fleetDb = { containerName: 'bot1-db', user: 'u', db: 'd', volume: 'bot1-vol' };
const SOURCE = { systemId: '7001', timeline: 3, checkpointLsn: '0/5000000', lsn: '0/5000100', storeId: 'S1' };

// A fresh id per bot: a runner from an earlier row may still be sleeping on its own id.
let seq = 0;
function receiver(rec?: Record<string, unknown>): any {
  return {
    id: `r${++seq}`, sanitizedName: `r${seq}`, displayName: 'Bot 1', status: 'stopped', sourceUrl: 'x', fleetDb,
    recoveryChannel: { mode: 'receiver', containerName: 'bot1-recovery-relay', token: 't', createdAt: 1, tunnelPort: 15433, publicHost: 'h', tlsKey: 'k', tlsCert: 'c' },
    ...(rec ? { recoveryRescue: { startedAt: 1, updatedAt: 1, identity: { source: { ...SOURCE }, acked: [] }, ...rec } } : {}),
  };
}

const ran = (pred: (a: string[]) => boolean) => st.calls.some(pred);

beforeEach(() => {
  st.bots = [];
  st.calls.length = 0;
  st.events.length = 0;
  st.vol = 'database';
  st.control = CONTROLDATA('7001', 2);
  st.localStore = '"S1"';
  st.sourceIdentity = { ...SOURCE };
  st.identityError = undefined;
  st.dump = { success: true, file: 'pre-rescue-1.dump' };
  st.sidecar = { success: true };
  st.quiesce = { code: 200, body: { success: true, sourceLsn: '0/6000000', sourceTerm: null } };
  st.left = undefined;
  st.onCall = null;
  st.onFetch = null;
  vi.stubGlobal('fetch', async (url: string) => {
    const action = String(url).split('/control/')[1] || '';
    await st.onFetch?.(action);
    if (action.startsWith('prepare')) {
      return new Response(JSON.stringify({ success: true, slot: 'recovery_channel', replicator: { user: 'r', password: 'p' }, identity: st.sourceIdentity, ...(st.identityError ? { identityError: st.identityError } : {}) }), { status: 200 });
    }
    if (action.startsWith('quiesce')) {
      st.events.push(`quiesce:${action}`);
      return new Response(JSON.stringify(st.quiesce.body), { status: st.quiesce.code });
    }
    if (action === 'backup-stop') return new Response(JSON.stringify({ success: true, result: { labelfile: 'START WAL LOCATION: 0/2000028\n' } }), { status: 200 });
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  });
});
afterEach(() => {
  for (const b of st.bots) b.recoveryRescue = undefined;
  vi.unstubAllGlobals();
});

async function runUntil(bot: any, done: (r: any) => boolean, timeout = 5000): Promise<void> {
  st.bots = [bot];
  rescue.resumeRecoveryRescues();
  await vi.waitFor(() => expect(done(st.bots[0].recoveryRescue)).toBe(true), { timeout, interval: 20 });
}

describe('R23-J3: the sender\'s identity against this machine\'s', () => {
  const here = (extra: Record<string, unknown> = {}) => ({ identity: { systemId: '7001', timeline: 2, ...extra } });

  it('a copy of the same database on a later timeline needs no acknowledgement', () => {
    expect(rescue.compareIdentities(SOURCE, undefined, here({ storeId: 'S1' }))).toEqual({ acks: [] });
  });

  it('a different fleet store is refused, and so is a sender with no store over a populated one', () => {
    expect(rescue.compareIdentities(SOURCE, undefined, here({ storeId: 'S2' })).refusal).toMatch(/different fleet store \(store id S1\) from this machine's \(store id S2\)/);
    expect(rescue.compareIdentities({ ...SOURCE, storeId: null }, undefined, here({ storeId: 'S2' })).refusal).toMatch(/holds no fleet store/);
  });

  it('a different cluster or a sender on a lower timeline needs an acknowledgement naming both', () => {
    const sys = rescue.compareIdentities({ ...SOURCE, systemId: '9009' }, undefined, here());
    expect(sys.acks.map(a => a.key)).toEqual(['system-id']);
    expect(sys.acks[0].text).toMatch(/system id 9009\) from this machine's \(system id 7001\)/);
    const tl = rescue.compareIdentities({ ...SOURCE, timeline: 1 }, undefined, here());
    expect(tl.acks.map(a => a.key)).toEqual(['timeline']);
    expect(tl.acks[0].text).toMatch(/timeline 1, below this machine's timeline 2/);
  });

  it('an identity this machine cannot read needs an acknowledgement; a sender that reports none is refused', () => {
    expect(rescue.compareIdentities(SOURCE, undefined, { error: 'no pg_control' }).acks.map(a => a.key)).toEqual(['local-unreadable']);
    expect(rescue.compareIdentities({}, 'the database did not answer', here()).refusal).toMatch(/did not report its database identity \(the database did not answer\)/);
    expect(rescue.compareIdentities({ ...SOURCE, storeId: undefined }, undefined, here()).refusal).toMatch(/did not report its store id/);
    expect(rescue.compareIdentities(SOURCE, undefined, null)).toEqual({ acks: [] });
  });
});

describe('R23-J3 and R4-J13: a fresh rescue confirms against both identities', () => {
  it('a volume docker cannot check refuses the rescue instead of offering the fresh sentence', async () => {
    st.vol = null;
    st.bots = [receiver()];
    const r = await rescue.startRescue(st.bots[0], false);
    expect(r.success).toBe(false);
    expect(r.needsConfirm).toBeUndefined();
    expect(r.error).toMatch(/could not say whether this machine's database volume holds a database/);
  });

  it('a sender of a different cluster asks a second confirm, and starts only once it is acknowledged', async () => {
    st.sourceIdentity = { ...SOURCE, systemId: '9009' };
    st.bots = [receiver()];
    const ask = await rescue.startRescue(st.bots[0], false);
    expect(ask).toMatchObject({ needsConfirm: true, state: 'outdated', localIdentity: { systemId: '7001', timeline: 2 } });
    expect(ask.acks!.map(a => a.key)).toEqual(['system-id']);
    const unacked = await rescue.startRescue(st.bots[0], true);
    expect(unacked.needsConfirm).toBe(true);
    expect(st.bots[0].recoveryRescue).toBeUndefined();
    const go = await rescue.startRescue(st.bots[0], true, { acknowledge: ['system-id'] });
    expect(go.success).toBe(true);
    expect(st.bots[0].recoveryRescue.identity).toEqual({ source: { systemId: '9009', timeline: 3, checkpointLsn: '0/5000000', storeId: 'S1' }, acked: ['system-id'] });
  });

  it('a sender that cannot report its identity is refused before any record', async () => {
    st.identityError = 'could not read the store id: permission denied';
    st.bots = [receiver()];
    const r = await rescue.startRescue(st.bots[0], true);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/permission denied/);
    expect(st.bots[0].recoveryRescue).toBeUndefined();
  });
});

describe('R4-J13: the pre-rescue dump is a precondition of the overwrite', () => {
  it('a failed dump parks the rescue at preflight with the failure recorded and the volume untouched', async () => {
    st.dump = { success: false, error: 'pg_dump: error: disk full' };
    await runUntil(receiver({ phase: 'preflight' }), r => r?.parked === true);
    const rec = st.bots[0].recoveryRescue;
    expect(rec).toMatchObject({ phase: 'preflight', dumpOk: false, dumpError: 'pg_dump: error: disk full' });
    expect(rec.lastError).toMatch(/safety dump of this machine's database failed \(pg_dump: error: disk full\), so nothing was overwritten/);
    expect(st.events).not.toContain('hold');
    expect(st.events).not.toContain('rm:bot1-db');
    expect(st.events.some(e => e.startsWith('mark:'))).toBe(false);
    expect(ran(a => a.join(' ').includes('rsync -a'))).toBe(false);
  });

  it('a database that does not start for the dump parks with that named', async () => {
    st.sidecar = { success: false, error: 'database did not become ready within 30 seconds' };
    await runUntil(receiver({ phase: 'preflight' }), r => r?.parked === true);
    expect(st.bots[0].recoveryRescue.dumpError).toMatch(/did not start for it: database did not become ready/);
    expect(st.events).not.toContain('dump');
    expect(st.events).not.toContain('hold');
  });

  it('a taken dump is recorded by file name and the preflight moves on to the copy', async () => {
    await runUntil(receiver({ phase: 'preflight' }), r => r?.phase === 'bulk');
    st.bots[0].recoveryRescue.parked = true;
    expect(st.bots[0].recoveryRescue).toMatchObject({ dumpOk: true, dumpFile: 'pre-rescue-1.dump' });
    expect(st.bots[0].recoveryRescue.identity.localStoreId).toBe('S1');
    expect(st.events.indexOf('dump')).toBeLessThan(st.events.indexOf('hold'));
  });

  it('overwrite without a dump is taken only on a failed dump, and then skips the dump', async () => {
    st.bots = [receiver({ phase: 'preflight' })];
    expect((await rescue.startRescue(st.bots[0], false, { withoutDump: true })).error).toMatch(/applies only to a rescue parked on a failed safety dump/);
    st.bots[0].recoveryRescue = undefined;
    const bot = receiver({ phase: 'preflight', parked: true, dumpOk: false, dumpError: 'disk full' });
    st.bots = [bot];
    expect((await rescue.startRescue(bot, false, { withoutDump: true })).success).toBe(true);
    await vi.waitFor(() => expect(bot.recoveryRescue?.phase).toBe('bulk'));
    bot.recoveryRescue.parked = true;
    expect(bot.recoveryRescue.dumpSkipped).toBe('waived');
    expect(st.events).not.toContain('dump');
  });

  it('a partial copy from an earlier rescue is not dumped, and that is recorded', async () => {
    st.vol = 'partial';
    await runUntil(receiver({ phase: 'preflight' }), r => r?.phase === 'bulk');
    st.bots[0].recoveryRescue.parked = true;
    expect(st.bots[0].recoveryRescue.dumpSkipped).toBe('partial');
    expect(st.events).not.toContain('dump');
  });
});

describe('R23-J3: the preflight compares both identities again before the overwrite', () => {
  it('a store id here that differs from the sender\'s parks the rescue before the database is taken out', async () => {
    st.localStore = '"S2"';
    await runUntil(receiver({ phase: 'preflight' }), r => r?.parked === true);
    expect(st.bots[0].recoveryRescue.lastError).toMatch(/different fleet store \(store id S1\) from this machine's \(store id S2\); nothing was overwritten/);
    expect(st.events).not.toContain('hold');
    expect(st.events).not.toContain('rm:bot1-db');
  });

  it('a sender that reports another database than the one confirmed parks the rescue', async () => {
    st.sourceIdentity = { ...SOURCE, systemId: '9009' };
    await runUntil(receiver({ phase: 'preflight' }), r => r?.parked === true);
    expect(st.bots[0].recoveryRescue.lastError).toMatch(/now reports a different database \(system id 9009/);
    expect(st.events).not.toContain('hold');
  });
});

describe('R9-J2: the marker means a pass has started', () => {
  it('the preflight writes no marker, and the bulk phase stamps the pass before it marks the volume', async () => {
    await runUntil(receiver({ phase: 'preflight' }), r => r?.phase === 'consistent', 15000);
    st.bots[0].recoveryRescue.parked = true;
    const marks = st.events.filter(e => e.startsWith('mark:'));
    expect(marks).toEqual(['mark:stamped']);
    expect(st.events.indexOf('mark:stamped')).toBeGreaterThan(st.events.indexOf('rm:bot1-db'));
    expect(st.bots[0].recoveryRescue.passStartedAt).toBeGreaterThan(0);
  }, 20000);

  it('a cancel before any pass leaves no mark; after a pass, a partial mark', async () => {
    st.bots = [receiver({ phase: 'bulk', parked: true })];
    const before = await rescue.cancelRescue(st.bots[0]);
    expect(st.left).toBeUndefined();
    expect(before.note).toMatch(/before any copy began/);
    st.bots = [receiver({ phase: 'consistent', parked: true, passStartedAt: 5 })];
    const after = await rescue.cancelRescue(st.bots[0]);
    expect(st.left).toMatchObject({ state: 'partial' });
    expect(after.note).toMatch(/partial copy/);
  });

  it('a cancel at preflight keeps an earlier rescue\'s mark and says the volume still holds it', async () => {
    st.bots = [{ ...receiver({ phase: 'preflight', parked: true }), recoveryRescueLeft: { at: 1, state: 'standby' } }];
    const r = await rescue.cancelRescue(st.bots[0]);
    expect(st.left).toBeUndefined();
    expect(r.note).not.toMatch(/was not changed/);
    expect(r.note).toMatch(/still holds the standby copy of the sender that an earlier cancelled rescue left/);
  });

  it('a cancel at preflight over a partial copy with no mark records one', async () => {
    st.bots = [receiver({ phase: 'preflight', parked: true, dumpSkipped: 'partial' })];
    const r = await rescue.cancelRescue(st.bots[0]);
    expect(st.left).toMatchObject({ state: 'partial' });
    expect(r.note).toMatch(/still holds the partial copy of the sender's database that an earlier rescue left/);
  });
});

describe('R22-J12: a cancelled rescue stops before its next write', () => {
  it('a cancel at streaming stops the standby and records it', async () => {
    st.bots = [receiver({ phase: 'streaming', parked: true, passStartedAt: 5 })];
    const r = await rescue.cancelRescue(st.bots[0]);
    expect(r.success).toBe(true);
    expect(st.left).toMatchObject({ state: 'standby' });
    expect(st.events).toContain('docker-stop:bot1-db');
    expect(r.note).toMatch(/standby copy of the sender/);
  });

  it('a cancel during the standby config write starts no standby afterwards', async () => {
    let cancelled = false;
    const bot = receiver({ phase: 'standby', passStartedAt: 5 });
    st.onCall = async args => {
      if (!cancelled && args.join(' ').includes('standby.signal')) {
        cancelled = true;
        await rescue.cancelRescue(bot);
      }
    };
    st.bots = [bot];
    rescue.resumeRecoveryRescues();
    await vi.waitFor(() => expect(cancelled && bot.recoveryRescue === undefined).toBe(true));
    await new Promise(r => setTimeout(r, 200));
    expect(st.events).not.toContain('sidecar-up');
  });

  it('a cancel during backup-stop writes no backup label', async () => {
    const bot = receiver({ phase: 'consistent', passStartedAt: 5 });
    st.onFetch = async action => { if (action === 'backup-stop') await rescue.cancelRescue(bot); };
    st.bots = [bot];
    rescue.resumeRecoveryRescues();
    await vi.waitFor(() => expect(bot.recoveryRescue).toBeUndefined(), { timeout: 15000 });
    await new Promise(r => setTimeout(r, 200));
    expect(st.events).not.toContain('label');
  }, 20000);
});

describe('R23-J3: the swap\'s quiesce checks the copy is the sender\'s', () => {
  it('the receiver sends its copy\'s system id, and a mismatch answer parks the rescue', async () => {
    st.quiesce = { code: 409, body: { success: false, identityMismatch: true, error: 'the receiver\'s copy (system id 7001) is not a copy of this database (system id 9009), so nothing was stopped' } };
    await runUntil(receiver({ phase: 'quiesce', passStartedAt: 5 }), r => r?.parked === true);
    expect(st.events).toContain('quiesce:quiesce?systemId=7001');
    expect(st.bots[0].recoveryRescue.lastError).toMatch(/The sender refused the swap: the receiver's copy \(system id 7001\) is not a copy/);
  });

  it('the sender refuses a copy that is not its own and stops nothing', async () => {
    const handle = (recoveryControl as any).handleRecoveryControl as (req: any, res: any) => Promise<void>;
    st.bots = [{ id: 's1', sanitizedName: 's1', displayName: 'S', status: 'running', fleetDb: { ...fleetDb, containerName: 's1-db' }, recoveryChannel: { mode: 'source', token: 'tok', createdAt: 1 } }];
    const call = async (url: string) => {
      let code = 0;
      let text = '';
      await handle({ url, headers: { 'x-recovery-token': 'tok' } }, { writeHead: (c: number) => { code = c; }, end: (t: string) => { text = t; } });
      return { code, body: JSON.parse(text) };
    };
    const wrong = await call('/control/quiesce?systemId=9009');
    expect(wrong.code).toBe(409);
    expect(wrong.body.error).toMatch(/system id 9009\) is not a copy of this database \(system id 7001\), so nothing was stopped/);
    const none = await call('/control/quiesce');
    expect(none.code).toBe(400);
    expect(st.events).not.toContain('stop-source');
    expect(st.events).not.toContain('swapped-away');
    expect(fleetBackup.isFleetBackupBusy('s1')).toBe(false);
  });

  it('the sender\'s prepare answer carries its checkpoint and store id', async () => {
    const handle = (recoveryControl as any).handleRecoveryControl as (req: any, res: any) => Promise<void>;
    st.bots = [{ id: 's1', sanitizedName: 's1', displayName: 'S', status: 'running', fleetDb: { ...fleetDb, containerName: 's1-db', replication: { role: 'repl', password: 'pw' } }, recoveryChannel: { mode: 'source', token: 'tok', createdAt: 1 } }];
    st.onCall = args => {
      if (args.join(' ').includes('pg_current_wal_lsn()') && args.join(' ').includes('checkpoint_lsn')) st.events.push('identity-read');
    };
    let text = '';
    await handle({ url: '/control/prepare', headers: { 'x-recovery-token': 'tok' } }, { writeHead: () => {}, end: (t: string) => { text = t; } });
    const body = JSON.parse(text);
    expect(st.events).toContain('identity-read');
    expect(body.identity.storeId).toBe('S1');
    expect(body.identityError).toBeUndefined();
  });
});
