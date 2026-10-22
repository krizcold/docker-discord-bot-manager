import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

const pageHtml = fs.readFileSync(process.env.B05_PAGE || path.resolve(__dirname, '../../src/webui/public/index.html'), 'utf8');
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

const deferred = () => {
  let resolve!: (v: any) => void;
  const promise = new Promise<any>(r => { resolve = r; });
  return { promise, resolve };
};
const tick = () => new Promise(r => setTimeout(r, 0));

const el = (extra: Record<string, any> = {}): any => {
  const cls = new Set<string>();
  const children: any[] = [];
  return {
    innerHTML: '', textContent: '', disabled: false, isConnected: true, dataset: {}, value: '', children,
    classList: { add: (c: string) => cls.add(c), remove: (c: string) => cls.delete(c), contains: (c: string) => cls.has(c) },
    appendChild: (c: any) => children.push(c),
    querySelector: () => null,
    querySelectorAll: () => [],
    ...extra,
  };
};
const bots = [{ id: 'b1', displayName: 'Bot 1' }, { id: 'b2', displayName: 'Bot 2' }];

describe('env editor saves only to the bot whose rows it collected', () => {
  const envPage = (validate: Promise<any>) => {
    const sent: any[] = []; const messages: string[][] = [];
    const modal = el(); const saveBtn = el(); const cancelBtn = el(); const rowsEl = el();
    const row = el({
      querySelector: (s: string) => (s === '.env-key'
        ? { value: 'DB_URL', dataset: { originalKey: 'DB_URL' } }
        : s === '.env-value' ? { value: 'postgres://new', dataset: {} } : null),
    });
    const ctx = runPage(['botLabel', 'envEditorRemovedKeys', 'missingMasterCandidates', 'dialsOutRole', 'semanticWrapper', 'semanticEnvValue', 'semanticValuesOf', 'saveEnvEditor', 'hideEnvEditor'], {
      bots, envEditorBotId: 'b1', envEditorSeq: 0, envEditorInitial: { DB_URL: 'postgres://old' }, envEditorStored: ['DB_URL'],
      document: {
        querySelectorAll: (s: string) => (s === '#env-editor-rows .env-row' ? [row] : []),
        querySelector: (s: string) => (s === '#env-editor-content .btn-primary' ? saveBtn : null),
        getElementById: (id: string) => ({ 'env-modal': modal, 'env-editor-rows': rowsEl, 'env-editor-cancel': cancelBtn } as any)[id] || null,
      },
      semanticEnvKey: () => 'DB_URL',
      confirm: () => true,
      api: async (method: string, url: string, body: any) => {
        sent.push({ method, url, body });
        if (url.endsWith('/validate-db')) return validate;
        return { success: true };
      },
      showMessage: (t: string, m: string) => messages.push([t, m]),
      loadBots: () => {},
    });
    return { ctx, sent, messages, modal, cancelBtn };
  };

  it('a save whose editor was closed and reopened on another bot during validate-db writes nothing', async () => {
    const v = deferred();
    const { ctx, sent, messages, modal } = envPage(v.promise);
    const p = ctx.saveEnvEditor();
    await tick();
    ctx.hideEnvEditor();
    ctx.envEditorBotId = 'b2'; ctx.envEditorSeq++; modal.classList.remove('hidden');
    v.resolve({ success: true, ok: true });
    await p;
    expect(sent.filter(s => s.method === 'PUT')).toEqual([]);
    expect(messages.some(([t, m]) => t === 'error' && /Nothing was saved/.test(m) && /Bot 1/.test(m))).toBe(true);
    expect(modal.classList.contains('hidden')).toBe(false);
  });

  it('a save on the open editor PUTs to its own bot, names it, and holds Cancel while it runs', async () => {
    const v = deferred();
    const { ctx, sent, messages, modal, cancelBtn } = envPage(v.promise);
    const p = ctx.saveEnvEditor();
    await tick();
    expect(cancelBtn.disabled).toBe(true);
    v.resolve({ success: true, ok: true });
    await p;
    expect(sent.find(s => s.method === 'PUT').url).toBe('/bots/b1/env');
    expect(messages).toContainEqual(['success', 'Environment variables of Bot 1 saved']);
    expect(modal.classList.contains('hidden')).toBe(true);
    expect(cancelBtn.disabled).toBe(false);
  });
});

