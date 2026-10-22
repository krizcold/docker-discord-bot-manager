import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

const pageHtml = fs.readFileSync(path.resolve(__dirname, '../../src/webui/public/index.html'), 'utf8');
// A top-level page function ends at the first closing brace at its own indent.
const pageFunction = (name: string): string => {
  let start = pageHtml.indexOf(`function ${name}(`);
  if (start < 0) return '';
  if (pageHtml.slice(start - 6, start) === 'async ') start -= 6;
  const end = pageHtml.indexOf('\n    }\n', start);
  if (end < 0) throw new Error(`no end for ${name}`);
  return pageHtml.slice(start, end + 6);
};
const runPage = (names: string[], globals: Record<string, unknown>): any => {
  const ctx = vm.createContext({ ...globals });
  vm.runInContext(names.map(pageFunction).join('\n'), ctx);
  return ctx;
};
const helpers = ['isBadNumber', 'refuseBadNumbers'];

const numInput = (value: string, bad = false) => ({ value, validity: { badInput: bad }, dataset: {} as any, defaultValue: value });

const common = (sent: any[], messages: string[][], els: Record<string, any>) => ({
  document: {
    getElementById: (id: string) => els[id] || null,
    querySelectorAll: (s: string) => els[s] || [],
    querySelector: () => ({ disabled: false, textContent: '', isConnected: true }),
  },
  api: async (method: string, url: string, body: any) => { sent.push({ method, url, body }); return { success: true, removed: [], fleetBackup: body }; },
  showMessage: (type: string, text: string) => { messages.push([type, text]); },
  loadBots: () => {}, hideEnvEditor: () => {}, confirm: () => true, alert: () => {},
  semanticEnvKey: () => null, envEditorInitial: {}, envEditorStored: [], envEditorBotId: 'b1',
});

const envRow = (key: string, val: any) => ({
  classList: { contains: () => false },
  querySelector: (s: string) => (s === '.env-key' ? { value: key, dataset: {} } : s === '.env-value' ? val : null),
});

describe('number env rows the browser cannot parse are refused', () => {
  it('the env editor saves nothing and names the row', async () => {
    const sent: any[] = []; const messages: string[][] = [];
    const ctx = runPage([...helpers, 'envEditorRemovedKeys', 'saveEnvEditor'], common(sent, messages, {
      '#env-editor-rows .env-row': [envRow('PORT', numInput('', true)), envRow('NAME', numInput('x'))],
    }));
    await ctx.saveEnvEditor();
    expect(sent).toHaveLength(0);
    expect(messages).toHaveLength(1);
    expect(messages[0][0]).toBe('error');
    expect(messages[0][1]).toContain('PORT');
    expect(messages[0][1]).toContain('Nothing was saved');
  });

  it('the install wizard creates nothing and names the row', async () => {
    const sent: any[] = []; const messages: string[][] = [];
    const ctx = runPage([...helpers, 'doInstall'], {
      ...common(sent, messages, {
        'install-name': { value: 'bot' },
        '#install-env-rows .env-row': [envRow('LIMIT', numInput('', true))],
      }),
      guidedReadyToSave: async () => true, installBotId: null, installSourceId: 's',
    });
    await ctx.doInstall();
    expect(sent).toHaveLength(0);
    expect(messages[0][0]).toBe('error');
    expect(messages[0][1]).toContain('LIMIT');
  });
});

describe('fleet backup Keep', () => {
  const page = (keep: any, storedKeep = 7, confirmAnswer = true) => {
    const sent: any[] = []; const messages: string[][] = []; const asked: string[] = [];
    const ctx = runPage([...helpers, 'saveFleetBackupConfig'], {
      ...common(sent, messages, {
        'fleet-backup-enabled': { checked: true },
        'fleet-backup-hour': { value: '4' },
        'fleet-backup-keep': keep,
      }),
      fleetBackupBotId: 'b1',
      fleetBackupStoredKeep: storedKeep,
      confirm: (t: string) => { asked.push(t); return confirmAnswer; },
    });
    return { ctx, sent, messages, asked };
  };

  it('unparsable text is refused, never saved as 7', async () => {
    const p = page(numInput('', true), 30);
    await p.ctx.saveFleetBackupConfig();
    expect(p.sent).toHaveLength(0);
    expect(p.messages[0][0]).toBe('error');
  });

  it('0 and a blank are refused, never saved as 7', async () => {
    for (const v of ['0', '', '2.5']) {
      const p = page(numInput(v), 30);
      await p.ctx.saveFleetBackupConfig();
      expect(p.sent).toHaveLength(0);
      expect(p.messages[0][0]).toBe('error');
    }
  });

  it('lowering Keep asks first; a decline sends nothing and shows the stored value', async () => {
    const el = numInput('3');
    const p = page(el, 30, false);
    await p.ctx.saveFleetBackupConfig();
    expect(p.asked).toHaveLength(1);
    expect(p.sent).toHaveLength(0);
    expect(el.value).toBe('30');
  });

  it('a valid raise saves the typed number', async () => {
    const p = page(numInput('40'), 30);
    await p.ctx.saveFleetBackupConfig();
    expect(p.asked).toHaveLength(0);
    expect(p.sent[0].body).toEqual({ enabled: true, hour: 4, keep: 40 });
  });
});

