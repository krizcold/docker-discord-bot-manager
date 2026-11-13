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

type El = { innerHTML: string; textContent: string; value?: string; isConnected: boolean; classList: { remove: () => void; add: () => void } };
const el = (value?: string): El => ({ innerHTML: '', textContent: '', value, isConnected: true, classList: { remove: () => {}, add: () => {} } });

const load = (names: string[], answers: (method: string, url: string, body: unknown) => unknown, extra: Record<string, unknown> = {}) => {
  const els: Record<string, El> = {};
  const calls: Array<[string, string, unknown]> = [];
  const confirms: string[] = [];
  const ctx = vm.createContext({
    api: async (method: string, url: string, body?: unknown) => { calls.push([method, url, body]); return answers(method, url, body); },
    confirm: (text: string) => { confirms.push(text); return true; },
    showMessage: () => {},
    showNoAnswer: () => {},
    loadBots: async () => {},
    setTimeout: () => 0,
    fleetBackupBotId: 'a',
    bots: [],
    document: { getElementById: (id: string) => (els[id] ??= el()) },
    Array, String, Number, JSON, Date, Math, Object, encodeURIComponent,
    ...extra,
  });
  vm.runInContext(['escapeHtml', 'jsArg', ...names].map(pageFunction).join('\n'), ctx);
  return { ctx, els, calls, confirms };
};

const buttons = (html: string) => [...html.matchAll(/<button [^>]*>([^<]*)<\/button>/g)].map(m => m[1]);
const tips = (html: string) => [...html.matchAll(/<div class="(?:env-tip|error-message)"[^>]*>(.*?)<\/div>/g)].map(m => m[1].replace(/<[^>]+>/g, ''));

describe('UG1: the generation line in the Move group', () => {
  const panel = (view: Record<string, unknown>, bot: Record<string, unknown> = { fleetDb: {}, status: 'running' }) =>
    load(['switchPanelHtml'], () => null).ctx.switchPanelHtml('a', bot, { lines: [], copies: [], ...view }) as string;
  it('a row: the machine, the generation and its UTC date', () => {
    expect(tips(panel({ generation: { machine: 'main.example', generation: 3, since: '2026-10-28T10:00:00Z' } }))[0])
      .toBe('This database is the main: main.example, generation 3 since 2026-10-28 10:00 UTC.');
  });
  it('a row without a date', () => {
    expect(tips(panel({ generation: { machine: 'main.example', generation: 3, since: null } }))[0]).toBe('This database is the main: main.example, generation 3.');
  });
  it('the read failed: can\'t confirm', () => {
    expect(tips(panel({ generation: { error: 'ERROR:  permission denied' } }))[0]).toBe("Can't confirm this database's generation: ERROR:  permission denied");
  });
  it('no field, no row, or a copy: no generation line', () => {
    expect(panel({})).not.toContain('generation');
    expect(panel({ generation: null })).not.toContain('generation');
    const copy = load(['switchPanelHtml'], () => null).ctx.switchPanelHtml('a', { fleetDbReplica: {} }, { lines: [], generation: { machine: 'm', generation: 1, since: null } }) as string;
    expect(copy).not.toContain('This database is the main');
  });
  it('a replaced main: no line saying it is the main', () => {
    expect(panel({ generation: { machine: 'main.example', generation: 3, since: null } }, { fleetDb: { replacedBy: { machine: 'b.example' } }, status: 'running' })).not.toContain('This database is the main');
  });
});

describe('UG6 (fixer 1): no generation line while the main role is in question', () => {
  const g = { generation: { machine: 'main.example', generation: 3, since: null } };
  const panel = (db: Record<string, unknown>, view: Record<string, unknown> = {}) =>
    load(['switchPanelHtml'], () => null).ctx.switchPanelHtml('a', { fleetDb: db, status: 'running' }, { lines: [], copies: [], ...g, ...view }) as string;
  it('two mains, a push not finished, a take-over not finished', () => {
    expect(panel({ mainConflict: { machine: 'b.example', host: 'b', port: 1, generation: 3 } })).not.toContain('This database is the main');
    expect(panel({ pushBroken: { at: '2026-10-30T00:00:00Z', safetyDump: 'x.dump' } })).not.toContain('This database is the main');
    expect(panel({}, { takeover: { planned: true, generation: 4 } })).not.toContain('This database is the main');
  });
  it('docker did not answer: can\'t confirm', () => {
    expect(tips(panel({}, { generation: { error: 'docker did not answer' } }))[0]).toBe("Can't confirm this database's generation: docker did not answer");
  });
});

