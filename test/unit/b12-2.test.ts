import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'b12-2-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir };
});

import * as fs from 'fs';
import * as path from 'path';

const COMPOSE = [
  'x-casaos:',
  '  main: gw',
  'services:',
  '  gw:',
  '    image: example/gw',
  '    environment:',
  '      BACKEND_HOST: app',
  '      BACKEND_PORT: "3000"',
  '      ALLOWED_PATHS: /guild,/auth',
  '      AUTH_MODE: credentials',
  '      USER: ${WEBUI_USER}',
  '      PASSWORD: ${WEBUI_PASSWORD}',
  '    volumes:',
  '      - ./gw/shield.yml:/etc/shield/shield.yml',
  '      - ./gw/config.json:/etc/shield/config.json',
  '  app:',
  '    image: example/app',
  '    environment:',
  '      APP_MODE: production',
  '    volumes:',
  '      - ./conf/app.yml:/app/app.yml',
  '',
].join('\n');

let repo = '';
beforeEach(() => {
  const dataDir = fs.mkdtempSync(path.join(h.dir, 't-'));
  process.env.DATA_DIR = dataDir;
  process.env.DATA_ROOT = path.join(dataDir, 'DATA');
  delete process.env.ENV_ENCRYPTION_KEY;
  delete process.env.BOT_PORT_BIND;
  delete process.env.BOT_DOMAIN_BASE;
  repo = fs.mkdtempSync(path.join(h.dir, 'repo-'));
  fs.writeFileSync(path.join(repo, 'docker-compose.yml'), COMPOSE);
  fs.mkdirSync(path.join(repo, 'gw'));
  fs.mkdirSync(path.join(repo, 'conf'));
  fs.writeFileSync(path.join(repo, 'gw', 'shield.yml'), 'realm: shield\n');
  fs.writeFileSync(path.join(repo, 'gw', 'config.json'), '{"gate": "x"}\n');
  fs.writeFileSync(path.join(repo, 'conf', 'app.yml'), 'level: info\n');
  fs.writeFileSync(path.join(repo, 'config.json.example'), '{"token": ""}\n');
  vi.resetModules();
});
afterAll(() => fs.rmSync(h.dir, { recursive: true, force: true }));

