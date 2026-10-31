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

const rec = (state: string, held?: unknown) => ({ state, message: '', orderedAt: '2026-10-31T10:00:00.000Z', settled: true, hook: 'confirmed', login: 'not-managed', savedByBot: 'maintenance', ...(held ? { held } : {}) });

const load = (bot: Record<string, unknown>, opts: { answer?: boolean; choice?: string } = {}) => {
  const seen = { confirm: [] as string[], calls: [] as Array<[string, string, unknown]> };
  const ctx = vm.createContext({
    bots: [bot],
    busyBots: new Set(),
    renderBots: () => {},
    redraw: () => {},
    loadBots: () => {},
    isTransientStatus: () => false,
    openTerminalPopup: () => {},
    streamBuildLogs: () => {},
    addTerminalLog: () => {},
    markTerminalComplete: () => {},
    showMessage: () => {},
    showNoAnswer: () => {},
    hideStateWindow: () => {},
    terminalBotId: null,
    confirm: (text: string) => { seen.confirm.push(text); return opts.answer !== false; },
    api: async (method: string, url: string, body?: unknown) => { seen.calls.push([method, url, body]); return { success: true }; },
    document: {
      querySelector: () => ({ value: opts.choice ?? 'off' }),
      getElementById: () => ({ value: '', disabled: false, textContent: '' }),
    },
    String, Number, Set,
  });
  vm.runInContext(['heldWarningText', 'restartBot', 'stopBot', 'updateBot', 'startBot', 'applyState'].map(pageFunction).join('\n'), ctx);
  return { ctx: ctx as any, seen };
};

const NO = { state: 'no', guilds: 2, files: 1 };
const UNKNOWN = { state: 'unknown' };
const LEAD_NO = 'The bot reports changes it could not save: 2 guild(s), 1 file(s).';
const LEAD_UNKNOWN = "The manager can't confirm the bot saved the changes it holds.";
const running = (m: unknown) => ({ id: 'b1', displayName: 'B1', status: 'running', maintenance: m });

describe('NM8 W: the restart warning', () => {
  it.each([
    ['restart', 'no', NO, `${LEAD_NO} A restart stops the bot and drops those changes. Restart anyway?`],
    ['restart', 'unknown', UNKNOWN, `${LEAD_UNKNOWN} A restart stops the bot and drops any it still holds. Restart anyway?`],
    ['update', 'no', NO, `${LEAD_NO} An update recreates the bot and drops those changes. Update anyway?`],
    ['update', 'unknown', UNKNOWN, `${LEAD_UNKNOWN} An update recreates the bot and drops any it still holds. Update anyway?`],
    ['apply', 'no', NO, `${LEAD_NO} Apply recreates the bot and drops those changes. Apply anyway?`],
    ['apply', 'unknown', UNKNOWN, `${LEAD_UNKNOWN} Apply recreates the bot and drops any it still holds. Apply anyway?`],
    ['off', 'no', NO, `${LEAD_NO} Off stops the bot and drops those changes. Choose Off anyway?`],
    ['off', 'unknown', UNKNOWN, `${LEAD_UNKNOWN} Off stops the bot and drops any it still holds. Choose Off anyway?`],
    ['stop', 'no', NO, `${LEAD_NO} Stopping the bot drops those changes. Stop anyway?`],
    ['stop', 'unknown', UNKNOWN, `${LEAD_UNKNOWN} Stopping the bot drops any it still holds. Stop anyway?`],
  ])('%s with held %s', (action, _n, held, text) => {
    const { ctx } = load(running(rec('maintenance', held)));
    expect(ctx.heldWarningText(ctx.bots[0], action)).toBe(text);
  });

  it('the note is shown as it is, after the lead', () => {
    const { ctx } = load(running(rec('maintenance', { ...NO, note: 'Guild g1 was refused.' })));
    expect(ctx.heldWarningText(ctx.bots[0], 'restart')).toBe(`${LEAD_NO} The bot's note: Guild g1 was refused. A restart stops the bot and drops those changes. Restart anyway?`);
  });

  it.each([
    ['held yes', running(rec('maintenance', { state: 'yes' }))],
    ['held stopped', running(rec('maintenance', { state: 'stopped' }))],
    ['held not-running', running(rec('maintenance', { state: 'not-running' }))],
    ['no held', running(rec('maintenance'))],
    ['state Running with an older answer', running(rec('running', NO))],
    ['no record', running(undefined)],
    ['a stopped container', { ...running(rec('maintenance', NO)), status: 'stopped' }],
  ])('no warning: %s', (_n, bot) => {
    const { ctx } = load(bot);
    for (const action of ['restart', 'update', 'apply', 'off', 'stop']) expect(ctx.heldWarningText(ctx.bots[0], action)).toBe('');
  });
});

