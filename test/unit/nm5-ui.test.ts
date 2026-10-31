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

type Seen = { confirm: string[]; messages: Array<[string, string]>; alerts: string[]; calls: Array<[string, string, unknown]>; prompts: string[] };

/** The page functions named, in a vm context whose api answers from `answers` by method and url. */
const load = (names: string[], answers: (method: string, url: string, body: unknown) => unknown, extra: Record<string, unknown> = {}) => {
  const seen: Seen = { confirm: [], messages: [], alerts: [], calls: [], prompts: [] };
  const ctx = vm.createContext({
    api: async (method: string, url: string, body?: unknown) => { seen.calls.push([method, url, body]); return answers(method, url, body); },
    confirm: (text: string) => { seen.confirm.push(text); return true; },
    prompt: (text: string) => { seen.prompts.push(text); return null; },
    alert: (text: string) => { seen.alerts.push(text); },
    showMessage: (kind: string, text: string) => { seen.messages.push([kind, text]); },
    showNoAnswer: () => {},
    loadBots: async () => {},
    showFleetBackups: () => {},
    fleetBackupBotId: null,
    document: { getElementById: () => ({ querySelectorAll: () => [] }) },
    Array, String, Number, JSON, Date, Math, Object, encodeURIComponent,
    ...extra,
  });
  vm.runInContext(names.map(pageFunction).join('\n'), ctx);
  return { ctx, seen };
};

const PREVIEW = { success: true, instances: [{ id: 'a', displayName: 'A', running: true }] };
const STEPS = { preRestoreDump: 'pre-restore-x.dump', restored: true, claimFloor: null, guildsRaised: null, claimRaisedTo: null, botState: 'maintenance', stopped: [], restarted: [], generation: 9 };
const restoreAnswers = (steps: unknown) => (method: string) => (method === 'GET' ? PREVIEW : { success: true, steps });

describe('W7: the restore confirm and success line', () => {
  it('a moved- file: W-MOVED in the confirm after its first sentence, RS-MOVED after the success line', async () => {
    const { ctx, seen } = load(['restoreSharersText', 'restoreFleetBackupFile'], restoreAnswers(STEPS));
    await ctx.restoreFleetBackupFile('a', 'moved-2026-10-30T10-00-00-000Z.dump');
    expect(seen.confirm[0].startsWith(`Restore "moved-2026-10-30T10-00-00-000Z.dump"? This backup was made for a move: restoring it makes this machine's database the main, with a generation above the file's and this database's.\n\n`)).toBe(true);
    expect(seen.messages[1][1].endsWith(', restarted 0. This machine is the main now (generation 9); the Database window shows whether the owner was sent a switch notice')).toBe(true);
  });
  it('an ordinary file: no W-MOVED, and RS-RAISED after the success line (D34)', async () => {
    const { ctx, seen } = load(['restoreSharersText', 'restoreFleetBackupFile'], restoreAnswers(STEPS));
    await ctx.restoreFleetBackupFile('a', 'old.dump');
    expect(seen.confirm[0]).not.toContain('made for a move');
    expect(seen.messages[1][1].endsWith(", restarted 0. The database's main generation is 9 now, above the dump's and the one it had before the restore")).toBe(true);
  });
  it('no generation in the steps: neither clause', async () => {
    const { ctx, seen } = load(['restoreSharersText', 'restoreFleetBackupFile'], restoreAnswers({ ...STEPS, generation: null }));
    await ctx.restoreFleetBackupFile('a', 'old.dump');
    expect(seen.messages[1][1].endsWith(', restarted 0')).toBe(true);
  });
});

describe('W8: the switch notice check in the env editor (D38)', () => {
  it('a guided row for DATA_NOTICE_CHECK, shown for a Postgres backend, on and off, default on', async () => {
    const { findAppCapabilities } = await import('../../src/config/appCapabilities');
    const fields = findAppCapabilities('https://github.com/krizcold/fully-modular-discord-bot')?.wizardFields ?? [];
    const row = fields.find(f => f.key === 'DATA_NOTICE_CHECK');
    expect(row).toMatchObject({
      displayLabel: 'Switch Notice Check', group: 'Fleet', advanced: true, defaultValue: 'on',
      options: [{ value: 'on' }, { value: 'off' }], showWhen: { key: 'DATA_BACKEND', equals: 'postgres' },
      description: "on: before it uses its database, the bot reads the switch notices in its owner's DMs, and while it cannot read them it waits, says it can't confirm its database is the main, and DMs the owner once. off: when it cannot read them, the bot starts on the databases alone. Choose off only for a bot that cannot read its owner's DMs.",
    });
    expect(fields.findIndex(f => f.key === 'DATA_NOTICE_CHECK')).toBe(fields.findIndex(f => f.key === 'DATA_BACKEND_URL') + 1);
  });
});

