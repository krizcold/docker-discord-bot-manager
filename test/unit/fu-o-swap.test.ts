import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

// The receiver's cancel and the sender's abandon route, with a fake docker, a fake control lane and bots in memory.
const st = vi.hoisted(() => ({
  bots: [] as any[],
  posted: [] as string[],
  answer: 'ok' as 'ok' | 'refused' | 'noSwap' | 'unreachable',
  saved: [] as Array<{ id: string; record: unknown }>,
  // The sender's fence read: the layers line fenceLayers parses, or null when docker fails it.
  fence: 'on|2|swap:5|swap:5' as string | null,
  order: [] as string[],
  timeouts: [] as number[],
}));

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const execFile = (_cmd: string, args: string[], _opts: any, cb: (err: any, stdout: string, stderr: string) => void) => {
    const sql = args.join(' ');
    if (args[0] === 'stop') st.order.push('stop');
    if (args[0] === 'exec' && sql.includes("pg_read_file('smdb-fence-owner', true)") && sql.includes('regexp_split_to_table')) {
      const fence = st.fence;
      setImmediate(() => fence === null ? cb(new Error('down'), '', 'Error response from daemon: container is not running') : cb(null, `${fence}\n`, ''));
      return { stdin: null };
    }
    setImmediate(() => cb(null, '', ''));
    return { stdin: null };
  };
  return { ...real, execFile };
});
vi.mock('../../src/docker/containerManager', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/docker/containerManager')>();
  return {
    ...real,
    getAllBots: () => st.bots,
    getBot: (id: string) => st.bots.find(b => b.id === id) ?? null,
    releaseFleetDbFromLane: () => { st.order.push('release'); return { success: true }; },
    updateInstanceRecoveryRescue: (id: string, rec: any) => {
      const b = st.bots.find(x => x.id === id);
      if (b) b.recoveryRescue = rec ?? undefined;
    },
    updateInstanceRecoverySwapAbandoned: (id: string, record: unknown) => {
      st.saved.push({ id, record });
      const b = st.bots.find(x => x.id === id);
      if (b) b.recoverySwapAbandoned = record ?? undefined;
    },
    broadcastBotUpdated: () => {},
  };
});

import * as rescue from '../../src/instance/recoveryRescue';
import { handleRecoveryControl } from '../../src/instance/recoveryControl';
import * as containerManager from '../../src/docker/containerManager';

const fleetDb = { containerName: 'bot1-db', user: 'u', db: 'd', volume: 'bot1-vol' };

let seq = 0;
function receiver(phase: string): any {
  return {
    id: `r${++seq}`, sanitizedName: `r${seq}`, displayName: 'Bot 1', status: 'stopped', sourceUrl: 'x', fleetDb,
    recoveryChannel: { mode: 'receiver', containerName: 'bot1-recovery-relay', token: 't', createdAt: 1, tunnelPort: 15433, publicHost: 'h', tlsKey: 'k', tlsCert: 'c' },
    recoveryRescue: { startedAt: 1, updatedAt: 1, phase, parked: true, passStartedAt: 5, identity: { source: { systemId: '7001', timeline: 3, checkpointLsn: '0/5', storeId: 'S1' }, acked: [] } },
  };
}

