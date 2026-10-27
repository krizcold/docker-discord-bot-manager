import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { describe, expect, it } from 'vitest';

const src = (p: string) => fs.readFileSync(path.resolve(__dirname, '../../src', p), 'utf8');
const pageHtml = src('webui/public/index.html');
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

const cardActions = (() => {
  const body = pageFunction('renderBots');
  const running = body.indexOf('${isRunning ? `');
  const started = body.indexOf('` : (bot.hasBeenStarted || bot.lastStartAt) ? `');
  const never = body.indexOf('` : `', started + 10);
  if (running < 0 || started < 0 || never < 0) throw new Error('card action branches not found');
  return { running: body.slice(running, started), stopped: body.slice(started, never) };
})();

describe('every built card renders a Build control', () => {
  it('the running card renders Build outside the Fetch/Update choice', () => {
    expect(cardActions.running).toMatch(/onclick="buildBotImage\('\$\{bot\.id\}'\)"[^>]*>Build</);
    expect(cardActions.running.indexOf('buildBotImage')).toBeLessThan(cardActions.running.indexOf('showFetch'));
  });
  it('the stopped card renders Build outside the Fetch/Update choice', () => {
    expect(cardActions.stopped).toMatch(/onclick="buildBotImage\('\$\{bot\.id\}'\)"[^>]*>Build</);
    expect(cardActions.stopped.indexOf('buildBotImage')).toBeLessThan(cardActions.stopped.indexOf('showFetch'));
  });
  it('Build calls POST /bots/:id/build and reports a refusal as an error', async () => {
    const calls: string[][] = [];
    const logs: string[][] = [];
    const ctx = vm.createContext({
      bots: [{ id: 'b1', displayName: 'One', status: 'stopped' }], busyBots: new Set(), isTransientStatus: () => false,
      renderBots: () => {}, loadBots: () => {}, terminalBotId: 'b1',
      openTerminalPopup: () => {}, streamBuildLogs: () => {}, showMessage: () => {}, showNoAnswer: () => {},
      addTerminalLog: (m: string, t: string) => logs.push([m, t]), markTerminalComplete: () => {},
      api: async (method: string, url: string) => { calls.push([method, url]); return { success: false, error: 'busy' }; },
    });
    vm.runInContext(pageFunction('buildBotImage'), ctx);
    await ctx.buildBotImage('b1');
    expect(calls).toEqual([['POST', '/bots/b1/build']]);
    expect(logs).toContainEqual(['Error: busy', 'error']);
  });
});

describe('remedies name the Build control', () => {
  const texts = [src('instance/fleetReplica.ts'), src('docker/containerManager.ts'), pageHtml];
  it('no remedy tells the operator to press Update or to rebuild the instance', () => {
    for (const t of texts) {
      expect(t).not.toMatch(/press Update|Press Update|Press Start \(or Update\)/);
      expect(t).not.toMatch(/rebuild it if a stopped re-seed|rebuilding the instance starts/);
    }
  });
  it('the stopped re-seed remedy names Build', () => {
    expect(src('instance/fleetReplica.ts')).toContain('press Build on its card');
  });
});
