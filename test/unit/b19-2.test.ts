import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'b19-2-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return {
    dir,
    hooks: true,
    factsOk: true,
    factsError: 'the instance is not running',
    facts: {} as Record<string, unknown>,
    hookCalls: [] as Array<{ hook: string; method: string; body: any }>,
    docker: 0,
    block: { success: true, dsn: '', cert: '' } as { success: boolean; dsn?: string; cert?: string; error?: string },
    stubEnable: null as null | ((...a: any[]) => Promise<any>),
    stubDisable: null as null | ((...a: any[]) => Promise<any>),
    decommission: { success: true, dumpFile: 'pre-decommission-x.dump' } as any,
    onDecommission: null as null | (() => void),
  };
});

// No docker here: every exec fails and is counted, so a lane that went past
// its admission check shows up as a count above zero.
vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const { EventEmitter } = await import('events');
  const { PassThrough } = await import('stream');
  const execFile = (_cmd: string, _args: string[], opts: any, cb?: any) => {
    h.docker++;
    const done = typeof opts === 'function' ? opts : cb;
    setTimeout(() => done(new Error('no docker in this test'), '', 'no docker in this test\n'), 1);
    const child: any = new EventEmitter();
    child.stdin = new PassThrough();
    child.kill = () => {};
    return child;
  };
  const spawn = () => {
    h.docker++;
    const child: any = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => {};
    setTimeout(() => { child.stdout.end(''); child.stderr.end('no docker\n'); setTimeout(() => child.emit('close', 1), 1); }, 1);
    return child;
  };
  return { ...real, execFile, spawn, default: { ...real, execFile, spawn } };
});
vi.mock('../../src/instance/appHookClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/appHookClient')>()),
  hasAppHooks: () => h.hooks,
  callAppHook: async (_instance: unknown, hook: string, method: string, body?: any) => {
    h.hookCalls.push({ hook, method, body });
    if (hook === 'facts') return h.factsOk ? { ok: true, body: { success: true, ...h.facts } } : { ok: false, error: h.factsError };
    return { ok: true, body: { success: true } };
  },
}));
vi.mock('../../src/instance/fleetReplication', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/instance/fleetReplication')>();
  return {
    ...real,
    getReplicaCopyBlock: async () => h.block,
    enableFleetReplication: (...a: any[]) => h.stubEnable ? h.stubEnable(...a) : (real.enableFleetReplication as any)(...a),
    disableFleetReplication: (...a: any[]) => h.stubDisable ? h.stubDisable(...a) : (real.disableFleetReplication as any)(...a),
  };
});
vi.mock('../../src/instance/fleetReplica', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/fleetReplica')>()),
  decommissionFleetDb: async () => { if (h.decommission.success) h.onDecommission?.(); return h.decommission; },
  adoptPromotedReplica: async () => ({ success: true }),
}));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import * as containerManager from '../../src/docker/containerManager';
import * as envManager from '../../src/env/manager';
import { ensureCopyBlockCurrent } from '../../src/instance/appLifecycle';
import { createBotRoutes } from '../../src/webui/routes/bots';

const dbUrl = 'postgresql://smdb:Db-Secret-0123456789@bot1-fleet-postgres:5432/smdb';
const fleetDb = { containerName: 'bot1-fleet-postgres', user: 'smdb', db: 'smdb', volume: 'bot1-fleet-postgres-data' };
const replication = { role: 'replicator', password: 'Repl-Secret-0123456789', hostPort: 15432, publicHost: 'primary.invalid', certHost: 'primary.invalid', slotWalKeepMb: 4096 };
const OWN_DSN = 'postgresql://replicator:Repl-Secret-0123456789@primary.invalid:15432/smdb?sslmode=verify-full';
const CERT = '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n';

