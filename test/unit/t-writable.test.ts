import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseDocument } from 'yaml';
import * as vm from 'vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as pcs from '../../src/templates/pcsProcessing';
import { addConfigFileBinds, prepareDockerBotFiles, setDeclaredBindModes } from '../../src/templates/pcsProcessing';

const BODY = 'a: 1\n';

let tmp: string;
const saved = { DATA_ROOT: process.env.DATA_ROOT, DATA_DIR: process.env.DATA_DIR };
const fwd = (p: string) => p.replace(/\\/g, '/');
const svcs = (content: string): Record<string, any> => (parseDocument(content).toJSON() as any).services;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 't-writable-'));
  process.env.DATA_ROOT = fwd(path.join(tmp, 'DATA'));
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(tmp, { recursive: true, force: true });
});

const declaredCompose = [
  'services:',
  '  app:',
  '    image: x',
  '    volumes:',
  '      - /host/bot/ro.yml:/app/ro.yml:ro',
  '      - /host/bot/plain.yml:/app/plain.yml',
  '      - /host/bot/rw.yml:/app/rw.yml:rw',
  '      - type: bind',
  '        source: /host/bot/obj.yml',
  '        target: /app/obj.yml',
  '      - type: bind',
  '        source: /host/bot/objro.yml',
  '        target: /app/objro.yml',
  '        read_only: true',
  '',
].join('\n');
const ALL = ['/app/ro.yml', '/app/plain.yml', '/app/rw.yml', '/app/obj.yml', '/app/objro.yml'];

describe('T-WRITABLE platform mode: a declared bind with Writable unset keeps the repo mode', () => {
  it('every declared bind keeps the mode the repo compose gives it, and the compose text is left as written', () => {
    const out = setDeclaredBindModes(declaredCompose, ALL.map(p => ({ path: p })));
    expect(out).toBe(declaredCompose);
  });

  it('readOnly false makes a declared :ro bind writable; readOnly true makes a writable one :ro', () => {
    const v = svcs(setDeclaredBindModes(declaredCompose, [
      { path: '/app/ro.yml', readOnly: false }, { path: '/app/plain.yml', readOnly: true },
      { path: '/app/obj.yml', readOnly: true }, { path: '/app/objro.yml', readOnly: false },
    ])).app.volumes;
    expect(v[0]).toBe('/host/bot/ro.yml:/app/ro.yml');
    expect(v[1]).toBe('/host/bot/plain.yml:/app/plain.yml:ro');
    expect(v[2]).toBe('/host/bot/rw.yml:/app/rw.yml:rw');
    expect(v[3].read_only).toBe(true);
    expect(v[4].read_only).toBe(false);
  });
});

describe('T-WRITABLE docker mode: a declared bind with Writable unset keeps the repo mode', () => {
  const run = (files: Array<{ path: string; readOnly?: boolean }>) =>
    svcs(prepareDockerBotFiles(declaredCompose, path.join(tmp, 'bot'), '/host/bot', null,
      files.map(f => ({ ...f, body: BODY })), () => {})).app.volumes;

  it('string binds (:ro, plain, :rw) and object binds (with and without read_only) are untouched', () => {
    const v = run(ALL.map(p => ({ path: p })));
    expect(v[0]).toBe('/host/bot/ro.yml:/app/ro.yml:ro');
    expect(v[1]).toBe('/host/bot/plain.yml:/app/plain.yml');
    expect(v[2]).toBe('/host/bot/rw.yml:/app/rw.yml:rw');
    expect('read_only' in v[3]).toBe(false);
    expect(v[4].read_only).toBe(true);
  });

  it('an explicit choice still wins on a declared bind', () => {
    const v = run([{ path: '/app/ro.yml', readOnly: false }, { path: '/app/plain.yml', readOnly: true }]);
    expect(v[0]).toBe('/host/bot/ro.yml:/app/ro.yml');
    expect(v[1]).toBe('/host/bot/plain.yml:/app/plain.yml:ro');
  });

  it('a bind the manager adds for a file with Writable unset is read-only', () => {
    const v = svcs(prepareDockerBotFiles('services:\n  app:\n    image: x\n', path.join(tmp, 'bot'), '/host/bot', null,
      [{ path: '/app/new.json', body: '{}' }], () => {})).app.volumes;
    expect(v.find((b: any) => b.target === '/app/new.json')?.read_only).toBe(true);
  });
});

