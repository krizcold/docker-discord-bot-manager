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

type El = { innerHTML: string; textContent: string; isConnected: boolean; classList: { remove: () => void; add: () => void } };
const el = (): El => ({ innerHTML: '', textContent: 'stale', isConnected: true, classList: { remove: () => {}, add: () => {} } });

const load = (names: string[], answers: (method: string, url: string) => unknown, extra: Record<string, unknown> = {}) => {
  const els: Record<string, El> = {};
  const calls: Array<[string, string]> = [];
  const ctx = vm.createContext({
    api: async (method: string, url: string) => { calls.push([method, url]); return answers(method, url); },
    showMessage: () => {},
    setTimeout: () => 0,
    fleetBackupBotId: 'a',
    bots: [],
    document: { getElementById: (id: string) => (els[id] ??= el()) },
    Array, String, Number, JSON, Date, Math, Object, encodeURIComponent,
    ...extra,
  });
  vm.runInContext(['escapeHtml', 'jsArg', ...names].map(pageFunction).join('\n'), ctx);
  return { ctx, els, calls };
};

const LEAD = "Connections: can't confirm that this database accepts every connection the bot can open: ";
const read = (machines: number, count: number, overlap: boolean, allowed = 97) =>
  ({ success: true, connections: { state: 'read', machines, count, overlap, max: 100, reserved: 3, allowed } });

describe('CU1: the connections line', () => {
  const line = async (answer: unknown) => {
    const { ctx, els, calls } = load(['connectionLineText', 'renderConnectionLine'], () => { if (answer instanceof Error) throw answer; return answer; });
    await ctx.renderConnectionLine('a');
    expect(calls).toEqual([['GET', '/bots/a/fleet-connections']]);
    return els['fleet-connections-line'].textContent;
  };
  it('over the limit, 1 machine, with and without overlap', async () => {
    expect(await line(read(1, 120, false))).toBe("Connections: this bot's 1 machine seen in the last 7 days can open up to 120 connections to this database at once, more than the 97 it accepts (max_connections 100, less 3 that Postgres reserves for superusers and for roles granted pg_use_reserved_connections). A connection past that is refused.");
    expect(await line(read(1, 120, true))).toBe("Connections: this bot's 1 machine seen in the last 7 days can open up to 120 connections to this database at once (during a reshard beside the running shards), more than the 97 it accepts (max_connections 100, less 3 that Postgres reserves for superusers and for roles granted pg_use_reserved_connections). A connection past that is refused.");
  });
  it('over the limit, 3 machines', async () => {
    expect(await line(read(3, 132, true))).toBe("Connections: this bot's 3 machines seen in the last 7 days can open up to 132 connections to this database at once (during a reshard beside the running shards), more than the 97 it accepts (max_connections 100, less 3 that Postgres reserves for superusers and for roles granted pg_use_reserved_connections). A connection past that is refused.");
    expect(await line(read(3, 132, false))).toBe("Connections: this bot's 3 machines seen in the last 7 days can open up to 132 connections to this database at once, more than the 97 it accepts (max_connections 100, less 3 that Postgres reserves for superusers and for roles granted pg_use_reserved_connections). A connection past that is refused.");
  });
  it('at or under the limit, and none: empty', async () => {
    expect(await line(read(1, 44, true))).toBe('');
    expect(await line(read(3, 97, false))).toBe('');
    expect(await line({ success: true, connections: { state: 'none' } })).toBe('');
  });
  it('unread, success false, no answer: can\'t confirm', async () => {
    expect(await line({ success: true, connections: { state: 'unread', error: 'the database did not answer (no answer)' } })).toBe(`${LEAD}the database did not answer (no answer)`);
    expect(await line({ success: false, error: 'Bot not found' })).toBe(`${LEAD}Bot not found`);
    expect(await line(new Error('down'))).toBe(`${LEAD}no answer from the manager`);
    expect(await line(null)).toBe(`${LEAD}no answer from the manager`);
  });
  it('another bot\'s window open: nothing is asked', async () => {
    const { ctx, calls } = load(['connectionLineText', 'renderConnectionLine'], () => read(1, 120, false), { fleetBackupBotId: 'b' });
    await ctx.renderConnectionLine('a');
    expect(calls).toEqual([]);
  });
});

describe('CU2: only the main\'s window holds the line', () => {
  const open = async (bot: Record<string, unknown>) => {
    const noop = () => {};
    const seen: string[] = [];
    const { ctx, els } = load(['showFleetBackups'], () => null, {
      bots: [bot], fleetBackupStored: null,
      fleetBackupListHtml: async () => '', fleetBackupErrorHtml: () => '', renderSeedBanner: noop, renderFleetReplication: noop, renderFleetSwitch: noop,
      refreshFleetBackupStatus: noop, renderFleetReplica: noop, renderPastFleetBackups: noop, refreshStateLine: noop, renderMemoryLine: noop,
      renderConnectionLine: (id: string) => { seen.push(id); },
    });
    await ctx.showFleetBackups('a');
    return { html: els['fleet-backup-content'].innerHTML, seen };
  };
  it('the main', async () => {
    const { html, seen } = await open({ id: 'a', displayName: 'A', fleetDb: {} });
    expect(seen).toEqual(['a']);
    expect(html).toContain('<div id="fleet-connections-line" class="env-tip"></div>');
    expect(html.indexOf('fleet-memory-line')).toBeLessThan(html.indexOf('fleet-connections-line'));
  });
  it('the copy and the plain bot', async () => {
    for (const bot of [{ id: 'a', displayName: 'A', fleetDbReplica: {} }, { id: 'a', displayName: 'A' }]) {
      const { html, seen } = await open(bot);
      expect(html).not.toContain('fleet-connections-line');
      expect(seen).toEqual([]);
    }
  });
});
