import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { describe, expect, it } from 'vitest';

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
const fns = (...names: string[]) => names.filter((n) => pageHtml.includes(`function ${n}(`));

const lost = async () => { throw Object.assign(new Error('No answer from the manager'), { noAnswer: true }); };
const hedged = (m: string[] | undefined) => !!m && m[0] === 'error' && /No answer from the manager; the .* may still be running/.test(m[1]);

describe('api() with a lost answer', () => {
  it('throws a no-answer error when fetch rejects or the body is not JSON', async () => {
    for (const fetch of [async () => { throw new TypeError('network'); }, async () => ({ json: async () => { throw new SyntaxError('html'); } })]) {
      const ctx = runPage(fns('api', 'noAnswerError').length === 2 ? ['api', 'noAnswerError'] : ['api'], { fetch, JSON });
      const err = await ctx.api('POST', '/x', {}).catch((e: any) => e);
      expect(err && err.noAnswer).toBe(true);
    }
  });
});

describe('write catches say the op may still be running and re-read', () => {
  const cases: [string, unknown[], string][] = [
    ['decommissionFleetDb', ['b1'], 'loadBots'],
    ['appDemote', ['b1'], 'loadBots'],
    ['restoreFleetBackupFile', ['b1', 'x.dump'], 'loadBots'],
    ['startRecoveryRescue', ['b1'], 'renderRecoveryChannel'],
    ['startRecoverySwap', ['b1'], 'renderRecoveryChannel'],
    ['cancelFailback', ['b1'], 'renderFleetReplica'],
    ['openFailback', ['b1'], 'renderFleetReplica'],
    ['adoptPromotedReplica', ['b1'], 'loadBots'],
    ['enableFleetReplication', ['b1'], 'renderFleetReplication'],
    ['fetchSource', ['s1'], 'loadSources'],
    ['addSource', [], 'loadSources'],
    ['restartBot', ['b1'], 'loadBots'],
  ];
  for (const [fn, args, reread] of cases) {
    it(fn, async () => {
      const messages: string[][] = [];
      const calls: string[] = [];
      const el: any = { value: 'h', disabled: false, textContent: '', querySelectorAll: () => [], classList: { add() {}, remove() {}, contains: () => true } };
      const g: Record<string, unknown> = {
        confirm: () => true, alert: () => {}, api: lost, fleetBackupBotId: null, bots: [], busyBots: new Set(), sources: [], setTimeout: (f: () => void) => f(),
        document: { getElementById: () => el },
        showMessage: (t: string, m: string) => messages.push([t, m]),
        refuseBadNumbers: () => false, botLabel: (id: string) => id, isTransientStatus: () => false,
        hideFleetBackups: () => {}, showFleetBackups: () => {}, hideAddSourceModal: () => {}, renderBots: () => {},
      };
      for (const r of ['loadBots', 'loadSources', 'renderRecoveryChannel', 'renderFleetReplica', 'renderFleetReplication']) g[r] = async () => { calls.push(r); };
      const ctx = runPage([fn, ...fns('showNoAnswer', 'waitForSourceUrl', 'restoreSharersText')], g);
      await ctx[fn](...args);
      expect(messages.some(hedged)).toBe(true);
      expect(calls).toContain(reread);
    });
  }
});

describe('the recovery channel section', () => {
  it('does not offer a fresh start when the rescue read fails, and polls again', async () => {
    const body: any = { innerHTML: '', isConnected: true };
    const timers: unknown[] = [];
    const ctx = runPage(fns('readRecoveryRescue', 'pollRecoveryChannel').concat(['renderRecoveryChannel', 'renderRescueBlock', 'escapeHtml']), {
      document: { getElementById: () => body }, fleetBackupBotId: 'b1', setTimeout: (f: unknown) => timers.push(f),
      loadBots: () => {},
      api: async (_m: string, ep: string) => ep.endsWith('recovery-channel') ? { success: true, channel: { armed: false } } : { success: false, error: 'busy' },
    });
    vm.runInContext('var recoveryChannelSeq = 0; var recoveryLastPhase = {}; var SWAP_PHASES = ["quiesce","catchup","promote","teardown","flip"];', ctx);
    await ctx.renderRecoveryChannel('b1');
    expect(body.innerHTML).not.toContain('Arm receiver');
    expect(timers.length).toBe(1);
  });
});

