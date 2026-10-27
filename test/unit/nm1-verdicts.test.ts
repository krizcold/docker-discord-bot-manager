import { describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({ status: { vars: {} as Record<string, string>, undecryptable: [] as string[], encrypted: [] as string[], corrupt: false } }));
vi.mock('../../src/env/manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/env/manager')>()),
  getEnvVarsWithStatus: () => env.status,
}));

import { maintenanceKind, readKind, orderPlan, settledVerdict, maintenanceOf, MaintenanceKind, PlanStep } from '../../src/instance/maintenance';
import { parseBotLogin, botRoleRefusal } from '../../src/instance/dbLogin';
import { BotRunState } from '../../src/types';

const SMDB = 'https://github.com/x/fully-modular-discord-bot';
const PLAIN = 'https://github.com/x/plain-bot';
const fleetDb = { containerName: 'b1-fleet-postgres', user: 'smdb', db: 'smdb', volume: 'v' };
const inst = (over: Record<string, unknown> = {}) => ({ id: 'b1', displayName: 'B1', sourceUrl: SMDB, envVars: {}, createdAt: '2026-10-01T00:00:00.000Z', ...over }) as any;

describe('maintenanceKind per kind', () => {
  it('database: postgres backend, a managed main and a blank URL', () => {
    expect(maintenanceKind(inst({ fleetDb }), { DATA_BACKEND: 'postgres' })).toBe('database');
  });
  it('database: the URL names the sidecar', () => {
    expect(maintenanceKind(inst({ fleetDb }), { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: 'postgresql://smdb:p@b1-fleet-postgres:5432/smdb' })).toBe('database');
  });
  it('database: the URL names the replication public host', () => {
    const rec = { ...fleetDb, replication: { publicHost: 'db.example.test' } };
    expect(maintenanceKind(inst({ fleetDb: rec }), { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: 'postgresql://smdb:p@db.example.test:15432/smdb' })).toBe('database');
  });
  it('external: a URL to another host, even with a fleetDb record', () => {
    expect(maintenanceKind(inst({ fleetDb }), { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: 'postgresql://u:p@elsewhere:5432/d' })).toBe('external');
  });
  it('external: a retiring main is not managed', () => {
    expect(maintenanceKind(inst({ fleetDb: { ...fleetDb, retiringAt: 'x' } }), { DATA_BACKEND: 'postgres' })).toBe('external');
  });
  it('copy: postgres with a standby record and no managed main', () => {
    expect(maintenanceKind(inst({ fleetDbReplica: { containerName: 'r' } }), { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: 'postgresql://u:p@main:5432/d' })).toBe('copy');
  });
  it('json: hooks and no postgres backend', () => {
    expect(maintenanceKind(inst({ fleetDb }), {})).toBe('json');
    expect(maintenanceKind(inst(), { DATA_BACKEND: 'json' })).toBe('json');
  });
  it('none: an app that declares no hooks', () => {
    expect(maintenanceKind(inst({ sourceUrl: PLAIN }), {})).toBe('none');
  });
});

describe('readKind refuses a broken env store (R8)', () => {
  const R8 = "The env store for this instance cannot be read, so the manager can't tell which database the bot uses; nothing was changed";
  it('a corrupt store', () => {
    env.status = { vars: {}, undecryptable: [], encrypted: [], corrupt: true };
    expect(readKind(inst({ fleetDb }))).toEqual({ error: R8 });
  });
  it('an undecryptable URL key', () => {
    env.status = { vars: { DATA_BACKEND: 'postgres' }, undecryptable: ['DATA_BACKEND_URL'], encrypted: ['DATA_BACKEND_URL'], corrupt: false };
    expect(readKind(inst({ fleetDb }))).toEqual({ error: R8 });
  });
  it('another undecryptable key does not refuse', () => {
    env.status = { vars: { DATA_BACKEND: 'postgres' }, undecryptable: ['OTHER'], encrypted: ['OTHER'], corrupt: false };
    expect(readKind(inst({ fleetDb }))).toEqual({ kind: 'database' });
  });
  it('the store value wins over the record', () => {
    env.status = { vars: { DATA_BACKEND: 'postgres' }, undecryptable: [], encrypted: [], corrupt: false };
    expect(readKind(inst({ fleetDb, envVars: { DATA_BACKEND: 'json' } }))).toEqual({ kind: 'database' });
  });
});