describe('port and WAL fields the browser cannot parse are refused', () => {
  const cases: [string, string, Record<string, any>][] = [
    ['enableFleetReplication', 'fleet-repl-port', { 'fleet-repl-host': { value: 'h' } }],
    ['enableFleetReplication', 'fleet-repl-keep', { 'fleet-repl-host': { value: 'h' } }],
    ['armRecoveryReceiver', 'rc-recv-port', { 'rc-recv-host': { value: 'h' } }],
    ['armRecoverySource', 'rc-src-port', { 'rc-src-host': { value: 'h' }, 'rc-src-cert': { value: 'c' }, 'rc-src-token': { value: 't' } }],
    ['provisionFleetReplicaFromFacts', 'replica-port', { 'replica-host': { value: 'h' } }],
    ['provisionFleetReplica', 'replica-port', { 'replica-host': { value: 'h' }, 'replica-dsn': { value: 'd' }, 'replica-cert': { value: 'c' } }],
    ['reseedStalePrimary', 'reseed-port', { 'reseed-host': { value: 'h' }, 'reseed-dsn': { value: 'd' }, 'reseed-cert': { value: 'c' } }],
  ];
  for (const [fn, field, els] of cases) {
    it(`${fn} refuses an unparsable ${field}`, async () => {
      const sent: any[] = []; const messages: string[][] = [];
      const ctx = runPage([...helpers, fn], { ...common(sent, messages, { ...els, [field]: numInput('', true) }), window: { confirm: () => true } });
      await ctx[fn]('b1');
      expect(sent).toHaveLength(0);
      expect(messages[0]?.[0]).toBe('error');
    });
  }

  it('appTransfer seeding first refuses an unparsable replica-port', async () => {
    const sent: any[] = []; const messages: string[][] = [];
    const ctx = runPage([...helpers, 'appTransfer'], common(sent, messages, { 'replica-host': { value: 'h' }, 'replica-port': numInput('', true) }));
    await ctx.appTransfer('b1', false, true, false);
    expect(sent).toHaveLength(0);
    expect(messages[0]?.[0]).toBe('error');
  });
});

describe('the guided form coerce honours badInput', () => {
  it('an unparsable number input (blank value, badInput set) is flagged, never written', () => {
    const calls: any[] = [];
    const ctx: any = vm.createContext({ setTimeout, clearTimeout, Promise, console,
      document: { activeElement: null, createElement: () => ({}), head: { appendChild() {} }, getElementById: () => null, querySelectorAll: () => [], querySelector: () => null },
      api: (m: string, u: string, b: any) => { calls.push(b); return Promise.resolve({ success: true, body: '{}', skipped: [] }); },
    });
    ctx.window = ctx;
    vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../src/webui/public/guidedConfig.js'), 'utf8'), ctx);
    ctx.guidedRegister('g1', { format: 'json', sections: [{ id: 's', title: 'S', fields: [{ type: 'number', label: 'N', target: { path: 'n' } }] }] }, 'json', { n: 3 });
    const cls = new Set<string>();
    const el: any = { value: '', validity: { badInput: true }, title: '', classList: { add: (c: string) => cls.add(c), remove: (c: string) => cls.delete(c), contains: (c: string) => cls.has(c) } };
    ctx.guidedEdit('g1', 'n', 'number', el);
    expect(cls.has('gc-invalid')).toBe(true);
    expect(calls).toHaveLength(0);
  });
});