describe('A12: the Enable and Disable toasts append the AD tail the answer carries', () => {
  const AD = ' The running bot took the new database list.';
  it('Enable', () => {
    const { ctx } = load(['fleetReplEnableNotes'], () => null);
    expect(ctx.fleetReplEnableNotes({ success: true, addressesText: AD })).toBe(AD);
  });
  it('Disable', async () => {
    const { ctx, seen } = load(['disableFleetReplication'], () => ({ success: true, addressesText: AD }), { renderFleetReplication: () => {}, botLabel: (id: string) => id });
    await ctx.disableFleetReplication('b1');
    expect(seen.messages.find(m => m[0] === 'success')?.[1].endsWith(AD)).toBe(true);
  });
});

describe('W4: the card badges', () => {
  const badges = (bot: unknown): Array<[string, string, boolean]> => {
    const { ctx } = load(['escapeHtml', 'switchDate', 'switchBadges'], () => null);
    const html: string = ctx.switchBadges(bot);
    return [...html.matchAll(/<span class="update-badge( danger)?" title="([^"]*)">([^<]*)<\/span>/g)].map(m => [m[3], m[2].replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&'), !!m[1]]);
  };
  const STREAM = { mode: 'stream', machine: 'copy.example', host: 'copy.example', port: 5434, at: '2026-10-30T09:00:00.000Z', lastCheck: 'connection refused' };
  it.each([
    ['B-HANDOVER (J-WAIT)', { fleetDb: { handover: { ...STREAM, phase: 'stopped' } } }, [['Handed over', 'Handed over to copy.example on 2026-10-30 09:00 UTC. This machine rejoins as its copy once copy.example is the main; last check: connection refused.', false]]],
    ['B-HANDOVER (J-ALONE)', { fleetDb: { handover: { mode: 'stream', phase: 'stopped', machine: 'copy.example', at: '2026-10-30T09:00:00.000Z' } } }, [['Handed over', 'Handed over to copy.example, which has no address for other machines, so this machine cannot rejoin it as a copy. Its database stays stopped; decommission it, or move the main back here with Push from copy.example.', false]]],
    ['B-HANDOVER-CUT', { fleetDb: { handover: { ...STREAM, phase: 'waiting' } } }, [['Hand-over not finished', 'Press Hand over again, or Cancel the hand-over', true]]],
    ['B-TAKEOVER-CUT', { fleetDbReplica: { takeover: { startedAt: 'x', planned: true, generation: 4 } } }, [['Take-over not finished', 'Press Take over again', true]]],
    ['B-RECEIVING', { fleetDb: { receive: { startedAt: 'x', expiresAt: '2026-10-31T09:00:00.000Z', safetyDump: 'z' } } }, [['Receiving', 'Waiting for a push until 2026-10-31 09:00 UTC', false]]],
    ['B-REPLACED', { fleetDb: { replacedBy: { machine: 'new.example', generation: 6 } } }, [['Replaced by new.example', 'new.example replaced this database as the main (generation 6). Rejoin this machine as a copy.', true]]],
    ['B-TWOMAINS', { fleetDb: { mainConflict: { machine: 'other.example' } } }, [['Two mains', "This database and other.example are both mains with the same generation; the bot's login here is blocked. Choose one in the Database window.", true]]],
    ['B-PUSHBROKEN', { fleetDb: { pushBroken: { at: '2026-10-30T09:00:00.000Z', safetyDump: 'pre-receive-x.dump' } } }, [['Push not finished', 'A push replaced this database on or before 2026-10-30 09:00 UTC and did not finish, so the bot cannot run on it. Restore the dump pre-receive-x.dump (taken before receiving) with the bot in Maintenance or Off, or press Receive again so the other machine can push again.', true]]],
    ['none', { fleetDb: {} }, []],
  ])('%s', (_n, bot, want) => {
    expect(badges(bot)).toEqual(want);
  });
});