const writeRegistry = (extra: Record<string, unknown> = {}): void => {
  fs.writeFileSync(path.join(h.dir, 'instances.json'), JSON.stringify({
    instances: {
      b1: {
        id: 'b1', sanitizedName: 'bot1', displayName: 'Bot 1', titleName: 'Bot 1', status: 'running',
        sourceType: 'git', sourceUrl: 'https://example.invalid/fake/super-modular-discord-bot',
        envVars: { DATA_BACKEND: 'postgres' },
        fleetDb: { ...fleetDb, replication },
        createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z',
        ...extra,
      },
    },
  }));
};
const bot = () => containerManager.getBot('b1')!;
const disabled = async () => { containerManager.updateInstanceFleetDbReplication('b1', null); return { success: true, restartRequired: true }; };

const router = createBotRoutes({ clients: new Set() } as any);
const call = async (method: 'get' | 'post', routePath: string, body: unknown = {}, query: Record<string, string> = {}): Promise<any> => {
  const layer = (router as any).stack.find((l: any) => l.route?.path === routePath && l.route.methods[method]);
  const res: any = { statusCode: 200 };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  await layer.route.stack[layer.route.stack.length - 1].handle({ params: { id: 'b1' }, query, body }, res);
  return res.body;
};
const published = () => h.hookCalls.filter(c => c.hook === 'copy-block' && c.body && c.body.clear !== true);
const cleared = () => h.hookCalls.filter(c => c.hook === 'copy-block' && c.body?.clear === true);
const settle = () => new Promise(r => setTimeout(r, 30));

beforeEach(() => {
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
  fs.mkdirSync(path.join(h.dir, 'bots', 'b1', 'env'), { recursive: true });
  writeRegistry();
  envManager.setEnvVars('b1', { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: dbUrl });
  h.hooks = true;
  h.factsOk = true;
  h.factsError = 'the instance is not running';
  h.facts = { running: true, initialized: true, role: 'master', copyBlockTarget: true, followerHold: null, copyBlock: null };
  h.hookCalls.length = 0;
  h.docker = 0;
  h.block = { success: true, dsn: OWN_DSN, cert: CERT };
  h.stubEnable = null;
  h.stubDisable = null;
  h.decommission = { success: true, dumpFile: 'pre-decommission-x.dump' };
  h.onDecommission = () => writeRegistry({ status: 'stopped', fleetDb: undefined });
});

afterAll(() => {
  fs.rmSync(h.dir, { recursive: true, force: true });
});

describe('freshness covers the whole block', () => {
  it('republishes when the held certificate differs behind the same endpoint', async () => {
    const r = await ensureCopyBlockCurrent(bot(), { dsn: OWN_DSN, cert: '-----BEGIN CERTIFICATE-----\nOLD\n-----END CERTIFICATE-----' });
    expect(r.delivered).toBe(true);
    expect(published()).toHaveLength(1);
    expect(published()[0].body).toEqual({ dsn: OWN_DSN, cert: CERT });
  });

  it('republishes when the held credential differs behind the same endpoint', async () => {
    const r = await ensureCopyBlockCurrent(bot(), { dsn: OWN_DSN.replace('Repl-Secret', 'Old-Secret'), cert: CERT });
    expect(r.delivered).toBe(true);
    expect(published()).toHaveLength(1);
  });

  it('publishes nothing when the held block is the whole current one', async () => {
    const r = await ensureCopyBlockCurrent(bot(), { dsn: OWN_DSN, cert: CERT.trim() });
    expect(r).toEqual({ success: true, delivered: false });
    expect(published()).toHaveLength(0);
  });

  it('says so when the current block cannot be built, and publishes nothing', async () => {
    h.block = { success: false, error: 'Database container is not running' };
    const r = await ensureCopyBlockCurrent(bot(), { dsn: OWN_DSN, cert: CERT });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/not running/);
    expect(published()).toHaveLength(0);
  });
});