beforeEach(() => {
  st.bots = [];
  st.posted = [];
  st.answer = 'ok';
  st.saved = [];
  st.fence = 'on|2|swap:5|swap:5';
  st.order = [];
  st.timeouts = [];
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => { st.timeouts.push(ms); return timeout(ms); });
  vi.stubGlobal('fetch', async (url: string, init?: { method?: string }) => {
    const action = String(url).split('/control/')[1] || '';
    st.posted.push(`${init?.method ?? 'GET'} ${action}`);
    st.order.push(`post ${action.split('?')[0]}`);
    if (st.answer === 'unreachable') throw new Error('connect ECONNREFUSED');
    if (st.answer === 'refused') return new Response(JSON.stringify({ success: false, error: 'no armed source channel matches that token' }), { status: 403 });
    if (st.answer === 'noSwap') return new Response(JSON.stringify({ success: false, noSwap: true, error: 'this source holds no swap record, so there is no swap to mark cancelled' }), { status: 409 });
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('FU-O row 9: a swap cancelled at quiesce or catchup tells the sender', () => {
  for (const phase of ['quiesce', 'catchup']) {
    it(`a cancel at ${phase} posts abandon with its phase`, async () => {
      st.bots = [receiver(phase)];
      const r = await rescue.cancelRescue(st.bots[0]);
      expect(r.success).toBe(true);
      expect(st.posted).toEqual([`POST abandon?phase=${phase}`]);
      expect(r.note).not.toMatch(/The sender was not told/);
    });
  }

  for (const phase of ['preflight', 'standby']) {
    it(`a cancel at ${phase} posts nothing`, async () => {
      st.bots = [receiver(phase)];
      const r = await rescue.cancelRescue(st.bots[0]);
      expect(r.success).toBe(true);
      expect(st.posted).toEqual([]);
      expect(r.note).not.toMatch(/The sender was not told/);
    });
  }

  it('an unreachable or refusing sender is named in the cancel note', async () => {
    st.answer = 'unreachable';
    st.bots = [receiver('quiesce')];
    const unreachable = await rescue.cancelRescue(st.bots[0]);
    expect(unreachable.success).toBe(true);
    expect(unreachable.note).toMatch(/The sender was not told; on the sender machine, disarm the channel and clear the swap record before starting it\.$/);
    st.answer = 'refused';
    st.bots = [receiver('catchup')];
    expect((await rescue.cancelRescue(st.bots[0])).note).toMatch(/The sender was not told/);
  });

  it('a sender that holds no swap record was never stopped or fenced, so the note does not ask the operator to disarm it', async () => {
    st.answer = 'noSwap';
    st.bots = [receiver('quiesce')];
    const r = await rescue.cancelRescue(st.bots[0]);
    expect(r.success).toBe(true);
    expect(st.posted).toEqual(['POST abandon?phase=quiesce']);
    expect(r.note).not.toMatch(/The sender was not told/);
  });

  it('the sender is told after the copy is stopped and the lane released, with a short wait', async () => {
    st.bots = [receiver('catchup')];
    await rescue.cancelRescue(st.bots[0]);
    expect(st.order).toEqual(['stop', 'release', 'post abandon']);
    expect(st.timeouts).toEqual([15_000]);
  });
});

async function call(action: string, token: string): Promise<{ code: number; body: any }> {
  let code = 0;
  let text = '';
  const req: any = { url: `/control/${action}`, headers: { 'x-recovery-token': token } };
  const res: any = { writeHead: (c: number) => { code = c; }, end: (t: string) => { text = t; } };
  await handleRecoveryControl(req, res);
  return { code, body: JSON.parse(text) };
}

const source = (extra: Record<string, unknown> = {}) => ({
  id: 's1', sanitizedName: 's1', displayName: 'Source', status: 'stopped', fleetDb,
  recoveryChannel: { mode: 'source', containerName: 's1-recovery-relay', token: 'tok', createdAt: 1 },
  recoverySwappedAway: { at: Date.UTC(2026, 9, 25, 9, 0) },
  ...extra,
});

describe('FU-O row 10: the sender records an abandoned swap', () => {
  it('saves the phase and the time with the right token', async () => {
    st.bots = [source()];
    const r = await call('abandon?phase=catchup', 'tok');
    expect(r.code).toBe(200);
    expect(st.saved).toHaveLength(1);
    expect(st.saved[0]).toMatchObject({ id: 's1', record: { phase: 'catchup', fenced: true } });
    expect(st.bots[0].recoverySwapAbandoned.at).toBeGreaterThan(0);
  });

  it('saves whether a fence stood: off when both layers read off, unknown when the read failed', async () => {
    st.fence = 'off|0||';
    st.bots = [source()];
    expect((await call('abandon?phase=quiesce', 'tok')).code).toBe(200);
    st.fence = null;
    st.bots = [source()];
    expect((await call('abandon?phase=quiesce', 'tok')).code).toBe(200);
    expect(st.saved.map(x => (x.record as { fenced: unknown }).fenced)).toEqual([false, null]);
  });

  it('a source with no swap record answers noSwap', async () => {
    st.bots = [source({ recoverySwappedAway: undefined })];
    const r = await call('abandon?phase=quiesce', 'tok');
    expect(r.code).toBe(409);
    expect(r.body.noSwap).toBe(true);
  });

  it('a quiesce still running on the source refuses the abandon without noSwap and saves nothing', async () => {
    st.bots = [source()];
    let release!: () => void;
    const held = containerManager.withExternalBotOp('s1', 'quiesce', () => new Promise<void>(resolve => { release = resolve; }));
    try {
      const r = await call('abandon?phase=quiesce', 'tok');
      expect(r.code).toBe(409);
      expect(r.body.noSwap).toBeUndefined();
      expect(r.body.error).toMatch(/quiesce is still running/);
      expect(st.saved).toEqual([]);
    } finally {
      release();
      await held;
    }
  });

  it('a wrong token gets 403 and saves nothing', async () => {
    st.bots = [source()];
    const r = await call('abandon?phase=quiesce', 'nope');
    expect(r.code).toBe(403);
    expect(st.saved).toEqual([]);
  });

  it('a source with no swap record, or no named phase, saves nothing', async () => {
    st.bots = [source({ recoverySwappedAway: undefined })];
    expect((await call('abandon?phase=quiesce', 'tok')).code).toBe(409);
    st.bots = [source()];
    expect((await call('abandon', 'tok')).code).toBe(400);
    expect(st.saved).toEqual([]);
  });

  it('the card shows a Swap cancelled badge and the Database modal says what to do', () => {
    const pageHtml = fs.readFileSync(path.resolve(__dirname, '../../src/webui/public/index.html'), 'utf8');
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
    const modal = (fenced: boolean | null) => vm.runInContext('swappedAwayHtml', ctx)(source({ recoverySwapAbandoned: { at: Date.UTC(2026, 9, 25, 9, 30), phase: 'catchup', fenced } })) as string;
    const cancelled = 'The receiving machine cancelled this swap on 2026-10-25 at the catch-up step, before it promoted its copy.';
    expect(modal(true)).toContain(`${cancelled} This database was still fenced when the cancel arrived: Disarm the recovery channel below (it lifts the layers the swap set and names any layer another lane holds), then clear the swap record and start the instance.`);
    expect(modal(false)).toContain(`${cancelled} This database was not fenced when the cancel arrived: clear the swap record, then start the instance.`);
    expect(modal(false)).not.toMatch(/still fenced|Disarm/);
    expect(modal(null)).toContain(`${cancelled} Whether this database is still fenced could not be confirmed`);
    expect(vm.runInContext('swappedAwayHtml', ctx)(source())).not.toContain('cancelled this swap');
    const badge = pageHtml.slice(pageHtml.indexOf('const fenceBadge = '), pageHtml.indexOf('// Replication health'));
    expect(badge).toMatch(/bot\.recoverySwappedAway && bot\.recoverySwapAbandoned[\s\S]*Swap cancelled/);
  });
});
