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
const hedged = (m: string[] | undefined) => !!m && m[0] === 'error' && /No answer from the manager(; the .* may still be running|, so the .* can't be confirmed)/.test(m[1]);

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
    ['restoreFleetBackupFile', ['b1', 'x.dump'], 'loadBots'],
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
      for (const r of ['loadBots', 'loadSources', 'renderFleetReplica', 'renderFleetReplication']) g[r] = async () => { calls.push(r); };
      const ctx = runPage([fn, ...fns('showNoAnswer', 'waitForSourceUrl', 'restoreSharersText')], g);
      await ctx[fn](...args);
      expect(messages.some(hedged)).toBe(true);
      expect(calls).toContain(reread);
    });
  }
});

describe('the remaining write catches say the op may still be running and re-read', () => {
  const row: any = { dataset: { groupId: 'g', groupType: 'standalone', originalKey: 'K' }, querySelector: () => ({ value: 'v' }), querySelectorAll: () => [], classList: { remove() {} } };
  const cases: [string, unknown[], string][] = [
    ['changeSource', ['b1', 's2'], 'loadBots'],
    ['setBotWebAuth', ['b1', 'off'], 'loadBots'],
    ['dropFleetSlot', ['b1', 'slot1'], 'renderFleetReplication'],
    ['disableFleetReplication', ['b1'], 'renderFleetReplication'],
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
      for (const r of ['loadBots', 'loadSources', 'loadVault', 'renderFleetReplica', 'renderFleetReplication']) g[r] = async () => { calls.push(r); };
      const ctx = runPage([fn, ...fns('showNoAnswer')], g);
      await ctx[fn](...args);
      expect(messages.some(hedged)).toBe(true);
      expect(calls).toContain(reread);
    });
  }
});

describe('a provisioning request whose answer was lost', () => {
  for (const [fn, ep] of [['provisionFleetReplica', 'fleet-replica'], ['reseedStalePrimary', 'fleet-reseed']]) {
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
      const ctx = runPage([fn, ...fns('showNoAnswer', 'followLostProvisioning', 'refuseWhileChecking', 'postProvision')], g);
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
  it('says the test got no answer when the request throws', () => {
    expect(pageFunction('saveEnvEditor')).toMatch(/connection test got no answer/);
  });
});