describe('env editor load', () => {
  it('a late load for one bot never fills the editor opened for another', async () => {
    const g = deferred();
    const content = el(); const modal = el();
    const ctx = runPage(['showEnvEditor', 'hideEnvEditor'], {
      bots, envEditorBotId: null, envEditorSeq: 0, envEditorInitial: {}, envEditorStored: [],
      document: {
        getElementById: (id: string) => ({ 'env-modal': modal, 'env-editor-content': content } as any)[id] || null,
        querySelectorAll: () => [],
      },
      escapeHtml: (s: string) => s, renderEnvRows: () => 'ROWS-B1', initEnvConditionals: () => {}, attachFleetMasterPrefill: () => {},
      api: async () => g.promise,
    });
    const p = ctx.showEnvEditor('b1');
    await tick();
    ctx.hideEnvEditor();
    ctx.envEditorBotId = 'b2'; ctx.envEditorSeq++; content.innerHTML = 'EDITOR-B2';
    g.resolve({ success: true, valid: true, vars: [] });
    await p;
    expect(content.innerHTML).toBe('EDITOR-B2');
  });
});

describe('config editor saves only to the bot whose rows it collected', () => {
  const cfgPage = (ready: Promise<boolean>, withRows = true) => {
    const sent: any[] = []; const messages: string[][] = [];
    const modal = el(); const saveBtn = el(); const cancelBtn = el();
    const block = el({
      querySelector: (s: string) => ({
        '.cf-path': { value: '/app/config.json' }, '.cf-body': { value: '{"a":1}' },
        '.cf-writable': { checked: false }, '.cf-enabled': { checked: true },
      } as any)[s],
    });
    const ctx = runPage(['botLabel', 'saveConfigEditor', 'hideConfigEditor'], {
      bots, configEditorBotId: 'b1', configEditorSeq: 0,
      document: {
        querySelectorAll: (s: string) => (withRows && s === '#config-editor-rows .config-file-block' ? [block] : []),
        querySelector: (s: string) => (s === '#config-editor-content .btn-primary' ? saveBtn : null),
        getElementById: (id: string) => ({ 'config-modal': modal, 'config-editor-rows': withRows ? el() : null, 'config-editor-cancel': cancelBtn } as any)[id] || null,
      },
      guidedReadyToSave: async () => ready,
      api: async (method: string, url: string, body: any) => { sent.push({ method, url, body }); return { success: true }; },
      showMessage: (t: string, m: string) => messages.push([t, m]),
      loadBots: () => {},
    });
    return { ctx, sent, messages, modal, saveBtn };
  };

  it('a save whose editor was closed and reopened on another bot during the guided flush writes nothing', async () => {
    const r = deferred();
    const { ctx, sent, modal, saveBtn } = cfgPage(r.promise);
    const p = ctx.saveConfigEditor();
    await tick();
    expect(saveBtn.disabled).toBe(true);
    ctx.hideConfigEditor();
    ctx.configEditorBotId = 'b2'; ctx.configEditorSeq++; modal.classList.remove('hidden');
    r.resolve(true);
    await p;
    expect(sent).toEqual([]);
  });

  it('refuses a PUT when the editor holds no rows container (it would empty the bot\'s files)', async () => {
    const { ctx, sent } = cfgPage(Promise.resolve(true), false);
    await ctx.saveConfigEditor();
    expect(sent).toEqual([]);
  });

  it('a save on the open editor PUTs to its own bot and names it', async () => {
    const { ctx, sent, messages, modal } = cfgPage(Promise.resolve(true));
    await ctx.saveConfigEditor();
    expect(sent.map(s => s.url)).toEqual(['/bots/b1/config']);
    expect(messages[0][0]).toBe('success');
    expect(messages[0][1]).toMatch(/Bot 1/);
    expect(modal.classList.contains('hidden')).toBe(true);
  });
});