const KINDS: MaintenanceKind[] = ['database', 'copy', 'external', 'json', 'none'];
const ORDERS: BotRunState[] = ['running', 'maintenance', 'off'];
const SAVED = ['running', 'maintenance', null] as const;
const space: Array<{ kind: MaintenanceKind; to: BotRunState; fromOff: boolean; app: boolean; savedByBot: 'running' | 'maintenance' | null; hooks: boolean }> = [];
for (const kind of KINDS) for (const to of ORDERS) for (const fromOff of [false, true]) for (const app of [false, true])
  for (const savedByBot of SAVED) for (const hooks of [false, true]) {
    // The hook kinds exist only for an app that declares hooks; none only for one that does not.
    if (kind !== 'database' && hooks !== (kind !== 'none')) continue;
    space.push({ kind, to, fromOff, app, savedByBot, hooks });
  }

const before = (steps: PlanStep[], a: PlanStep, b: PlanStep) => !steps.includes(a) || !steps.includes(b) || steps.indexOf(a) < steps.indexOf(b);

describe('orderPlan over the whole input space', () => {
  it.each(space)('%o', (p) => {
    const plan = orderPlan(p);
    if ('refusal' in plan) {
      if (p.kind === 'none') expect([p.to, plan.refusal]).toEqual(['maintenance', 'R7']);
      else {
        expect(p.kind).not.toBe('database');
        expect(p.to).toBe('maintenance');
        expect(p.app).toBe(false);
        expect(plan.refusal).toBe(p.fromOff ? 'R10' : 'R9');
        if (p.fromOff) expect(p.savedByBot).not.toBe('maintenance');
      }
      return;
    }
    const s = plan.steps;
    expect(before(s, 'hook', 'block')).toBe(true);
    expect(before(s, 'block', 'end-sessions')).toBe(true);
    expect(before(s, 'end-sessions', 'stop')).toBe(true);
    expect(before(s, 'hook', 'stop')).toBe(true);
    expect(before(s, 'stop', 'db-up-alone')).toBe(true);
    expect(before(s, 'open', 'start')).toBe(true);
    expect(before(s, 'start', 'hook-wait')).toBe(true);
    expect(before(s, 'open', 'hook')).toBe(true);
    expect(before(s, 'db-up', 'block')).toBe(true);
    expect(before(s, 'db-up', 'open')).toBe(true);
    expect(new Set(s).size).toBe(s.length);
    if (s.includes('stop')) expect([p.to, p.app]).toEqual(['off', true]);
    if (s.includes('start')) expect([p.fromOff, p.to === 'off', p.app]).toEqual([true, false, false]);
    if (s.includes('hook-wait')) expect(s.includes('start')).toBe(true);
    if (p.kind !== 'database') expect(s.filter(x => ['db-up', 'block', 'end-sessions', 'open', 'db-up-alone'].includes(x))).toEqual([]);
    if (p.kind === 'database') {
      if (p.to === 'running') expect(s.includes('open') && !s.includes('block')).toBe(true);
      else expect(s.includes('block') && s.includes('end-sessions') && !s.includes('open')).toBe(true);
    }
    if (!p.hooks) expect(s.filter(x => x === 'hook' || x === 'hook-wait')).toEqual([]);
    if (s.includes('hook')) expect(p.app).toBe(true);
    if (p.to === 'off') expect(s.includes('start')).toBe(false);
    if (p.to === 'off' && p.kind === 'database') expect(s[s.length - 1]).toBe('db-up-alone');
    if (p.to === 'off' && p.app) expect(s.includes('stop')).toBe(true);
    // The from-Off steps apply only while the app does not run; an app that runs takes the hook first.
    if (p.to !== 'off' && p.fromOff && !p.app && p.hooks) expect(s.includes('start') && s.includes('hook-wait')).toBe(true);
    if (p.app && p.hooks && p.to !== 'running') expect(s[0]).toBe('hook');
  });

  it('database to maintenance with the app running: hook, db-up, block, end-sessions', () => {
    expect(orderPlan({ kind: 'database', to: 'maintenance', fromOff: false, app: true, savedByBot: null, hooks: true })).toEqual({ steps: ['hook', 'db-up', 'block', 'end-sessions'] });
  });
  it('database to maintenance from Off: db-up, block, end-sessions, start, hook-wait', () => {
    expect(orderPlan({ kind: 'database', to: 'maintenance', fromOff: true, app: false, savedByBot: null, hooks: true })).toEqual({ steps: ['db-up', 'block', 'end-sessions', 'start', 'hook-wait'] });
  });
  it('F4 database to maintenance, record Off, the app runs: the hook first, no start', () => {
    expect(orderPlan({ kind: 'database', to: 'maintenance', fromOff: true, app: true, savedByBot: null, hooks: true })).toEqual({ steps: ['hook', 'db-up', 'block', 'end-sessions'] });
  });
  it('F4 database to running, record Off, the app runs: open, then the hook', () => {
    expect(orderPlan({ kind: 'database', to: 'running', fromOff: true, app: true, savedByBot: null, hooks: true })).toEqual({ steps: ['db-up', 'open', 'hook'] });
  });
  it('database to off with the app running', () => {
    expect(orderPlan({ kind: 'database', to: 'off', fromOff: false, app: true, savedByBot: null, hooks: true })).toEqual({ steps: ['hook', 'db-up', 'block', 'end-sessions', 'stop', 'db-up-alone'] });
  });
  it('database to running from Off', () => {
    expect(orderPlan({ kind: 'database', to: 'running', fromOff: true, app: false, savedByBot: null, hooks: true })).toEqual({ steps: ['db-up', 'open', 'start', 'hook-wait'] });
  });
  it('database to running with the app running', () => {
    expect(orderPlan({ kind: 'database', to: 'running', fromOff: false, app: true, savedByBot: null, hooks: true })).toEqual({ steps: ['db-up', 'open', 'hook'] });
  });
  it('json to maintenance from Off after the bot saved maintenance', () => {
    expect(orderPlan({ kind: 'json', to: 'maintenance', fromOff: true, app: false, savedByBot: 'maintenance', hooks: true })).toEqual({ steps: ['start', 'hook-wait'] });
  });
  it('json to off with the app running', () => {
    expect(orderPlan({ kind: 'json', to: 'off', fromOff: false, app: true, savedByBot: null, hooks: true })).toEqual({ steps: ['hook', 'stop'] });
  });
  it('none to running from Off: start alone', () => {
    expect(orderPlan({ kind: 'none', to: 'running', fromOff: true, app: false, savedByBot: null, hooks: false })).toEqual({ steps: ['start'] });
  });
});

