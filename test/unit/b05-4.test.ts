import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

const pageHtml = fs.readFileSync(path.resolve(__dirname, '../../src/webui/public/index.html'), 'utf8');
const guidedJs = fs.readFileSync(path.resolve(__dirname, '../../src/webui/public/guidedConfig.js'), 'utf8');
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
const tick = () => new Promise(r => setTimeout(r, 0));

const manifest = { format: 'json', sections: [{ id: 's', title: 'S', fields: [{ type: 'text', label: 'Name', target: { path: 'name' } }] }] };

const classes = (init: string[]) => {
  const c = new Set(init);
  return { add: (x: string) => c.add(x), remove: (x: string) => c.delete(x), contains: (x: string) => c.has(x), toggle: (x: string, on: boolean) => (on ? c.add(x) : c.delete(x)) };
};

const page = (parseAnswer: any = { success: true, ok: false }) => {
  const calls: any[] = [];
  const els: Record<string, any> = {};
  const ctx: any = vm.createContext({
    setTimeout, clearTimeout, Promise, console,
    document: {
      activeElement: null, createElement: () => ({}), head: { appendChild() {} },
      getElementById: (x: string) => els[x] || null, querySelectorAll: () => [], querySelector: () => null,
    },
    api: (method: string, url: string, body: any) => { calls.push({ method, url, body }); return Promise.resolve(url === '/config/parse' ? parseAnswer : { success: true, body: body.body, skipped: [] }); },
  });
  ctx.window = ctx;
  vm.runInContext(guidedJs, ctx);
  vm.runInContext(['escapeHtml', 'buildConfigFileBlockHtml'].map(pageFunction).join('\n'), ctx);
  const ctxDoc = ctx.document;
  ctxDoc.createElement = () => { const d: any = {}; Object.defineProperty(d, 'textContent', { set(v: string) { d.innerHTML = String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); } }); return d; };
  const mount = (html: string) => {
    const id = /id="(cfb\d+)"/.exec(html)![1];
    const tabs = ['form', 'raw'].map(t => ({ t, classList: classes(new RegExp(`class="gc-tab active" data-tab="${t}"`).test(html) ? ['active'] : []), getAttribute: () => t }));
    const form = { innerHTML: '', classList: classes(new RegExp(`class="gc-form hidden" id="${id}-form"`).test(html) ? ['hidden'] : []), querySelectorAll: () => [] };
    const ta = { value: '', classList: classes(/class="cf-body hidden"/.test(html) ? ['hidden'] : []) };
    els[id] = { querySelector: (s: string) => (s === '.cf-body' ? ta : null), querySelectorAll: (s: string) => (s === '.gc-tab' ? tabs : []) };
    els[id + '-form'] = form;
    els[id + '-badge'] = { textContent: '', className: '' };
    return { id, tabs, form, ta };
  };
  return { ctx, calls, mount };
};

describe('B05-4: a body that does not parse or decrypt never opens on the empty form', () => {
  it('an unparsable body opens on Raw with the form hidden and the paused badge set', () => {
    const p = page();
    const html = p.ctx.buildConfigFileBlockHtml('/app/config.json', '{ broken', true, true, manifest, 'json', null);
    expect(html).toMatch(/class="gc-tab active" data-tab="raw"/);
    expect(html).not.toMatch(/class="gc-tab active" data-tab="form"/);
    expect(html).toMatch(/class="gc-form hidden"/);
    expect(html).not.toMatch(/class="cf-body hidden"/);
    expect(html).toMatch(/form paused/);
  });

  it('an undecryptable body opens on Raw and says it no longer decrypts', () => {
    const p = page();
    const html = p.ctx.buildConfigFileBlockHtml('/app/config.json', '', true, true, manifest, 'json', null, true);
    expect(html).toMatch(/class="gc-tab active" data-tab="raw"/);
    expect(html).toMatch(/class="gc-form hidden"/);
    expect(html).toMatch(/no longer decrypts/);
    expect(html).toMatch(/data-undecryptable="1"/);
  });

  it('a parsed body still opens on the Form', () => {
    const p = page();
    const html = p.ctx.buildConfigFileBlockHtml('/app/config.json', '{"name":"a"}', true, true, manifest, 'json', { name: 'a' });
    expect(html).toMatch(/class="gc-tab active" data-tab="form"/);
    expect(html).toMatch(/class="cf-body hidden"/);
  });

  it('the Form tab stays off while the body fails to parse, and opens once it parses', async () => {
    const answer: any = { success: true, ok: false };
    const p = page(answer);
    const m = p.mount(p.ctx.buildConfigFileBlockHtml('/app/config.json', '{ broken', true, true, manifest, 'json', null));
    p.ctx.guidedTab(m.id, 'form');
    await tick(); await tick();
    expect(m.form.classList.contains('hidden')).toBe(true);
    expect(m.ta.classList.contains('hidden')).toBe(false);
    expect(p.ctx.guidedFormLocked(m.id)).toBe(true);
    answer.ok = true; answer.data = { name: 'fixed' };
    p.ctx.guidedRawEdit(m.id, true);
    await tick(); await tick();
    expect(p.ctx.guidedFormLocked(m.id)).toBe(false);
    p.ctx.guidedTab(m.id, 'form');
    expect(m.form.classList.contains('hidden')).toBe(false);
  });
});