describe('install modal answers land only in the form they were asked for', () => {
  const installGlobals = (api: any, extra: Record<string, any> = {}) => {
    const modal = el(); const content = el(); const btn = el(); const rowsEl = el();
    const messages: string[][] = []; const renders: any[] = [];
    const ctx = runPage(['botLabel', 'showInstallModal', 'hideInstallModal', 'scanInstallEnvs', 'inspectInstallImage', 'addInstallEnvRow', 'missingMasterCandidates', 'dialsOutRole', 'semanticWrapper', 'semanticEnvValue', 'semanticValuesOf', 'doInstall', 'cloneAndInstallSource'], {
      bots, sources: [{ id: 's1', url: 'https://x/one.git' }, { id: 's2', url: 'https://x/two.git' }],
      installSourceId: null, installSeq: 0, installBotId: null, installNameLocked: true, installEnvHints: [], installConfigHints: [],
      installInteractiveSetup: null, installIsImage: false, installDetectError: null, cloningSources: new Set(),
      getRepoName: (u: string) => u.split('/').pop(),
      document: {
        getElementById: (id: string) => ({ 'install-modal': modal, 'install-modal-content': content, 'install-btn': btn, 'install-env-rows': rowsEl, 'install-name': { value: 'My Bot' } } as any)[id] || null,
        querySelectorAll: () => [],
        createElement: () => el(),
      },
      renderInstallModal: (...args: any[]) => renders.push({ args, sourceId: ctx.installSourceId, hints: ctx.installEnvHints, detectError: ctx.installDetectError }),
      renderSourceSidebar: () => {}, loadSources: async () => {}, loadBots: () => {},
      guidedReadyToSave: async () => true,
      escapeHtml: (s: string) => s,
      showMessage: (t: string, m: string) => messages.push([t, m]),
      api,
      ...extra,
    });
    return { ctx, modal, content, btn, rowsEl, messages, renders };
  };

  it('a late detection answer for one source never renders over the form opened for another', async () => {
    const first = deferred();
    const { ctx, renders } = installGlobals(async (_m: string, url: string) => (url.startsWith('/sources/s1/') ? first.promise : { success: true, vars: [{ key: 'TWO' }] }));
    const p1 = ctx.showInstallModal('s1');
    await tick();
    await ctx.showInstallModal('s2');
    first.resolve({ success: true, vars: [{ key: 'ONE' }] });
    await p1;
    expect(renders.length).toBe(1);
    expect(renders[0].sourceId).toBe('s2');
    expect(renders[0].hints).toEqual([{ key: 'TWO' }]);
  });

  it('a failed detection read renders as a failure, not as an empty result', async () => {
    const thrown = installGlobals(async () => { throw new Error('net'); });
    await thrown.ctx.showInstallModal('s1');
    expect(thrown.renders[0].detectError).toBeTruthy();
    const refused = installGlobals(async () => ({ success: false, error: 'not cloned' }));
    await refused.ctx.showInstallModal('s1');
    expect(refused.renders[0].detectError).toMatch(/not cloned/);
  });

  it('a late scan answer adds no rows to a form opened for another source', async () => {
    const d = deferred();
    const { ctx, rowsEl, messages } = installGlobals(async () => d.promise);
    ctx.installSourceId = 's1';
    const p = ctx.scanInstallEnvs();
    await tick();
    ctx.installSourceId = 's2'; ctx.installSeq++;
    d.resolve({ success: true, vars: [{ key: 'NEW' }] });
    await p;
    expect(rowsEl.children).toEqual([]);
    expect(messages).toEqual([]);
  });

  it('a late image inspect adds no rows to a form opened for another source', async () => {
    const d = deferred();
    const { ctx, rowsEl, messages } = installGlobals(async () => d.promise);
    ctx.installSourceId = 's1';
    const p = ctx.inspectInstallImage(null);
    await tick();
    ctx.installSourceId = 's2'; ctx.installSeq++;
    d.resolve({ success: true, vars: [{ key: 'NEW' }] });
    await p;
    expect(rowsEl.children).toEqual([]);
    expect(messages).toEqual([]);
  });

  it('an install whose form was closed and reopened mid-create keeps its env on its own instance and leaves the new form alone', async () => {
    const create = deferred();
    const sent: any[] = [];
    const row = el({
      classList: { contains: () => false },
      querySelector: (s: string) => (s === '.env-key' ? { value: 'TOKEN' } : s === '.env-value' ? { value: 'abc', dataset: {} } : null),
    });
    const g = installGlobals(async (method: string, url: string, body: any) => {
      sent.push({ method, url, body });
      return url === '/bots' ? create.promise : { success: true };
    });
    g.ctx.document.querySelectorAll = (s: string) => (s === '#install-env-rows .env-row' ? [row] : []);
    g.ctx.installSourceId = 's1';
    const p = g.ctx.doInstall();
    await tick();
    g.ctx.hideInstallModal();
    g.ctx.installSourceId = 's2'; g.ctx.installSeq++; g.modal.classList.remove('hidden');
    create.resolve({ success: true, bot: { id: 'new1' } });
    await p;
    expect(g.ctx.installBotId).toBe(null);
    expect(sent.find(s => s.method === 'PUT')).toEqual({ method: 'PUT', url: '/bots/new1/env', body: { vars: { TOKEN: 'abc' } } });
    expect(g.modal.classList.contains('hidden')).toBe(false);
    expect(g.messages.some(([t, m]) => t === 'success' && /new1/.test(m))).toBe(true);
  });

  it('a finished clone never replaces an open install form', async () => {
    const shown: string[] = [];
    const g = installGlobals(async () => ({ success: true }));
    g.ctx.showInstallModal = (id: string) => { shown.push(id); };
    await g.ctx.cloneAndInstallSource('s2');
    expect(shown).toEqual([]);
    expect(g.messages.some(([t]) => t === 'success')).toBe(true);
    g.modal.classList.add('hidden');
    await g.ctx.cloneAndInstallSource('s1');
    expect(shown).toEqual(['s1']);
  });
});

