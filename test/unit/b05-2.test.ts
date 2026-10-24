import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

const pageHtml = fs.readFileSync(path.resolve(__dirname, '../../src/webui/public/index.html'), 'utf8');
const pageFunction = (name: string): string => {
  let start = pageHtml.indexOf(`function ${name}(`);
  if (start < 0) return '';
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
const el = (extra: Record<string, any> = {}): any => {
  const cls = new Set<string>(extra.classes || []);
  return {
    innerHTML: '', textContent: '', disabled: false, title: '', value: '', dataset: {}, style: {},
    classList: { add: (c: string) => cls.add(c), remove: (c: string) => cls.delete(c), contains: (c: string) => cls.has(c) },
    querySelector: () => null, querySelectorAll: () => [],
    ...extra,
  };
};

describe('manager self-update never reloads over an open editor', () => {
  const page = (openModal: string | null, dirtyVault = false) => {
    const reloads: number[] = []; const timers: Function[] = [];
    const els: Record<string, any> = {};
    for (const id of ['env-modal', 'config-modal', 'files-modal', 'install-modal', 'fleet-backup-modal', 'source-modal', 'edit-source-modal', 'manager-update-modal'])
      els[id] = el({ classes: id === openModal ? [] : ['hidden'] });
    for (const id of ['manager-update-log', 'manager-update-title', 'manager-update-close', 'manager-updating-pill', 'manager-update-reload'])
      els[id] = el({ classes: id === 'manager-update-reload' ? ['hidden'] : [] });
    const ctx = runPage(['appendManagerLog', 'finishManagerUpdate', 'pageHasUnsavedInput', 'reloadWhenSafe', 'resolveManagerReconnect'], {
      managerUpdating: true,
      managerUpdateBaseline: { commit: 'a', bootId: '1' },
      api: async () => ({ success: true, bootId: '2', currentCommit: 'b' }),
      showMessage: () => {},
      clearInterval: () => {}, managerUpdatePoll: null,
      setTimeout: (f: Function) => timers.push(f),
      window: { location: { reload: () => reloads.push(1) } },
      document: {
        getElementById: (id: string) => els[id] || null,
        querySelector: (s: string) => (dirtyVault && s.includes('.dirty') ? el() : null),
      },
    });
    return { ctx, reloads, timers, els };
  };

  it('reloads after a confirmed update when nothing is open', async () => {
    const p = page(null);
    await p.ctx.resolveManagerReconnect();
    p.timers.forEach(f => f());
    expect(p.reloads.length).toBe(1);
  });

  for (const id of ['env-modal', 'config-modal', 'files-modal', 'install-modal', 'fleet-backup-modal']) {
    it(`an open ${id} keeps the page and offers a Reload button`, async () => {
      const p = page(id);
      await p.ctx.resolveManagerReconnect();
      p.timers.forEach(f => f());
      expect(p.reloads.length).toBe(0);
      expect(p.els['manager-update-reload'].classList.contains('hidden')).toBe(false);
      expect(p.els['manager-update-log'].textContent).toMatch(/reload this page when you have saved/i);
      expect(p.els['manager-update-log'].textContent).not.toMatch(/reloading/i);
    });
  }

  it('a dirty vault row keeps the page', async () => {
    const p = page(null, true);
    await p.ctx.resolveManagerReconnect();
    p.timers.forEach(f => f());
    expect(p.reloads.length).toBe(0);
  });

  it('the update modal stacks above the editor modals', () => {
    const m = /#manager-update-modal\s*\{[^}]*z-index:\s*(\d+)/.exec(pageHtml);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThan(1000);
  });

  it('a beforeunload guard asks while input is unsaved', () => {
    expect(pageHtml).toMatch(/addEventListener\('beforeunload'[^\n]*pageHasUnsavedInput\(\)/);
  });
});

describe('vault re-render keeps a row being edited', () => {
  const mkRow = (gid: string, key: string, val: string, dirty: boolean) => {
    const k = el({ value: key }); const v = el({ value: val });
    return el({
      classes: dirty ? ['dirty'] : [],
      dataset: { groupId: gid, originalKey: key },
      querySelector: (s: string) => (s === '.vault-entry-key-input' ? k : s === '.vault-entry-value-input' ? v : null),
      contains: () => false,
      k, v,
    });
  };
  const page = (oldRows: any[], newKeys: string[], active: any = null, addRow: Record<string, any> = {}) => {
    let rows = oldRows;
    const messages: string[][] = [];
    const list = el({ querySelectorAll: (s: string) => (s === '.vault-entry' ? rows : []) });
    Object.defineProperty(list, 'innerHTML', {
      get: () => '',
      set: () => { rows = newKeys.map(k => mkRow('b1', k, '', false)); },
    });
    const ctx = runPage(['renderVault', 'captureVaultEdits', 'restoreVaultEdits', 'paintVault'], {
      vaultGroups: [{ id: 'b1', type: 'instance', name: 'Bot', entries: newKeys.map(k => ({ key: k, value: '', hidden: true, masked: '***' })) }],
      vaultHealth: {}, expandedVaultGroups: new Set(['b1']), vaultRenderDeferred: false,
      storeHealthBanner: () => '', escapeHtml: (s: string) => s, jsArg: (s: string) => JSON.stringify(s),
      showMessage: (t: string, m: string) => messages.push([t, m]),
      document: { getElementById: (id: string) => (id === 'vault-list' ? list : addRow[id] || null), activeElement: active },
    });
    return { ctx, messages, rows: () => rows };
  };

  it('a dirty row keeps its typed key and value across a background re-render', () => {
    const p = page([mkRow('b1', 'TOKEN', 'typed-secret', true)], ['TOKEN', 'OTHER']);
    p.ctx.renderVault();
    const r = p.rows().find((x: any) => x.dataset.originalKey === 'TOKEN');
    expect(r.v.value).toBe('typed-secret');
    expect(r.classList.contains('dirty')).toBe(true);
  });

  it('a dirty row whose entry vanished defers the re-render and says why', () => {
    const old = mkRow('b1', 'GONE', 'typed', true);
    old.contains = (x: any) => x === old.k;
    const p = page([old], ['OTHER'], old.k);
    p.ctx.renderVault();
    expect(p.rows()[0]).toBe(old);
    expect(old.v.value).toBe('typed');
    expect(p.messages.some(m => /changed elsewhere/i.test(m[1]))).toBe(true);
  });
});

describe('vault edits after review', () => {
  it('a dirty row that lost focus is not called kept when its group collapses', () => {
    const k = el({ value: 'TOKEN' }); const v = el({ value: 'typed' });
    const row = el({ classes: ['dirty'], dataset: { groupId: 'b1', originalKey: 'TOKEN' }, contains: () => false,
      querySelector: (s: string) => (s === '.vault-entry-key-input' ? k : v) });
    const messages: string[][] = [];
    const list = el({ querySelectorAll: (s: string) => (s === '.vault-entry' ? [row] : []) });
    const ctx = runPage(['renderVault', 'captureVaultEdits', 'restoreVaultEdits', 'paintVault'], {
      vaultGroups: [{ id: 'b1', type: 'instance', name: 'Bot', entries: [{ key: 'TOKEN', value: '', hidden: true, masked: '***' }] }],
      vaultHealth: {}, expandedVaultGroups: new Set(), vaultRenderDeferred: false,
      storeHealthBanner: () => '', escapeHtml: (s: string) => s, jsArg: (s: string) => JSON.stringify(s),
      showMessage: (t: string, m: string) => messages.push([t, m]),
      document: { getElementById: (id: string) => (id === 'vault-list' ? list : null), activeElement: null },
    });
    ctx.renderVault();
    expect(messages.some(m => /is kept/.test(m[1]))).toBe(false);
  });

  it('adding a standalone entry empties the add row after the re-render', async () => {
    const newKey = el({ value: 'NEWKEY' }); const newValue = el({ value: 'v1' });
    const list = el();
    const doc = { getElementById: (id: string) => (id === 'vault-list' ? list : id === 'vault-new-key' ? newKey : id === 'vault-new-value' ? newValue : null), activeElement: null };
    const ctx: any = runPage(['addVaultEntry', 'renderVault', 'captureVaultEdits', 'restoreVaultEdits', 'paintVault'], {
      vaultGroups: [{ id: 's', type: 'standalone', name: 'Standalone', entries: [{ key: 'NEWKEY', value: 'v1', hidden: false }] }],
      vaultHealth: {}, expandedVaultGroups: new Set(['s']), vaultRenderDeferred: false, newVaultHidden: false,
      storeHealthBanner: () => '', escapeHtml: (s: string) => s, jsArg: (s: string) => JSON.stringify(s),
      showMessage: () => {}, api: async () => ({ success: true }), document: doc,
    });
    ctx.loadVault = () => ctx.renderVault();
    await ctx.addVaultEntry();
    expect(newKey.value).toBe('');
    expect(newValue.value).toBe('');
  });
});

describe('saveVaultRow refuses an empty value on a dirty instance row', () => {
  it('says nothing was saved and keeps the row dirty', async () => {
    const sent: any[] = []; const messages: string[][] = [];
    const k = el({ value: 'TOKEN' }); const v = el({ value: '' });
    const row = el({
      classes: ['dirty'], dataset: { groupId: 'b1', groupType: 'instance', originalKey: 'TOKEN' },
      querySelector: (s: string) => (s === '.vault-entry-key-input' ? k : s === '.vault-entry-value-input' ? v : null),
    });
    const ctx = runPage(['lockBtns', 'saveVaultRow'], {
      api: async (...a: any[]) => { sent.push(a); return { success: true }; },
      showMessage: (t: string, m: string) => messages.push([t, m]),
      loadVault: () => {}, vaultValuesCache: null,
    });
    await ctx.saveVaultRow(row);
    expect(sent.length).toBe(0);
    expect(row.classList.contains('dirty')).toBe(true);
    expect(messages.some(m => m[0] === 'error' && /nothing was saved/i.test(m[1]))).toBe(true);
  });
});

describe('toggleNameLock flips the name field without rebuilding the Install form', () => {
  it('keeps the rest of the form and only toggles the name controls', () => {
    const input = el({ value: 'mybot', disabled: true });
    const reset = el({ style: { display: 'none' } }); const edit = el();
    const group = el({ querySelector: (s: string) => (s === '.name-reset-btn' ? reset : s === '.name-edit-btn' ? edit : null) });
    input.closest = () => group;
    let rendered = 0;
    const ctx = runPage(['toggleNameLock'], {
      installNameLocked: true, installSourceId: 's1', sources: [{ id: 's1', composeName: 'mybot' }],
      getRepoName: () => '', renderInstallModal: () => { rendered++; }, onNameInput: () => {},
      document: { getElementById: (id: string) => (id === 'install-name' ? input : null) },
    });
    ctx.toggleNameLock();
    expect(rendered).toBe(0);
    expect(input.disabled).toBe(false);
    expect(reset.style.display).toBe('');
    ctx.toggleNameLock();
    expect(rendered).toBe(0);
    expect(input.disabled).toBe(true);
    expect(reset.style.display).toBe('none');
  });
});
