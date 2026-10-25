import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'b21-3-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return {
    dir,
    calls: [] as Array<{ args: string[]; stdin: string }>,
    startBot: null as null | (() => Promise<{ success: boolean; error?: string }>),
    startCalls: 0,
    hookWait: { success: true } as { success: boolean; error?: string },
    roleReset: { success: true } as { success: boolean; error?: string; unknown?: boolean },
    roleResetCalls: 0,
    recordAtRoleReset: undefined as any,
    hooks: true,
  };
});

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const { EventEmitter } = await import('events');
  const { PassThrough } = await import('stream');
  const execFile = (_cmd: string, args: string[], opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    const call = { args, stdin: '' };
    h.calls.push(call);
    const child: any = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdin.on('data', (d: Buffer) => { call.stdin += d.toString(); });
    child.kill = () => {};
    setTimeout(() => done(null, '', ''), 2);
    return child;
  };
  const exec = (_cmd: string, opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    done(null, { stdout: '', stderr: '' });
  };
  return { ...real, execFile, exec, default: { ...real, execFile, exec } };
});
vi.mock('../../src/docker/containerManager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/docker/containerManager')>()),
  startBot: async () => {
    h.startCalls++;
    return h.startBot!();
  },
}));
vi.mock('../../src/instance/fleetReplication', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/fleetReplication')>()),
  enableFleetReplication: async () => ({ success: true }),
}));
vi.mock('../../src/instance/appHookClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/appHookClient')>()),
  hasAppHooks: () => h.hooks,
}));
vi.mock('../../src/instance/appLifecycle', async (importOriginal) => {
  const cm = await import('../../src/docker/containerManager');
  return {
    ...(await importOriginal<typeof import('../../src/instance/appLifecycle')>()),
    waitForAppHook: async () => h.hookWait,
    deliverCopyBlock: async () => ({ success: true }),
    resetRole: async () => {
      h.roleResetCalls++;
      h.recordAtRoleReset = cm.getBot('b1')?.recoveryRescue;
      return h.roleReset;
    },
  };
});

import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import * as containerManager from '../../src/docker/containerManager';
import * as envManager from '../../src/env/manager';
import { resumeRecoveryRescues, startRescue } from '../../src/instance/recoveryRescue';

const botDir = path.join(h.dir, 'bots', 'b1');
const dbUrl = 'postgresql://smdb:Db-Secret-0123456789@bot1-fleet-postgres:5432/smdb?sslmode=no-verify';
const fleetDb = { containerName: 'bot1-fleet-postgres', user: 'smdb', db: 'smdb', volume: 'bot1-fleet-postgres-data' };
const replication = { role: 'replicator', password: 'Repl-Secret-0123456789', hostPort: 15432, publicHost: 'primary.invalid', certHost: 'primary.invalid', slotWalKeepMb: 4096 };

const writeRegistry = (extra: Record<string, unknown> = {}, id = 'b1'): void => {
  fs.mkdirSync(path.join(h.dir, 'bots', id, 'env'), { recursive: true });
  fs.writeFileSync(path.join(h.dir, 'instances.json'), JSON.stringify({
    instances: {
      [id]: {
        id, sanitizedName: 'bot1', displayName: 'Bot 1', titleName: 'Bot 1', status: 'stopped',
        sourceType: 'git', sourceUrl: 'https://example.invalid/fake/super-modular-discord-bot',
        envVars: { DATA_BACKEND: 'postgres' },
        fleetDb: { ...fleetDb, replication },
        createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z',
        ...extra,
      },
    },
  }));
};
const flipRecord = (extra: Record<string, unknown> = {}) => ({ phase: 'flip', startedAt: 1000, updatedAt: 1000, swapPublicHost: 'primary.invalid', swapSourceTerm: null, ...extra });
const rescueOf = (id = 'b1') => containerManager.getBot(id)?.recoveryRescue;
const waitFor = async (cond: () => boolean): Promise<void> => {
  for (let i = 0; i < 400 && !cond(); i++) await new Promise(r => setTimeout(r, 10));
};
const alterCalls = () => h.calls.filter(c => /ALTER ROLE/.test(c.stdin));

beforeEach(() => {
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
  fs.mkdirSync(path.join(botDir, 'env'), { recursive: true });
  writeRegistry();
  envManager.setEnvVars('b1', { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: dbUrl });
  h.calls.length = 0;
  h.startBot = async () => ({ success: true });
  h.startCalls = 0;
  h.hookWait = { success: true };
  h.roleReset = { success: true };
  h.roleResetCalls = 0;
  h.recordAtRoleReset = undefined;
  h.hooks = true;
});

afterAll(() => {
  fs.rmSync(h.dir, { recursive: true, force: true });
});