describe('install form rendering', () => {
  it('a failed detection shows Retry, names the source and keeps Save & Install disabled', () => {
    const content = el();
    const ctx = runPage(['renderInstallModal'], {
      sources: [{ id: 's1', url: 'https://x/one.git' }], installSourceId: 's1', installNameLocked: true, installEnvHints: [],
      installConfigHints: [], installInteractiveSetup: null, installIsImage: false,
      getRepoName: (u: string) => u.split('/').pop(), escapeHtml: (s: string) => s, jsArg: (s: string) => JSON.stringify(s),
      buildEnvRowHtml: () => '', buildConfigFileBlockHtml: () => '', renderEnvRows: () => '',
      onNameInput: () => {}, initEnvConditionals: () => {}, autofillGenerateSecrets: () => {}, attachFleetMasterPrefill: () => {},
      window: {},
      document: { getElementById: (id: string) => (id === 'install-modal-content' ? content : null) },
    });
    ctx.installDetectError = 'not cloned'; ctx.renderInstallModal('My Bot');
    expect(content.innerHTML).toMatch(/Retry/);
    expect(content.innerHTML).toMatch(/not cloned/);
    expect(content.innerHTML).toMatch(/one\.git/);
    expect(content.innerHTML).toMatch(/id="install-btn"[^>]*disabled/);
    expect(content.innerHTML).toMatch(/data-source-id="s1"/);
  });
});

describe('fleet adopt closes only the modal it ran from', () => {
  it('a late adopt answer leaves another bot\'s fleet modal open and names its instance', async () => {
    const d = deferred();
    let hidden = 0; const messages: string[][] = [];
    const ctx = runPage(['botLabel', 'adoptPromotedReplica'], {
      bots, fleetBackupBotId: 'b1', confirm: () => true,
      api: async () => d.promise,
      hideFleetBackups: () => { hidden++; }, loadBots: () => {},
      showMessage: (t: string, m: string) => messages.push([t, m]),
    });
    const p = ctx.adoptPromotedReplica('b1');
    await tick();
    ctx.fleetBackupBotId = 'b2';
    d.resolve({ success: true });
    await p;
    expect(hidden).toBe(0);
    expect(messages[0][1]).toMatch(/Bot 1/);
  });
});