describe('UG2: the lag figure and the copy\'s address', () => {
  const slot = (over: Record<string, unknown>) => ({ slot: 'smdb_fleet_c', fleet: true, walStatus: 'reserved', active: true, retainedBytes: 0, clientAddr: '10.0.0.5', state: 'streaming', replayLagSeconds: null, behindBytes: 0, machine: 'copy.example', address: 'copy.example:5434', ...over });
  const render = async (s: Record<string, unknown>) => {
    const answer = { success: true, replication: { enabled: true, publicHost: 'main.example', hostPort: 5433, live: { sslOn: true, standbys: [], slots: [s], slotWalKeep: '4096MB' } } };
    const { ctx, els } = load(['renderFleetReplication'], () => answer, { bots: [{ id: 'a', status: 'running' }], panelHasEntry: () => false });
    await ctx.renderFleetReplication('a');
    return tips(els['fleet-replication-body'].innerHTML).find(t => t.startsWith('The copy on'));
  };
  it('0 bytes behind: caught up', async () => {
    expect(await render(slot({}))).toBe('The copy on copy.example (slot smdb_fleet_c): streaming, caught up');
  });
  it('bytes behind: the MB figure, with the seconds when Postgres has them', async () => {
    expect(await render(slot({ behindBytes: 5242880, replayLagSeconds: 1.25 }))).toBe('The copy on copy.example (slot smdb_fleet_c): streaming, 5 MB behind, replay lag 1.3s');
    expect(await render(slot({ behindBytes: 1000 }))).toBe('The copy on copy.example (slot smdb_fleet_c): streaming, less than 1 MB behind');
  });
  it('no byte figure: the seconds alone, as before', async () => {
    expect(await render(slot({ behindBytes: null, replayLagSeconds: 2 }))).toBe('The copy on copy.example (slot smdb_fleet_c): streaming, replay lag 2.0s');
  });
  it('the IP address only for a slot without a machine name', async () => {
    expect(await render(slot({}))).not.toContain('10.0.0.5');
    expect(await render(slot({ machine: null }))).toBe('The copy on slot smdb_fleet_c (10.0.0.5): streaming, caught up');
  });
});

describe('UG3: the window titles and the State button', () => {
  const open = async (bot: Record<string, unknown>) => {
    const noop = () => {};
    const { ctx, els } = load(['showFleetBackups'], () => null, {
      bots: [bot], fleetBackupStored: null,
      fleetBackupListHtml: async () => '', fleetBackupErrorHtml: () => '', renderSeedBanner: noop, renderFleetReplication: noop, renderFleetSwitch: noop,
      refreshFleetBackupStatus: noop, renderFleetReplica: noop, renderPastFleetBackups: noop, refreshStateLine: noop, renderMemoryLine: noop, renderConnectionLine: noop,
    });
    await ctx.showFleetBackups('a');
    return els['fleet-backup-content'].innerHTML;
  };
  for (const [name, bot] of [['main', { id: 'a', displayName: 'A', fleetDb: {} }], ['copy', { id: 'a', displayName: 'A', fleetDbReplica: {} }]] as const) {
    it(`the ${name}'s window: titled Database, a State button opening the State window, the memory line`, async () => {
      const html = await open(bot);
      expect(html).toContain('<h3>Database: A</h3>');
      expect(html).toMatch(/<button [^>]*onclick="showStateWindow\(&quot;a&quot;\)"[^>]*>State\.\.\.<\/button>/);
      expect(html).toContain('<div id="fleet-memory-line"');
    });
  }
});