describe('a flip whose start fails keeps its record', () => {
  it('keeps the flip record with the reason when the start throws on a held op lock, and logs retrying only with a record', async () => {
    writeRegistry({ recoveryRescue: flipRecord() }, 'bs1');
    envManager.setEnvVars('bs1', { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: dbUrl });
    h.startBot = async () => { throw new Error("Operation 'update' is already in progress for this bot"); };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const retryLogs: Array<{ withRecord: boolean }> = [];
    warn.mockImplementation((...args: unknown[]) => {
      if (/retrying/.test(String(args[0]))) retryLogs.push({ withRecord: !!rescueOf('bs1') });
    });
    try {
      resumeRecoveryRescues();
      await waitFor(() => h.startCalls > 0 && retryLogs.length > 0);
      const rec = rescueOf('bs1');
      expect(rec?.phase).toBe('flip');
      expect(rec?.flipStep).toBe('start');
      expect(rec?.lastError).toBe("The swap finished but the fleet did not start: Operation 'update' is already in progress for this bot; the manager retries every 30 s, or start it from the bot list");
      expect(retryLogs.length).toBeGreaterThan(0);
      expect(retryLogs.every(l => l.withRecord)).toBe(true);
      expect(containerManager.getBot('bs1')?.recoveryLastSwap).toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps the record when the start answers a refusal', async () => {
    writeRegistry({ recoveryRescue: flipRecord() }, 'bs2');
    envManager.setEnvVars('bs2', { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: dbUrl });
    h.startBot = async () => ({ success: false, error: 'compose up failed' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      resumeRecoveryRescues();
      await waitFor(() => !!rescueOf('bs2')?.lastError);
      expect(rescueOf('bs2')?.lastError).toMatch(/^The swap finished but the fleet did not start: compose up failed;/);
      expect(h.roleResetCalls).toBe(0);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('a flip resumed at boot runs only its remaining sub-steps', () => {
  it('starts the fleet without reconciling the credentials again', async () => {
    writeRegistry({ recoveryRescue: flipRecord({ flipStep: 'start' }) });
    resumeRecoveryRescues();
    await waitFor(() => !rescueOf());
    expect(alterCalls()).toEqual([]);
    expect(h.startCalls).toBe(1);
    expect(h.roleResetCalls).toBe(1);
    expect(containerManager.getBot('b1')?.recoveryLastSwap?.startedAt).toBe(1000);
  });

  it('skips the start when the fleet already runs', async () => {
    writeRegistry({ status: 'running', recoveryRescue: flipRecord({ flipStep: 'start' }) });
    resumeRecoveryRescues();
    await waitFor(() => !rescueOf());
    expect(h.startCalls).toBe(0);
    expect(h.roleResetCalls).toBe(1);
  });

  it('resumes at the role reset without starting again', async () => {
    writeRegistry({ status: 'running', recoveryRescue: flipRecord({ flipStep: 'role' }) });
    resumeRecoveryRescues();
    await waitFor(() => !rescueOf());
    expect(alterCalls()).toEqual([]);
    expect(h.startCalls).toBe(0);
    expect(h.roleResetCalls).toBe(1);
    expect(containerManager.getBot('b1')?.recoveryLastSwap?.startedAt).toBe(1000);
  });
});

describe('the record stays until the role reset answers', () => {
  it('holds the flip record at the role step while the role reset runs, then clears it with the last swap', async () => {
    writeRegistry({ recoveryRescue: flipRecord() });
    resumeRecoveryRescues();
    await waitFor(() => !rescueOf());
    expect(alterCalls().length).toBe(1);
    expect(h.startCalls).toBe(1);
    expect(h.recordAtRoleReset?.phase).toBe('flip');
    expect(h.recordAtRoleReset?.flipStep).toBe('role');
    expect(containerManager.getBot('b1')?.recoveryLastSwap?.startedAt).toBe(1000);
  });

  it('parks with can\'t confirm when the role reset gets no answer', async () => {
    writeRegistry({ recoveryRescue: flipRecord() });
    h.roleReset = { success: false, unknown: true, error: 'role-reset sent, no answer within 30 s' };
    resumeRecoveryRescues();
    await waitFor(() => rescueOf()?.parked === true);
    const rec = rescueOf();
    expect(rec?.flipStep).toBe('role');
    expect(rec?.lastError).toBe("The fleet started, but can't confirm the app returned to its configured role: role-reset sent, no answer within 30 s; Continue sends the role reset again");
    expect(containerManager.getBot('b1')?.recoveryLastSwap).toBeUndefined();
  });

  it('parks with the app\'s reason when the role reset is refused', async () => {
    writeRegistry({ recoveryRescue: flipRecord() });
    h.roleReset = { success: false, error: 'the app refused' };
    resumeRecoveryRescues();
    await waitFor(() => rescueOf()?.parked === true);
    expect(rescueOf()?.lastError).toBe('The fleet started, but the app did not return to its configured role: the app refused; fix the cause, then Continue');
  });

  it('parks when the started app never answers its hooks', async () => {
    writeRegistry({ recoveryRescue: flipRecord() });
    h.hookWait = { success: false, error: 'the app did not answer its hooks within 90 s (fetch failed)' };
    resumeRecoveryRescues();
    await waitFor(() => rescueOf()?.parked === true);
    expect(rescueOf()?.lastError).toBe('The fleet started, but the app did not answer its hooks within 90 s (fetch failed); check the app, then Continue to publish the copy block and return it to its configured role');
    expect(h.roleResetCalls).toBe(0);
  });

  it('finishes after the start when the app declares no hooks', async () => {
    writeRegistry({ recoveryRescue: flipRecord() });
    h.hooks = false;
    resumeRecoveryRescues();
    await waitFor(() => !rescueOf());
    expect(h.startCalls).toBe(1);
    expect(h.roleResetCalls).toBe(0);
    expect(containerManager.getBot('b1')?.recoveryLastSwap?.startedAt).toBe(1000);
  });
});

describe('Continue on a parked flip', () => {
  it('re-enters the flip with the channel gone and the fleet running', async () => {
    writeRegistry({ status: 'running', recoveryRescue: flipRecord({ flipStep: 'role', parked: true, lastError: 'x' }) });
    const res = await startRescue(containerManager.getBot('b1')!, false);
    expect(res).toEqual({ success: true });
    await waitFor(() => !rescueOf());
    expect(h.roleResetCalls).toBe(1);
    expect(containerManager.getBot('b1')?.recoveryLastSwap?.startedAt).toBe(1000);
  });
});

describe('the start guard during the flip', () => {
  it('lets the fleet start once the flip has filed the copy as primary', () => {
    writeRegistry({ recoveryRescue: flipRecord({ flipStep: 'start' }) });
    expect(containerManager.startPreflightRefusal('b1')).toBeNull();
    writeRegistry({ recoveryRescue: flipRecord({ flipStep: 'role' }) });
    expect(containerManager.startPreflightRefusal('b1')).toBeNull();
  });

  it('still refuses before the flip has reconciled the database', () => {
    writeRegistry({ recoveryRescue: flipRecord() });
    expect(containerManager.startPreflightRefusal('b1')?.error).toMatch(/database rescue/);
    writeRegistry({ recoveryRescue: flipRecord({ phase: 'streaming' }) });
    expect(containerManager.startPreflightRefusal('b1')?.error).toMatch(/database rescue/);
  });
});

describe('the page during the flip', () => {
  const pageHtml = fs.readFileSync(path.resolve(__dirname, '../../src/webui/public/index.html'), 'utf8');
  const pageFunction = (name: string): string => {
    let start = pageHtml.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`no function ${name}`);
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
  const runPage = (names: string[], globals: Record<string, unknown>): any => {
    const ctx = vm.createContext({ ...globals });
    vm.runInContext(names.map(pageFunction).join('\n'), ctx);
    return ctx;
  };
  const card = async (rescue: Record<string, unknown>): Promise<string> => {
    const body: any = { innerHTML: '', isConnected: true };
    const ctx = runPage(['readRecoveryRescue', 'pollRecoveryChannel', 'renderRecoveryChannel', 'renderRescueBlock', 'escapeHtml'], {
      document: { getElementById: () => body }, fleetBackupBotId: 'b1', setTimeout: () => {}, loadBots: () => {},
      api: async (_m: string, ep: string) => ep.endsWith('recovery-channel') ? { success: true, channel: { armed: false } }
        : { success: true, rescue: { startedAt: 1000, ...rescue } },
    });
    vm.runInContext('var recoveryChannelSeq = 0; var recoveryLastPhase = {}; var SWAP_PHASES = ["quiesce","catchup","promote","teardown","flip"];', ctx);
    await ctx.renderRecoveryChannel('b1');
    return body.innerHTML as string;
  };

  it('names the start sub-step and shows why the start failed', async () => {
    const html = await card({ phase: 'flip', flipStep: 'start', lastError: 'The swap finished but the fleet did not start: an operation is running' });
    expect(html).toContain('this database is the primary; starting the fleet');
    expect(html).not.toMatch(/filing this database/);
    expect(html).toContain('The swap finished but the fleet did not start: an operation is running');
    expect(html).not.toMatch(/Cancel rescue/);
  });

  it('names the role sub-step on a parked flip and offers Continue', async () => {
    const html = await card({ phase: 'flip', flipStep: 'role', parked: true, lastError: 'the role reset was refused: hooks busy' });
    expect(html).toMatch(/returning the app to its configured role/);
    expect(html).toContain('the role reset was refused: hooks busy');
    expect(html).toMatch(/>Continue</);
  });

  it('does not promise in the swap toast that the fleet starts', async () => {
    const messages: string[][] = [];
    const ctx = runPage(['startRecoverySwap'], {
      api: async () => ({ success: true }), confirm: () => true, showNoAnswer: () => {}, renderRecoveryChannel: () => {},
      showMessage: (t: string, m: string) => messages.push([t, m]),
    });
    await ctx.startRecoverySwap('b1');
    expect(messages).toHaveLength(1);
    expect(messages[0][0]).toBe('success');
    expect(messages[0][1]).not.toMatch(/starts the fleet|fleet starts/);
  });
});