describe('T-WRITABLE platform mode: a bind the manager adds', () => {
  it('a file with Writable unset is mounted read-only', () => {
    const v = svcs(addConfigFileBinds('services:\n  app:\n    image: x\n', 'app1', [{ path: '/app/new.json' }], () => {})).app.volumes;
    expect(v.find((b: any) => b.target === '/app/new.json')?.read_only).toBe(true);
  });
});

describe('T-WRITABLE the store keeps an unset Writable unset', () => {
  const load = async () => {
    process.env.DATA_DIR = path.join(tmp, 'mgr');
    vi.resetModules();
    return import('../../src/config/configFileManager');
  };

  it('a file saved without readOnly is stored and read back without it; true and false stay as given', async () => {
    const cfm = await load();
    cfm.setConfigFiles('tw1', [
      { path: '/app/a.yml', body: BODY },
      { path: '/app/b.yml', body: BODY, readOnly: false },
      { path: '/app/c.yml', body: BODY, readOnly: true },
    ]);
    const raw = JSON.parse(fs.readFileSync(path.join(tmp, 'mgr', 'bots', 'tw1', 'env', 'configFiles.json'), 'utf8'));
    expect('readOnly' in raw.files[0]).toBe(false);
    const got = cfm.getConfigFiles('tw1');
    expect(got.map(f => f.readOnly)).toEqual([undefined, false, true]);
  });

  it('the mount key of an unset file differs from an explicit read-only one, so a change is seen as a mount change', async () => {
    const cfm = await load();
    expect(cfm.mountKey({ path: '/app/a.yml' })).not.toBe(cfm.mountKey({ path: '/app/a.yml', readOnly: true }));
    expect(cfm.mountKey({ path: '/app/a.yml' })).not.toBe(cfm.mountKey({ path: '/app/a.yml', readOnly: false }));
  });

  it('the config list leaves an unset row unset and gives the repo compose mode of its path', async () => {
    const cfm = await load();
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(path.join(repo, 'conf'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'docker-compose.yml'),
      'services:\n  app:\n    image: x\n    volumes:\n      - ./conf/a.yml:/app/a.yml\n      - ./conf/b.yml:/app/b.yml:ro\n      - ./conf/c.yml:/app/c.yml\n');
    for (const n of ['a', 'b', 'c']) fs.writeFileSync(path.join(repo, 'conf', `${n}.yml`), BODY);
    cfm.setConfigFiles('tw2', [{ path: '/app/c.yml', body: BODY }, { path: '/app/d.yml', body: BODY }]);
    const envList = await import('../../src/env/envList');
    const list = envList.buildBotConfigList(repo, 'tw2');
    const row = (p: string) => list.find(f => f.path === p) as any;
    expect(row('/app/a.yml').readOnly).toBeUndefined();
    expect(row('/app/a.yml').repoReadOnly).toBe(false);
    expect(row('/app/b.yml').repoReadOnly).toBe(true);
    expect(row('/app/c.yml').readOnly).toBeUndefined();
    expect(row('/app/c.yml').repoReadOnly).toBe(false);
    expect(row('/app/d.yml').readOnly).toBeUndefined();
    expect(row('/app/d.yml').repoReadOnly).toBeUndefined();
  });

  it('the repo mode comes from the compose the build uses, a prod variant included', async () => {
    const cfm = await load();
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    fs.writeFileSync(path.join(repo, 'docker-compose.prod.yml'),
      'services:\n  app:\n    image: x\n    volumes:\n      - ./config.yml:/app/config.yml\n');
    cfm.setConfigFiles('tw3', [{ path: '/app/config.yml', body: BODY }]);
    const envList = await import('../../src/env/envList');
    const row = envList.buildBotConfigList(repo, 'tw3').find(f => f.path === '/app/config.yml') as any;
    expect(row.readOnly).toBeUndefined();
    expect(row.repoReadOnly).toBe(false);
  });

  it('the repo mode is unknown when two binds at one path disagree', () => {
    const mode = (pcs as any).declaredBindReadOnly as ((c: string, t: string) => boolean | undefined) | undefined;
    expect(typeof mode).toBe('function');
    const c = 'services:\n  a:\n    volumes:\n      - ./x.yml:/app/x.yml\n  b:\n    volumes:\n      - ./x.yml:/app/x.yml:ro\n';
    expect(mode!(c, '/app/x.yml')).toBeUndefined();
    expect(mode!(c, '/app/none.yml')).toBeUndefined();
    expect(mode!('services:\n  a:\n    volumes:\n      - type: bind\n        source: ./x.yml\n        target: /app/x.yml\n        read_only: true\n', '/app/x.yml')).toBe(true);
  });
});