describe('NM8 W: the buttons ask first and send nothing on cancel', () => {
  const cases: Array<[string, (ctx: any) => Promise<unknown>, string]> = [
    ['Restart', ctx => ctx.restartBot('b1'), '/bots/b1/restart'],
    ['Update', ctx => ctx.updateBot('b1'), '/bots/b1/update'],
    ['Apply', ctx => ctx.startBot('b1', 'Applying'), '/bots/b1/start'],
    ['Off', ctx => ctx.applyState('b1'), '/bots/b1/maintenance'],
    ['Stop', ctx => ctx.stopBot('b1'), '/bots/b1/stop'],
  ];
  it.each(cases)('%s with held no: confirm, then the call', async (_n, run, url) => {
    const { ctx, seen } = load(running(rec('maintenance', NO)));
    await run(ctx);
    expect(seen.confirm).toHaveLength(1);
    expect(seen.confirm[0].startsWith(LEAD_NO)).toBe(true);
    expect(seen.calls.map(c => c[1])).toEqual([url]);
  });
  it.each(cases)('%s with held no, cancelled: no call', async (_n, run) => {
    const { ctx, seen } = load(running(rec('maintenance', NO)), { answer: false });
    await run(ctx);
    expect(seen.confirm).toHaveLength(1);
    expect(seen.calls).toEqual([]);
  });
  it.each(cases)('%s with held yes: no confirm', async (_n, run, url) => {
    const { ctx, seen } = load(running(rec('maintenance', { state: 'yes' })));
    await run(ctx);
    expect(seen.confirm).toEqual([]);
    expect(seen.calls.map(c => c[1])).toEqual([url]);
  });

  it('a plain Start asks nothing', async () => {
    const { ctx, seen } = load(running(rec('maintenance', NO)));
    await ctx.startBot('b1');
    expect(seen.confirm).toEqual([]);
  });
  it('choosing Maintenance asks nothing', async () => {
    const { ctx, seen } = load(running(rec('maintenance', NO)), { choice: 'maintenance' });
    await ctx.applyState('b1');
    expect(seen.confirm).toEqual([]);
    expect(seen.calls).toHaveLength(1);
  });
  it.each([['no', NO, LEAD_NO], ['unknown', UNKNOWN, LEAD_UNKNOWN]])('Off again while the record says Off and the bot still runs, held %s: it warns', async (_n, held, lead) => {
    const { ctx, seen } = load(running(rec('off', held)));
    await ctx.applyState('b1');
    expect(seen.confirm).toHaveLength(1);
    expect(seen.confirm[0].startsWith(lead as string)).toBe(true);
    expect(seen.calls.map(c => c[1])).toEqual(['/bots/b1/maintenance']);
  });
  it('Off again while the record says Off and the bot is stopped asks nothing', async () => {
    const { ctx, seen } = load({ ...running(rec('off', NO)), status: 'stopped' });
    await ctx.applyState('b1');
    expect(seen.confirm).toEqual([]);
  });
  it.each([['no', NO], ['unknown', UNKNOWN]])('Stop of a stopped bot with held %s asks nothing', async (_n, held) => {
    const { ctx, seen } = load({ ...running(rec('maintenance', held)), status: 'stopped' });
    await ctx.stopBot('b1');
    expect(seen.confirm).toEqual([]);
  });
});
