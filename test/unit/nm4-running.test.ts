import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const s = {
    inst: null as any,
    env: { vars: {} as Record<string, string>, undecryptable: [] as string[], encrypted: [] as string[], corrupt: false },
    lock: null as string | null,
    hold: false,
    deleteLane: false,
    app: true as boolean | null,
    appAfterStart: true,
    sidecar: true as boolean | null,
    db: { inRecovery: false, canLogin: true as boolean | null, sessions: 1 },
    readFail: null as string | null,
    readOpenAfterBlock: false,
    dbUp: { success: true } as { success: boolean; error?: string },
    dbUpCalls: 0,
    ensure: { ok: true } as any,
    block: { ok: true } as any,
    end: { ok: true } as any,
    open: { ok: true } as any,
    hook: (_body: any): any => ({ ok: true, status: 200, body: { success: true } }),
    hookBodies: [] as any[],
    start: { success: true } as { success: boolean; error?: string },
    stop: { success: true } as { success: boolean; error?: string },
    events: [] as string[],
    writes: [] as any[],
    failWrite: (_n: number, _rec: any): string | null => null,
    crashAt: null as string | null,
    ro: { ok: true, on: false } as any,
  };
  return s;
});

vi.mock('../../src/env/manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/env/manager')>()),
  getEnvVarsWithStatus: () => h.env,
}));

const crash = (step: string) => { if (h.crashAt === step) { h.crashAt = null; throw new Error(`crash at ${step}`); } };

vi.mock('../../src/docker/containerManager', () => ({
  SHUTDOWN_REFUSAL: 'shutting down',
  isShuttingDown: () => false,
  registryFault: () => null,
  getBot: (id: string) => (h.inst && h.inst.id === id ? JSON.parse(JSON.stringify(h.inst)) : null),
  getAllBots: () => (h.inst ? [JSON.parse(JSON.stringify(h.inst))] : []),
  isBotBusy: () => h.lock,
  databaseHoldRefusal: (_id: string, action: string) => (h.hold ? { success: false, error: `A database restore is running on this instance's database; ${action} is refused until it ends` } : null),
  deleteLaneRefusal: (_id: string, action: string) => (h.deleteLane ? { success: false, error: `A Delete of this instance did not finish, so its containers, image or compose may already be gone; ${action} is refused until Delete is run again` } : null),
  updateInstanceMaintenance: (_id: string, rec: any) => {
    const n = h.writes.length + 1;
    const err = h.failWrite(n, rec);
    if (err) throw new Error(err);
    h.writes.push(rec ? JSON.parse(JSON.stringify(rec)) : null);
    if (rec) h.inst.maintenance = JSON.parse(JSON.stringify(rec));
    else delete h.inst.maintenance;
  },
  withExternalBotOp: async (_id: string, op: string, fn: () => Promise<unknown>) => {
    if (h.lock) throw new Error(`Operation '${h.lock}' is already in progress for this bot`);
    h.lock = op;
    try { return await fn(); } finally { h.lock = null; }
  },
  appContainerRunning: async () => h.app,
  startBotInOp: async (_id: string, op: string) => {
    crash('start');
    h.events.push(`start:${op}`);
    if (h.start.success) h.app = h.appAfterStart;
    return h.start;
  },
  stopBotInOp: async (_id: string, op: string) => {
    crash('stop');
    h.events.push(`stop:${op}`);
    if (h.stop.success) { h.app = false; h.sidecar = false; }
    return h.stop;
  },
  startFleetDbSidecar: async () => {
    crash('db-up');
    h.dbUpCalls++;
    h.events.push('db-up');
    if (h.dbUp.success) h.sidecar = true;
    return h.dbUp;
  },
}));

vi.mock('../../src/instance/dbLogin', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/dbLogin')>()),
  sidecarRunning: async () => h.sidecar,
  ensureManagerDbRole: async () => { h.events.push('ensure'); return h.ensure; },
  readBotLogin: async () => (h.readFail ? { ok: false, cls: 'other', error: h.readFail } : { ok: true, login: { ...h.db } }),
  readWriteFence: async () => { h.events.push('read-fence'); return typeof h.ro === 'function' ? h.ro() : h.ro; },
  blockBotLogin: async () => {
    crash('block');
    h.events.push('block');
    if (h.block.ok) h.db.canLogin = h.readOpenAfterBlock ? true : false;
    return h.block;
  },
  endBotSessions: async () => {
    crash('end-sessions');
    h.events.push('end-sessions');
    if (h.end.ok) h.db.sessions = 0;
    return h.end;
  },
  openBotLogin: async () => {
    crash('open');
    h.events.push('open');
    if (h.open.ok) h.db.canLogin = true;
    return h.open;
  },
}));

