import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { actionRows, LANE_NOT_CONFIRMED, laneOutcome, RUN_AGAIN_LIMIT_MS } from '../../src/cli/tui/actions';
import { laneCall } from '../../src/cli/tui/api';
import { dumpTiming, restoreCountTiming, tocTiming } from '../../src/instance/fleetBackup';
import { START_DB_READY } from '../../src/docker/containerManager';
import { refused, Reply } from './m2-fake';
import { switchBody } from './m4-fake';
import { laneAccepted, switchFrame } from './m5-fake';
import { B, bars, calls, closeAll, mainLaneBot, mainRoutes, take, tick, toDb, wsFake } from './m5-lanekit';

vi.setConfig({ testTimeout: 40_000 });
afterEach(closeAll);

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

type Seen = { confirm: string[]; messages: Array<[string, string]>; calls: Array<[string, string, unknown]> };

const load = (names: string[], answers: (method: string, url: string, body: unknown) => unknown, extra: Record<string, unknown> = {}) => {
  const seen: Seen = { confirm: [], messages: [], calls: [] };
  const ctx = vm.createContext({
    api: async (method: string, url: string, body?: unknown) => { seen.calls.push([method, url, body]); return answers(method, url, body); },
    confirm: (text: string) => { seen.confirm.push(text); return true; },
    showMessage: (kind: string, text: string) => { seen.messages.push([kind, text]); },
    showNoAnswer: () => {},
    renderFleetSwitch: () => {},
    fleetBackupBotId: null,
    bots: [{ id: 'b1', displayName: 'Bot 1' }],
    Array, String, Number, JSON, Date, Math, Object, encodeURIComponent,
    ...extra,
  });
  vm.runInContext(names.map(pageFunction).join('\n'), ctx);
  return { ctx, seen };
};

const unescape = (s: string) => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const titles = (html: string) => [...html.matchAll(/title="([^"]*)"/g)].map(m => unescape(m[1]));

const ALONE = { mode: 'stream', phase: 'stopped', machine: 'copy.example', at: '2026-11-20T10:00:00.000Z' };
const WAITING = { ...ALONE, phase: 'waiting' };
const F = 'pre-receive-2026-11-20T11-00-00-000Z.dump';
const WAITING_NO_ADDRESS = "The hand-over to copy.example did not finish, and copy.example has no address for other machines. Hand over again finishes it while copy.example's copy streams from this database; Receive a main takes the main back when copy.example's copy is not connected; Cancel the hand-over ends it when copy.example's copy receives the cancel; if copy.example is lost for good, press Run the main here again.";