describe('the remaining write catches say the op may still be running and re-read', () => {
  const row: any = { dataset: { groupId: 'g', groupType: 'standalone', originalKey: 'K' }, querySelector: () => ({ value: 'v' }), querySelectorAll: () => [], classList: { remove() {} } };
  const cases: [string, unknown[], string][] = [
    ['changeSource', ['b1', 's2'], 'loadBots'],
    ['setBotWebAuth', ['b1', 'off'], 'loadBots'],
    ['dropFleetSlot', ['b1', 'slot1'], 'renderFleetReplication'],
    ['disableFleetReplication', ['b1'], 'renderFleetReplication'],
    ['armRecoveryReceiver', ['b1'], 'renderRecoveryChannel'],
    ['disarmRecoveryChannel', ['b1'], 'renderRecoveryChannel'],
    ['dismissTransfer', ['b1'], 'renderFleetReplica'],
    ['removeFleetReplica', ['b1', false, false], 'renderFleetReplica'],
    ['cancelReplicaSeed', ['b1', false, false, 'seed', ''], 'loadBots'],
    ['deleteSource', ['s1'], 'loadSources'],
    ['saveEditSource', [], 'loadSources'],
    ['saveVaultRow', [row], 'loadVault'],
    ['deleteVaultEntry', ['K'], 'loadVault'],
    ['deleteDeletedVaultEntry', ['K', 'g'], 'loadVault'],
    ['deleteDeletedVaultGroup', ['g', 'G'], 'loadVault'],
    ['addVaultEntry', [], 'loadVault'],
    ['toggleSourceAutoUpdate', ['s1', true], 'loadSources'],
  ];
  for (const [fn, args, reread] of cases) {
    it(fn, async () => {
      const messages: string[][] = [];
      const calls: string[] = [];
      const el: any = { value: '{"host":"h","port":1,"cert":"c","token":"t"}', disabled: false, textContent: '', querySelectorAll: () => [], classList: { add() {}, remove() {}, contains: () => true } };
      const g: Record<string, unknown> = {
        confirm: () => true, window: { confirm: () => true }, alert: () => {}, api: lost, fleetBackupBotId: 'b1', bots: [], busyBots: new Set(), editSourceId: 's1',
        document: { getElementById: () => el, querySelectorAll: () => [] }, newVaultHidden: false, vaultValuesCache: null,
        showMessage: (t: string, m: string) => messages.push([t, m]), lockBtns: () => () => {},
        refuseBadNumbers: () => false, botLabel: (id: string) => id, renderSeedBanner: async () => {}, hideEditSourceModal: () => {},
      };
      for (const r of ['loadBots', 'loadSources', 'loadVault', 'renderRecoveryChannel', 'renderFleetReplica', 'renderFleetReplication']) g[r] = async () => { calls.push(r); };
      const ctx = runPage([fn, ...fns('showNoAnswer')], g);
      await ctx[fn](...args);
      expect(messages.some(hedged)).toBe(true);
      expect(calls).toContain(reread);
    });
  }
});

describe('a provisioning request whose answer was lost', () => {
  for (const [fn, ep] of [['provisionFleetReplicaFromFacts', 'from-facts'], ['provisionFleetReplica', 'fleet-replica'], ['reseedStalePrimary', 'fleet-reseed']]) {
    it(`${fn} re-reads the instance and refuses a second press while it checks`, async () => {
      const messages: string[][] = [];
      const calls: string[] = [];
      const posts: string[] = [];
      let released = false;
      let release: () => void = () => {};
      const gate = new Promise<void>((r) => { release = () => { released = true; r(); }; });
      const el: any = { value: 'x', disabled: false, textContent: '' };
      const g: Record<string, unknown> = {
        confirm: () => true, window: { confirm: () => true }, fleetBackupBotId: 'b1', bots: [],
        document: { getElementById: () => el },
        setTimeout: (f: () => void) => { gate.then(f); },
        showMessage: (t: string, m: string) => messages.push([t, m]), refuseBadNumbers: () => false, botLabel: (id: string) => id,
        hideFleetBackups: () => { calls.push('hideFleetBackups'); },
        api: async (m: string, e: string) => {
          if (m === 'POST') { posts.push(e); throw Object.assign(new Error('x'), { noAnswer: true }); }
          return { success: true, replica: released ? { provisioning: { phase: 'copy' } } : null };
        },
      };
      for (const r of ['loadBots', 'renderFleetReplica']) g[r] = async () => { calls.push(r); };
      const ctx = runPage([fn, ...fns('showNoAnswer', 'followLostProvisioning', 'refuseWhileChecking')], g);
      vm.runInContext('var provisionChecking = new Set();', ctx);
      const first = ctx[fn]('b1');
      await new Promise((r) => setTimeout(r, 10));
      expect(messages.some(hedged)).toBe(true);
      expect(calls).toContain('loadBots');
      await ctx[fn]('b1');
      expect(posts.filter((p) => p.includes(ep)).length).toBe(1);
      release();
      await first;
      await new Promise((r) => setTimeout(r, 20));
      expect(calls).toContain(fn === 'reseedStalePrimary' ? 'hideFleetBackups' : 'renderFleetReplica');
    });
  }
});

describe('the env editor database check', () => {
  it('armRecoverySource hedges a lost answer and re-reads (its brace literal defeats the function scanner)', () => {
    const at = pageHtml.indexOf('async function armRecoverySource(');
    const body = pageHtml.slice(at, pageHtml.indexOf('async function disarmRecoveryChannel(', at));
    expect(body).toMatch(/catch \(err\) \{\s*showNoAnswer\('sender arming'\);\s*\}\s*renderRecoveryChannel\(botId\)/);
  });
  it('says the test got no answer when the request throws', () => {
    expect(pageFunction('saveEnvEditor')).toMatch(/connection test got no answer/);
  });
});

