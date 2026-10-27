import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

const st = vi.hoisted(() => ({
  broadcasts: [] as Array<{ type: string; data: any }>,
  lastError: null as string | null,
  fence: null as string | null,
  bots: [] as any[],
}));

vi.mock('../../src/docker/containerManager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/docker/containerManager')>()),
  registryFault: () => null,
  getBot: (id: string) => st.bots.find(b => b.id === id) ?? null,
  getAllBots: () => st.bots,
  isBotBusy: () => null,
  startPreflightRefusal: () => null,
  startBot: async () => ({ success: true }),
  stopBot: async () => ({ success: true }),
  restartBot: async () => ({ success: true }),
}));
vi.mock('../../src/instance/fleetBackup', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/instance/fleetBackup')>();
  return {
    ...real,
    fleetBackupStatus: (bot: any) => {
      const status = real.fleetBackupStatus(bot);
      return { ...status, main: status.main && { ...status.main, lastError: st.lastError } };
    },
    getFleetFenceStuck: () => st.fence,
    fleetBackupScopeState: () => true,
    listFleetBackups: () => [],
  };
});
vi.mock('../../src/webui/server', () => ({ broadcastToClients: (_w: unknown, type: string, data: any) => { st.broadcasts.push({ type, data }); } }));

import * as routes from '../../src/webui/routes/bots';

const router = routes.createBotRoutes({ clients: new Set() } as any);
const call = async (routePath: string): Promise<any> => {
  const layer = (router as any).stack.find((l: any) => l.route?.path === routePath && l.route.methods.post);
  const res: any = { statusCode: 200 };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  await layer.route.stack[layer.route.stack.length - 1].handle({ params: { id: 'b1' }, query: {}, body: {} }, res);
  await new Promise(r => setTimeout(r, 0));
  return res.body;
};

beforeEach(() => {
  st.broadcasts = [];
  st.lastError = 'disk full';
  st.fence = null;
  st.bots = [{ id: 'b1', status: 'running', sourceType: 'git', fleetDb: { containerName: 'db' }, fleetBackup: { enabled: true, hour: 4 } }];
});

describe('B09-4 lifecycle pushes carry the enriched health keys', () => {
  for (const [route, type] of [['/:id/start', 'bot:started'], ['/:id/stop', 'bot:stopped'], ['/:id/restart', 'bot:restarted']]) {
    it(`${type} carries the backup error`, async () => {
      await call(route);
      const push = st.broadcasts.find(b => b.type === type);
      expect(push?.data.fleetBackup?.main?.lastError).toBe('disk full');
    });
  }
});