describe('UG4: the memory line', () => {
  const line = async (answer: unknown) => {
    const { ctx, els } = load(['memoryLineText', 'renderMemoryLine'], () => { if (answer instanceof Error) throw answer; return answer; });
    await ctx.renderMemoryLine('a');
    return els['fleet-memory-line'].textContent;
  };
  it('room, no room, can\'t confirm, stopped', async () => {
    expect(await line({ success: true, memory: { running: true, room: true, useMb: 300, freeMb: 1000 } })).toBe('Room to reshard beside the running shards: yes, 1000 MB free for 300 MB');
    expect(await line({ success: true, memory: { running: true, room: false, useMb: 300, freeMb: 212 } })).toBe('Room to reshard beside the running shards: no, 212 MB free for 300 MB');
    expect(await line({ success: true, memory: { running: true, room: null, useMb: 300, freeMb: null, error: '/proc/meminfo has no MemAvailable line' } })).toBe("Room to reshard beside the running shards: can't confirm: /proc/meminfo has no MemAvailable line");
    expect(await line({ success: true, memory: { running: null, room: null, useMb: null, freeMb: null, error: 'docker did not answer' } })).toBe("Room to reshard beside the running shards: can't confirm: docker did not answer");
    expect(await line({ success: true, memory: { running: false } })).toBe('Room to reshard beside the running shards: the bot is not running');
  });
  it('the manager not answering: can\'t confirm', async () => {
    expect(await line(new Error('down'))).toBe("Room to reshard beside the running shards: can't confirm: no answer from the manager");
    expect(await line({ success: false, error: 'Bot not found' })).toBe("Room to reshard beside the running shards: can't confirm: Bot not found");
  });
});

describe('UG5: Rejoin as a copy in the Move group, with the join code field', () => {
  const panel = (bot: Record<string, unknown>) => load(['switchPanelHtml'], () => null).ctx.switchPanelHtml('a', bot, { lines: [], copies: [] }) as string;
  const db = { replication: { publicHost: 'main.example', hostPort: 5433 } };
  it('stopped, nothing recorded: the form with the join code, address and port', () => {
    const html = panel({ fleetDb: db, status: 'stopped' });
    expect(html).toContain('id="reseed-join"');
    expect(html).toContain('id="reseed-host" value="main.example"');
    expect(html).toContain('id="reseed-port" value="5433"');
    expect(html).toMatch(/onclick="reseedStalePrimary\(&quot;a&quot;\)">Rejoin as a copy<\/button>/);
  });
  it('running: no form, the reason to stop', () => {
    const html = panel({ fleetDb: db, status: 'running' });
    expect(html).not.toContain('id="reseed-join"');
    expect(html).toContain('Stop the bot to rejoin this machine as a copy: that deletes the database it runs on.');
  });
  it('a recorded replacement: NM5\'s button alone', () => {
    const html = panel({ fleetDb: { ...db, replacedBy: { machine: 'b.example' } }, status: 'stopped' });
    expect(html).not.toContain('id="reseed-join"');
    expect(buttons(html).filter(b => b === 'Rejoin as a copy')).toHaveLength(1);
  });
  it('replication never enabled: no form and no reason to stop (fixer 1)', () => {
    for (const status of ['stopped', 'running']) {
      const html = panel({ fleetDb: {}, status });
      expect(html).not.toContain('id="reseed-join"');
      expect(html).not.toContain('Stop the bot to rejoin');
    }
  });
  it('a hand-over or a receive standing, no NM5 button: the form shows (fixer 1)', () => {
    for (const extra of [{ handover: { mode: 'stream', phase: 'waiting', machine: 'b.example' } }, { receive: { expiresAt: '2026-11-01T00:00:00Z' } }]) {
      const html = panel({ fleetDb: { ...db, ...extra }, status: 'stopped' });
      expect(html).toContain('id="reseed-join"');
      expect(buttons(html).filter(b => b === 'Rejoin as a copy')).toHaveLength(1);
    }
  });
  it('the form posts the same payload to /fleet-reseed', async () => {
    const posted: Array<[string, unknown]> = [];
    const values: Record<string, string> = { 'reseed-join': ' smdbjoin1.x ', 'reseed-host': 'here.example', 'reseed-port': '5440' };
    const { ctx, confirms } = load(['reseedStalePrimary'], () => null, {
      document: { getElementById: (id: string) => ({ value: values[id] ?? '' }) },
      refuseBadNumbers: () => false, refuseWhileChecking: () => false, botLabel: (id: string) => id, hideFleetBackups: () => {}, followLostProvisioning: async () => {},
      postProvision: async (url: string, payload: unknown) => { posted.push([url, payload]); return { success: true }; },
    });
    await ctx.reseedStalePrimary('a');
    expect(posted).toEqual([['/bots/a/fleet-reseed', { joinCode: 'smdbjoin1.x', publicHost: 'here.example', hostPort: 5440 }]]);
    expect(confirms[0].startsWith('Rejoin this machine as a copy?')).toBe(true);
    for (const fact of ['dumped once under a write fence', 'DELETED', 'the same system id', 'on the same or a later timeline', 'if it does not, or if the dump fails, nothing is deleted', 'is discarded', 'takes no writes of its own']) {
      expect(confirms[0]).toContain(fact);
    }
  });
});