describe('a swap whose record closed', () => {
  const swap = { startedAt: 111, completedAt: 222 };
  let timers: unknown[] = [];
  const run = async (bot: unknown) => {
    const body: any = { innerHTML: '', isConnected: true };
    timers = [];
    const ctx = runPage(fns('readRecoveryRescue', 'pollRecoveryChannel').concat(['renderRecoveryChannel', 'renderRescueBlock', 'escapeHtml']), {
      document: { getElementById: () => body }, fleetBackupBotId: 'b1', setTimeout: (t: unknown) => timers.push(t), loadBots: () => {},
      api: async (_m: string, ep: string) => ep.endsWith('recovery-channel') ? { success: true, channel: { armed: false } }
        : ep.endsWith('recovery-rescue') ? { success: true, rescue: null }
          : bot ? { success: true, bot } : { success: false, error: 'busy' },
    });
    vm.runInContext('var recoveryChannelSeq = 0; var recoveryLastPhase = { b1: { phase: "flip", startedAt: 111, waits: 0 } }; var SWAP_PHASES = ["quiesce","catchup","promote","teardown","flip"];', ctx);
    await ctx.renderRecoveryChannel('b1');
    return body.innerHTML as string;
  };
  it('says the fleet is starting and keeps polling while the start runs', async () => {
    for (const fields of [{ status: 'building' }, { status: 'starting' }, { status: 'stopped', activeOp: 'start' }]) {
      const html = await run({ id: 'b1', ...fields, recoveryLastSwap: swap, fleetDb: { replication: { publicHost: 'h' } } });
      expect(html).toMatch(/fleet is starting/);
      expect(html).not.toMatch(/Start it from the bot list/);
      expect(timers.length).toBe(1);
    }
  });
  it('does not claim a start it has not read, and keeps polling', async () => {
    const html = await run({ id: 'b1', status: 'stopped', activeOp: null, recoveryLastSwap: swap, fleetDb: { replication: { publicHost: 'h' } } });
    expect(html).toMatch(/this machine now holds the primary/);
    expect(html).not.toMatch(/fleet is starting/);
    expect(html).toMatch(/has not shown yet/);
    expect(timers.length).toBe(1);
  });
  it('does not claim the swap finished when the flip did not stamp it', async () => {
    const html = await run({ id: 'b1', status: 'running', fleetDb: { replication: { publicHost: 'h' } } });
    expect(html).not.toMatch(/swap finished/);
    expect(html).toMatch(/can't confirm/);
  });
  it('does not claim the swap finished on a stamp from an earlier swap', async () => {
    const html = await run({ id: 'b1', status: 'running', recoveryLastSwap: { startedAt: 5, completedAt: 6 }, fleetDb: { replication: { publicHost: 'h' } } });
    expect(html).not.toMatch(/swap finished/);
  });
  it('states that this machine holds the primary and the fleet runs', async () => {
    const html = await run({ id: 'b1', status: 'running', recoveryLastSwap: swap, fleetDb: { replication: { publicHost: 'h' } } });
    expect(html).toMatch(/this machine now holds the primary/);
    expect(html).toMatch(/fleet is running/);
  });
  it('states that the fleet did not start', async () => {
    const html = await run({ id: 'b1', status: 'error', recoveryLastSwap: swap, fleetDb: { replication: { publicHost: 'h' } } });
    expect(html).toMatch(/this machine now holds the primary/);
    expect(html).toMatch(/did not start/);
    expect(timers.length).toBe(0);
  });
  it('states that the swap did not make this machine the primary', async () => {
    const html = await run({ id: 'b1', status: 'stopped', fleetDbReplica: { slot: 's' } });
    expect(html).toMatch(/did not make this machine the primary/);
  });
  it('hedges only when the instance cannot be read', async () => {
    const html = await run(null);
    expect(html).toMatch(/can't confirm/);
  });
});

describe('the armed receiver with no rescue record', () => {
  it('forgets the last swap phase so a later disarm reports no swap outcome', async () => {
    const body: any = { innerHTML: '', isConnected: true };
    const ctx = runPage(fns('readRecoveryRescue', 'pollRecoveryChannel').concat(['renderRecoveryChannel', 'renderRescueBlock', 'escapeHtml']), {
      document: { getElementById: () => body }, fleetBackupBotId: 'b1', setTimeout: () => {}, loadBots: () => {},
      api: async (_m: string, ep: string) => ep.endsWith('recovery-channel') ? { success: true, channel: { armed: true, mode: 'receiver', publicHost: 'h', tunnelPort: 1 } }
        : { success: true, rescue: null },
    });
    vm.runInContext('var recoveryChannelSeq = 0; var recoveryLastPhase = { b1: { phase: "catchup", startedAt: 1, waits: 0 } }; var SWAP_PHASES = ["quiesce","catchup","promote","teardown","flip"];', ctx);
    await ctx.renderRecoveryChannel('b1');
    expect(vm.runInContext('recoveryLastPhase.b1', ctx)).toBeUndefined();
  });
});