// The reference, written per case rather than as one formula.
function reference(p: { kind: MaintenanceKind; to: BotRunState; hook: string; login: string; app: boolean; startOwed: boolean; hooks: boolean }): boolean {
  const hookOk = !p.hooks || p.hook === 'confirmed' || p.hook === 'missing';
  if (p.kind === 'none') {
    if (p.to === 'maintenance') return false;
    if (p.to === 'off') return p.app === false;
    return p.startOwed ? p.app : true;
  }
  if (p.to === 'off') return p.kind === 'database' ? (p.login === 'blocked' && p.app === false) : p.app === false;
  if (p.to === 'maintenance') {
    if (p.kind !== 'database') return p.hook === 'confirmed';
    if (p.login !== 'blocked') return false;
    return p.startOwed ? p.app : true;
  }
  if (p.kind === 'database' && p.login !== 'open') return false;
  if (p.startOwed) return p.app && hookOk;
  return p.app ? hookOk : true;
}

const HOOKS = ['confirmed', 'unconfirmed', 'missing', 'none'] as const;
const LOGINS = ['blocked', 'open', 'unconfirmed', 'not-managed'] as const;
const vspace: Array<{ kind: MaintenanceKind; to: BotRunState; hook: typeof HOOKS[number]; login: typeof LOGINS[number]; app: boolean; startOwed: boolean; hooks: boolean }> = [];
for (const kind of KINDS) for (const to of ORDERS) for (const hook of HOOKS) for (const login of LOGINS)
  for (const app of [false, true]) for (const startOwed of [false, true]) for (const hooks of [false, true]) vspace.push({ kind, to, hook, login, app, startOwed, hooks });