describe('B12-2 a fronting gateway is not offered as the bot', () => {
  it('gateway compose literals are not env rows; the app service literals are', async () => {
    const { buildWizardEnvList } = await import('../../src/env/envList');
    const keys = buildWizardEnvList(repo).vars.map(v => v.key);
    expect(keys).toContain('APP_MODE');
    for (const k of ['BACKEND_HOST', 'BACKEND_PORT', 'ALLOWED_PATHS', 'AUTH_MODE']) expect(keys).not.toContain(k);
  });

  it('the deploy decides when the gateway is dropped', async () => {
    const { frontingGatewayDropped } = await import('../../src/templates/pcsProcessing');
    expect(frontingGatewayDropped('docker', undefined)).toBe(true);
    expect(frontingGatewayDropped('docker', 'managed')).toBe(true);
    expect(frontingGatewayDropped('docker', 'public')).toBe(false);
    expect(frontingGatewayDropped('casaos', 'auto')).toBe(false);
    process.env.BOT_PORT_BIND = '0.0.0.0';
    expect(frontingGatewayDropped('docker', 'auto')).toBe(false);
  });

  it('login rows say they are not used when this deployment drops the gateway', async () => {
    const { buildWizardEnvList } = await import('../../src/env/envList');
    const dropped = buildWizardEnvList(repo, { gateway: { dropped: true, webAuth: 'auto' } }).vars;
    const rows = dropped.filter(v => v.key === 'WEBUI_USER' || v.key === 'WEBUI_PASSWORD');
    expect(rows.length).toBe(2);
    for (const r of rows) {
      expect(r.inactive).toMatch(/^Not used: this deployment removes the bot's own login gateway \(Auth: Auto\)/);
      expect(r.inactive).toMatch(/Public/);
    }
    const kept = buildWizardEnvList(repo, { gateway: { dropped: false, webAuth: 'public' } }).vars;
    for (const r of kept.filter(v => v.key.startsWith('WEBUI_'))) expect(r.inactive).toBeUndefined();
  });

  it('a stored login stays editable when the gateway is dropped, so a save cannot remove it', async () => {
    const env = await import('../../src/env/manager');
    const { buildBotEnvList } = await import('../../src/env/envList');
    env.setEnvVars('b122', { WEBUI_USER: 'admin' });
    const rows = buildBotEnvList(repo, 'b122', undefined, undefined, { dropped: true, webAuth: 'managed' });
    const user = rows.find(r => r.key === 'WEBUI_USER')!;
    const pass = rows.find(r => r.key === 'WEBUI_PASSWORD')!;
    expect(user.inactive).toBeUndefined();
    expect(user.value).toBe('admin');
    expect(user.description).toMatch(/Not used: this deployment removes the bot's own login gateway \(Auth: Managed\)/);
    expect(pass.inactive).toMatch(/^Not used/);
  });

  it('a dropped gateway service config files are not offered', async () => {
    const { buildWizardEnvList } = await import('../../src/env/envList');
    const files = buildWizardEnvList(repo, { gateway: { dropped: true, webAuth: 'auto' } }).detection.configFiles;
    const paths = files.map(f => f.inContainerPath);
    expect(paths).toContain('/app/app.yml');
    expect(paths).not.toContain('/etc/shield/shield.yml');
    expect(paths.some(p => p.startsWith('/etc/shield/'))).toBe(false);
  });

  it('a kept gateway keeps its config files, marked with their service', async () => {
    const { buildWizardEnvList } = await import('../../src/env/envList');
    const files = buildWizardEnvList(repo, { gateway: { dropped: false, webAuth: 'public' } }).detection.configFiles;
    const shield = files.find(f => f.inContainerPath === '/etc/shield/shield.yml');
    expect(shield?.service).toBe('gw');
  });

  it('a root template is never re-homed onto a gateway bind path', async () => {
    const { detectBotType } = await import('../../src/detection');
    const cfg = detectBotType(repo).configFiles.find(f => f.targetName === 'config.json' && f.exampleName === 'config.json.example');
    expect(cfg).toBeDefined();
    expect(cfg!.inContainerPath.startsWith('/etc/shield/')).toBe(false);
  });

  it('README says which deployments keep the gateway login rows in use', () => {
    const readme = fs.readFileSync(path.resolve(__dirname, '../../README.md'), 'utf8');
    const line = readme.split('\n').find(l => l.includes('$WEBUI_USER') && l.includes('Env')) || '';
    expect(line).toMatch(/Docker mode removes the gateway/);
  });
});

describe('B12-2 review: the login rows and gateway files follow the gateway that is really dropped', () => {
  it('a gateway-less compose whose app takes $WEBUI_USER keeps the login rows live', async () => {
    fs.writeFileSync(path.join(repo, 'docker-compose.yml'), 'services:\n  app:\n    image: example/app\n    environment:\n      WEBUI_USER: ${WEBUI_USER}\n      WEBUI_PASSWORD: ${WEBUI_PASSWORD}\n');
    const { buildWizardEnvList } = await import('../../src/env/envList');
    const rows = buildWizardEnvList(repo, { gateway: { dropped: true, webAuth: 'auto' } }).vars.filter(v => v.key.startsWith('WEBUI_'));
    expect(rows.length).toBe(2);
    for (const r of rows) expect(r.inactive).toBeUndefined();
  });

  it('a backend that takes $WEBUI_USER keeps the login rows live when the gateway is dropped', async () => {
    const compose = COMPOSE
      .replace('      USER: ${WEBUI_USER}\n      PASSWORD: ${WEBUI_PASSWORD}\n', '')
      .replace('      APP_MODE: production\n', '      APP_MODE: production\n      WEBUI_USER: ${WEBUI_USER}\n');
    expect(compose).not.toBe(COMPOSE);
    fs.writeFileSync(path.join(repo, 'docker-compose.yml'), compose);
    const { buildWizardEnvList } = await import('../../src/env/envList');
    const rows = buildWizardEnvList(repo, { gateway: { dropped: true, webAuth: 'auto' } }).vars.filter(v => v.key.startsWith('WEBUI_'));
    expect(rows.length).toBe(2);
    for (const r of rows) expect(r.inactive).toBeUndefined();
  });

  it('the note names the bot-card Auth control only when the bot has a public URL', async () => {
    const { buildWizardEnvList } = await import('../../src/env/envList');
    const noUrl = buildWizardEnvList(repo, { gateway: { dropped: true, webAuth: 'auto', publicUrl: false } as never }).vars.find(v => v.key === 'WEBUI_USER')!;
    expect(noUrl.inactive).not.toMatch(/bot card/);
    expect(noUrl.inactive).toMatch(/bots web-auth <id> public/);
    expect(noUrl.inactive).toMatch(/BOT_PORT_BIND/);
    const withUrl = buildWizardEnvList(repo, { gateway: { dropped: true, webAuth: 'auto', publicUrl: true } as never }).vars.find(v => v.key === 'WEBUI_USER')!;
    expect(withUrl.inactive).toMatch(/bot card/);
  });

  it('the config editor leaves out an unsaved gateway file and keeps a saved one, marked not used', async () => {
    const cfm = await import('../../src/config/configFileManager');
    const envList = await import('../../src/env/envList') as any;
    cfm.setConfigFiles('b122c', [{ path: '/etc/shield/config.json', body: '{"gate": "y"}' }]);
    const list = envList.buildBotConfigList(repo, 'b122c', undefined, { dropped: true, webAuth: 'auto' }) as Array<{ path: string; inactive?: string }>;
    const paths = list.map(f => f.path);
    expect(paths).toContain('/app/app.yml');
    expect(paths).not.toContain('/etc/shield/shield.yml');
    expect(list.find(f => f.path === '/etc/shield/config.json')?.inactive).toMatch(/^Not used/);
    const kept = (envList.buildBotConfigList(repo, 'b122c', undefined, { dropped: false, webAuth: 'public' }) as Array<{ path: string }>).map(f => f.path);
    expect(kept).toContain('/etc/shield/shield.yml');
  });

  it('a stored config for a stripped gateway bind is not bound onto the app service', async () => {
    const pcs = await import('../../src/templates/pcsProcessing') as any;
    const { parse } = await import('yaml');
    const bot = { id: 'b122d', name: 'b', webAuth: 'auto' };
    const processed = pcs.processComposeForDocker(COMPOSE, 'b122d', bot, '/host/bot');
    expect(processed.droppedGatewayBinds).toEqual(expect.arrayContaining(['/etc/shield/config.json', '/etc/shield/shield.yml']));
    const out = pcs.prepareDockerBotFiles(processed.content, path.join(repo, 'botdir'), '/host/bot', null,
      [{ path: '/etc/shield/config.json', body: '{}' }, { path: '/app/extra.json', body: '{}' }], () => {}, undefined, undefined, processed.droppedGatewayBinds);
    const vols = JSON.stringify(parse(out).services.app.volumes || []);
    expect(vols).not.toContain('/etc/shield/config.json');
    expect(vols).toContain('/app/extra.json');
  });
});

describe('B12-2 review 2: the note and rows match the deployment', () => {
  it('a gateway and a backend that both take the login keep the login rows live', async () => {
    const compose = COMPOSE.replace('      APP_MODE: production\n', '      APP_MODE: production\n      WEBUI_USER: ${WEBUI_USER}\n');
    expect(compose).not.toBe(COMPOSE);
    fs.writeFileSync(path.join(repo, 'docker-compose.yml'), compose);
    const { buildWizardEnvList } = await import('../../src/env/envList');
    const rows = buildWizardEnvList(repo, { gateway: { dropped: true, webAuth: 'auto' } }).vars.filter(v => v.key.startsWith('WEBUI_'));
    expect(rows.length).toBe(2);
    for (const r of rows) expect(r.inactive).toBeUndefined();
  });

  it('with no public URL yet, the note names BOT_PORT_BIND', async () => {
    const { buildWizardEnvList } = await import('../../src/env/envList');
    const row = buildWizardEnvList(repo, { gateway: { dropped: true, webAuth: 'auto', publicUrl: false } }).vars.find(v => v.key === 'WEBUI_USER')!;
    expect(row.inactive).toMatch(/bots web-auth <id> public/);
    expect(row.inactive).toMatch(/BOT_PORT_BIND is off loopback/);
  });

  it('the config editor shows a file note and still saves the file', () => {
    const vm = require('vm') as typeof import('vm');
    const html = fs.readFileSync(path.resolve(__dirname, '../../src/webui/public/index.html'), 'utf8');
    const fn = (name: string): string => {
      const start = html.indexOf(`function ${name}(`);
      expect(start).toBeGreaterThanOrEqual(0);
      let i = html.indexOf(')', start);
      i = html.indexOf('{', i);
      for (let depth = 0; ; i++) {
        if (html[i] === '{') depth++;
        else if (html[i] === '}' && --depth === 0) return html.slice(start, i + 1);
      }
    };
    expect(html).toMatch(/f\.bodyUndecryptable, f\.inactive[,)]/);
    const ctx: any = vm.createContext({ window: {} });
    vm.runInContext([fn('escapeHtml'), fn('buildConfigFileBlockHtml')].join('\n'), ctx);
    const out: string = ctx.buildConfigFileBlockHtml('/app/app.yml', 'a: 1\n', true, true, null, 'yaml', null, false, 'Not used: <gw> removed');
    const tip = out.indexOf('class="env-tip cf-inactive"');
    const collapse = out.indexOf('class="cf-collapse hidden"');
    expect(tip).toBeGreaterThan(0);
    expect(collapse).toBeGreaterThan(tip);
    expect(out).toContain('Not used: &lt;gw&gt; removed');
    expect(out).toMatch(/class="cf-path"[^>]*value="\/app\/app\.yml"/);
    expect(out.slice(collapse)).toMatch(/<textarea class="cf-body"[\s\S]*a: 1/);
    expect(out).toContain('class="cf-enabled" checked');
  });
});