describe('NM42 row 15: the web page', () => {
  const panel = (bot: unknown, view: unknown) => {
    const { ctx } = load(['escapeHtml', 'jsArg', 'switchPanelHtml'], () => null);
    return ctx.switchPanelHtml('b1', bot, view) as string;
  };
  const buttons = (html: string) => [...html.matchAll(/<button [^>]*>([^<]*)<\/button>/g)].map(m => m[1]);

  it('the btn-danger button shows from the served runAgain flag alone, in either phase', () => {
    for (const h of [ALONE, WAITING]) {
      const html = panel({ fleetDb: { handover: h } }, { lines: [], copies: [], noAddress: true, runAgain: true });
      expect(buttons(html)).toContain('Run the main here again');
      expect(unescape(html)).toContain('<button class="btn btn-danger btn-small" onclick="runAgainFleet("b1")">Run the main here again</button>');
      expect(buttons(panel({ fleetDb: { handover: h, receive: { expiresAt: 'x' } } }, { lines: [], copies: [], noAddress: true, runAgain: false }))).not.toContain('Run the main here again');
      expect(buttons(panel({ fleetDb: { handover: h } }, { lines: [], copies: [], noAddress: true, runAgain: false }))).not.toContain('Run the main here again');
      expect(buttons(panel({ fleetDb: { handover: { ...h, host: 'copy.example' } } }, { lines: [], copies: [], noAddress: false, runAgain: false }))).not.toContain('Run the main here again');
    }
    expect(buttons(panel({ fleetDb: { handover: ALONE, pushBroken: { at: 'x', safetyDump: F } } }, { lines: [], copies: [], noAddress: true, runAgain: true }))).toContain('Run the main here again');
    expect(buttons(panel({ fleetDb: {} }, { lines: [], copies: [], noAddress: false }))).not.toContain('Run the main here again');
  });

  it('runAgainFleet asks the server question and sends confirm with the question\'s confirmDump', async () => {
    const answers = [{ success: false, needsConfirm: true, error: 'Run the main here again only if ...?', confirmDump: F }, { success: true, opId: 'op1' }];
    const { ctx, seen } = load(['switchRequest', 'runAgainFleet'], () => answers.shift());
    await ctx.runAgainFleet('b1');
    expect(seen.confirm).toEqual(['Run the main here again only if ...?']);
    expect(seen.calls).toEqual([['POST', '/bots/b1/fleet-run-again', null], ['POST', '/bots/b1/fleet-run-again', { confirm: true, confirmDump: F }]]);
    expect(seen.messages).toEqual([['info', 'Working on Bot 1; the result shows here when it finishes']]);
  });

  it('a question after the confirm is asked again with the "question changed" prefix, at most three rounds', async () => {
    const q = (error: string, dump: string) => ({ success: false, needsConfirm: true, error, confirmDump: dump });
    const answers = [q('Q1', ''), q('Q2', F), { success: true, opId: 'op1' }];
    const { ctx, seen } = load(['switchRequest', 'runAgainFleet'], () => answers.shift());
    await ctx.runAgainFleet('b1');
    expect(seen.confirm).toEqual(['Q1', 'The question changed; read it again:\n\nQ2']);
    expect(seen.calls.map(c => c[2])).toEqual([null, { confirm: true, confirmDump: '' }, { confirm: true, confirmDump: F }]);
    const always = load(['switchRequest', 'runAgainFleet'], () => q('Q', F));
    await always.ctx.runAgainFleet('b1');
    expect(always.seen.confirm).toHaveLength(3);
    expect(always.seen.calls).toHaveLength(4);
    expect(always.seen.messages).toEqual([['error', 'The question changed again, so nothing was run. Press the button again to read the new question.']]);
  });

  it('a refusal without a text names running the main here again', async () => {
    const { ctx, seen } = load(['switchRequest', 'runAgainFleet'], () => ({ success: false }));
    await ctx.runAgainFleet('b1');
    expect(seen.messages).toEqual([['error', 'Running the main here again was refused']]);
  });

  it('no answer names running the main here again', () => {
    const { ctx, seen } = load(['showNoAnswer'], () => null);
    ctx.showNoAnswer('run-again');
    ctx.showNoAnswer('run-again', true);
    expect(seen.messages).toEqual([
      ['error', 'No answer from the manager; running the main here again may still be in progress. Check its state before trying again.'],
      ['error', "No answer from the manager, so running the main here again can't be confirmed. Check whether it took effect before trying again."],
    ]);
  });

  it('switchBadges: waiting no-address by the served noAddress, with-address text without it, the receiving, stopped and pushBroken lines', () => {
    const { ctx } = load(['escapeHtml', 'switchDate', 'switchBadges'], () => null);
    expect(titles(ctx.switchBadges({ noAddress: true, fleetDb: { handover: WAITING } }))).toEqual([WAITING_NO_ADDRESS]);
    expect(titles(ctx.switchBadges({ fleetDb: { handover: WAITING } }))).toEqual(['Press Hand over again, or Cancel the hand-over']);
    const lead = 'Handed over to copy.example, which has no address for other machines, so this machine does not rejoin it as a copy by itself. ';
    expect(titles(ctx.switchBadges({ takeBack: true, noAddress: true, fleetDb: { handover: ALONE, receive: { expiresAt: '2026-11-21T10:00:00.000Z' } } }))[0]).toBe(
      `${lead}Its database runs to receive the main back; the hand-over stays recorded until a push from copy.example's manager finishes, or until you press Stop receiving and then Run the main here again if copy.example is lost for good.`);
    expect(titles(ctx.switchBadges({ takeBack: true, noAddress: true, fleetDb: { handover: ALONE } }))).toEqual([
      `${lead}Its database stays stopped. To move the main back, press Receive a main here, then Push the main in copy.example's manager. Cancel the hand-over only if copy.example never took over. If copy.example is lost for good, press Run the main here again.`]);
    const broken = titles(ctx.switchBadges({ takeBack: true, noAddress: true, fleetDb: { handover: ALONE, pushBroken: { at: '2026-11-20T11:00:00.000Z', safetyDump: F } } }));
    expect(broken[0]).toBe(`${lead}Its database stays stopped. To move the main back, press Receive a main here, then Push the main in copy.example's manager. If copy.example is lost for good, press Run the main here again.`);
    expect(broken[1]).toBe(`A push replaced this database on or before 2026-11-20 11:00 UTC and did not finish, so the bot cannot run on it. Press Receive a main again so copy.example can push again. The dump ${F} (taken before receiving) stays with the backups; a restore is refused while the hand-over is recorded. If copy.example is lost for good, press Run the main here again, which restores that dump first.`);
  });
});

const RUN_AGAIN = `${B}/fleet-run-again`;
const question = (error: string, confirmDump: string): Reply => refused(409, { success: false, error, needsConfirm: true, confirmDump });
const alonePage = (fleetDb: Record<string, unknown> = {}) => mainRoutes({
  bot: mainLaneBot({ handover: ALONE, ...fleetDb }, { noAddress: true, takeBack: true }),
  switch: switchBody({ handover: ALONE, noAddress: true, takeBack: true, runAgain: true, generation: null }),
});

