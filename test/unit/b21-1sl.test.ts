import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as nodeFs from 'fs';
import * as nodePath from 'path';
import * as vm from 'vm';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b21-1sl-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = path.join(dir, 'DATA');
  return { dir };
});

// The sender's database as postgres keeps it (the fu-l fake): the live read-only value, the owner file and the owner
// each fence line names. resetFails makes the read-only reset fail, stripFails the volume strip that follows it.
type Db = { readOnly: boolean; ownerFile: string | null; lines: string[] };
const pg = vi.hoisted(() => ({
  db: { readOnly: false, ownerFile: null, lines: [] } as { readOnly: boolean; ownerFile: string | null; lines: string[] },
  events: [] as string[],
  resetFails: false,
  stripFails: false,
  live: [] as string[],
}));

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const HBA = '/var/lib/postgresql/data/pg_hba.conf';
  const owners = (d: { lines: string[] }) => Array.from(new Set(d.lines.map(o => o || '-'))).join(',');
  const execFile = (_cmd: string, args: string[], optsOrCb: unknown, maybeCb?: unknown) => {
    const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as (err: Error | null, stdout: string, stderr: string) => void;
    const ok = (out = '') => setImmediate(() => cb(null, out, ''));
    const no = (err: string) => setImmediate(() => cb(new Error(err), '', err));
    const d = pg.db;
    const sql = args.join(' ');
    if (args[0] === 'inspect') return ok('true\n');
    if (args[0] === 'volume') return ok('[]');
    if (args[0] === 'rm') { pg.events.push('rm'); return ok(); }
    if (args[0] === 'run') { pg.events.push('strip'); return pg.stripFails ? no('docker: Error response from daemon: no space left on device') : ok(); }
    if (args[0] === 'stop') { pg.events.push(`stop:${args[1]}`); return ok(); }
    if (args[0] !== 'exec') return ok();
    if (args[1] === '-u' && args[2] === 'root') {
      const script = args[args.length - 1];
      if (script.includes('grep -qx')) {
        const pattern = new RegExp(`^${/grep -qx '([^']*)'/.exec(script)![1].replace('[0-9][0-9]*', '[0-9]+')}$`);
        if (d.ownerFile !== null && pattern.test(d.ownerFile)) d.ownerFile = null;
        return ok();
      }
      if (script.includes('held-hba')) {
        pg.events.push('hba-lift');
        if (d.lines.length === 0) return ok();
        const pattern = /grep -v '# smdb-fence-owner=([^ ]*) # smdb-write-fence\$'/.exec(script)![1];
        const re = new RegExp(`^${pattern.replace('[0-9][0-9]*', '[0-9]+')}$`);
        if (d.lines.every(o => re.test(o))) { d.lines = []; return ok('stripped-hba\n'); }
        return ok(`held-hba ${d.lines.find(o => o) ?? ''}\n`);
      }
      const ownerWrite = /smdb-fence-owner; printf '%s' '([^']*)'/.exec(script);
      if (ownerWrite) { d.ownerFile = ownerWrite[1]; return ok(); }
      const lineOwner = /smdb-fence-owner=([a-z]+:[0-9]+) # smdb-write-fence/.exec(script);
      if (lineOwner) { pg.events.push('fence'); d.lines = [lineOwner[1], lineOwner[1]]; return ok(); }
      return ok();
    }
    if (args.includes('127.0.0.1')) return no('psql: error: FATAL:  pg_hba.conf rejects connection for host "127.0.0.1"');
    if (sql.includes('SELECT system_identifier FROM pg_control_system()')) return ok('7001\n');
    if (sql.includes("current_setting('hba_file') ||")) return ok(`${HBA}|on|0|0|${d.readOnly ? 'on' : 'off'}|${d.ownerFile ?? ''}|${d.lines.length}|${owners(d)}\n`);
    if (sql.includes("pg_read_file('smdb-fence-owner', true)") && !sql.includes('regexp_split_to_table')) return ok(`${d.readOnly ? 'on' : 'off'}|${d.ownerFile ?? ''}\n`);
    if (sql.includes("pg_read_file('smdb-fence-owner', true)")) return ok(`${d.readOnly ? 'on' : 'off'}|${d.lines.length}|${d.ownerFile ?? ''}|${owners(d)}\n`);
    if (sql.includes('ALTER SYSTEM SET default_transaction_read_only = on')) { d.readOnly = true; return ok(); }
    if (sql.includes('ALTER SYSTEM RESET default_transaction_read_only')) {
      if (pg.resetFails) return no('ERROR:  could not write auto.conf: No space left on device');
      pg.events.push('reset');
      d.readOnly = false;
      return ok();
    }
    if (sql.includes('SELECT pg_current_wal_lsn()')) return ok('0/3000000\n');
    if (sql.includes("to_regclass('smdb_control.term')")) return ok('t|t\n');
    if (sql.includes('SELECT coalesce(GREATEST(')) return ok('41\n');
    return ok();
  };
  return { ...real, execFile, default: { ...real, execFile } };
});
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));
vi.mock('../../src/docker/containerManager', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/docker/containerManager')>();
  return {
    ...real,
    runningNonSidecarContainers: async () => pg.live,
    stopBotInOp: async () => { pg.events.push('stop-bot'); pg.live = []; return { success: true }; },
    startFleetDbSidecar: async () => { pg.events.push('sidecar-up'); return { success: true }; },
    startBot: async () => { pg.events.push('start-bot'); return { success: true }; },
  };
});