describe('UG7 (fixer 2): no generation line while a move or a receive stands', () => {
  const g = { generation: { machine: 'main.example', generation: 3, since: null } };
  const panel = (db: Record<string, unknown>) =>
    load(['switchPanelHtml'], () => null).ctx.switchPanelHtml('a', { fleetDb: db, status: 'stopped' }, { lines: [], copies: [], ...g }) as string;
  it('a finished push, a stream hand-over waiting, a receive', () => {
    expect(panel({ handover: { mode: 'push', phase: 'done', machine: 'b.example' } })).not.toContain('This database is the main');
    expect(panel({ handover: { mode: 'stream', phase: 'waiting', machine: 'b.example' } })).not.toContain('This database is the main');
    expect(panel({ receive: { expiresAt: '2026-11-01T00:00:00Z' } })).not.toContain('This database is the main');
  });
});

describe('UG8 (fixer 2): the Rejoin form follows the state while the window is open', () => {
  const db = { replication: { publicHost: 'main.example', hostPort: 5433 } };
  const switchAnswer = (method: string, url: string) => (url === '/bots/a/fleet-switch' ? { success: true, lines: [], copies: [] } : { success: true });
  const settle = () => new Promise(r => setTimeout(r, 0));
  it('replication disabled with the window open: the form goes', async () => {
    const holder: { ctx?: vm.Context } = {};
    const { ctx, els } = load(['switchPanelHtml', 'renderFleetSwitch', 'disableFleetReplication'], switchAnswer, {
      renderFleetReplication: () => {},
      loadBots: async () => { holder.ctx!.bots = [{ id: 'a', status: 'stopped', fleetDb: {} }]; },
    });
    holder.ctx = ctx;
    ctx.bots = [{ id: 'a', status: 'stopped', fleetDb: db }];
    await ctx.renderFleetSwitch('a');
    expect(els['fleet-switch-body'].innerHTML).toContain('id="reseed-join"');
    await ctx.disableFleetReplication('a');
    await settle();
    expect(els['fleet-switch-body'].innerHTML).not.toContain('id="reseed-join"');
  });
  it('replication enabled with the window open: the form comes', async () => {
    const holder: { ctx?: vm.Context } = {};
    const values: Record<string, string> = { 'fleet-repl-host': 'main.example', 'fleet-repl-port': '', 'fleet-repl-keep': '' };
    const els: Record<string, El> = {};
    const { ctx } = load(['switchPanelHtml', 'renderFleetSwitch', 'enableFleetReplication'], switchAnswer, {
      renderFleetReplication: () => {}, refuseBadNumbers: () => false, fleetReplEnableNotes: () => '',
      document: { getElementById: (id: string) => (els[id] ??= el(values[id])) },
      loadBots: async () => { holder.ctx!.bots = [{ id: 'a', status: 'stopped', fleetDb: db }]; },
    });
    holder.ctx = ctx;
    ctx.bots = [{ id: 'a', status: 'stopped', fleetDb: {} }];
    await ctx.renderFleetSwitch('a');
    expect(els['fleet-switch-body'].innerHTML).not.toContain('id="reseed-join"');
    await ctx.enableFleetReplication('a');
    await settle();
    expect(els['fleet-switch-body'].innerHTML).toContain('id="reseed-join"');
  });
  it('the bot started, then stopped, with the window open', async () => {
    const sockets: Array<{ onmessage?: (e: { data: string }) => void }> = [];
    const { ctx, els } = load(['switchPanelHtml', 'renderFleetSwitch', 'mergeBotState', 'connectWebSocket'], switchAnswer, {
      window: { location: { protocol: 'http:', host: 'x' } },
      WebSocket: function (this: object) { sockets.push(this); },
      busyBots: new Set(), redraw: () => {},
    });
    ctx.bots = [{ id: 'a', status: 'stopped', fleetDb: db }];
    ctx.connectWebSocket();
    await ctx.renderFleetSwitch('a');
    expect(els['fleet-switch-body'].innerHTML).toContain('id="reseed-join"');
    sockets[0].onmessage!({ data: JSON.stringify({ type: 'bot:started', data: { id: 'a', status: 'running' } }) });
    await settle();
    expect(els['fleet-switch-body'].innerHTML).not.toContain('id="reseed-join"');
    expect(els['fleet-switch-body'].innerHTML).toContain('Stop the bot to rejoin this machine as a copy');
    sockets[0].onmessage!({ data: JSON.stringify({ type: 'bot:stopped', data: { id: 'a', status: 'stopped' } }) });
    await settle();
    expect(els['fleet-switch-body'].innerHTML).toContain('id="reseed-join"');
  });
});