vi.mock('../../src/instance/appHookClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/appHookClient')>()),
  callAppHook: async (_inst: any, action: string, method: string, body: any, timeout: number) => {
    crash('hook');
    h.events.push(`hook:${body.state}`);
    h.hookBodies.push({ action, method, body, timeout });
    return h.hook(body);
  },
}));

import { runMaintenanceOrder, orderMaintenance, resetMaintenanceState, MAINTENANCE_TIMING } from '../../src/instance/maintenance';

const SMDB = 'https://github.com/x/fully-modular-discord-bot';
const fleetDb = { containerName: 'b1-fleet-postgres', user: 'smdb', db: 'smdb', volume: 'v' };
const settled = (state: string, over: Record<string, unknown> = {}) => ({ state, message: 'old', orderedAt: '2026-10-01T00:00:00.000Z', settled: true, hook: 'confirmed', login: 'blocked', savedByBot: state === 'running' ? 'running' : 'maintenance', ...over });

type Kind = 'database' | 'copy' | 'external' | 'json' | 'none';
function setup(kind: Kind, maintenance?: any): void {
  const base: any = { id: 'b1', displayName: 'B1', sourceUrl: SMDB, envVars: {}, createdAt: '2026-10-01T00:00:00.000Z', status: 'running' };
  let vars: Record<string, string> = { DATA_BACKEND: 'postgres' };
  if (kind === 'database') base.fleetDb = { ...fleetDb };
  if (kind === 'copy') { base.fleetDbReplica = { containerName: 'b1-replica' }; vars = { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: 'postgresql://u:p@main.example.test:15432/smdb' }; }
  if (kind === 'external') vars = { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: 'postgresql://u:p@db.elsewhere.test:5432/smdb' };
  if (kind === 'json') vars = {};
  if (kind === 'none') { base.sourceUrl = 'https://github.com/x/plain-bot'; vars = {}; }
  if (maintenance) base.maintenance = maintenance;
  h.inst = base;
  h.env = { vars, undecryptable: [], encrypted: [], corrupt: false };
}

const HOOK = (restarting?: unknown) => () => ({ ok: true, status: 200, body: restarting === undefined ? { success: true, state: 'running' } : { success: true, state: 'running', restarting } });
const NOTICE = { file: 'old.dump', text: 'Restore of old.dump has not finished: ...' };
const R13 = 'A restore of old.dump has not finished cleanly (its notice is on the Database window), so Running was refused and nothing was changed; restore a dump again, or dismiss the notice to choose Running anyway';

const H_TRUE = ' It restarts itself once it has saved what it holds (a change the database refuses for its content is dropped at that restart), then loads its data again.';
const RESTORE_OWNER = 'restore:1793181600000';
const RESEED_OWNER = 'reseed:1793181600000';
const R13_FENCE = "The bot's database is READ-ONLY under a write fence of a restore (started 2026-10-28 10:00 UTC), so Running was refused and nothing was changed; with the bot in Maintenance or Off, run a restore again to lift the fence";
const R13_RESEED = "The bot's database is READ-ONLY under a write fence of a re-seed (started 2026-10-28 10:00 UTC), so Running was refused and nothing was changed; retrying the re-seed retries the lift";
const R13_NO_OWNER = "The bot's database is READ-ONLY, and this manager cannot tell which step left it so. Running was refused and nothing was changed";
const R13_RESTART = "The bot's database is READ-ONLY, and this manager cannot tell which step left it so. Running was refused and nothing was changed; its read-only setting is not saved in the database's configuration, so restarting the instance clears it";
const FENCE_RUNNING = "Running is not confirmed: the bot's login could not be restored, because its database is READ-ONLY and this manager cannot tell which step left it so. Choose Running again once the database is writable.";
const FENCE_RUNNING_RESEED = "Running is not confirmed: the bot's database is READ-ONLY under a write fence of a re-seed (started 2026-10-28 10:00 UTC), so its login could not be restored. Retry the re-seed, then choose Running.";
const H_FALSE = ' It answered that it does not restart (it was not in maintenance by its own record, or no bot process runs). If a restore ran while it was in maintenance, restart the bot so it loads the restored data.';
const H_NULL = " Whether it restarts is not confirmed (it answered that it can't confirm, or did not say). If a restore ran while it was in maintenance, restart the bot so it loads the restored data.";
const RUN_OK = 'The bot is running normally: its database login is restored, and it took the order to leave maintenance.';
const RUN_STARTED = 'The bot is running normally: it started, its database login is restored, and it took the order to leave maintenance.';

