import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { parseDocument } from 'yaml';
import * as vm from 'vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addConfigFileBinds, applyUserConfigOverrides, createVolumeDirectories, newDeliveryReport, prepareDockerBotFiles,
  redeliverConfigFiles, writeConfigFiles,
} from '../../src/templates/pcsProcessing';

const TEMPLATE = 'token: CHANGE_ME\n';
const OPERATOR = 'token: the-operators-edit\n';

let tmp: string;
let dataRoot: string;
const savedDataRoot = process.env.DATA_ROOT;
const fwd = (p: string) => p.replace(/\\/g, '/');
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const svcs = (content: string): Record<string, any> => (parseDocument(content).toJSON() as any).services;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'b17-3-'));
  dataRoot = fwd(path.join(tmp, 'DATA'));
  process.env.DATA_ROOT = dataRoot;
});

afterEach(() => {
  if (savedDataRoot === undefined) delete process.env.DATA_ROOT; else process.env.DATA_ROOT = savedDataRoot;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const appDir = () => `${dataRoot}/AppData/app1`;
const bindsOn = (compose: string, svc = 'app') => (svcs(compose)[svc].volumes || []) as any[];
const added = (compose: string, target: string) => bindsOn(compose).find((v) => v && typeof v === 'object' && v.target === target);
const inside = (child: string, parent: string) => child === parent || child.startsWith(parent.replace(/\/+$/, '') + '/');

describe('B17-3 platform mode: one host file per config path', () => {
  it('two config paths with one basename get two host files', async () => {
    const files = [
      { path: '/app/a/config.json', body: '{"a":1}' },
      { path: '/app/b/config.json', body: '{"b":2}' },
    ];
    const report = newDeliveryReport();
    const out = addConfigFileBinds('services:\n  app:\n    image: x\n', 'app1', files, () => {}, report);
    const a = added(out, '/app/a/config.json');
    const b = added(out, '/app/b/config.json');
    expect(a.source).not.toBe(b.source);
    await writeConfigFiles('app1', files, () => {}, report);
    expect(report.failed).toEqual([]);
    expect(fs.readFileSync(a.source, 'utf8')).toBe('{"a":1}');
    expect(fs.readFileSync(b.source, 'utf8')).toBe('{"b":2}');
  });

  it('a config file never lands inside a directory the compose already binds (./config)', () => {
    const compose = `services:\n  app:\n    image: x\n    volumes:\n      - ${appDir()}/config:/app/config\n`;
    const report = newDeliveryReport();
    const out = addConfigFileBinds(compose, 'app1', [{ path: '/app/settings.json' }], () => {}, report);
    const b = added(out, '/app/settings.json');
    if (b) expect(inside(b.source, `${appDir()}/config`)).toBe(false);
    else expect(report.failed).toContain('/app/settings.json');
  });

  it('refuses a config file whose host source would sit inside a bound directory', () => {
    const compose = `services:\n  app:\n    image: x\n    volumes:\n      - ${appDir()}:/data\n`;
    const report = newDeliveryReport();
    const out = addConfigFileBinds(compose, 'app1', [{ path: '/app/settings.json' }], () => {}, report);
    expect(added(out, '/app/settings.json')).toBeUndefined();
    expect(report.failed).toContain('/app/settings.json');
  });

  it('reinstall over kept AppData: an existing host file with no delivery record is kept', async () => {
    const files = [{ path: '/app/config.yml', body: TEMPLATE }];
    const out = addConfigFileBinds('services:\n  app:\n    image: x\n', 'app1', files, () => {});
    const src = added(out, '/app/config.yml').source as string;
    fs.mkdirSync(path.dirname(src), { recursive: true });
    fs.writeFileSync(src, OPERATOR);
    const report = newDeliveryReport();
    const logs: string[] = [];
    await (writeConfigFiles as any)('app1', files, (m: string) => logs.push(m), report, {});
    expect(fs.readFileSync(src, 'utf8')).toBe(OPERATOR);
    expect(report.failed).toContain('/app/config.yml');
    expect(logs.some((l) => l.includes('Kept'))).toBe(true);
  });

  it('a host file still holding what the manager delivered is replaced, and the write is recorded', async () => {
    const files = [{ path: '/app/config.yml', body: OPERATOR }];
    const out = addConfigFileBinds('services:\n  app:\n    image: x\n', 'app1', files, () => {});
    const src = added(out, '/app/config.yml').source as string;
    fs.mkdirSync(path.dirname(src), { recursive: true });
    fs.writeFileSync(src, TEMPLATE);
    const report = newDeliveryReport();
    await (writeConfigFiles as any)('app1', files, () => {}, report, { [src]: sha(TEMPLATE) });
    expect(report.failed).toEqual([]);
    expect(fs.readFileSync(src, 'utf8')).toBe(OPERATOR);
    expect(report.delivered[src]).toBe(sha(OPERATOR));
  });
});

describe('B17-3 docker mode: one host file per config path', () => {
  const bot = () => path.join(tmp, 'bot');
  const local = (src: string) => path.join(bot(), src.slice('/host/bot/'.length));

  it('two config paths with one basename get two host files', () => {
    const report = newDeliveryReport();
    const out = prepareDockerBotFiles('services:\n  app:\n    image: x\n', bot(), '/host/bot', null, [
      { path: '/app/a/config.json', body: '{"a":1}' },
      { path: '/app/b/config.json', body: '{"b":2}' },
    ], () => {}, report);
    const a = added(out, '/app/a/config.json');
    const b = added(out, '/app/b/config.json');
    expect(a.source).not.toBe(b.source);
    expect(report.failed).toEqual([]);
    expect(fs.readFileSync(local(a.source), 'utf8')).toBe('{"a":1}');
    expect(fs.readFileSync(local(b.source), 'utf8')).toBe('{"b":2}');
  });

  it('a config file never lands inside a directory the compose already binds (./config)', () => {
    const compose = 'services:\n  app:\n    image: x\n    volumes:\n      - /host/bot/config:/app/config\n';
    fs.mkdirSync(path.join(bot(), 'config'), { recursive: true });
    const report = newDeliveryReport();
    const out = prepareDockerBotFiles(compose, bot(), '/host/bot', null, [{ path: '/app/settings.json', body: TEMPLATE }], () => {}, report);
    const b = added(out, '/app/settings.json');
    expect(fs.readdirSync(path.join(bot(), 'config'))).toEqual([]);
    if (b) expect(inside(b.source, '/host/bot/config')).toBe(false);
    else expect(report.failed).toContain('/app/settings.json');
  });

  it('reinstall over a kept data dir: an existing host file with no delivery record is kept', () => {
    const files = [{ path: '/app/config.yml', body: TEMPLATE }];
    const first = prepareDockerBotFiles('services:\n  app:\n    image: x\n', path.join(tmp, 'probe'), '/host/bot', null, files, () => {});
    const rel = (added(first, '/app/config.yml').source as string).slice('/host/bot/'.length);
    const target = path.join(bot(), rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, OPERATOR);
    const report = newDeliveryReport();
    prepareDockerBotFiles('services:\n  app:\n    image: x\n', bot(), '/host/bot', null, files, () => {}, report, {});
    expect(fs.readFileSync(target, 'utf8')).toBe(OPERATOR);
    expect(report.failed).toContain('/app/config.yml');
  });

  it('a host file still holding what the manager delivered is replaced', () => {
    const files = [{ path: '/app/config.yml', body: OPERATOR }];
    const first = prepareDockerBotFiles('services:\n  app:\n    image: x\n', path.join(tmp, 'probe'), '/host/bot', null, files, () => {});
    const rel = (added(first, '/app/config.yml').source as string).slice('/host/bot/'.length);
    const target = path.join(bot(), rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, TEMPLATE);
    const report = newDeliveryReport();
    prepareDockerBotFiles('services:\n  app:\n    image: x\n', bot(), '/host/bot', null, files, () => {}, report, { [target]: sha(TEMPLATE) });
    expect(report.failed).toEqual([]);
    expect(fs.readFileSync(target, 'utf8')).toBe(OPERATOR);
    expect(report.delivered[target]).toBe(sha(OPERATOR));
  });
});

describe('B17-3 casaos: a compose-declared bind over a kept file', () => {
  const declared = () => `services:\n  app:\n    image: x\n    volumes:\n      - type: bind\n        source: ${appDir()}/application.yml\n        target: /app/application.yml\n`;
  const hostFile = () => `${appDir()}/application.yml`;
  const files = [{ path: '/app/application.yml', body: TEMPLATE }];
  let repo: string;
  beforeEach(() => {
    repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    fs.writeFileSync(path.join(repo, 'application.yml'), TEMPLATE);
  });

  it('keep-data reinstall: the build keeps the operator file and fails naming the path', async () => {
    fs.mkdirSync(appDir(), { recursive: true });
    fs.writeFileSync(hostFile(), OPERATOR);
    const report = newDeliveryReport();
    const logs: string[] = [];
    await createVolumeDirectories(declared(), 'app1', repo, (m) => logs.push(m), report, {});
    const handled = await (applyUserConfigOverrides as any)(declared(), 'app1', files, (m: string) => logs.push(m), report, {});
    expect(handled.has('/app/application.yml')).toBe(true);
    expect(fs.readFileSync(hostFile(), 'utf8')).toBe(OPERATOR);
    expect(report.failed).toContain('/app/application.yml');
    expect(logs.some((l) => l.includes('Kept existing') && l.includes('application.yml'))).toBe(true);
  });

  it('a file the same build just seeded from the repo takes the stored body', async () => {
    const report = newDeliveryReport();
    await createVolumeDirectories(declared(), 'app1', repo, () => {}, report, {});
    await (applyUserConfigOverrides as any)(declared(), 'app1', [{ path: '/app/application.yml', body: OPERATOR }], () => {}, report, {});
    expect(report.failed).toEqual([]);
    expect(fs.readFileSync(hostFile(), 'utf8')).toBe(OPERATOR);
  });

  it('a file still holding the recorded delivery takes the new body', async () => {
    fs.mkdirSync(appDir(), { recursive: true });
    fs.writeFileSync(hostFile(), OPERATOR);
    const report = newDeliveryReport();
    await (applyUserConfigOverrides as any)(declared(), 'app1', files, () => {}, report, { [hostFile()]: sha(OPERATOR) });
    expect(report.failed).toEqual([]);
    expect(fs.readFileSync(hostFile(), 'utf8')).toBe(TEMPLATE);
  });

  it('a file the bot changed after delivery, with the stored body unchanged, is kept and not failed', async () => {
    fs.mkdirSync(appDir(), { recursive: true });
    fs.writeFileSync(hostFile(), OPERATOR);
    const report = newDeliveryReport();
    const logs: string[] = [];
    await (applyUserConfigOverrides as any)(declared(), 'app1', files, (m: string) => logs.push(m), report, { [hostFile()]: sha(TEMPLATE) });
    expect(report.failed).toEqual([]);
    expect(fs.readFileSync(hostFile(), 'utf8')).toBe(OPERATOR);
    expect(logs.some((l) => l.includes('Kept existing') && l.includes('changed since'))).toBe(true);
  });

  it('a changed stored body over a file changed since delivery fails, saying it changed since delivery', async () => {
    fs.mkdirSync(appDir(), { recursive: true });
    fs.writeFileSync(hostFile(), OPERATOR);
    const report = newDeliveryReport();
    const logs: string[] = [];
    await (applyUserConfigOverrides as any)(declared(), 'app1', [{ path: '/app/application.yml', body: 'token: new\n' }], (m: string) => logs.push(m), report, { [hostFile()]: sha(TEMPLATE) });
    expect(report.failed).toContain('/app/application.yml');
    expect(logs.some((l) => l.includes('changed since the manager delivered it'))).toBe(true);
  });

  it('a kept file still byte for byte the repo template, with no record, takes the edited body', async () => {
    fs.mkdirSync(appDir(), { recursive: true });
    fs.writeFileSync(hostFile(), TEMPLATE);
    const report = newDeliveryReport();
    await createVolumeDirectories(declared(), 'app1', repo, () => {}, report, {});
    await (applyUserConfigOverrides as any)(declared(), 'app1', [{ path: '/app/application.yml', body: OPERATOR }], () => {}, report, {});
    expect(report.failed).toEqual([]);
    expect(fs.readFileSync(hostFile(), 'utf8')).toBe(OPERATOR);
    expect(report.delivered[hostFile()]).toBe(sha(OPERATOR));
  });

  it('Start redelivery keeps a file with no delivery record', async () => {
    fs.mkdirSync(appDir(), { recursive: true });
    fs.writeFileSync(hostFile(), OPERATOR);
    const report = newDeliveryReport();
    await (redeliverConfigFiles as any)(declared(), 'app1', files, () => {}, report, {});
    expect(fs.readFileSync(hostFile(), 'utf8')).toBe(OPERATOR);
    expect(report.failed).toContain('/app/application.yml');
  });
});

describe('B17-3 the config editor sends a repo-template card only when it differs from what was loaded', () => {
  const html = fs.readFileSync(path.join(__dirname, '../../src/webui/public/index.html'), 'utf8');
  const fn = (name: string): string => {
    const at = html.indexOf(`function ${name}(`);
    expect(at).toBeGreaterThanOrEqual(0);
    let i = html.indexOf('{', html.indexOf(')', at));
    for (let depth = 0; ; i++) {
      if (html[i] === '{') depth++;
      else if (html[i] === '}' && --depth === 0) return html.slice(at, i + 1);
    }
  };
  const unescape = (t: string) => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  // A card as the DOM holds it after rendering: its inputs carry the rendered values.
  const card = (out: string) => {
    const tpl = out.match(/data-template="([^"]*)"/);
    const p = out.match(/class="cf-path"[^>]*value="([^"]*)"/);
    const ta = out.match(/<textarea class="cf-body[^>]*>([\s\S]*?)<\/textarea>/);
    const els: Record<string, any> = {
      '.cf-path': { value: p ? unescape(p[1]) : '' },
      '.cf-body': { value: ta ? unescape(ta[1]) : '' },
      '.cf-writable': { checked: /class="cf-writable" checked/.test(out) },
      '.cf-enabled': { checked: /class="cf-enabled" checked/.test(out) },
    };
    return { dataset: tpl ? { template: tpl[1] } : {}, querySelector: (sel: string) => els[sel] };
  };
  const setup = () => {
    const blocks: any[] = [];
    const ctx: any = vm.createContext({ window: {}, document: { querySelectorAll: () => blocks } });
    vm.runInContext('const cfTemplateOrig = new Map(); let cfTemplateSeq = 0;\n'
      + ['escapeHtml', 'buildConfigFileBlockHtml', 'registerTemplateOrig', 'collectConfigFiles'].map(fn).join('\n')
      + '\nthis.render = buildConfigFileBlockHtml; this.collect = collectConfigFiles;', ctx);
    return { ctx, blocks };
  };
  const LIST = 'items:\n  - a\n  - b\n';
  const tplCard = (ctx: any, p: string) => card(ctx.render(p, LIST, true, true, null, 'yaml', null, false, undefined, true));

  it('an untouched template card is not sent, so the host file is left as it is', () => {
    const { ctx, blocks } = setup();
    blocks.push(tplCard(ctx, '/app/list.yml'));
    expect(ctx.collect('#config-editor-rows')).toEqual([]);
  });

  it('a guided list edit written into the body from code is sent', () => {
    const { ctx, blocks } = setup();
    const b = tplCard(ctx, '/app/list.yml');
    blocks.push(b);
    b.querySelector('.cf-body').value = 'items:\n  - a\n';
    expect(JSON.parse(JSON.stringify(ctx.collect('#config-editor-rows')))).toEqual([{ path: '/app/list.yml', body: 'items:\n  - a\n', readOnly: true, enabled: true }]);
  });

  it('a template card turned off or made writable is sent; a stored card is always sent', () => {
    const { ctx, blocks } = setup();
    const off = tplCard(ctx, '/app/a.yml');
    off.querySelector('.cf-enabled').checked = false;
    const rw = tplCard(ctx, '/app/b.yml');
    rw.querySelector('.cf-writable').checked = true;
    blocks.push(off, rw, card(ctx.render('/app/c.yml', LIST, true, true, null, 'yaml', null, false, undefined, false)));
    expect(ctx.collect('#config-editor-rows').map((f: any) => f.path)).toEqual(['/app/a.yml', '/app/b.yml', '/app/c.yml']);
  });

  it('the config list marks only rows with no stored body as repo templates', async () => {
    process.env.DATA_DIR = path.join(tmp, 'mgr');
    const repo = path.join(tmp, 'repo2');
    fs.mkdirSync(path.join(repo, 'conf'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'docker-compose.yml'), 'services:\n  app:\n    image: x\n    volumes:\n      - ./conf/a.yml:/app/a.yml\n      - ./conf/b.yml:/app/b.yml\n');
    fs.writeFileSync(path.join(repo, 'conf', 'a.yml'), 'a: 1\n');
    fs.writeFileSync(path.join(repo, 'conf', 'b.yml'), 'b: 1\n');
    vi.resetModules();
    const cfm = await import('../../src/config/configFileManager');
    const envList = await import('../../src/env/envList');
    cfm.setConfigFiles('b173', [{ path: '/app/a.yml', body: 'a: 2\n' }]);
    const list = envList.buildBotConfigList(repo, 'b173');
    expect(list.find(f => f.path === '/app/a.yml')?.fromTemplate).toBeUndefined();
    expect(list.find(f => f.path === '/app/b.yml')?.fromTemplate).toBe(true);
  });
});
