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

describe('showMessage', () => {
  it('gives a warning its own style', () => {
    const el: any = {};
    const ctx = runPage(['showMessage'], { document: { getElementById: () => el }, setTimeout: () => {} });
    ctx.showMessage('warning', 'w');
    expect(el.className).toBe('warning-message');
    expect(pageHtml).toMatch(/\.warning-message \{[^}]*var\(--warning\)/);
  });
});

describe('showNoAnswer', () => {
  it('does not say an instant dismiss may still be running', async () => {
    const messages: string[][] = [];
    const ctx = runPage(['dismissFleetRestoreError', 'showNoAnswer'], {
      api: async () => { throw new Error('x'); },
      showMessage: (t: string, m: string) => messages.push([t, m]),
      loadBots: async () => {}, fleetBackupBotId: null, showFleetBackups: () => {},
    });
    await ctx.dismissFleetRestoreError('b1');
    expect(messages[0][0]).toBe('error');
    expect(messages[0][1]).not.toMatch(/still be running/);
    expect(messages[0][1]).toMatch(/can't be confirmed/);
  });
});

describe('loadPreviousEnvs', () => {
  it('fills nothing when the source changed during the request', async () => {
    const touched: string[] = [];
    const el = (id: string) => ({ value: 'bot', textContent: '', disabled: false, querySelectorAll: () => { touched.push(id); return []; } });
    let ctx: any;
    ctx = runPage(['loadPreviousEnvs'], {
      installSourceId: 's1', installSeq: 1,
      document: { getElementById: el },
      api: async () => { ctx.installSourceId = 's2'; return { success: true, envs: [{ key: 'A', value: '1' }] }; },
      addInstallEnvRow: () => touched.push('add'), setEnvInputValue: () => touched.push('set'),
      showMessage: () => {},
    });
    await ctx.loadPreviousEnvs();
    expect(touched).toEqual([]);
  });
});

describe('saveVaultRow', () => {
  for (const groupType of ['standalone', 'deleted']) {
    it(`sends nothing and says so on an empty ${groupType} save`, async () => {
      const calls: unknown[] = [];
      const messages: string[][] = [];
      const row: any = {
        dataset: { groupId: 'g', groupType, originalKey: 'K' },
        classList: { remove: () => {} },
        querySelector: (s: string) => (s.includes('key') ? { value: 'K' } : { value: '' }),
        querySelectorAll: () => [],
      };
      const ctx = runPage(['saveVaultRow', 'lockBtns'], {
        api: async (...a: unknown[]) => { calls.push(a); return { success: true }; },
        showMessage: (t: string, m: string) => messages.push([t, m]),
        loadVault: () => {}, vaultValuesCache: null,
      });
      await ctx.saveVaultRow(row);
      expect(calls).toEqual([]);
      expect(messages.length).toBe(1);
      expect(messages[0][1]).toMatch(/nothing was saved/);
    });
  }
});

describe('saveEnvEditor', () => {
  it('neither overwrites nor removes a stored env-autowired key', async () => {
    const puts: any[] = [];
    const row: any = {
      classList: { contains: (c: string) => c === 'env-autowired' },
      querySelector: (s: string) => (s === '.env-key'
        ? { value: 'DATABASE_URL', dataset: {} }
        : { value: 'Auto-configured', dataset: {} }),
    };
    const btn: any = { classList: { contains: () => false } };
    const ctx = runPage(['saveEnvEditor', 'envEditorRemovedKeys'], {
      envEditorBotId: 'b1', envEditorSeq: 1, envEditorStored: ['DATABASE_URL'], envEditorInitial: {},
      document: { getElementById: () => btn, querySelector: () => btn, querySelectorAll: () => [row] },
      semanticEnvKey: () => null, missingMasterCandidates: () => false, botLabel: () => 'bot',
      api: async (m: string, _u: string, b: unknown) => { if (m === 'PUT') puts.push(b); return { success: true }; },
      showMessage: () => {}, hideEnvEditor: () => {}, loadBots: () => {},
    });
    await ctx.saveEnvEditor();
    expect(puts.length).toBe(1);
    expect(Object.keys(puts[0].vars)).not.toContain('DATABASE_URL');
    expect(puts[0].removed).not.toContain('DATABASE_URL');
  });
});