beforeEach(() => {
  resetMaintenanceState();
  MAINTENANCE_TIMING.hookWaitMs = 30;
  MAINTENANCE_TIMING.hookWaitPauseMs = 1;
  MAINTENANCE_TIMING.hookWaitTryMs = 10;
  h.lock = null; h.hold = false; h.deleteLane = false; h.app = true; h.appAfterStart = true; h.sidecar = true;
  h.db = { inRecovery: false, canLogin: false, sessions: 0 }; h.readFail = null; h.readOpenAfterBlock = false;
  h.dbUp = { success: true }; h.dbUpCalls = 0; h.ensure = { ok: true }; h.block = { ok: true }; h.end = { ok: true }; h.open = { ok: true };
  h.hook = HOOK(true); h.hookBodies = []; h.start = { success: true }; h.stop = { success: true };
  h.events = []; h.writes = []; h.failWrite = () => null; h.crashAt = null; h.ro = { ok: true, on: false };
  setup('database', settled('maintenance'));
});

const order = (to: string) => runMaintenanceOrder('b1', to as any, '');
const admit = async (to: string): Promise<{ admission: any; result: any }> => {
  let result: any = null;
  let done: () => void = () => {};
  const finished = new Promise<void>(r => { done = r; });
  const admission = await orderMaintenance('b1', to as any, '', r => { result = r; done(); });
  if (admission.accepted) await finished;
  return { admission, result };
};

describe('Z the Running gate while a restore notice stands (R13)', () => {
  it('Z1 order Running with a notice: 409 R13, record unchanged', async () => {
    h.inst.fleetRestoreError = NOTICE;
    const before = JSON.stringify(h.inst.maintenance);
    const { admission } = await admit('running');
    expect(admission).toEqual({ accepted: false, status: 409, error: R13 });
    expect(JSON.stringify(h.inst.maintenance)).toBe(before);
    expect(h.writes).toEqual([]);
    expect(h.events).toEqual([]);
  });

  it('Z2 order Running without a notice: NM1 as before', async () => {
    const { admission, result } = await admit('running');
    expect(admission).toEqual({ accepted: true });
    expect(result.settled).toBe(true);
  });

  it.each(['maintenance', 'off'])('Z3 order %s with a notice is not refused', async (to) => {
    h.inst.fleetRestoreError = NOTICE;
    const { admission } = await admit(to);
    expect(admission).toEqual({ accepted: true });
  });

  it('Z4 a retry of an unsettled Running record is not refused', async () => {
    h.inst.fleetRestoreError = NOTICE;
    h.inst.maintenance = { ...settled('running'), settled: false, login: 'unconfirmed', hook: 'unconfirmed' };
    const r = await runMaintenanceOrder('b1', 'running', '', { retry: true });
    expect(r.text).not.toBe(R13);
    expect(h.events).toContain('open');
  });
});

describe('M leaving maintenance: the bot answers whether it restarts (D14)', () => {
  const rows: Array<[string, () => any, string]> = [
    ['M4 restarting true', HOOK(true), RUN_OK + H_TRUE],
    ['M5 restarting false', HOOK(false), RUN_OK + H_FALSE],
    ['M6a restarting null', HOOK(null), RUN_OK + H_NULL],
    ['M6b no restarting key', HOOK(undefined), RUN_OK + H_NULL],
    ["M6c restarting 'yes'", HOOK('yes'), RUN_OK + H_NULL],
  ];
  it.each(rows)('%s', async (_name, hook, text) => {
    h.hook = hook;
    const r = await order('running');
    expect(r).toEqual({ settled: true, text });
  });

  it('M7 no answer: NM1 text unchanged, no H clause', async () => {
    h.hook = () => ({ ok: false, unknown: true, error: 'maintenance sent, no answer within 30 s' });
    const r = await order('running');
    expect(r).toEqual({ settled: false, text: 'Running is not confirmed: its database login is restored, but the bot did not confirm it left maintenance (no answer within 30 seconds); it keeps answering with the maintenance message until it does. The manager sends the order again every 30 seconds while the bot runs.' });
  });

  it('M8 from Off: started, confirmed with restarting true', async () => {
    setup('database', settled('off'));
    h.app = false;
    const r = await order('running');
    expect(h.events).toContain('start:maintenance');
    expect(r).toEqual({ settled: true, text: RUN_STARTED + H_TRUE });
  });

  it('M-MAINT an order to Maintenance whose answer holds restarting gets no H clause', async () => {
    setup('database', settled('running'));
    h.db = { inRecovery: false, canLogin: true, sessions: 1 };
    h.hook = () => ({ ok: true, status: 200, body: { success: true, state: 'maintenance', restarting: true } });
    const r = await order('maintenance');
    expect(r).toEqual({ settled: true, text: 'Maintenance is on: the bot took the message, and its database login is blocked with no session open.' });
  });
});

