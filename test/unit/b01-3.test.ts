import { describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { serializeConfig } from '../../src/config/configSerializer';
import { applyYamlOps } from '../../src/config/yamlOps';

describe('the serializer reports ops it could not apply', () => {
  it('json: a set under a null parent is skipped and named', () => {
    const body = '{\n  "a": null,\n  "b": 1\n}';
    const r = serializeConfig('json', body, [{ path: 'a.x', value: 2 }, { path: 'b', value: 3 }]) as any;
    expect(r.skipped).toEqual(['a.x']);
    expect(JSON.parse(r.body)).toEqual({ a: null, b: 3 });
  });
  it('yaml: a set under a scalar parent is skipped and named', () => {
    const r = serializeConfig('yaml', 'a: 5\nb: 1\n', [{ path: 'a.x', value: 2 }, { path: 'b', value: 3 }]) as any;
    expect(r.skipped).toEqual(['a.x']);
    expect(r.body).toBe('a: 5\nb: 3\n');
  });
  it('yaml: a malformed body skips every op and stays untouched', () => {
    const skipped: string[] = [];
    expect(applyYamlOps('a: [1\n', [{ path: 'a', value: 1 }], { createMissing: true, skipped } as any)).toBe('a: [1\n');
    expect(skipped).toEqual(['a']);
  });
  it('an untouched set reports nothing skipped', () => {
    expect((serializeConfig('json', '{"b":1}', [{ path: 'b', value: 2 }]) as any).skipped).toEqual([]);
  });
});

const flush = () => new Promise((r) => setTimeout(r, 0));
const deferred = () => { let resolve: (v: any) => void = () => {}; const p = new Promise<any>((r) => { resolve = r; }); return { p, resolve }; };

const manifest = {
  format: 'json',
  sections: [{
    id: 's', title: 'S', fields: [
      { type: 'text', label: 'Name', target: { path: 'name' } },
      { type: 'number', label: 'Count', target: { path: 'n' } },
      { type: 'password', label: 'Token', target: { path: 'token' }, envAlt: { var: 'BOT_TOKEN', flagPath: 'tokenFromEnv' } },
    ],
  }],
};

const guidedPage = (initial: string, parsed: any, answer: (call: any) => any) => {
  const calls: any[] = [];
  const ta: any = { value: initial, classList: { add() {}, remove() {}, contains: () => false } };
  const badge: any = { textContent: '', className: 'gc-badge' };
  const form: any = { innerHTML: '', classList: { contains: () => false, add() {}, remove() {} }, querySelectorAll: () => [] };
  const id = 'cfb1';
  const block = { querySelector: (s: string) => (s === '.cf-body' ? ta : null), querySelectorAll: () => [] };
  const ctx: any = vm.createContext({
    setTimeout, clearTimeout, Promise, console,
    document: {
      activeElement: null,
      createElement: () => ({}), head: { appendChild() {} },
      getElementById: (x: string) => (x === id ? block : x === id + '-badge' ? badge : x === id + '-form' ? form : null),
      querySelectorAll: () => [],
      querySelector: (s: string) => (s === '#mine' ? { contains: (b: any) => b === block } : s === '#other' ? { contains: () => false } : null),
    },
    api: (method: string, url: string, body: any) => { const c = { method, url, body: JSON.parse(JSON.stringify(body)) }; calls.push(c); return Promise.resolve(answer(c)); },
  });
  ctx.window = ctx;
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../src/webui/public/guidedConfig.js'), 'utf8'), ctx);
  ctx.guidedRegister(id, manifest, 'json', parsed);
  return { ctx, id, ta, badge, calls, serializes: () => calls.filter((c) => c.url === '/config/serialize') };
};
const numberInput = (value: string) => {
  const cls = new Set<string>();
  return { value, title: '', onblur: null as any, classList: { add: (c: string) => cls.add(c), remove: (c: string) => cls.delete(c), contains: (c: string) => cls.has(c) }, cls };
};

describe('the guided form keeps raw edits and reports failed writes', () => {
  it('a late serialize answer never overwrites a raw edit; the ops re-run on the new body', async () => {
    const first = deferred();
    let n = 0;
    const p = guidedPage('{"name":"a"}', { name: 'a' }, (c) => {
      if (c.url !== '/config/serialize') return { success: true, ok: true, data: {} };
      return ++n === 1 ? first.p : { success: true, body: c.body.body.replace('}', ',"name2":1}'), skipped: [] };
    });
    p.ctx.guidedEdit(p.id, 'name', 'select', { value: 'b' });
    await flush();
    p.ta.value = '{"name":"a","raw":"typed"}';
    first.resolve({ success: true, body: '{"name":"b"}', skipped: [] });
    await flush(); await flush(); await flush();
    expect(p.ta.value).toContain('"raw":"typed"');
    expect(p.serializes()).toHaveLength(2);
    expect(p.serializes()[1].body.body).toBe('{"name":"a","raw":"typed"}');
    expect(p.serializes()[1].body.ops).toEqual([{ path: 'name', value: 'b' }]);
  });

  it('a failed serialize keeps the ops, flags the block and makes the flush report failure', async () => {
    let fail = true;
    const p = guidedPage('{}', {}, (c) => (c.url === '/config/serialize'
      ? (fail ? { success: false, error: 'boom' } : { success: true, body: '{"name":"b"}', skipped: [] })
      : { success: true, ok: true, data: {} }));
    p.ctx.guidedEdit(p.id, 'name', 'select', { value: 'b' });
    expect(await p.ctx.guidedFlushAll()).toBe(false);
    expect(p.badge.textContent).toContain('boom');
    expect(p.ta.value).toBe('{}');
    fail = false;
    expect(await p.ctx.guidedFlushAll()).toBe(true);
    expect(p.serializes().at(-1).body.ops).toEqual([{ path: 'name', value: 'b' }]);
    expect(p.ta.value).toBe('{"name":"b"}');
  });

  it('a skipped op marks the field and blocks the save', async () => {
    const p = guidedPage('{"name":null}', { name: null }, (c) => (c.url === '/config/serialize'
      ? { success: true, body: c.body.body, skipped: ['name'] }
      : { success: true, ok: true, data: { name: null } }));
    p.ctx.guidedEdit(p.id, 'name', 'select', { value: 'b' });
    expect(await p.ctx.guidedFlushAll()).toBe(false);
    expect(p.badge.textContent).toContain('name');
    expect(p.ctx.buildGuidedFormHtml(p.id)).toContain('could not be written');
  });

  it('a failed parse request says the form shows earlier values', async () => {
    const p = guidedPage('{}', {}, () => Promise.reject(new Error('offline')));
    p.ctx.guidedRawEdit(p.id, true);
    await flush(); await flush();
    expect(p.badge.textContent).toBe('Could not refresh the form; showing earlier values');
  });

  it('an invalid number is flagged and restored on blur', () => {
    const p = guidedPage('{"n":3}', { n: 3 }, () => ({ success: true, body: '{}', skipped: [] }));
    const el = numberInput('');
    p.ctx.guidedEdit(p.id, 'n', 'number', el);
    expect(el.cls.has('gc-invalid')).toBe(true);
    expect(p.serializes()).toHaveLength(0);
    el.onblur();
    expect(el.value).toBe(3);
  });
});

describe('the From env / In file switch keeps the in-file value', () => {
  const env = () => guidedPage('{"token":"tok","tokenFromEnv":false}', { token: 'tok', tokenFromEnv: false },
    (c) => (c.url === '/config/serialize' ? { success: true, body: c.body.body, skipped: [] } : { success: true, ok: true, data: {} }));

  it('switching back to In file writes the value back', async () => {
    const p = env();
    p.ctx.guidedEnvAltMode(p.id, 'token', 'env');
    await p.ctx.guidedFlushAll();
    p.ctx.guidedEnvAltMode(p.id, 'token', 'file');
    await p.ctx.guidedFlushAll();
    const ops = p.serializes().flatMap((c) => c.body.ops);
    expect(ops.at(-1)).toEqual({ path: 'token', value: 'tok' });
  });

  it('a save while in env mode is told which value it erases', async () => {
    const p = env();
    p.ctx.guidedEnvAltMode(p.id, 'token', 'env');
    expect(JSON.parse(JSON.stringify(p.ctx.guidedPendingErasures()))).toEqual([{ label: 'Token', envVar: 'BOT_TOKEN' }]);
  });

  it('a block outside the modal being saved neither asks nor blocks it', async () => {
    const p = env();
    p.ctx.guidedEnvAltMode(p.id, 'token', 'env');
    expect(p.ctx.guidedPendingErasures('#other')).toHaveLength(0);
    expect(p.ctx.guidedPendingErasures('#mine')).toHaveLength(1);
    const q = guidedPage('{"name":null}', { name: null }, (c) => (c.url === '/config/serialize'
      ? { success: true, body: c.body.body, skipped: ['name'] } : { success: true, ok: true, data: {} }));
    q.ctx.guidedEdit(q.id, 'name', 'select', { value: 'b' });
    expect(await q.ctx.guidedFlushAll('#other')).toBe(true);
    expect(await q.ctx.guidedFlushAll('#mine')).toBe(false);
  });

  it('a click on the active mode sends nothing', async () => {
    const p = env();
    p.ctx.guidedEnvAltMode(p.id, 'token', 'file');
    await p.ctx.guidedFlushAll();
    expect(p.serializes()).toHaveLength(0);
  });
});

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

const vaultRow = (groupType: string, originalKey: string, newKey: string, value: string) => {
  const cls = new Set(['dirty']);
  return {
    dataset: { groupId: 'g1', groupType, originalKey },
    classList: { remove: (c: string) => cls.delete(c), add: (c: string) => cls.add(c), contains: (c: string) => cls.has(c) },
    querySelector: (s: string) => (s === '.vault-entry-key-input' ? { value: newKey } : { value }),
    querySelectorAll: () => [],
    cls,
  };
};
const vaultPage = (answer: any, inputs: Record<string, string> = {}) => {
  const sent: any[] = []; const messages: string[][] = []; let loads = 0;
  const ctx = runPage(['lockBtns', 'saveVaultRow', 'deleteVaultEntry', 'addVaultEntry'], {
    document: { querySelectorAll: () => [], getElementById: (x: string) => ({ value: inputs[x] || '' }) },
    api: async (method: string, url: string, body: any) => { sent.push({ method, url, body }); return answer; },
    showMessage: (t: string, m: string) => messages.push([t, m]),
    loadVault: () => { loads++; },
    vaultValuesCache: null, newVaultHidden: true,
  });
  return { ctx, sent, messages, loads: () => loads };
};

describe('the vault editors check the answer', () => {
  it('a refused standalone save keeps the row dirty and shows the error', async () => {
    const p = vaultPage({ success: false, error: 'Entry not found' });
    const row = vaultRow('standalone', 'K', 'K', 'v');
    await p.ctx.saveVaultRow(row);
    expect(row.cls.has('dirty')).toBe(true);
    expect(p.messages).toEqual([['error', 'Entry not found']]);
  });
  it('a refused bot-instance save keeps the row dirty', async () => {
    const p = vaultPage({ success: false, error: 'Bot not found' });
    const row = vaultRow('bot', 'K', 'K', 'v');
    await p.ctx.saveVaultRow(row);
    expect(row.cls.has('dirty')).toBe(true);
    expect(p.messages).toEqual([['error', 'Bot not found']]);
  });
  it('a bot-instance rename is refused, not silently dropped', async () => {
    const p = vaultPage({ success: true });
    const row = vaultRow('bot', 'K', 'K2', 'v');
    await p.ctx.saveVaultRow(row);
    expect(p.sent).toHaveLength(0);
    expect(row.cls.has('dirty')).toBe(true);
    expect(p.messages[0][0]).toBe('error');
  });
  it('a refused delete says so', async () => {
    const p = vaultPage({ success: false, error: 'Entry not found' });
    await p.ctx.deleteVaultEntry('K');
    expect(p.messages).toEqual([['error', 'Entry not found']]);
  });
  it('a refused add says so', async () => {
    const p = vaultPage({ success: false, error: 'key is required' }, { 'vault-new-key': 'K', 'vault-new-value': 'v' });
    await p.ctx.addVaultEntry();
    expect(p.messages).toEqual([['error', 'key is required']]);
  });
});

const installPage = (answers: Record<string, any[]>, flushOk = true) => {
  const sent: any[] = []; const messages: string[][] = []; let hidden = 0;
  const envRow = {
    classList: { contains: () => false },
    querySelector: (s: string) => (s === '.env-key' ? { value: 'K' } : { value: 'v', dataset: {} }),
  };
  const cfBlock = { querySelector: (s: string) => (s === '.cf-path' ? { value: '/app/c.json' } : s === '.cf-body' ? { value: '{}' } : { checked: true }) };
  const btn = { disabled: false, textContent: '', isConnected: true, dataset: {}, classList: { contains: () => false }, querySelector: () => null };
  const ctx = runPage(['botLabel', 'guidedReadyToSave', 'missingMasterCandidates', 'dialsOutRole', 'semanticWrapper', 'semanticEnvValue', 'semanticValuesOf', 'doInstall', 'saveConfigEditor'], {
    document: {
      getElementById: (x: string) => (x === 'install-name' ? { value: 'Bot' } : btn),
      querySelectorAll: (s: string) => (s.includes('env-row') ? [envRow] : [cfBlock]),
      querySelector: () => btn,
    },
    window: { guidedFlushAll: true, guidedPendingErasures: true },
    guidedFlushAll: async () => flushOk,
    guidedPendingErasures: () => [],
    confirm: () => true,
    api: async (method: string, url: string, body: any) => { sent.push({ method, url }); return answers[`${method} ${url}`].shift(); },
    showMessage: (t: string, m: string) => messages.push([t, m]),
    hideInstallModal: () => { hidden++; },
    hideConfigEditor: () => { hidden++; },
    loadBots: () => {},
    installSourceId: 's1', installBotId: null, configEditorBotId: 'b9', installSeq: 0, configEditorSeq: 0, bots: [],
  });
  return { ctx, sent, messages, hidden: () => hidden };
};

describe('the install wizard and config editor check every write', () => {
  it('a refused env write keeps the modal open and a retry reuses the instance', async () => {
    const p = installPage({
      'POST /bots': [{ success: true, bot: { id: 'b1' } }],
      'PUT /bots/b1/env': [{ success: false, error: 'disk full' }, { success: true }],
      'PUT /bots/b1/config': [{ success: true }],
    });
    await p.ctx.doInstall();
    expect(p.hidden()).toBe(0);
    expect(p.messages.at(-1)![0]).toBe('error');
    expect(p.messages.at(-1)![1]).toContain('disk full');
    await p.ctx.doInstall();
    expect(p.sent.filter((s) => s.url === '/bots')).toHaveLength(1);
    expect(p.hidden()).toBe(1);
    expect(p.messages.at(-1)![0]).toBe('success');
  });
  it('a refused config write keeps the modal open', async () => {
    const p = installPage({
      'POST /bots': [{ success: true, bot: { id: 'b1' } }],
      'PUT /bots/b1/env': [{ success: true }],
      'PUT /bots/b1/config': [{ success: false, error: 'bad path' }],
    });
    await p.ctx.doInstall();
    expect(p.hidden()).toBe(0);
    expect(p.messages.at(-1)![1]).toContain('bad path');
  });
  it('a failed guided flush refuses the install and the config save before any write', async () => {
    const p = installPage({}, false);
    await p.ctx.doInstall();
    await p.ctx.saveConfigEditor();
    expect(p.sent).toHaveLength(0);
    expect(p.messages.map((m) => m[0])).toEqual(['error', 'error']);
  });
});

describe('the form never shows a body the serialize answer replaced', () => {
  it('a tab switch to Form during an in-flight serialize parses the body the answer leaves', async () => {
    const first = deferred();
    const p = guidedPage('{"name":"a"}', { name: 'a' }, (c) => {
      if (c.url === '/config/serialize') return first.p;
      return { success: true, ok: true, data: JSON.parse(c.body.body) };
    });
    p.ctx.guidedEdit(p.id, 'name', 'select', { value: 'b' });
    p.ctx.guidedTab(p.id, 'raw');
    p.ctx.guidedTab(p.id, 'form');
    await flush(); await flush();
    first.resolve({ success: true, body: '{"name":"b"}', skipped: [] });
    for (let i = 0; i < 6; i++) await flush();
    expect(p.ta.value).toBe('{"name":"b"}');
    expect(p.calls.filter((c) => c.url === '/config/parse').at(-1).body.body).toBe('{"name":"b"}');
    expect(p.ctx.buildGuidedFormHtml(p.id)).toContain('"b"');
  });

  it('a re-run after a raw paste re-parses the body it writes', async () => {
    const first = deferred();
    let n = 0;
    const p = guidedPage('{"name":"a"}', { name: 'a' }, (c) => {
      if (c.url === '/config/serialize') return ++n === 1 ? first.p : { success: true, body: '{"name":"b"}', skipped: [] };
      return { success: true, ok: true, data: JSON.parse(c.body.body) };
    });
    p.ctx.guidedEdit(p.id, 'name', 'select', { value: 'b' });
    p.ctx.guidedTab(p.id, 'raw');
    p.ta.value = '{"name":"c"}';
    p.ctx.guidedRawEdit(p.id, true);
    await flush(); await flush();
    first.resolve({ success: true, body: '{"name":"b"}', skipped: [] });
    for (let i = 0; i < 6; i++) await flush();
    expect(p.ta.value).toBe('{"name":"b"}');
    expect(p.calls.filter((c) => c.url === '/config/parse').at(-1).body.body).toBe('{"name":"b"}');
  });

  it('a flush that gets no answer in time warns on the block that the write is unconfirmed', async () => {
    vi.useFakeTimers();
    try {
      const p = guidedPage('{}', {}, (c) => (c.url === '/config/serialize' ? new Promise(() => {}) : { success: true, ok: true, data: {} }));
      p.ctx.guidedEdit(p.id, 'name', 'select', { value: 'b' });
      const done = p.ctx.guidedFlushAll();
      await vi.advanceTimersByTimeAsync(10001);
      expect(await done).toBe(false);
      expect(p.badge.textContent).toContain('could not confirm');
      expect(p.badge.textContent).not.toContain('was not written');
    } finally { vi.useRealTimers(); }
  });
});