describe('UG9 (fixer 3): the Database button for every bot that takes the hooks', () => {
  const button = (bot: Record<string, unknown>) => load(['databaseButtonHtml'], () => null).ctx.databaseButtonHtml({ id: 'a', ...bot }) as string;
  it('a JSON bot with hooks and a bot on an outside database with hooks: the button', () => {
    expect(buttons(button({ appHooks: true, dataPlace: 'json' }))).toEqual(['Database']);
    expect(buttons(button({ appHooks: true, dataPlace: 'outside' }))).toEqual(['Database']);
  });
  it('a bot without hooks: no button', () => {
    expect(button({ appHooks: false, dataPlace: 'json' })).toBe('');
    expect(button({})).toBe('');
  });
  it('the bots that had it: the button as before', () => {
    for (const bot of [{ fleetDb: {}, fleetBackup: {} }, { fleetDbReplica: {} }, { fleetDbReplicaSeed: {} }, { fleetWorker: true }, { hasDbBackups: true }]) {
      expect(buttons(button(bot))).toEqual(['Database']);
    }
    expect(button({ fleetDb: {}, fleetBackup: {} })).toContain("Backups and replication of this bot\'s managed database");
  });
});

describe('UG10 (fixer 3): the window of a bot on JSON files or an outside database', () => {
  const open = async (bot: Record<string, unknown>) => {
    const noop = () => {};
    const called: string[] = [];
    const { ctx, els } = load(['showFleetBackups'], () => null, {
      bots: [{ id: 'a', displayName: 'A', appHooks: true, ...bot }], fleetBackupStored: null,
      fleetBackupListHtml: async () => '', fleetBackupErrorHtml: () => '', renderSeedBanner: noop, renderFleetReplication: noop, renderFleetSwitch: noop,
      refreshFleetBackupStatus: noop, renderFleetReplica: () => called.push('replica'), renderPastFleetBackups: noop,
      refreshStateLine: () => called.push('state'), renderMemoryLine: () => called.push('memory'),
    });
    await ctx.showFleetBackups('a');
    return { html: els['fleet-backup-content'].innerHTML, called };
  };
  it('the title, the state line, the State button and the memory line', async () => {
    const { html, called } = await open({ dataPlace: 'json' });
    expect(html).toContain('<h3>Database: A</h3>');
    expect(html).toContain('<div id="fleet-state-line"></div>');
    expect(html).toMatch(/<button [^>]*onclick="showStateWindow\(&quot;a&quot;\)"[^>]*>State\.\.\.<\/button>/);
    expect(html).toContain('<div id="fleet-memory-line"');
    expect(html).not.toContain('fleet-replica-body');
    expect(called).toEqual(['state', 'memory']);
  });
  it('each of the three data lines', async () => {
    expect(tips((await open({ dataPlace: 'json' })).html)).toContain('This bot keeps its data in JSON files.');
    expect(tips((await open({ dataPlace: 'outside' })).html)).toContain('This bot keeps its data in a database this manager does not run.');
    expect(tips((await open({ dataPlace: null })).html)).toContain("Can't confirm where this bot keeps its data: its env store cannot be read.");
  });
});