describe('B05-4: a save over an undecryptable body asks first', () => {
  const run = (confirmAnswer: boolean, body: string) => {
    const puts: any[] = [];
    const confirms: string[] = [];
    const block = {
      dataset: {},
      querySelector: (s: string) => ({ '.cf-path': { value: '/app/config.json' }, '.cf-body': { value: body }, '.cf-writable': { checked: false }, '.cf-enabled': { checked: true } } as any)[s],
    };
    const modal = { classList: { contains: () => false } };
    const ctx: any = vm.createContext({
      configEditorBotId: 'b1', configEditorSeq: 1, console, cfTemplateOrig: new Map(),
      botLabel: () => 'bot', guidedReadyToSave: async () => true, showMessage() {}, hideConfigEditor() {}, loadBots() {},
      confirm: (t: string) => { confirms.push(t); return confirmAnswer; },
      api: async (m: string, u: string, b: any) => { puts.push(b); return { success: true }; },
      document: {
        getElementById: (x: string) => (x === 'config-modal' ? modal : x === 'config-editor-rows' ? {} : null),
        querySelector: () => null,
        querySelectorAll: (s: string) => (s.includes('[data-undecryptable="1"]') || s === '#config-editor-rows .config-file-block' ? [block] : []),
      },
    });
    vm.runInContext(pageFunction('configFileReadOnly') + '\n' + pageFunction('collectConfigFiles') + '\n' + pageFunction('saveConfigEditor'), ctx);
    return { ctx, puts, confirms };
  };

  it('declining the confirm saves nothing', async () => {
    const r = run(false, '{"name":"new"}');
    await r.ctx.saveConfigEditor();
    expect(r.confirms.length).toBe(1);
    expect(r.puts.length).toBe(0);
  });

  it('an empty body keeps the stored copy without a confirm', async () => {
    const r = run(false, '');
    await r.ctx.saveConfigEditor();
    expect(r.confirms.length).toBe(0);
    expect(r.puts.length).toBe(1);
  });
});

describe('B05-4: the lock badge keeps telling the truth', () => {
  const yaml = { ...manifest, format: 'yaml' };

  it('an empty undecryptable YAML body that parses to null stays locked with its reason', async () => {
    const p = page({ success: true, ok: true, data: null });
    const m = p.mount(p.ctx.buildConfigFileBlockHtml('/app/config.yml', '', true, true, yaml, 'yaml', null, true));
    p.ctx.guidedTab(m.id, 'form');
    await tick(); await tick();
    expect(p.ctx.guidedFormLocked(m.id)).toBe(true);
    expect(m.form.classList.contains('hidden')).toBe(true);
    expect(p.ctx.document.getElementById(m.id + '-badge').textContent).toMatch(/no longer decrypts/);
  });

  it('an empty undecryptable JSON body that fails to parse keeps the decrypt reason', async () => {
    const p = page({ success: true, ok: false });
    const m = p.mount(p.ctx.buildConfigFileBlockHtml('/app/config.json', '', true, true, manifest, 'json', null, true));
    p.ctx.guidedRawEdit(m.id, true);
    await tick(); await tick();
    const badge = p.ctx.document.getElementById(m.id + '-badge').textContent;
    expect(badge).toMatch(/no longer decrypts/);
    expect(badge).not.toMatch(/form paused/);
  });

  it('a re-entered body on an undecryptable block unlocks the form', async () => {
    const p = page({ success: true, ok: true, data: { name: 'x' } });
    const m = p.mount(p.ctx.buildConfigFileBlockHtml('/app/config.json', '', true, true, manifest, 'json', null, true));
    m.ta.value = '{"name":"x"}';
    p.ctx.guidedRawEdit(m.id, true);
    await tick(); await tick();
    expect(p.ctx.guidedFormLocked(m.id)).toBe(false);
  });

  it('the config routes send an empty object for a body that parses to null', () => {
    for (const f of ['bots.ts', 'sources.ts']) {
      const src = fs.readFileSync(path.resolve(__dirname, '../../src/webui/routes', f), 'utf8');
      expect(src).toMatch(/if \(r\.ok\) parsed = r\.data \?\? \{\};/);
    }
  });
});