describe('NM4 round 1 fixes', () => {
  it('N1: Running is refused while a live read shows the read-only layer on', async () => {
    h.ro = { ok: true, on: true, owner: RESTORE_OWNER, persisted: true };
    const before = JSON.stringify(h.inst.maintenance);
    const { admission } = await admit('running');
    expect(admission).toEqual({ accepted: false, status: 409, error: R13_FENCE });
    expect(JSON.stringify(h.inst.maintenance)).toBe(before);
    expect(h.writes).toEqual([]);
    expect(h.events).toEqual(['read-fence']);
  });

  it('N1: a read of the layer that fails does not refuse; the open step then names the fence', async () => {
    h.ro = { ok: false, cls: 'other', error: 'docker did not answer' };
    h.open = { ok: false, cls: 'write-fence', error: 'ERROR:  cannot execute ALTER ROLE in a read-only transaction' };
    const r = await order('running');
    expect(r).toEqual({ settled: false, text: FENCE_RUNNING });
  });

  it('N1: Maintenance and Off do not read the layer', async () => {
    h.ro = { ok: true, on: true };
    expect((await admit('maintenance')).admission).toEqual({ accepted: true });
    expect(h.events).not.toContain('read-fence');
  });

  it('R2: the Running refusal takes its remedy from the owner of the read-only layer', async () => {
    h.ro = { ok: true, on: true, owner: RESEED_OWNER, persisted: true };
    expect((await admit('running')).admission).toEqual({ accepted: false, status: 409, error: R13_RESEED });
    h.ro = { ok: true, on: true, owner: null, persisted: true };
    expect((await admit('running')).admission).toEqual({ accepted: false, status: 409, error: R13_NO_OWNER });
    h.ro = { ok: true, on: true, owner: null, persisted: false };
    expect((await admit('running')).admission).toEqual({ accepted: false, status: 409, error: R13_RESTART });
    expect(h.writes).toEqual([]);
  });

  it('R2: a Running order stopped at the open by the layer names the owner read after the failure', async () => {
    const reads: any[] = [{ ok: true, on: false }, { ok: true, on: true, owner: RESEED_OWNER, persisted: true }];
    h.ro = () => reads.shift();
    h.open = { ok: false, cls: 'write-fence', error: 'ERROR:  cannot execute ALTER ROLE in a read-only transaction' };
    const r = await order('running');
    expect(r).toEqual({ settled: false, text: FENCE_RUNNING_RESEED });
    expect(h.events.filter(e => e === 'read-fence')).toHaveLength(2);
  });

  for (const [name, read, remedy] of [
    ['a restore', { owner: RESTORE_OWNER, persisted: true }, 'With the bot in Maintenance or Off, run a restore again to lift the fence'],
    ['a re-seed', { owner: RESEED_OWNER, persisted: true }, 'Retry the re-seed'],
    ['a decommission', { owner: 'decommission:1793181600000', persisted: true }, 'Run the decommission again'],
    ['an unsaved setting', { owner: null, persisted: false }, 'Restart the instance'],
  ] as const) {
    it(`S2: the Running text after a layer of ${name} reads as one sentence ending with choosing Running`, async () => {
      const reads: any[] = [{ ok: true, on: false }, { ok: true, on: true, ...read }];
      h.ro = () => reads.shift();
      h.open = { ok: false, cls: 'write-fence', error: 'ERROR:  cannot execute ALTER ROLE in a read-only transaction' };
      const r: any = await order('running');
      expect(r.text.endsWith(` ${remedy}, then choose Running.`)).toBe(true);
    });
  }

  it('N4: a notice on a bot with no database record does not refuse Running', async () => {
    setup('json', settled('off'));
    h.app = false;
    h.inst.fleetRestoreError = NOTICE;
    const { admission } = await admit('running');
    expect(admission).toEqual({ accepted: true });
  });
});
