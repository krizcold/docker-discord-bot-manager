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

const load = (names: string[], extra: Record<string, unknown> = {}) => {
  const ctx = vm.createContext({ Date, String, ...extra });
  vm.runInContext(['escapeHtml', ...names].filter((n) => pageHtml.includes(`function ${n}(`)).map(pageFunction).join('\n'), ctx);
  return ctx;
};

describe('NM16 C7: the card offers Stop from the last docker check', () => {
  it.each([
    [{ status: 'stopped', containersLive: ['app'] }, '', 'app'],
    [{ status: 'error', containersLive: ['app', 'worker'] }, ' disabled', 'app, worker'],
    [{ status: 'stopped', containersLive: ['a<b'] }, '', 'a&lt;b'],
  ])('U1 %o with d %j shows Stop naming %s', (bot, d, names) => {
    const html = load(['stopIfLiveHtml']).stopIfLiveHtml({ id: 'b', ...bot }, d);
    expect(html).toBe(`<button class="btn btn-danger btn-small"${d} onclick="stopBot('b')" title="Docker still runs ${names} for this bot; Stop takes the bot's containers down">Stop</button>`);
  });
  it.each([
    [{ status: 'stopped', containersLive: [] }],
    [{ status: 'error', containersLive: null }],
    [{ status: 'running', containersLive: ['app'] }],
  ])('U1 %o shows no Stop', (bot) => {
    expect(load(['stopIfLiveHtml']).stopIfLiveHtml({ id: 'b', ...bot }, '')).toBe('');
  });
  it('U2 both non-running branches of renderBots carry the button', () => {
    const render = pageFunction('renderBots');
    expect(render.match(/\$\{stopIfLiveHtml\(bot, d\)\}/g)?.length ?? 0).toBe(2);
  });
  it('U3 a docker check redraws the card when the containers it lists change', () => {
    const { checkedChangesCard } = load(['checkedChangesCard']);
    expect(checkedChangesCard({ containersLive: null }, { containersLive: ['app'] })).toBe(true);
    expect(checkedChangesCard({ containersLive: ['app'] }, { containersLive: [] })).toBe(true);
    expect(checkedChangesCard({ containersLive: ['app'] }, { containersLive: ['app'] })).toBe(false);
    expect(checkedChangesCard({}, { containersLive: [] })).toBe(false);
  });
});