describe('B09-4 health changes are pushed', () => {
  it('carries a stuck fence for an instance with only a standby', () => {
    st.bots = [{ id: 'r1', status: 'running', sourceType: 'git', fleetDbReplica: { containerName: 'copy' } }];
    st.fence = 'The copy is READ-ONLY';
    const pushed = (routes as any).collectHealthChanges(new Map());
    expect(pushed[0].fenceStuck).toBe('The copy is READ-ONLY');
    expect(pushed[0].fleetBackup?.main).toBeNull();
  });

  it('reports a bot once, then only when its backup status changes', () => {
    const fn = (routes as any).collectHealthChanges;
    expect(typeof fn).toBe('function');
    const seen = new Map<string, string>();
    expect(fn(seen).map((p: any) => p.id)).toEqual(['b1']);
    expect(fn(seen)).toEqual([]);
    st.lastError = null;
    const changed = fn(seen);
    expect(changed).toHaveLength(1);
    expect(changed[0].fleetBackup.main.lastError).toBeNull();
  });

  const pageHtml = fs.readFileSync(path.join(__dirname, '../../src/webui/public/index.html'), 'utf8');
  const pageFunction = (name: string): string => {
    let start = pageHtml.indexOf(`function ${name}(`);
    if (pageHtml.slice(start - 6, start) === 'async ') start -= 6;
    let i = pageHtml.indexOf('(', start);
    for (let depth = 0; ; i++) {
      if (pageHtml[i] === '(') depth++;
      else if (pageHtml[i] === ')' && --depth === 0) break;
    }
    i = pageHtml.indexOf('{', i);
    for (let depth = 0; ; i++) {
      if (pageHtml[i] === '{') depth++;
      else if (pageHtml[i] === '}' && --depth === 0) return pageHtml.slice(start, i + 1);
    }
  };
  const fam = (lastError: string | null) => ({ family: 'main', role: 'main database', enabled: true, hour: 4, paused: false, lastFile: null, lastAt: null, dataAt: null, lastError, failingSince: null, listError: null, test: null, alerts: { dumps: null, test: null } });
  const page = (api: () => Promise<any>) => {
    const boxes: Record<string, any> = {
      'fleet-backup-modal': { classList: { remove: () => {} } },
      'fleet-backup-content': { innerHTML: '' },
      'fleet-backup-error': { innerHTML: '<div class="error-message">Last backup failed: disk full</div>', isConnected: true },
      'fleet-backup-list': { innerHTML: 'old list', isConnected: true },
    };
    const ctx: any = vm.createContext({
      bots: [{ id: 'b1', displayName: 'B1', fleetDb: { containerName: 'db' }, fleetBackup: { enabled: true, hour: 4, main: fam('disk full') } }],
      fleetBackupBotId: 'b1', fleetBackupStored: null, fleetBackupRefreshSeq: 0,
      document: { getElementById: (id: string) => boxes[id] ?? null },
      escapeHtml: (s: string) => String(s), formatBackupSize: () => '', jsArg: (s: string) => JSON.stringify(s),
      renderSeedBanner: () => {}, renderFleetReplication: () => {}, api,
    });
    for (const fn of ['mergeBotState', 'refreshFleetBackupStatus', 'showFleetBackups', 'fleetBackupErrorHtml', 'fleetBackupListHtml', 'backupTime', 'backupTestHtml', 'backupAlertHtml', 'backupStatusHtml']) vm.runInContext(pageFunction(fn), ctx);
    return { ctx, boxes };
  };
  const listed = async () => ({ success: true, backups: [{ file: 'new.dump', size: 1, mtime: 1 }] });

  it('a bot:health push for the open bot clears the error line and redraws the list', async () => {
    const { ctx, boxes } = page(listed);
    ctx.mergeBotState({ id: 'b1', fleetBackup: { enabled: true, hour: 4, main: fam(null) } });
    await ctx.refreshFleetBackupStatus('b1');
    expect(boxes['fleet-backup-error'].innerHTML).not.toContain('disk full');
    expect(boxes['fleet-backup-error'].innerHTML).toContain('No backup yet');
    expect(boxes['fleet-backup-list'].innerHTML).toContain('new.dump');
  });

  it('a bot:health push for another bot leaves the modal unchanged', async () => {
    const { ctx, boxes } = page(listed);
    ctx.bots.push({ id: 'b2', fleetDb: {}, fleetBackup: { enabled: true, main: fam('x') } });
    ctx.mergeBotState({ id: 'b2', fleetBackup: { enabled: true, main: fam(null) } });
    await ctx.refreshFleetBackupStatus('b2');
    expect(boxes['fleet-backup-error'].innerHTML).toContain('disk full');
    expect(boxes['fleet-backup-list'].innerHTML).toBe('old list');
  });

  it('a push that lands while the modal opens is shown once the modal renders', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const { ctx, boxes } = page(async () => { await gate; return { success: true, backups: [] }; });
    delete boxes['fleet-backup-error'];
    delete boxes['fleet-backup-list'];
    const opening = ctx.showFleetBackups('b1');
    ctx.mergeBotState({ id: 'b1', fleetBackup: { enabled: true, hour: 4, main: fam(null) } });
    await ctx.refreshFleetBackupStatus('b1');
    release();
    await opening;
    expect(boxes['fleet-backup-content'].innerHTML).not.toContain('disk full');
  });
});
