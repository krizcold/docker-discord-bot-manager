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
  readWriteFence: async () => ({ ok: true, on: false }),
  sidecarRunning: async () => h.sidecar,
  ensureManagerDbRole: async () => { h.events.push('ensure'); return h.ensure; },
  readBotLogin: async () => (h.readFail ? { ok: false, cls: 'other', error: h.readFail } : { ok: true, login: { ...h.db } }),
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

import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { runMaintenanceOrder, resetMaintenanceState, maintenanceStatus, MAINTENANCE_TIMING } from '../../src/instance/maintenance';

const SMDB = 'https://github.com/x/fully-modular-discord-bot';

function setupJson(maintenance?: any): void {
  h.inst = { id: 'b1', displayName: 'B1', sourceUrl: SMDB, envVars: {}, createdAt: '2026-10-01T00:00:00.000Z', status: 'running', ...(maintenance ? { maintenance } : {}) };
  h.env = { vars: {}, undecryptable: [], encrypted: [], corrupt: false };
}

beforeEach(() => {
  resetMaintenanceState();
  MAINTENANCE_TIMING.hookWaitMs = 30;
  MAINTENANCE_TIMING.hookWaitPauseMs = 1;
  MAINTENANCE_TIMING.hookWaitTryMs = 10;
  h.lock = null; h.app = true; h.appAfterStart = true; h.sidecar = true;
  h.hookBodies = []; h.start = { success: true }; h.stop = { success: true };
  h.events = []; h.writes = []; h.failWrite = () => null; h.crashAt = null;
  setupJson();
});

const answer = (body: Record<string, unknown>) => () => ({ ok: true, status: 200, body: { success: true, state: 'maintenance', ...body } });

describe('NM8 state: the GET answer carries what the bot said about the changes it holds', () => {
  it('S2 saved false: the counts and the note, saved through the order', async () => {
    h.hook = answer({ saved: false, unsavedGuilds: ['g1', 'g2'], unsavedFiles: 3, note: 'Two guilds were refused by the database.' });
    await runMaintenanceOrder('b1', 'maintenance', '');
    const s: any = await maintenanceStatus(h.inst, null);
    expect(s.held).toEqual({ state: 'no', guilds: 2, files: 3, note: 'Two guilds were refused by the database.' });
  });

  it('S1 saved true', async () => {
    h.hook = answer({ saved: true });
    await runMaintenanceOrder('b1', 'maintenance', '');
    expect(((await maintenanceStatus(h.inst, null)) as any).held).toEqual({ state: 'yes' });
  });

  it('S3 saved null', async () => {
    h.hook = answer({ saved: null, note: 'The save did not finish in time.' });
    await runMaintenanceOrder('b1', 'maintenance', '');
    expect(((await maintenanceStatus(h.inst, null)) as any).held).toEqual({ state: 'unknown', note: 'The save did not finish in time.' });
  });

  it('S5 a Running bot has no reading, even with an older answer on the record', async () => {
    h.hook = answer({ saved: false, unsavedGuilds: 1, unsavedFiles: 0 });
    await runMaintenanceOrder('b1', 'maintenance', '');
    h.hook = () => ({ ok: true, status: 200, body: { success: true, state: 'running', restarting: true } });
    await runMaintenanceOrder('b1', 'running', '');
    expect(((await maintenanceStatus(h.inst, null)) as any).held).toBeNull();
  });

  it('S5 no answer from the bot: no reading', async () => {
    h.hook = () => ({ ok: false, unknown: true, error: 'maintenance sent, no answer within 30 s' });
    await runMaintenanceOrder('b1', 'maintenance', '');
    expect(((await maintenanceStatus(h.inst, null)) as any).held).toBeNull();
  });
});

const pageHtml = fs.readFileSync(path.resolve(__dirname, '../../src/webui/public/index.html'), 'utf8');
const pageFunction = (name: string): string => {
  let start = pageHtml.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`no function ${name}`);
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
const page = () => {
  const ctx = vm.createContext({ String, Number });
  vm.runInContext(['escapeHtml', 'stateName', 'heldLineText', 'stateWindowHtml'].map(pageFunction).join('\n'), ctx);
  return ctx as any;
};

describe('NM8 state: the saved line in the State window', () => {
  const ctx = page();
  it.each([
    ['S1', { state: 'yes' }, "The bot's last answer: it saved every change it held."],
    ['S2', { state: 'no', guilds: 2, files: 3 }, 'The bot reports changes it could not save: 2 guild(s), 3 file(s). Its log names them.'],
    ['S3', { state: 'unknown' }, "The manager can't confirm the bot saved the changes it holds: its last answer did not say."],
    ['S4', { state: 'stopped' }, 'The bot was stopped without confirming that it saved what it held.'],
    ['S5 not-running', { state: 'not-running' }, ''],
    ['S5 none', null, ''],
    ['S6', { state: 'no', guilds: 1, files: 0, note: 'Guild g1 was refused.' }, "The bot reports changes it could not save: 1 guild(s), 0 file(s). Its log names them. The bot's note: Guild g1 was refused."],
  ])('%s', (_n, held, text) => {
    expect(ctx.heldLineText(held)).toBe(text);
  });

  it('the window shows the line, escaped, and none without a reading', () => {
    const info = { state: 'maintenance', kind: 'json', message: '' };
    const withLine = ctx.stateWindowHtml({ id: 'b1', displayName: 'B1' }, { ...info, held: { state: 'unknown', note: '<b>x</b>' } });
    expect(withLine).toContain(ctx.escapeHtml("The manager can't confirm the bot saved the changes it holds: its last answer did not say. The bot's note: <b>x</b>"));
    const without = ctx.stateWindowHtml({ id: 'b1', displayName: 'B1' }, { ...info, held: null });
    expect(without).not.toContain("The bot's last answer");
    expect(without).not.toContain('id="state-held"');
  });
});