describe('W5: the Database window buttons and confirms', () => {
  const panel = (bot: unknown, view: unknown = { lines: [], copies: [] }) => {
    const { ctx } = load(['escapeHtml', 'jsArg', 'switchPanelHtml'], () => null);
    const html: string = ctx.switchPanelHtml('b1', bot, view);
    return [...html.matchAll(/<button [^>]*>([^<]*)<\/button>/g)].map(m => m[1]);
  };
  it('main view, nothing recorded: Hand over per streaming copy, Receive, Download, Push, Upload', () => {
    expect(panel({ fleetDb: {} }, { lines: [], copies: [{ machine: 'copy.example', slot: 'slot_c', streaming: true }, { machine: 'down.example', slot: 'slot_d', streaming: false }] }))
      .toEqual(['Hand over to copy.example', 'Receive a main', 'Download for a move', 'Push the main', 'Upload a backup']);
  });
  it('a hand-over stopped: Cancel the hand-over, Upload, Rejoin as a copy', () => {
    expect(panel({ fleetDb: { handover: { mode: 'stream', phase: 'stopped', machine: 'copy.example', host: 'copy.example' } } })).toEqual(['Cancel the hand-over', 'Upload a backup', 'Rejoin as a copy']);
  });
  it('a push or file mark: Cancel the move', () => {
    expect(panel({ fleetDb: { handover: { mode: 'push', phase: 'pushing', machine: 'srv' } } })).toEqual(['Cancel the move', 'Upload a backup']);
  });
  it('receiving: Stop receiving', () => {
    expect(panel({ fleetDb: { receive: { expiresAt: 'x' } } })).toEqual(['Stop receiving', 'Upload a backup']);
  });
  it('two mains: Keep this machine as the main and Rejoin as a copy', () => {
    expect(panel({ fleetDb: { mainConflict: { machine: 'other.example' } } })).toEqual(['Receive a main', 'Download for a move', 'Push the main', 'Upload a backup', 'Keep this machine as the main', 'Rejoin as a copy']);
  });
  it('replica view: Take over and the start checkbox, checked', () => {
    const { ctx } = load(['escapeHtml', 'jsArg', 'switchPanelHtml'], () => null);
    const html: string = ctx.switchPanelHtml('b1', { fleetDbReplica: {} }, { lines: [] });
    expect(html).toContain('>Take over</button>');
    expect(html).toContain('<input type="checkbox" id="fleet-takeover-start" checked> Start the bot here when done');
  });

  const CONFIRMS: Array<[string, string, unknown[], string]> = [
    ['handOverFleet', 'POST', ['b1', 'slot_c', 'copy.example'], "Hand over the main to copy.example? The bot stays in maintenance; this machine's database stops once the copy holds every change, and it rejoins as a copy after copy.example takes over."],
    ['receiveFleet', 'POST', ['b1'], "Replace this machine's database with one pushed from another machine? The bot must be Off; a dump of this database is kept first."],
    ['moveOutFleet', 'POST', ['b1'], 'Make a backup for a move to a machine without an open port? The bot stays stopped here until you Cancel the move.'],
    ['keepFleetMain', 'POST', ['b1', 'other.example'], "Make this machine the main? Its generation is raised above other.example's; other.example's manager blocks its bot's login when it next reads this machine (it checks every 5 minutes while it can reach it)."],
    ['takeOverFleet', 'POST', ['b1'], 'Make this copy the main database? The manager checks the old main first; if it handed over to this copy, nothing is lost.'],
  ];
  it.each(CONFIRMS)('%s: its confirm, then the accepted toast', async (name, method, args, text) => {
    const { ctx, seen } = load([name, 'switchRequest'], () => ({ success: true, opId: 'op1' }), { bots: [{ id: 'b1', displayName: 'Bot 1' }], renderFleetSwitch: () => {} });
    await ctx[name](...args);
    await new Promise(r => setTimeout(r, 0));
    expect(seen.confirm).toEqual([text]);
    expect(seen.calls[0][0]).toBe(method);
    expect(seen.messages).toEqual([['info', 'Working on Bot 1; the result shows here when it finishes']]);
  });
  it('a declined confirm sends nothing', () => {
    const { ctx, seen } = load(['moveOutFleet', 'switchRequest'], () => ({ success: true }), { confirm: () => false, bots: [] });
    ctx.moveOutFleet('b1');
    expect(seen.calls).toEqual([]);
  });
});

describe('W10: the panel of a copy promoted outside the manager offers Take over (D46)', () => {
  it('the promoted text and a Take over button calling takeOverFleet; no Adopt anywhere on the page', () => {
    const panel = pageFunction('renderFleetReplica');
    expect(panel).toContain("This copy has been PROMOTED outside the manager and no longer follows a main. Take over makes it this machine's main database: the manager checks the old main, then raises this copy's generation before any bot can use it. If the promotion was a mistake, remove the replica and provision it again; that deletes every write made to this copy since the promote.");
    expect(panel).toContain('<button class="btn btn-primary btn-small" onclick="takeOverFleet(${jsArg(botId)})">Take over</button>');
    expect(pageHtml).not.toContain('adoptPromotedReplica');
    expect(pageHtml).not.toContain('fleet-adopt-primary');
    expect(pageHtml).not.toContain("Adopt as this machine's database");
  });
});