const REGISTRY = nodePath.join(tmp.dir, 'instances.json');
const fleetDb = { containerName: 'src1-db', user: 'u', db: 'd', volume: 'src1-vol' };
const channel = { mode: 'source', containerName: 'src1-recovery-dialer', token: 'tok', createdAt: 1, endpointHost: 'h', endpointPort: 15433, pinCert: 'c' };
const SWAP_AT = Date.UTC(2026, 9, 25, 9, 0);
const SWAP = `swap:${SWAP_AT}`;
const onDisk = () => JSON.parse(nodeFs.readFileSync(REGISTRY, 'utf-8')).instances.s1;

function seedRegistry(extra: Record<string, unknown> = {}): void {
  nodeFs.writeFileSync(REGISTRY, JSON.stringify({ instances: { s1: {
    id: 's1', displayName: 'Source 1', sanitizedName: 'src1', status: 'stopped', fleetDb,
    fleetBackup: { enabled: false, hour: 4, keep: 7 }, recoveryChannel: channel, ...extra,
  } } }, null, 2));
}

async function modules() {
  vi.resetModules();
  const cm = await import('../../src/docker/containerManager');
  const guards = await import('../../src/instance/fleetBackupGuards');
  const control = await import('../../src/instance/recoveryControl');
  return { cm, guards, control };
}

async function call(control: typeof import('../../src/instance/recoveryControl'), action: string): Promise<{ code: number; body: any }> {
  let code = 0;
  let text = '';
  await control.handleRecoveryControl({ url: `/control/${action}`, headers: { 'x-recovery-token': 'tok' } } as any, {
    writeHead: (c: number) => { code = c; },
    end: (t: string) => { text = t; },
  } as any);
  return { code, body: JSON.parse(text) };
}

const fencedBySwap = (): Db => ({ readOnly: true, ownerFile: SWAP, lines: [SWAP, SWAP] });

beforeEach(() => {
  pg.db = { readOnly: false, ownerFile: null, lines: [] };
  pg.events = [];
  pg.resetFails = false;
  pg.stripFails = false;
  pg.live = [];
});
afterAll(() => { nodeFs.rmSync(tmp.dir, { recursive: true, force: true }); });