describe('review fixes', () => {
  const renderGlobals = (content: any) => ({
    sources: [{ id: 's1', url: 'https://x/one.git' }], installSourceId: 's1', installNameLocked: true, installEnvHints: [],
    installConfigHints: [], installInteractiveSetup: null, installIsImage: false, installDetectError: null, installSeq: 0,
    getRepoName: (u: string) => u.split('/').pop(), escapeHtml: (s: string) => s, jsArg: (s: string) => JSON.stringify(s),
    buildEnvRowHtml: () => '', buildConfigFileBlockHtml: () => '', renderEnvRows: () => '',
    onNameInput: () => {}, initEnvConditionals: () => {}, autofillGenerateSecrets: () => {}, attachFleetMasterPrefill: () => {},
    window: {}, loadBots: () => {},
    api: async () => ({ success: false, error: 'not cloned' }),
    document: { getElementById: (id: string) => (id === 'install-modal-content' ? content : id === 'install-modal' ? el() : null) },
  });

  it('the name edit pencil after a failed detection keeps the banner and the disabled Save & Install', async () => {
    const content = el();
    const ctx = runPage(['showInstallModal', 'renderInstallModal'], renderGlobals(content));
    await ctx.showInstallModal('s1');
    expect(content.innerHTML).toMatch(/install-detect-error/);
    ctx.renderInstallModal('repo');
    expect(content.innerHTML).toMatch(/install-detect-error/);
    expect(content.innerHTML).toMatch(/id="install-btn"[^>]*disabled/);
  });

  it('Continue manually then a re-render keeps Save & Install enabled', async () => {
    const content = el();
    const ctx = runPage(['showInstallModal', 'renderInstallModal', 'installContinueManually'], renderGlobals(content));
    await ctx.showInstallModal('s1');
    ctx.installContinueManually();
    ctx.renderInstallModal('repo');
    expect(content.innerHTML).not.toMatch(/install-detect-error/);
    expect(content.innerHTML).not.toMatch(/id="install-btn"[^>]*disabled/);
  });

  it('a late Load envs answer writes nothing into a form opened for another source', async () => {
    const d = deferred();
    const added: any[] = [];
    const detail = el(); const btn = el(); const row = el();
    const ctx = runPage(['loadPreviousEnvs'], {
      installSourceId: 's1', installSeq: 0,
      document: {
        getElementById: (id: string) => ({ 'install-name': { value: 'foo' }, 'install-reuse-btn': btn, 'install-reuse-detail': detail, 'install-reuse-row': row, 'install-env-rows': el() } as any)[id] || null,
      },
      api: async () => d.promise,
      addInstallEnvRow: (k: string, v: string) => added.push([k, v]), setEnvInputValue: () => {},
    });
    const p = ctx.loadPreviousEnvs();
    await tick();
    ctx.installSourceId = 's2'; ctx.installSeq++;
    d.resolve({ success: true, envs: [{ key: 'TOKEN', value: 'old' }], sources: { vault: 1 } });
    await p;
    expect(added).toEqual([]);
    expect(detail.textContent).toBe('');
  });

  it('a late re-seed answer leaves another bot\'s fleet modal open and names its instance', async () => {
    const d = deferred();
    let hidden = 0; const messages: string[][] = [];
    const ctx = runPage(['botLabel', 'reseedStalePrimary'], {
      bots, fleetBackupBotId: 'b1', confirm: () => true, window: { confirm: () => true },
      document: { getElementById: () => ({ value: 'x' }) },
      refuseBadNumbers: () => false,
      api: async () => d.promise,
      hideFleetBackups: () => { hidden++; }, loadBots: () => {},
      showMessage: (t: string, m: string) => messages.push([t, m]),
    });
    const p = ctx.reseedStalePrimary('b1');
    await tick();
    ctx.fleetBackupBotId = 'b2';
    d.resolve({ success: true });
    await p;
    expect(hidden).toBe(0);
    expect(messages[0][1]).toMatch(/Bot 1/);
  });

  it('two Save & Install presses during a slow guided flush create one instance', async () => {
    const r = deferred();
    const sent: any[] = [];
    const modal = el(); const btn = el(); btn.dataset.sourceId = 's1';
    const ctx = runPage(['botLabel', 'missingMasterCandidates', 'dialsOutRole', 'semanticWrapper', 'semanticEnvValue', 'semanticValuesOf', 'doInstall'], {
      bots, installSourceId: 's1', installSeq: 0, installBotId: null,
      document: {
        getElementById: (id: string) => ({ 'install-modal': modal, 'install-btn': btn, 'install-name': { value: 'My Bot' } } as any)[id] || null,
        querySelectorAll: () => [],
      },
      guidedReadyToSave: async () => r.promise,
      api: async (method: string, url: string) => { sent.push({ method, url }); return url === '/bots' ? { success: true, bot: { id: 'n1' } } : { success: true }; },
      showMessage: () => {}, loadBots: () => {}, hideInstallModal: () => {},
    });
    const p1 = ctx.doInstall(); const p2 = ctx.doInstall();
    await tick();
    r.resolve(true);
    await Promise.all([p1, p2]);
    expect(sent.filter(s => s.method === 'POST' && s.url === '/bots').length).toBe(1);
  });

  it('a guided flush that refuses re-enables Save & Install', async () => {
    const btn = el(); btn.dataset.sourceId = 's1';
    const ctx = runPage(['missingMasterCandidates', 'dialsOutRole', 'semanticWrapper', 'semanticEnvValue', 'semanticValuesOf', 'doInstall'], {
      installSourceId: 's1', installSeq: 0, installBotId: null,
      document: {
        getElementById: (id: string) => ({ 'install-modal': el(), 'install-btn': btn, 'install-name': { value: 'My Bot' } } as any)[id] || null,
        querySelectorAll: () => [],
      },
      guidedReadyToSave: async () => false, api: async () => ({ success: true }), showMessage: () => {},
    });
    await ctx.doInstall();
    expect(btn.disabled).toBe(false);
  });
});