describe('settledVerdict against the reference table', () => {
  it(`agrees on all ${vspace.length} inputs`, () => {
    const wrong = vspace.filter(p => settledVerdict(p) !== reference(p));
    expect(wrong).toEqual([]);
  });

  it('an unknown app (docker did not answer) is never settled where the app decides', () => {
    expect(settledVerdict({ kind: 'database', to: 'off', hook: 'confirmed', login: 'blocked', app: null, startOwed: false, hooks: true })).toBe(false);
    expect(settledVerdict({ kind: 'database', to: 'maintenance', hook: 'confirmed', login: 'blocked', app: null, startOwed: true, hooks: true })).toBe(false);
    expect(settledVerdict({ kind: 'json', to: 'running', hook: 'unconfirmed', login: 'not-managed', app: null, startOwed: false, hooks: true })).toBe(false);
  });

  const flips: Array<[string, any, Record<string, unknown>]> = [
    ['database maintenance: login', { kind: 'database', to: 'maintenance', hook: 'confirmed', login: 'blocked', app: true, startOwed: true, hooks: true }, { login: 'unconfirmed' }],
    ['database maintenance: app owed', { kind: 'database', to: 'maintenance', hook: 'confirmed', login: 'blocked', app: true, startOwed: true, hooks: true }, { app: false }],
    ['database off: login', { kind: 'database', to: 'off', hook: 'none', login: 'blocked', app: false, startOwed: false, hooks: true }, { login: 'open' }],
    ['database off: app', { kind: 'database', to: 'off', hook: 'none', login: 'blocked', app: false, startOwed: false, hooks: true }, { app: true }],
    ['database running: login', { kind: 'database', to: 'running', hook: 'confirmed', login: 'open', app: true, startOwed: true, hooks: true }, { login: 'blocked' }],
    ['database running: app owed', { kind: 'database', to: 'running', hook: 'confirmed', login: 'open', app: true, startOwed: true, hooks: true }, { app: false }],
    ['database running: hook', { kind: 'database', to: 'running', hook: 'confirmed', login: 'open', app: true, startOwed: true, hooks: true }, { hook: 'unconfirmed' }],
    ['json maintenance: hook', { kind: 'json', to: 'maintenance', hook: 'confirmed', login: 'not-managed', app: true, startOwed: false, hooks: true }, { hook: 'unconfirmed' }],
    ['json off: app', { kind: 'json', to: 'off', hook: 'confirmed', login: 'not-managed', app: false, startOwed: false, hooks: true }, { app: true }],
    ['json running: hook', { kind: 'json', to: 'running', hook: 'confirmed', login: 'not-managed', app: true, startOwed: false, hooks: true }, { hook: 'unconfirmed' }],
    ['none running: app owed', { kind: 'none', to: 'running', hook: 'none', login: 'not-managed', app: true, startOwed: true, hooks: false }, { app: false }],
  ];
  it.each(flips)('%s: the safe input settles and each key flipped alone does not', (_n, safe, flip) => {
    expect(settledVerdict(safe)).toBe(true);
    expect(settledVerdict({ ...safe, ...flip })).toBe(false);
  });
});

describe('parseBotLogin fails closed', () => {
  it.each([
    ['false|false|0', { inRecovery: false, canLogin: false, sessions: 0 }],
    ['false|true|3', { inRecovery: false, canLogin: true, sessions: 3 }],
    ['true|false|0', { inRecovery: true, canLogin: false, sessions: 0 }],
    ['false|true|0\n', { inRecovery: false, canLogin: true, sessions: 0 }],
  ])('%j', (line, parsed) => expect(parseBotLogin(line)).toEqual(parsed));

  it('a missing role reads canLogin null, never true', () => {
    expect(parseBotLogin('false|missing|0')).toEqual({ inRecovery: false, canLogin: null, sessions: 0 });
  });

  it.each(['', 'garbage', 'false|false', 'false|false|0|1', 'f|false|0', 'false|t|0', 'false|false|-1', 'false|false|x', 'false|false|0\nfalse|true|0', ' false|false|0'])('null for %j', (line) => {
    expect(parseBotLogin(line)).toBeNull();
  });
});

describe('botRoleRefusal', () => {
  const R14 = (u: string) => `The app's database role name ${u} cannot be used by the maintenance tool (it must be a plain lower-case name other than dbm_admin and replicator); nothing was changed`;
  it.each(['smdb', 'bot_1', '_x', 'a'.repeat(63)])('accepts %s', (u) => expect(botRoleRefusal(u)).toBeNull());
  it.each(['dbm_admin', 'replicator', 'Smdb', '1bot', 'a-b', 'a"b', "a'b", '', 'a'.repeat(64), 'smdb; DROP'])('refuses %j', (u) => expect(botRoleRefusal(u)).toBe(R14(u)));
});

describe('maintenanceOf', () => {
  it('an absent record reads Running, settled', () => {
    expect(maintenanceOf(inst())).toEqual({ state: 'running', message: '', orderedAt: '2026-10-01T00:00:00.000Z', settled: true, hook: 'none', login: 'not-managed', savedByBot: null });
  });
  it('a null record reads the same', () => {
    expect(maintenanceOf(inst({ maintenance: null })).state).toBe('running');
  });
  it('a stored record is returned as it is', () => {
    const rec = { state: 'off', message: 'm', orderedAt: 't', settled: false, hook: 'unconfirmed', login: 'unconfirmed', savedByBot: 'maintenance' };
    expect(maintenanceOf(inst({ maintenance: rec }))).toEqual(rec);
  });
});