describe('NM42 row 15b: the terminal', () => {
  it('actionRows offers runagain from the served runAgain flag alone', () => {
    const kinds = (fleetDb: Record<string, unknown>, runAgain: boolean) => actionRows('main', { switch: { ok: true, value: { lines: [], copies: [], noAddress: true, runAgain } } as never }, mainLaneBot(fleetDb) as never).map(r => r.kind);
    expect(kinds({ handover: ALONE }, true)).toContain('runagain');
    expect(kinds({ handover: WAITING }, true)).toContain('runagain');
    expect(kinds({ handover: ALONE }, false)).not.toContain('runagain');
    expect(kinds({ handover: ALONE, receive: { expiresAt: 'x' } }, false)).not.toContain('runagain');
    expect(kinds({ handover: { ...ALONE, host: 'copy.example' } }, false)).not.toContain('runagain');
  });

  it('laneOutcome and the not-confirmed text name running the main here again', () => {
    expect(laneOutcome('run-again', { kind: 'refused', text: '' })).toEqual({ ok: false, text: 'Running the main here again was refused' });
    expect(laneOutcome('run-again', { kind: 'ended', ok: true, text: '' })).toEqual({ ok: true, text: 'Running the main here again finished.' });
    expect(LANE_NOT_CONFIRMED['run-again']).toBe('Cancelled: nothing was changed.');
  });

  it('laneCall keeps confirmDump, \'\' included, and its can\'t confirm names the op', async () => {
    const f = wsFake();
    f.on('POST', RUN_AGAIN, question('Q', ''));
    expect(await laneCall(f.client, 'b1', 'POST', RUN_AGAIN, {}, { op: 'run-again', limitMs: 5000 })).toEqual({ kind: 'question', text: 'Q', confirmDump: '' });
    f.on('POST', RUN_AGAIN, laneAccepted('op-1'));
    expect(await laneCall(f.client, 'b1', 'POST', RUN_AGAIN, {}, { op: 'run-again', limitMs: 200 })).toEqual({
      kind: 'unconfirmed', text: "Can't confirm running the main here again: no result came within 200 ms; it may still be running. The Move lines show what stands.",
    });
  });

  it('the row sends the route; Y Confirm sends confirm with confirmDump; another key sends nothing more', async () => {
    const answers: Reply[] = [question('Q1', F), laneAccepted('op-1')];
    const f = alonePage().on('POST', RUN_AGAIN, () => answers.shift()!);
    const v = await toDb(f);
    await take(v, 'Run the main here again');
    await v.until('Y Confirm');
    await v.press('n');
    await v.until(LANE_NOT_CONFIRMED['run-again']);
    expect(calls(f, 'POST', RUN_AGAIN).map(c => c.body)).toEqual([undefined]);
    answers.unshift(question('Q1', F));
    await take(v, 'Run the main here again');
    await v.until('Y Confirm');
    await v.press('y');
    await v.until('Working on mybot');
    expect(calls(f, 'POST', RUN_AGAIN).map(c => c.body)).toEqual([undefined, undefined, { confirm: true, confirmDump: F }]);
    f.emit('bot:switch', switchFrame('op-1', true, 'DONE TEXT'));
    await v.until('DONE TEXT');
  });

  it('a question after a confirm asks again with "The question changed; read it again:"', async () => {
    const answers: Reply[] = [question('Q1', ''), question('Q2', F), laneAccepted('op-1')];
    const f = alonePage().on('POST', RUN_AGAIN, () => answers.shift()!);
    const v = await toDb(f);
    await take(v, 'Run the main here again');
    await v.until('Y Confirm');
    await v.press('y');
    await v.until('The question changed; read it again:');
    await v.until('Y Confirm');
    await v.press('y');
    await v.until('Working on mybot');
    expect(calls(f, 'POST', RUN_AGAIN).map(c => c.body)).toEqual([undefined, { confirm: true, confirmDump: '' }, { confirm: true, confirmDump: F }]);
    await tick(30);
    expect(bars(v.frame())).not.toContain('Y Confirm');
  });
});

describe('NM42 row 21: the terminal\'s limit', () => {
  it('RUN_AGAIN_LIMIT_MS is at least the named sum of the restore\'s bounds', () => {
    const sum = dumpTiming.snapshotTimeoutMs + dumpTiming.dumpTimeoutMs + dumpTiming.conflictBudgetMs
      + dumpTiming.dumpTimeoutMs
      + dumpTiming.dumpTimeoutMs + 30_000
      + restoreCountTiming.ms
      + 2 * tocTiming.backstopMs
      + 2 * START_DB_READY.deadlineMs;
    expect(RUN_AGAIN_LIMIT_MS).toBeGreaterThanOrEqual(sum);
    expect(RUN_AGAIN_LIMIT_MS).toBe(60 * 60_000);
  });
});