describe('T-WRITABLE the config pages keep an untouched Writable unset', () => {
  const html = fs.readFileSync(path.join(__dirname, '../../src/webui/public/index.html'), 'utf8');
  const fn = (name: string): string => {
    let at = html.indexOf(`function ${name}(`);
    expect(at).toBeGreaterThanOrEqual(0);
    if (html.slice(at - 6, at) === 'async ') at -= 6;
    let i = html.indexOf('{', html.indexOf(')', at));
    for (let depth = 0; ; i++) {
      if (html[i] === '{') depth++;
      else if (html[i] === '}' && --depth === 0) return html.slice(at, i + 1);
    }
  };
  const unescape = (t: string) => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  const card = (out: string) => {
    const dataset: Record<string, string> = {};
    const open = out.match(/<div class="config-file-block"[^>]*>/)![0];
    for (const m of open.matchAll(/data-([a-z-]+)="([^"]*)"/g)) dataset[m[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = unescape(m[2]);
    const p = out.match(/class="cf-path"[^>]*value="([^"]*)"/);
    const ta = out.match(/<textarea class="cf-body[^>]*>([\s\S]*?)<\/textarea>/);
    const els: Record<string, any> = {
      '.cf-path': { value: p ? unescape(p[1]) : '' },
      '.cf-body': { value: ta ? unescape(ta[1]) : '' },
      '.cf-writable': { checked: /class="cf-writable" checked/.test(out) },
      '.cf-enabled': { checked: /class="cf-enabled" checked/.test(out) },
    };
    const block: any = { dataset, html: out, querySelector: (sel: string) => els[sel] };
    els['.cf-writable'].closest = (sel: string) => (sel === '.config-file-block' ? block : null);
    const onchange = out.match(/class="cf-writable"[^>]*onchange="([^"]*)"/);
    els['.cf-writable'].onchange = onchange ? new Function(unescape(onchange[1])) : () => {};
    return block;
  };
  const toggle = (block: any) => { const box = block.querySelector('.cf-writable'); box.checked = !box.checked; box.onchange.call(box); };
  const writableTitle = (block: any) => block.html.match(/<label class="toggle-row" title="([^"]*)">\s*<span class="toggle-switch"><input type="checkbox" class="cf-writable"/)![1];
  const setup = () => {
    const blocks: any[] = [];
    const ctx: any = vm.createContext({ window: {}, document: { querySelectorAll: () => blocks } });
    vm.runInContext('const cfTemplateOrig = new Map(); let cfTemplateSeq = 0;\n'
      + ['escapeHtml', 'buildConfigFileBlockHtml', 'registerTemplateOrig', 'configFileReadOnly', 'collectConfigFiles'].map(fn).join('\n')
      + '\nthis.render = buildConfigFileBlockHtml; this.collect = collectConfigFiles;', ctx);
    return { ctx, blocks };
  };
  const plain = (v: unknown) => JSON.parse(JSON.stringify(v));
  // path, body, readOnly, enabled, manifest, format, parsed, undecryptable, inactive, fromTemplate, repoReadOnly
  const render = (ctx: any, p: string, readOnly: boolean | undefined, fromTemplate: boolean, repoReadOnly?: boolean) =>
    card(ctx.render(p, BODY, readOnly, true, null, 'yaml', null, false, undefined, fromTemplate, repoReadOnly));

  it('an untouched stored row with Writable unset is sent without readOnly', () => {
    const { ctx, blocks } = setup();
    blocks.push(render(ctx, '/app/a.yml', undefined, false));
    expect(plain(ctx.collect('#config-editor-rows'))).toEqual([{ path: '/app/a.yml', body: BODY, enabled: true }]);
  });

  it('an untouched stored row keeps the value it had', () => {
    const { ctx, blocks } = setup();
    blocks.push(render(ctx, '/app/a.yml', false, false), render(ctx, '/app/b.yml', true, false));
    expect(plain(ctx.collect('#config-editor-rows')).map((f: any) => f.readOnly)).toEqual([false, true]);
  });

  it('a toggled row sends the toggle as true or false', () => {
    const { ctx, blocks } = setup();
    const a = render(ctx, '/app/a.yml', undefined, false);
    toggle(a);
    const b = render(ctx, '/app/b.yml', undefined, false, false);
    toggle(b);
    blocks.push(a, b);
    expect(plain(ctx.collect('#config-editor-rows')).map((f: any) => f.readOnly)).toEqual([false, true]);
  });

  it('an untouched template row is still skipped, and an edited one is sent without readOnly', () => {
    const { ctx, blocks } = setup();
    const untouched = render(ctx, '/app/a.yml', undefined, true, false);
    const edited = render(ctx, '/app/b.yml', undefined, true, false);
    edited.querySelector('.cf-body').value = 'a: 2\n';
    blocks.push(untouched, edited);
    expect(plain(ctx.collect('#config-editor-rows'))).toEqual([{ path: '/app/b.yml', body: 'a: 2\n', enabled: true }]);
  });

  it('an unset row shows the repo mode when the page knows it, and says so when it does not', () => {
    const { ctx } = setup();
    expect(render(ctx, '/app/a.yml', undefined, true, false).querySelector('.cf-writable').checked).toBe(true);
    expect(render(ctx, '/app/a.yml', undefined, true, true).querySelector('.cf-writable').checked).toBe(false);
    const titles = [
      render(ctx, '/app/a.yml', undefined, false),
      render(ctx, '/app/a.yml', undefined, false, false),
      render(ctx, '/app/a.yml', undefined, false, true),
      render(ctx, '/app/a.yml', true, false),
    ].map(writableTitle);
    expect(new Set(titles).size).toBe(4);
    expect(titles[0]).toMatch(/repo/i);
    expect(render(ctx, '/app/a.yml', true, false).querySelector('.cf-writable').checked).toBe(false);
    expect(render(ctx, '/app/a.yml', false, false).querySelector('.cf-writable').checked).toBe(true);
  });

  it('a row moved on and back off stores the mode it shows', () => {
    const { ctx, blocks } = setup();
    const a = render(ctx, '/app/a.yml', undefined, false);
    toggle(a);
    toggle(a);
    const b = render(ctx, '/app/b.yml', false, false);
    toggle(b);
    toggle(b);
    blocks.push(a, b);
    expect(plain(ctx.collect('#config-editor-rows')).map((f: any) => f.readOnly)).toEqual([true, false]);
  });

  it('the install wizard sends readOnly only for a toggled row', async () => {
    const blocks: any[] = [];
    const puts: any[] = [];
    const btn: any = { disabled: false, textContent: '', isConnected: true, dataset: {}, classList: { contains: () => false }, querySelector: () => null };
    const ctx: any = vm.createContext({
      window: { guidedFlushAll: true, guidedPendingErasures: true },
      guidedFlushAll: async () => true,
      guidedPendingErasures: () => [],
      confirm: () => true,
      document: {
        getElementById: (x: string) => (x === 'install-name' ? { value: 'Bot' } : btn),
        querySelectorAll: (s: string) => (s.includes('config-file-block') ? blocks : []),
        querySelector: () => btn,
      },
      api: async (method: string, url: string, body: any) => {
        if (url === '/bots') return { success: true, bot: { id: 'b1' } };
        puts.push({ method, url, body: JSON.parse(JSON.stringify(body)) });
        return { success: true };
      },
      showMessage: () => {}, hideInstallModal: () => {}, loadBots: () => {},
      installSourceId: 's1', installBotId: null, installSeq: 0, bots: [],
    });
    vm.runInContext('const cfTemplateOrig = new Map(); let cfTemplateSeq = 0;\n'
      + ['escapeHtml', 'buildConfigFileBlockHtml', 'registerTemplateOrig', 'configFileReadOnly', 'botLabel', 'guidedReadyToSave',
        'semanticWrapper', 'semanticEnvValue', 'doInstall'].map(fn).join('\n')
      + '\nthis.render = buildConfigFileBlockHtml;', ctx);
    const untouched = render(ctx, '/app/a.yml', undefined, false);
    const toggled = render(ctx, '/app/b.yml', undefined, false);
    toggle(toggled);
    toggle(toggled);
    blocks.push(untouched, toggled);
    await ctx.doInstall();
    const put = puts.find((x) => x.url === '/bots/b1/config');
    expect(put).toBeDefined();
    expect(put.body.files).toEqual([
      { path: '/app/a.yml', body: BODY, enabled: true },
      { path: '/app/b.yml', body: BODY, readOnly: true, enabled: true },
    ]);
  });
});