describe('W11 (D60): the Two mains badge title by blockError', () => {
  const titleOf = (conflict: unknown) => {
    const { ctx } = load(['escapeHtml', 'switchDate', 'switchBadges'], () => null);
    const html: string = ctx.switchBadges({ fleetDb: { mainConflict: conflict } });
    return /title="([^"]*)">Two mains</.exec(html)![1].replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  };
  it('with blockError: B-TWOMAINS-FAIL, the error escaped', () => {
    expect(titleOf({ machine: 'other.example', blockError: 'permission denied <x>' })).toBe("This database and other.example are both mains with the same generation; the bot's login here could not be blocked (permission denied <x>), so bots may still write to this database. Choose one in the Database window.");
    const { ctx } = load(['escapeHtml', 'switchDate', 'switchBadges'], () => null);
    expect(ctx.switchBadges({ fleetDb: { mainConflict: { machine: 'm', blockError: '<x>' } } })).not.toContain('<x>');
  });
  it('without blockError: the round 1 title', () => {
    expect(titleOf({ machine: 'other.example' })).toBe("This database and other.example are both mains with the same generation; the bot's login here is blocked. Choose one in the Database window.");
  });
});

describe('W12 (D52) and V31: Receive a main under pushBroken, and an answer with no move code', () => {
  const run = async (fleetDb: unknown, answer: unknown) => {
    const out: Record<string, unknown> = {};
    const { ctx, seen } = load(['escapeHtml', 'receiveFleet', 'switchRequest'], () => answer, {
      bots: [{ id: 'b1', displayName: 'Bot 1', fleetDb }], renderFleetSwitch: () => {}, document: { getElementById: () => out },
    });
    await ctx.receiveFleet('b1');
    return { seen, out };
  };
  it('pushBroken stands: W-RECEIVE-BROKEN naming the carried dump', async () => {
    const { seen } = await run({ pushBroken: { at: '2026-10-30T09:00:00.000Z', safetyDump: 'pre-receive-old.dump' } }, { success: true, text: 't', moveCode: 'c' });
    expect(seen.confirm).toEqual(["Replace this machine's database with one pushed from another machine? The bot must be Off. This database holds a push that did not finish, so no new dump is taken; the dump pre-receive-old.dump, taken before that push, stays with the backups."]);
  });
  it('no pushBroken: the usual confirm', async () => {
    const { seen } = await run({}, { success: true, text: 't', moveCode: 'c' });
    expect(seen.confirm).toEqual(["Replace this machine's database with one pushed from another machine? The bot must be Off; a dump of this database is kept first."]);
  });
  it('RV-AGAIN-DONE (no moveCode): its text is the toast, and no code box is written', async () => {
    const text = 'The push from win.local had already finished (generation 6), so this database is the main now; receiving ended and no new move code was made.';
    const { seen, out } = await run({ receive: { expiresAt: 'x' } }, { success: true, text });
    expect(seen.messages).toEqual([['success', text]]);
    expect(out.innerHTML).toBeUndefined();
  });
});

describe('W13 (D67): switchRequest sends the flag a question names', () => {
  const ask = (extra: Record<string, unknown>) => {
    let n = 0;
    return load(['switchRequest'], () => (n++ === 0 ? { success: false, needsConfirm: true, error: 'Take over anyway?', ...extra } : { success: true, opId: 'op1' }), { bots: [], confirm: () => true });
  };
  it('an answer with confirmFlag: the second request holds confirm and confirmUnchecked', async () => {
    const { ctx, seen } = ask({ confirmFlag: 'confirmUnchecked' });
    await ctx.switchRequest('b1', 'POST', '/api/bots/b1/fleet-takeover', { start: false }, 'take-over');
    expect(seen.calls.map(c => c[2])).toEqual([{ start: false }, { start: false, confirm: true, confirmUnchecked: true }]);
  });
  it('an answer without confirmFlag: the second request holds confirm only', async () => {
    const { ctx, seen } = ask({});
    await ctx.switchRequest('b1', 'POST', '/api/bots/b1/fleet-takeover', { start: false }, 'take-over');
    expect(seen.calls.map(c => c[2])).toEqual([{ start: false }, { start: false, confirm: true }]);
  });
});
