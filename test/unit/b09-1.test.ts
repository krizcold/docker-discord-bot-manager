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

describe('the restore request toast', () => {
  it('shows no success styling before the server answers', async () => {
    const messages: string[][] = [];
    let atRequest: string[][] = [];
    const ctx = runPage(['restoreFleetBackupFile', 'restoreSharersText'], {
      confirm: () => true,
      document: { getElementById: () => ({ querySelectorAll: () => [] }) },
      showMessage: (t: string, m: string) => messages.push([t, m]),
      api: async () => { atRequest = [...messages]; return { success: false, error: 'dump missing' }; },
      loadBots: async () => {}, showFleetBackups: () => {}, fleetBackupBotId: null, alert: () => {},
    });
    await ctx.restoreFleetBackupFile('b1', 'x.dump');
    expect(atRequest.every(([t]) => t !== 'success')).toBe(true);
    expect(messages[messages.length - 1]).toEqual(['error', 'dump missing']);
  });
});

describe('copy buttons', () => {
  const page = (writeText: (t: string) => Promise<void>) => {
    const messages: string[][] = [];
    const ctx = runPage(fns('copyToClipboard', 'copyFleetReplBlock', 'copyFleetReplCert'), {
      navigator: { clipboard: { writeText } },
      document: { getElementById: () => ({ value: 'secret-dsn' }) },
      showMessage: (t: string, m: string) => messages.push([t, m]),
      setTimeout: () => {},
    });
    return { ctx, messages };
  };
  for (const fn of ['copyFleetReplBlock', 'copyFleetReplCert']) {
    it(`${fn} says Copied only when the browser copied`, async () => {
      const { ctx, messages } = page(() => Promise.reject(new Error('denied')));
      const btn = { textContent: 'Copy' };
      await ctx[fn](btn);
      await new Promise((r) => setImmediate(r));
      expect(btn.textContent).toBe('Copy');
      expect(messages[0]?.[0]).toBe('error');
    });
    it(`${fn} says Copied after a copy`, async () => {
      const copied: string[] = [];
      const { ctx } = page(async (t) => { copied.push(t); });
      const btn = { textContent: 'Copy' };
      await ctx[fn](btn);
      expect(copied).toEqual(['secret-dsn']);
      expect(btn.textContent).toBe('Copied');
    });
  }
  it('the fleet URL copy button says Copied only when the browser copied', async () => {
    const m = pageHtml.match(/btn\.addEventListener\('click', (\(\) => [^\n]*)\);\n/);
    expect(m).not.toBeNull();
    const { ctx, messages } = page(() => Promise.reject(new Error('denied')));
    const btn = { textContent: 'Copy' };
    Object.assign(ctx, { btn, urlOf: () => 'https://x' });
    await vm.runInContext(`(${m![1]})()`, ctx);
    await new Promise((r) => setImmediate(r));
    expect(btn.textContent).toBe('Copy');
    expect(messages[0]?.[0]).toBe('error');
  });
});

describe('instance auto-update controls', () => {
  const run = async (fn: string, args: unknown[], answer: any) => {
    let reloads = 0;
    const ctx = runPage([fn, ...fns('showNoAnswer')], {
      api: async () => { if (answer instanceof Error) throw answer; return answer; },
      showMessage: () => {}, loadBots: () => { reloads++; }, bots: [{ id: 'b1', autoUpdate: true }],
    });
    await ctx[fn](...args);
    return reloads;
  };
  for (const [fn, args] of [
    ['toggleBotAutoUpdate', ['b1', false]], ['setBotAutoUpdateInterval', ['b1', 6]],
    ['setBotAutoUpdateHour', ['b1', 3]], ['setBotWebAuth', ['b1', 'public']],
  ] as [string, unknown[]][]) {
    it(`${fn} re-renders from the stored state when refused`, async () => {
      expect(await run(fn, args, { success: false, error: 'no' })).toBeGreaterThan(0);
    });
    it(`${fn} re-renders from the stored state when the request fails`, async () => {
      expect(await run(fn, args, new Error('offline'))).toBeGreaterThan(0);
    });
  }
});

describe('fleet backup settings', () => {
  const page = (answer: any, stored = { enabled: true, hour: 4, keep: 7 }) => {
    const els: Record<string, any> = {
      'fleet-backup-enabled': { checked: false },
      'fleet-backup-hour': { value: '9' },
      'fleet-backup-keep': { value: '30' },
    };
    const messages: string[][] = [];
    const ctx = runPage(fns('saveFleetBackupConfig', 'showFleetBackupControls', 'showNoAnswer'), {
      document: { getElementById: (id: string) => els[id] },
      isBadNumber: () => false, confirm: () => true,
      api: async () => { if (answer instanceof Error) throw answer; return answer; },
      showMessage: (t: string, m: string) => messages.push([t, m]),
      loadBots: () => {}, fleetBackupBotId: 'b1',
    });
    vm.runInContext(`var fleetBackupStored = ${JSON.stringify(stored)};`, ctx);
    return { ctx, els, messages };
  };
  const shown = (els: Record<string, any>) => [els['fleet-backup-enabled'].checked, els['fleet-backup-hour'].value, els['fleet-backup-keep'].value];

  it('shows the stored values again when the save is refused', async () => {
    const { ctx, els, messages } = page({ success: false, error: 'locked' });
    await ctx.saveFleetBackupConfig();
    expect(shown(els)).toEqual([true, '4', '7']);
    expect(messages).toEqual([['error', 'locked']]);
  });
  it('shows the stored values again when the request fails', async () => {
    const { ctx, els } = page(new Error('offline'));
    await ctx.saveFleetBackupConfig();
    expect(shown(els)).toEqual([true, '4', '7']);
  });
  it('shows what the server stored on success', async () => {
    const { ctx, els } = page({ success: true, fleetBackup: { enabled: false, hour: 9, keep: 20 } });
    await ctx.saveFleetBackupConfig();
    expect(shown(els)).toEqual([false, '9', '20']);
  });
  it("says it can't confirm when the server answers without the settings", async () => {
    const { ctx, messages } = page({ success: true });
    await ctx.saveFleetBackupConfig();
    expect(messages[0][0]).toBe('error');
    expect(messages[0][1]).toMatch(/Can't confirm/);
  });
});