describe('Enable and adopt deliver the block only to the node that relays it', () => {
  const enableBody = { enabled: true, publicHost: 'primary.invalid', hostPort: 15432 };

  it('skips the delivery and says why when the bot is not the copy-block target', async () => {
    h.stubEnable = async () => ({ success: true, restartRequired: true });
    h.facts = { ...h.facts, role: 'worker', copyBlockTarget: false };
    const res = await call('post', '/:id/fleet-replication', enableBody);
    expect(res.success).toBe(true);
    expect(published()).toHaveLength(0);
    expect(res.copyBlockNote).toMatch(/not the fleet's master/);
    expect(res.copyBlockError).toBeUndefined();
  });

  it('delivers to the target and says a registered backup receives it only at its next registration', async () => {
    h.stubEnable = async () => ({ success: true, restartRequired: true });
    const res = await call('post', '/:id/fleet-replication', enableBody);
    expect(published()).toHaveLength(1);
    expect(res.copyBlockNote).toMatch(/next registration/);
    expect(res.copyBlockNote).toMatch(/holds the current copy block/);
  });

  it('says the block was not handed over, and when it will be, on a stopped instance', async () => {
    h.stubEnable = async () => ({ success: true, restartRequired: true });
    writeRegistry({ status: 'stopped' });
    const res = await call('post', '/:id/fleet-replication', enableBody);
    expect(published()).toHaveLength(0);
    expect(res.copyBlockNote).toMatch(/not running/);
    expect(res.copyBlockNote).toMatch(/answers as the fleet's master/);
  });

  it('adopt skips the delivery and says why when the bot is not the copy-block target', async () => {
    h.facts = { ...h.facts, role: 'worker', copyBlockTarget: false };
    const res = await call('post', '/:id/fleet-adopt-primary');
    expect(res.success).toBe(true);
    expect(published()).toHaveLength(0);
    expect(res.copyBlockNote).toMatch(/not the fleet's master/);
  });

  it('adopt delivers to the target', async () => {
    const res = await call('post', '/:id/fleet-adopt-primary');
    expect(published()).toHaveLength(1);
    expect(res.copyBlockNote).toMatch(/next registration/);
    expect(res.copyBlockNote).toMatch(/holds the current copy block/);
  });
});

describe('Enable and Disable refuse on a node behind a stand-in', () => {
  for (const [label, body] of [['Enable', { enabled: true, publicHost: 'primary.invalid', hostPort: 15432 }], ['Disable', { enabled: false }]] as const) {
    it(`${label} refuses while a failback run is recorded, and runs nothing`, async () => {
      writeRegistry({ fleetFailback: { mode: 'failback', phase: 'awaiting-block', startedAt: 1, updatedAt: 1 } });
      const before = JSON.stringify(bot().fleetDb);
      const res = await call('post', '/:id/fleet-replication', body);
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/failback run is recorded/);
      expect(res.error).toMatch(/nothing was changed/);
      expect(h.docker).toBe(0);
      expect(JSON.stringify(bot().fleetDb)).toBe(before);
    });

    it(`${label} refuses while the bot reports a follower hold, and runs nothing`, async () => {
      h.facts = { ...h.facts, followerHold: { reason: 'behind', standInNodeId: 'n2', namesThisNode: true } };
      const res = await call('post', '/:id/fleet-replication', body);
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/follower hold/);
      expect(h.docker).toBe(0);
    });

    it(`${label} refuses with "can't confirm" when the bot does not answer`, async () => {
      h.factsOk = false;
      h.factsError = 'the bot process is not running';
      const res = await call('post', '/:id/fleet-replication', body);
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/Can't confirm/);
      expect(h.docker).toBe(0);
    });
  }
});

describe('Disable and decommission retract the block', () => {
  it('Disable clears the block the bot holds for this database', async () => {
    h.stubDisable = disabled;
    h.facts = { ...h.facts, copyBlock: { dsn: OWN_DSN, cert: CERT, publishedAt: 1 } };
    const res = await call('post', '/:id/fleet-replication', { enabled: false });
    expect(res.success).toBe(true);
    expect(cleared()).toHaveLength(1);
    expect(bot().copyBlockRetract).toBeUndefined();
    expect(res.copyBlockNote).toMatch(/no longer holds/);
  });

  it('Disable leaves a block that names another database alone', async () => {
    h.stubDisable = disabled;
    h.facts = { ...h.facts, copyBlock: { dsn: 'postgresql://replicator:x@other.invalid:15432/smdb?sslmode=verify-full', cert: CERT, publishedAt: 1 } };
    await call('post', '/:id/fleet-replication', { enabled: false });
    expect(cleared()).toHaveLength(0);
    expect(bot().copyBlockRetract).toBeUndefined();
  });

  it('Disable keeps the retraction recorded, and says so, when the bot does not answer', async () => {
    h.stubDisable = disabled;
    h.factsOk = false;
    const res = await call('post', '/:id/fleet-replication', { enabled: false });
    expect(res.success).toBe(true);
    expect(cleared()).toHaveLength(0);
    expect(bot().copyBlockRetract).toMatchObject({ host: 'primary.invalid', port: 15432 });
    expect(res.copyBlockNote).toMatch(/may still hold/);
  });

  it('a refused Disable records no retraction', async () => {
    h.stubDisable = async () => ({ success: false, error: 'Standbys are still streaming' });
    await call('post', '/:id/fleet-replication', { enabled: false });
    expect(bot().copyBlockRetract).toBeUndefined();
    expect(cleared()).toHaveLength(0);
  });

  it('decommission records the retraction for the bot to receive once it answers', async () => {
    writeRegistry({ status: 'stopped' });
    h.factsOk = false;
    const res = await call('post', '/:id/fleet-db/decommission');
    expect(res.success).toBe(true);
    expect(bot().copyBlockRetract).toMatchObject({ host: 'primary.invalid', port: 15432 });
    expect(res.copyBlockNote).toMatch(/may still hold/);
    expect(res.copyBlockNote).toMatch(/when its Database modal is opened/);
    expect(res.copyBlockNote).not.toMatch(/Replication section/);
  });

  it('a refused decommission records no retraction', async () => {
    h.decommission = { success: false, error: 'Stop the instance first' };
    await call('post', '/:id/fleet-db/decommission');
    expect(bot().copyBlockRetract).toBeUndefined();
  });

  it('reading the facts sends a recorded retraction once the bot answers, then drops the record', async () => {
    const { replication: _r, ...plain } = { ...fleetDb, replication };
    writeRegistry({ fleetDb: plain, copyBlockRetract: { host: 'primary.invalid', port: 15432, since: '2026-10-24T00:00:00.000Z' } });
    h.facts = { ...h.facts, copyBlock: { dsn: OWN_DSN, cert: CERT, publishedAt: 1 } };
    await call('get', '/:id/app-facts');
    await settle();
    expect(cleared()).toHaveLength(1);
    expect(bot().copyBlockRetract).toBeUndefined();
  });

  it('a recorded retraction is dropped unsent once replication names that endpoint again', async () => {
    writeRegistry({ copyBlockRetract: { host: 'primary.invalid', port: 15432, since: '2026-10-24T00:00:00.000Z' } });
    h.facts = { ...h.facts, copyBlock: { dsn: OWN_DSN, cert: CERT, publishedAt: 1 } };
    await call('get', '/:id/app-facts');
    await settle();
    expect(cleared()).toHaveLength(0);
    expect(bot().copyBlockRetract).toBeUndefined();
  });
});

describe('the page', () => {
  const pageHtml = fs.readFileSync(path.resolve(__dirname, '../../src/webui/public/index.html'), 'utf8');
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
  const run = (names: string[], globals: Record<string, unknown>): any => {
    const ctx = vm.createContext({ ...globals });
    vm.runInContext(names.map(pageFunction).join('\n'), ctx);
    return ctx;
  };

  it('the Enable toast carries the copy-block note', async () => {
    const messages: string[][] = [];
    const el: any = { value: 'primary.invalid', disabled: false };
    const ctx = run(['enableFleetReplication', 'fleetReplEnableNotes'], {
      document: { getElementById: () => el }, refuseBadNumbers: () => false,
      api: async () => ({ success: true, restartRequired: true, copyBlockNote: 'NOTE-TEXT' }),
      showMessage: (t: string, m: string) => messages.push([t, m]), showNoAnswer: () => {},
      renderFleetReplication: () => {}, loadBots: () => {},
    });
    await ctx.enableFleetReplication('b1');
    expect(messages[0][0]).toBe('success');
    expect(messages[0][1]).toContain('NOTE-TEXT');
  });

  it('the Disable toast carries the copy-block note', async () => {
    const messages: string[][] = [];
    const ctx = run(['disableFleetReplication'], {
      confirm: () => true, document: { getElementById: () => null },
      api: async () => ({ success: true, restartRequired: true, copyBlockNote: 'NOTE-TEXT' }),
      showMessage: (t: string, m: string) => messages.push([t, m]), showNoAnswer: () => {},
      renderFleetReplication: () => {}, loadBots: () => {},
    });
    await ctx.disableFleetReplication('b1');
    expect(messages[0][1]).toContain('NOTE-TEXT');
  });

  it('a covered panel offers neither Disable, the WAL bound Apply, nor the setup block', async () => {
    const body: any = { innerHTML: '', isConnected: true };
    const res = {
      success: true,
      replication: { enabled: true, publicHost: 'primary.invalid', hostPort: 15432, live: { sslOn: true, slotWalKeep: '-1', slots: [] }, reachability: null },
      standIn: { role: 'covered', namesThisNode: true, holdReason: 'behind', standInNodeId: 'n2' },
      block: { dsn: OWN_DSN, cert: CERT }, failback: null, failbackDeclined: null, failbackCancelable: false,
    };
    const ctx = run(['renderFleetReplication'], {
      document: { getElementById: () => body }, fleetBackupBotId: 'b1', bots: [{ id: 'b1', status: 'running', appHooks: true }],
      api: async () => res, setTimeout: () => {}, panelHasEntry: () => false, failbackRunHtml: () => '',
      escapeHtml: (s: unknown) => String(s), jsArg: (s: unknown) => JSON.stringify(s), failbackPhaseText: () => '',
    });
    await ctx.renderFleetReplication('b1');
    expect(body.innerHTML).toContain('BEHIND A STAND-IN');
    expect(body.innerHTML).not.toContain('fleet-repl-disable');
    expect(body.innerHTML).not.toContain('applyFleetReplBound');
    expect(body.innerHTML).not.toContain('Replica setup block');
  });

  it('the backup offers its held block only when the bot says it is current', async () => {
    const draw = async (current: boolean): Promise<string> => {
      const body: any = { innerHTML: '', isConnected: true };
      const ctx = run(['renderFleetReplica'], {
        document: { getElementById: () => body }, fleetBackupBotId: 'b1', replicaPollSeq: 0,
        bots: [{ id: 'b1', status: 'running', appHooks: true }],
        api: async (_m: string, url: string) => url.endsWith('/app-facts')
          ? { success: true, facts: { running: true, nodeId: 'n1', copyBlockPresent: true, copyBlockCurrent: current } }
          : { success: true, replica: { present: false }, failback: null, failbackDeclined: null, transfer: null },
        setTimeout: () => {}, panelHasEntry: () => false, failbackRunHtml: () => '', seedPurposeText: () => '',
        seedAfterRetire: () => false, seedWarningHtml: () => '', seedDumpHtml: () => '', transferPhaseText: () => '',
        failbackPhaseText: () => '', replicaPromiseText: () => '',
        escapeHtml: (s: unknown) => String(s), jsArg: (s: unknown) => JSON.stringify(s),
      });
      await ctx.renderFleetReplica('b1');
      expect(body.innerHTML).toContain('replica-dsn');
      return body.innerHTML;
    };
    expect(await draw(false)).not.toContain('Provision from the block');
    expect(await draw(true)).toContain('Provision from the block');
  });
});