describe('B21-1s row 1: a cancel at quiesce or catchup lifts the swap\'s own fence on the sender', () => {
  it('an abandon at catchup after a real quiesce lifts the fence, clears the swap record, releases the slot and keeps the channel armed and the bot stopped', async () => {
    seedRegistry();
    pg.live = ['src1-app'];
    const { cm, guards, control } = await modules();
    const q = await call(control, 'quiesce?systemId=7001');
    expect(q.code).toBe(200);
    expect(pg.db.readOnly).toBe(true);
    expect(pg.db.lines.length).toBe(2);
    expect(control.holdsQuiesceSlot('s1')).toBe(true);
    pg.events = [];
    const r = await call(control, 'abandon?phase=catchup');
    expect(r.code).toBe(200);
    expect(r.body).toEqual({ success: true, cleared: true, left: null });
    expect(pg.db).toEqual({ readOnly: false, ownerFile: null, lines: [] });
    const stored = onDisk();
    expect(stored.recoverySwappedAway).toBeUndefined();
    expect(stored.recoverySwapAbandoned).toMatchObject({ phase: 'catchup', cleared: true, left: null });
    expect(stored.recoveryChannel).toMatchObject({ containerName: channel.containerName });
    expect(cm.getBot('s1')!.recoveryChannel!.token).toBe('tok');
    expect(stored.recoveryChannel.disarmingAt).toBeUndefined();
    expect(pg.events).not.toContain('rm');
    expect(pg.events).not.toContain('start-bot');
    expect(control.holdsQuiesceSlot('s1')).toBe(false);
    expect(guards.isFleetBackupBusy('s1')).toBe(false);
    expect(cm.getBot('s1')!.recoverySwappedAway).toBeUndefined();
  });

  it('an abandon at quiesce with no quiesce slot held (a restarted manager) claims the backup slot for the lift and releases it', async () => {
    seedRegistry({ recoverySwappedAway: { at: SWAP_AT } });
    pg.db = fencedBySwap();
    const { guards, control } = await modules();
    const r = await call(control, 'abandon?phase=quiesce');
    expect(r.code).toBe(200);
    expect(r.body).toMatchObject({ success: true, cleared: true, left: null });
    expect(pg.db).toEqual({ readOnly: false, ownerFile: null, lines: [] });
    expect(onDisk().recoverySwappedAway).toBeUndefined();
    expect(guards.isFleetBackupBusy('s1')).toBe(false);
  });

  it('another operation holding the backup slot refuses the abandon and changes nothing', async () => {
    seedRegistry({ recoverySwappedAway: { at: SWAP_AT } });
    pg.db = fencedBySwap();
    const { guards, control } = await modules();
    expect(guards.claimFleetBackupBusy('s1')).toBe(true);
    const r = await call(control, 'abandon?phase=catchup');
    guards.releaseFleetBackupBusy('s1');
    expect(r.code).toBe(409);
    expect(r.body.success).toBe(false);
    expect(r.body.error).toBe('another database operation holds the backup slot of this source, so the cancel was refused and nothing was changed: the swap\'s write fence and the swap record stay');
    expect(pg.db).toEqual(fencedBySwap());
    expect(pg.events).toEqual([]);
    expect(onDisk().recoverySwappedAway).toEqual({ at: SWAP_AT });
    expect(onDisk().recoverySwapAbandoned).toBeUndefined();
  });

  it('a layer another lane owns stays on and is named, and the swap record still clears', async () => {
    seedRegistry({ recoverySwappedAway: { at: SWAP_AT } });
    pg.db = { readOnly: true, ownerFile: 'restore:7', lines: ['restore:7', 'restore:7'] };
    const { control } = await modules();
    const r = await call(control, 'abandon?phase=catchup');
    expect(r.code).toBe(200);
    expect(r.body.cleared).toBe(true);
    expect(r.body.left).toMatch(/^the database refuses every connection but the manager's and is READ-ONLY, so the bot cannot reach it: both layers of the write fence belong to a restore/);
    expect(pg.db).toEqual({ readOnly: true, ownerFile: 'restore:7', lines: ['restore:7', 'restore:7'] });
    expect(onDisk().recoverySwappedAway).toBeUndefined();
    expect(onDisk().recoverySwapAbandoned).toMatchObject({ cleared: true, left: r.body.left });
  });

  it('a lift that fails keeps the swap record and the quiesce slot, and says which layer may stay', async () => {
    seedRegistry();
    pg.live = ['src1-app'];
    const { control } = await modules();
    expect((await call(control, 'quiesce?systemId=7001')).code).toBe(200);
    pg.resetFails = true;
    pg.stripFails = true;
    const r = await call(control, 'abandon?phase=catchup');
    expect(r.code).toBe(200);
    expect(r.body.cleared).toBe(false);
    expect(r.body.left).toMatch(/^the write fence on src1-db could not be lifted \(docker: Error response from daemon: no space left on device\), so the database may stay READ-ONLY/);
    expect(pg.db.readOnly).toBe(true);
    const stored = onDisk();
    expect(stored.recoverySwappedAway).toBeDefined();
    expect(stored.recoverySwapAbandoned).toMatchObject({ phase: 'catchup', cleared: false, left: r.body.left });
    expect(control.holdsQuiesceSlot('s1')).toBe(true);
    control.releaseQuiesceSlot('s1');
  });

  it('a quiesce after the cancel starts a new swap and clears the cancelled one\'s notice', async () => {
    seedRegistry({ recoverySwappedAway: { at: SWAP_AT } });
    pg.db = fencedBySwap();
    const { control } = await modules();
    expect((await call(control, 'abandon?phase=quiesce')).code).toBe(200);
    expect(onDisk().recoverySwapAbandoned).toBeDefined();
    expect((await call(control, 'quiesce?systemId=7001')).code).toBe(200);
    expect(onDisk().recoverySwapAbandoned).toBeUndefined();
    expect(onDisk().recoverySwappedAway).toBeDefined();
    control.releaseQuiesceSlot('s1');
  });
});

describe('FU-Lq: a quiesce inside the teardown\'s disarm wait never runs without the backup slot', () => {
  it('a quiesce that arrives while the teardown\'s disarm is pending is refused and stops nothing', async () => {
    seedRegistry();
    pg.live = ['src1-app'];
    const { guards, control } = await modules();
    expect((await call(control, 'quiesce?systemId=7001')).code).toBe(200);
    expect((await call(control, 'teardown')).code).toBe(200);
    pg.events = [];
    pg.live = ['src1-app'];
    const again = await call(control, 'quiesce?systemId=7001');
    expect(again.code).toBe(409);
    expect(again.body.error).toBe('the source is tearing down the swap it handed away, so the quiesce was refused and nothing was stopped');
    expect(pg.events).toEqual([]);
    await new Promise(resolve => setTimeout(resolve, 2_600));
    expect(onDisk().recoveryChannel).toBeUndefined();
    expect(control.holdsQuiesceSlot('s1')).toBe(false);
    expect(guards.isFleetBackupBusy('s1')).toBe(false);
  }, 10_000);
});

describe('B21-1s row 2: the receiver repeats what the sender did', () => {
  const receiver = {
    id: 'r1', displayName: 'Bot 1', sanitizedName: 'r1', status: 'stopped', fleetDb: { ...fleetDb, containerName: 'r1-db' },
    fleetBackup: { enabled: false, hour: 4, keep: 7 },
    recoveryChannel: { mode: 'receiver', containerName: 'r1-recovery-relay', token: 't', createdAt: 1, tunnelPort: 15433, publicHost: 'h', tlsKey: 'k', tlsCert: 'c' },
    recoveryRescue: { startedAt: 1, updatedAt: 1, phase: 'catchup', parked: true, passStartedAt: 5, identity: { source: { systemId: '7001', timeline: 3, checkpointLsn: '0/5', storeId: 'S1' }, acked: [] } },
  };
  async function cancelWith(status: number, body: unknown): Promise<string> {
    nodeFs.writeFileSync(REGISTRY, JSON.stringify({ instances: { r1: receiver } }, null, 2));
    vi.resetModules();
    const cm = await import('../../src/docker/containerManager');
    const rescue = await import('../../src/instance/recoveryRescue');
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(body), { status }));
    try {
      const r = await rescue.cancelRescue(cm.getBot('r1')!);
      expect(r.success).toBe(true);
      return r.note!;
    } finally {
      vi.unstubAllGlobals();
    }
  }

  it('a sender that lifted its fence and cleared its record is repeated, without the disarm instruction', async () => {
    const note = await cancelWith(200, { success: true, cleared: true, left: null });
    expect(note).toMatch(/ No write fence this swap set stays on the sender's database, and its swap record is cleared; the cancel left its instance stopped until its operator starts it\.$/);
    expect(note).not.toMatch(/disarm the channel and clear the swap record/);
  });

  it('a layer another lane holds on the sender is named', async () => {
    const note = await cancelWith(200, { success: true, cleared: true, left: 'the database is READ-ONLY: the read-only layer of the write fence belongs to a restore' });
    expect(note).toMatch(/ No write fence this swap set stays on the sender's database, and its swap record is cleared, but on the sender the database is READ-ONLY: the read-only layer of the write fence belongs to a restore\. The cancel left its instance stopped until its operator starts it\.$/);
  });

  it('a sender that kept its swap record says why and that Disarm there lifts the fence', async () => {
    const note = await cancelWith(200, { success: true, cleared: false, left: 'the write fence on src1-db could not be lifted (x), so the database may stay READ-ONLY' });
    expect(note).toMatch(/ The sender kept its swap record, so Start stays refused there: the write fence on src1-db could not be lifted \(x\), so the database may stay READ-ONLY\. On the sender machine, disarm the channel \(it lifts the layers the swap set\), then clear the swap record before starting it\.$/);
  });

  it('a sender that does not answer within the wait is reported as unconfirmed, not as untold', async () => {
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    const spy = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => timeout(20));
    nodeFs.writeFileSync(REGISTRY, JSON.stringify({ instances: { r1: receiver } }, null, 2));
    vi.resetModules();
    const cm = await import('../../src/docker/containerManager');
    const rescue = await import('../../src/instance/recoveryRescue');
    vi.stubGlobal('fetch', (_url: string, init: { signal: AbortSignal }) => new Promise((_ok, fail) => {
      init.signal.addEventListener('abort', () => fail(init.signal.reason));
    }));
    try {
      const r = await rescue.cancelRescue(cm.getBot('r1')!);
      expect(r.success).toBe(true);
      expect(r.note).toMatch(/ The sender did not answer within 15 s, so whether it lifted its fence and cleared its swap record can't be confirmed; its Database modal shows what it did, and if its swap record still stands there, disarm the channel and clear the swap record before starting it.$/);
      expect(r.note).not.toMatch(/was not told/);
    } finally {
      vi.unstubAllGlobals();
      spy.mockRestore();
    }
  });

  it('a sender the call never reached is reported as not told', async () => {
    nodeFs.writeFileSync(REGISTRY, JSON.stringify({ instances: { r1: receiver } }, null, 2));
    vi.resetModules();
    const cm = await import('../../src/docker/containerManager');
    const rescue = await import('../../src/instance/recoveryRescue');
    vi.stubGlobal('fetch', async () => { throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED') }); });
    try {
      const r = await rescue.cancelRescue(cm.getBot('r1')!);
      expect(r.note).toMatch(/ The sender was not told; on the sender machine, disarm the channel and clear the swap record before starting it.$/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a sender that refused the cancel is named with its reason', async () => {
    const note = await cancelWith(409, { success: false, error: 'another database operation holds the backup slot of this source' });
    expect(note).toMatch(/ The sender did not complete the cancel \(another database operation holds the backup slot of this source\); on the sender machine, disarm the channel and clear the swap record before starting it\.$/);
  });

  it('the Database modal and the card say what the cancel lifted or left', () => {
    const pageHtml = nodeFs.readFileSync(nodePath.resolve(__dirname, '../../src/webui/public/index.html'), 'utf8');
    const fn = (name: string): string => {
      const start = pageHtml.indexOf(`function ${name}(`);
      let i = pageHtml.indexOf('{', start);
      for (let depth = 0; ; i++) {
        if (pageHtml[i] === '{') depth++;
        else if (pageHtml[i] === '}' && --depth === 0) return pageHtml.slice(start, i + 1);
      }
    };
    const ctx = vm.createContext({ escapeHtml: (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;') });
    vm.runInContext(`${fn('swapAbandonedText')}\n${fn('swappedAwayHtml')}`, ctx);
    const html = (bot: Record<string, unknown>) => vm.runInContext('swappedAwayHtml', ctx)({ id: 's1', ...bot }) as string;
    const abandoned = (extra: Record<string, unknown>) => ({ at: Date.UTC(2026, 9, 25, 9, 30), phase: 'catchup', ...extra });
    const cancelled = 'The receiving machine cancelled this swap on 2026-10-25 at the catch-up step, before it promoted its copy.';
    const lifted = html({ recoverySwapAbandoned: abandoned({ cleared: true, left: null }) });
    expect(lifted).toContain(`${cancelled} No write fence this swap set stays on the database, and the swap record is cleared. The cancel left the recovery channel armed and the instance stopped.`);
    expect(lifted).not.toMatch(/lifted the write fence|stays armed|stays stopped/);
    expect(lifted).toContain('dismissSwapAbandoned(\'s1\')');
    expect(lifted).not.toContain('Clear the swap record');
    const held = html({ recoverySwapAbandoned: abandoned({ cleared: true, left: 'the database is READ-ONLY: the read-only layer of the write fence belongs to a restore' }) });
    expect(held).toContain(`${cancelled} No write fence this swap set stays on the database, and the swap record is cleared, but the database is READ-ONLY: the read-only layer of the write fence belongs to a restore. The cancel left the recovery channel armed and the instance stopped.`);
    const kept = html({ recoverySwappedAway: { at: SWAP_AT }, recoverySwapAbandoned: abandoned({ cleared: false, left: 'the write fence on src1-db could not be lifted (x), so the database may stay READ-ONLY' }) });
    expect(kept).toContain(`${cancelled} The swap record stays, so Start is refused: the write fence on src1-db could not be lifted (x), so the database may stay READ-ONLY. Disarm the recovery channel below (it lifts the layers the swap set), then clear the swap record and start the instance.`);
    expect(kept).toContain('Clear the swap record');
    expect(html({})).toBe('');
  });
});
