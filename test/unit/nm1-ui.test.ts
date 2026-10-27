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

const S_OFF = 'This bot is Off. Choose Running in its State window to start it';
const D_LOGIN = "The bot's database login is blocked, but its state is Running, so every process of this bot answers with the maintenance message. Choose Running in State to restore the login.";
const D_OFF = 'The state is Off, but the bot runs (it was started outside the manager). Choose Off in State to stop it, or Running.';

const load = (names: string[], extra: Record<string, unknown> = {}) => {
  const ctx = vm.createContext({ Date, String, ...extra });
  vm.runInContext(['escapeHtml', 'stateName', ...names].filter((n) => pageHtml.includes(`function ${n}(`)).map(pageFunction).join('\n'), ctx);
  return ctx;
};

const rec = (state: string, over: Record<string, unknown> = {}) => ({
  state, message: '', orderedAt: '2026-10-27T10:00:00.000Z', settled: true, hook: 'confirmed', login: 'blocked', savedByBot: state === 'running' ? 'running' : 'maintenance', ...over,
});

describe('U1 card badges per record and drift', () => {
  const ctx = load(['maintenanceBadges']);
  const when = new Date('2026-10-27T10:00:00.000Z').toLocaleString();

  it('shows no badge for a settled Running bot or a null record', () => {
    expect(ctx.maintenanceBadges({ id: 'b', maintenance: null, maintenanceDrift: null })).toBe('');
    expect(ctx.maintenanceBadges({ id: 'b', maintenance: rec('running') })).toBe('');
  });

  it('B-M names the time and the message, escaped', () => {
    const html = ctx.maintenanceBadges({ id: 'b', maintenance: rec('maintenance', { message: 'Back <soon>' }) });
    expect(html).toContain('>Maintenance</span>');
    expect(html).toContain(`In maintenance since ${when}. Message: Back &lt;soon&gt;`);
  });

  it("B-M without a message names the bot's default text", () => {
    const html = ctx.maintenanceBadges({ id: 'b', maintenance: rec('maintenance') });
    expect(html).toContain('Message: the bot&#39;s default text');
  });

  it('B-O', () => {
    const html = ctx.maintenanceBadges({ id: 'b', maintenance: rec('off') });
    expect(html).toContain('>Off</span>');
    expect(html).toContain(`Off since ${when}. Choose Running in State to start it.`);
  });

  it('B-UNSET is a danger badge titled with lastError', () => {
    const html = ctx.maintenanceBadges({ id: 'b', maintenance: rec('maintenance', { settled: false, lastError: 'no <answer>' }) });
    expect(html).toContain('update-badge danger');
    expect(html).toContain('>Maintenance not confirmed</span>');
    expect(html).toContain('title="no &lt;answer&gt;"');
    expect(html).not.toContain('>Maintenance</span>');
  });

  it('B-DRIFT names the login drift and the Off drift', () => {
    const a = ctx.maintenanceBadges({ id: 'b', maintenance: null, maintenanceDrift: D_LOGIN });
    expect(a).toContain('update-badge danger');
    expect(a).toContain('>Database login blocked</span>');
    const b = ctx.maintenanceBadges({ id: 'b', maintenance: rec('off'), maintenanceDrift: D_OFF });
    expect(b).toContain('>Off, but running</span>');
  });

  it('shows no badge while a maintenance order runs', () => {
    expect(ctx.maintenanceBadges({ id: 'b', activeOp: 'maintenance', maintenance: rec('off'), maintenanceDrift: D_OFF })).toBe('');
  });
});

describe('U2 the State button label', () => {
  const ctx = load(['stateButtonLabel']);
  it.each([
    [null, 'State: Running'], [rec('running'), 'State: Running'], [rec('maintenance'), 'State: Maintenance'], [rec('off'), 'State: Off'],
  ])('%j reads %s', (m, label) => {
    expect(ctx.stateButtonLabel({ id: 'b', maintenance: m })).toBe(label);
  });
});

describe('U3 Start on an Off bot', () => {
  const ctx = load(['startOffRefusal']);
  it('refuses with S-OFF only when the state is Off', () => {
    expect(ctx.startOffRefusal({ maintenance: rec('off') })).toBe(S_OFF);
    expect(ctx.startOffRefusal({ maintenance: rec('maintenance') })).toBe('');
    expect(ctx.startOffRefusal({ maintenance: null })).toBe('');
  });
  it('both Start buttons carry the refusal', () => {
    const render = pageFunction('renderBots');
    expect(render.match(/startOffRefusal\(bot\)/g)?.length ?? 0).toBeGreaterThanOrEqual(1);
    expect(render).toMatch(/onclick="startBot\('\$\{bot\.id\}'\)"\$\{offStart\}>Start</);
    expect(render).toMatch(/onclick="startBot\('\$\{bot\.id\}'\)"\$\{offStart\}>Install &amp; Run</);
  });
});

describe('U4 the State window per kind', () => {
  const ctx = load(['stateWindowHtml']);
  const notes: Record<string, string> = {
    database: 'The manager blocks the bot&#39;s database login',
    copy: 'This machine holds a live copy of the database.',
    external: 'The bot&#39;s database is not run by this manager, so its login is not',
    json: 'The bot keeps its data in files, so it is',
    none: 'This app declares no lifecycle hooks, so Maintenance is not',
  };
  it.each(Object.keys(notes))('kind %s shows its note', (kind) => {
    const html = ctx.stateWindowHtml({ id: 'b', displayName: 'Bee <1>' }, { state: 'running', message: '', kind });
    const plain = html.replace(/&#39;/g, "'");
    expect(plain).toContain(notes[kind].replace(/&#39;/g, "'"));
    expect(html).toContain('State: Bee &lt;1&gt;');
    expect(html).toContain('maxlength="1500"');
    expect(html).toContain('Maintenance message');
    expect(html).toContain('>Apply</button>');
    const maint = html.match(/<input[^>]*value="maintenance"[^>]*>/)![0];
    expect(maint.includes('disabled')).toBe(kind === 'none');
  });
  it('the Off line adds the database sentence only for kind database', () => {
    const db = ctx.stateWindowHtml({ id: 'b' }, { state: 'off', message: 'x', kind: 'database' }).replace(/&#39;/g, "'");
    expect(db).toContain("Its database keeps running for backups and copies, with the bot's login blocked.");
    const js = ctx.stateWindowHtml({ id: 'b' }, { state: 'off', message: 'x', kind: 'json' }).replace(/&#39;/g, "'");
    expect(js).not.toContain('Its database keeps running');
  });
  it('checks the current state and escapes the message', () => {
    const html = ctx.stateWindowHtml({ id: 'b' }, { state: 'maintenance', message: '</textarea><b>', kind: 'database' });
    expect(html).toMatch(/<input[^>]*value="maintenance"[^>]*checked/);
    expect(html).toContain('&lt;/textarea&gt;&lt;b&gt;');
  });
});

describe('U5 the bot:maintenance push', () => {
  const run = (settled: boolean) => {
    const messages: string[][] = [];
    const bots = [{ id: 'b', activeOp: 'maintenance', maintenance: null }];
    const refreshed: string[] = [];
    const ctx = load(['onBotMaintenance', 'mergeBotState', 'clearActiveOp'], {
      bots, showMessage: (t: string, m: string) => messages.push([t, m]), redraw: () => {}, refreshStateLine: (id: string) => refreshed.push(id),
    });
    ctx.onBotMaintenance({ id: 'b', maintenance: rec('maintenance', { settled }), opId: 'o', settled, text: 'Done.' });
    return { messages, bots, refreshed };
  };
  it('merges, clears the op and shows success when settled', () => {
    const { messages, bots, refreshed } = run(true);
    expect(bots[0].activeOp).toBeNull();
    expect((bots[0].maintenance as any).state).toBe('maintenance');
    expect(messages).toEqual([['success', 'Done.']]);
    expect(refreshed).toEqual(['b']);
  });
  it('shows an error when not settled', () => {
    expect(run(false).messages).toEqual([['error', 'Done.']]);
  });
  it('F3 a result with notify false updates the bot and the state line with no message', () => {
    const messages: Array<[string, string]> = [];
    const bots = [{ id: 'b', activeOp: 'maintenance', maintenance: null }];
    const refreshed: string[] = [];
    const ctx = load(['onBotMaintenance', 'mergeBotState', 'clearActiveOp'], {
      bots, showMessage: (t: string, m: string) => messages.push([t, m]), redraw: () => {}, refreshStateLine: (id: string) => refreshed.push(id),
    });
    ctx.onBotMaintenance({ id: 'b', maintenance: rec('maintenance', { settled: false }), opId: null, settled: false, text: 'Same.', notify: false });
    expect(messages).toEqual([]);
    expect((bots[0].maintenance as any).settled).toBe(false);
    expect(refreshed).toEqual(['b']);
  });
  it('ws.onmessage routes bot:maintenance to it', () => {
    expect(pageHtml).toMatch(/case 'bot:maintenance':\s*onBotMaintenance\(payload\)/);
  });
});

describe('U6 the Database window state line', () => {
  it('both views of the Database window hold the line', () => {
    expect(pageFunction('showFleetBackups').match(/<div id="fleet-state-line"><\/div>/g)?.length).toBe(2);
  });
  it("fills the line with the GET's summary as text", async () => {
    const el = { textContent: '' };
    const ctx = load(['refreshStateLine'], {
      document: { getElementById: (id: string) => (id === 'fleet-state-line' ? el : null) },
      api: async (method: string, ep: string) => (method === 'GET' && ep === '/bots/b/maintenance' ? { success: true, summary: 'State: Running.' } : null),
      fleetBackupBotId: 'b',
    });
    vm.runInContext('fleetBackupBotId = "b"', ctx);
    await ctx.refreshStateLine('b');
    expect(el.textContent).toBe('State: Running.');
  });
});
