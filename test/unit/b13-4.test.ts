import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'b13-4-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir, mode: 'docker' as 'docker' | 'casaos', facts: {} as Record<string, any> };
});

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const exec = (cmd: string, opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    if (cmd.startsWith('docker inspect')) done(new Error('Error: No such object'));
    else done(null, { stdout: '', stderr: '' });
  };
  return { ...real, exec, default: { ...real, exec } };
});
vi.mock('../../src/casaos/detector', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/casaos/detector')>()),
  getDeploymentMode: async () => tmp.mode,
}));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));
vi.mock('../../src/config/appCapabilities', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/config/appCapabilities')>()),
  findAppCapabilities: () => ({
    hooks: {},
    controlPlane: {
      groupSecretEnv: 'FLEET_SECRET',
      roleEnv: { key: 'FLEET_ROLE', default: 'leader', dialTargetOrder: ['leader', 'standby'], dialsOut: ['worker'] },
      urlScheme: { secure: 'wss', plain: 'ws' },
    },
  }),
}));
vi.mock('../../src/instance/appLifecycle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/appLifecycle')>()),
  getAppFacts: async (bot: { id: string }) => {
    const f = tmp.facts[bot.id];
    return f ? { success: true, facts: f } : { success: false, error: 'no answer' };
  },
}));

import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import YAML from 'yaml';
import * as envManager from '../../src/env/manager';
import { createBotRoutes } from '../../src/webui/routes/bots';

const ids = ['b1', 'b2', 'b3', 'b4', 'b5'];
const live = { running: true, initialized: true, role: 'master', superseded: null, followerHold: null };

beforeEach(() => {
  delete process.env.APP_DOMAIN;
  delete process.env.BOT_DOMAIN_BASE;
  tmp.mode = 'docker';
  fs.rmSync(path.join(tmp.dir, 'bots'), { recursive: true, force: true });
  const instances: Record<string, any> = {};
  for (const id of ids) {
    fs.mkdirSync(path.join(tmp.dir, 'bots', id, 'env'), { recursive: true });
    fs.writeFileSync(path.join(tmp.dir, 'bots', id, 'docker-compose.yml'), YAML.stringify({
      services: { app: { image: 'fake/app:1', container_name: `${id}-app`, labels: { 'fleet.control-port': '9500' }, environment: { FLEET_SECRET: 's' } } },
    }));
    instances[id] = {
      id, sanitizedName: id, displayName: `Bot ${id}`, titleName: `Bot ${id}`, status: 'running',
      sourceType: 'git', sourceUrl: 'https://example.invalid/app', envVars: {},
      createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z',
    };
  }
  fs.writeFileSync(path.join(tmp.dir, 'instances.json'), JSON.stringify({ instances }));
  for (const id of ids) envManager.setEnvVars(id, { FLEET_SECRET: 's' });
  tmp.facts = {
    b1: live,
    b2: { ...live, initialized: false },
    b3: { ...live, superseded: { byNodeId: 'x', byNodeName: 'x', term: 2, retireRequested: false, at: 1, source: 'peer', steppedDown: true } },
    b5: { ...live, followerHold: { reason: 'behind', standInNodeId: 'x', standInName: 'x', observedTerm: 2, localTerm: 1, seenVia: 'peer', since: 1, following: 'x', namesThisNode: true } },
  };
});

afterAll(() => {
  delete process.env.APP_DOMAIN;
  delete process.env.BOT_DOMAIN_BASE;
  fs.rmSync(tmp.dir, { recursive: true, force: true });
});

const router = createBotRoutes({ clients: new Set() } as any);
const masters = async (): Promise<any> => {
  const layer = (router as any).stack.find((l: any) => l.route?.path === '/fleet/masters' && l.route.methods.get);
  const out = { body: undefined as any };
  const res = { status() { return res; }, json(body: any) { out.body = body; return res; } };
  await layer.route.stack[layer.route.stack.length - 1].handle({ query: {}, body: {}, params: {} }, res);
  return out.body;
};

describe('the wizard master list asks each app whether it is a live master', () => {
  it('lists a running, initialized master that no node superseded', async () => {
    const m = (await masters()).masters.find((x: any) => x.id === 'b1');
    expect(m).toBeTruthy();
    expect(m.unanswered).toBeNull();
  });

  it('leaves out a master that is not initialized or was superseded', async () => {
    const got = (await masters()).masters.map((x: any) => x.id);
    expect(got).not.toContain('b2');
    expect(got).not.toContain('b3');
  });

  it('leaves out a master that follows a stand-in under a follower hold', async () => {
    expect((await masters()).masters.map((x: any) => x.id)).not.toContain('b5');
  });

  it('leaves out a node whose app reports a role other than master', async () => {
    tmp.facts.b1 = { ...live, role: 'worker' };
    expect((await masters()).masters.map((x: any) => x.id)).not.toContain('b1');
  });

  it('keeps a master that did not answer, labelled as unconfirmed', async () => {
    const m = (await masters()).masters.find((x: any) => x.id === 'b4');
    expect(m.unanswered).toMatch(/can't confirm/);
  });

  it('keeps the record order', async () => {
    tmp.facts.b2 = live;
    expect((await masters()).masters.map((x: any) => x.id)).toEqual(['b1', 'b2', 'b4']);
  });
});

describe('the fleet URL template names the lane the deployment mode attaches', () => {
  it('uses BOT_DOMAIN_BASE in docker mode even when APP_DOMAIN is set', async () => {
    process.env.APP_DOMAIN = 'app.example';
    process.env.BOT_DOMAIN_BASE = 'base.example';
    const body = await masters();
    expect(body.fleetUrlTemplate).toBe('wss://{name}-fleet.base.example');
    expect(body.masters[0].masterUrl).toBe('wss://b1-fleet.base.example');
  });

  it('uses APP_DOMAIN in casaos mode', async () => {
    tmp.mode = 'casaos';
    process.env.APP_DOMAIN = 'app.example';
    process.env.BOT_DOMAIN_BASE = 'base.example';
    expect((await masters()).fleetUrlTemplate).toBe('wss://{name}-fleet-app.example');
  });

  it('has no template in docker mode with only APP_DOMAIN', async () => {
    process.env.APP_DOMAIN = 'app.example';
    expect((await masters()).fleetUrlTemplate).toBeNull();
  });
});

describe('the wizard previews the route of the name the manager will save', () => {
  const html = fs.readFileSync(path.join(__dirname, '../../src/webui/public/index.html'), 'utf-8');
  const between = (a: string, b: string) => html.slice(html.indexOf(a), html.indexOf(b));
  const attachSrc = between('function attachFleetMasterUrlPreview', 'function addEnvEditorRow');
  const nameSrc = between('let installValidatedName', 'async function loadPreviousEnvs');

  const load = () => {
    const listeners: Record<string, Array<() => void>> = {};
    const el = (extra: Record<string, any> = {}): any => ({
      value: '', textContent: '', innerHTML: '', disabled: false, title: '', dataset: {}, style: {}, className: '',
      classList: { remove() {} },
      addEventListener() {}, insertAdjacentElement() {},
      ...extra,
    });
    const nameInput = el();
    const byId: Record<string, any> = { 'install-name': nameInput, 'install-name-preview': el(), 'install-name-error': el() };
    const parts: Record<string, any> = { '.fleet-url-value': el(), '.fleet-url-label': el(), button: el() };
    const timers: Array<() => Promise<void>> = [];
    const answers: Record<string, any> = {};
    const ctx: any = {
      document: {
        getElementById: (id: string) => byId[id] ?? null,
        createElement: () => el({ querySelector: (q: string) => parts[q] }),
        addEventListener: (t: string, f: () => void) => { (listeners[t] ||= []).push(f); },
        dispatchEvent: (e: { type: string }) => { for (const f of listeners[e.type] || []) f(); },
      },
      Event: class { type: string; constructor(t: string) { this.type = t; } },
      semanticWrapper: () => el(),
      semanticTargetOrderOf: () => ['leader'],
      semanticEnvKey: () => 'FLEET_ROLE',
      semanticEnvValue: () => 'leader',
      FLEET_URL_PREVIEW_TEXT: [{ label: 'L', title: 'T' }],
      updateEnvConditionals() {}, copyToClipboard() {},
      sanitizeNamePreview: (n: string) => n.toLowerCase(),
      escapeHtml: (s: string) => s,
      nameValidationTimeout: null,
      setTimeout: (f: () => Promise<void>) => { timers.push(f); return timers.length; },
      clearTimeout() {},
      api: async (_m: string, url: string) => answers[decodeURIComponent(url.split('name=')[1])],
    };
    vm.createContext(ctx);
    const api = vm.runInContext(`${nameSrc}\n${attachSrc}\n({ attachFleetMasterUrlPreview, onNameInput })`, ctx);
    api.attachFleetMasterUrlPreview(el({ querySelector: () => null }), 'wss://{name}-fleet.base.example');
    return { api, nameInput, parts, timers, answers };
  };

  it('shows the uniquified name from the validate-name answer, and a placeholder with Copy disabled before it', async () => {
    const t = load();
    t.answers.foo = { valid: true, adjusted: true, sanitizedName: 'foo2', displayName: 'foo2', reuseAvailable: false };
    t.nameInput.value = 'foo';
    await t.api.onNameInput();
    expect(t.parts['.fleet-url-value'].textContent).toBe('Shown once the name is checked.');
    expect(t.parts.button.disabled).toBe(true);
    await t.timers.pop()!();
    expect(t.parts['.fleet-url-value'].textContent).toBe('wss://foo2-fleet.base.example');
    expect(t.parts.button.disabled).toBe(false);
  });

  it('ignores an answer that arrives after the input changed', async () => {
    const t = load();
    t.answers.foo = { valid: true, adjusted: false, sanitizedName: 'foo', displayName: 'foo', reuseAvailable: false };
    t.nameInput.value = 'foo';
    await t.api.onNameInput();
    const stale = t.timers.pop()!;
    t.nameInput.value = 'bar';
    await t.api.onNameInput();
    await stale();
    expect(t.parts['.fleet-url-value'].textContent).toBe('Shown once the name is checked.');
    expect(t.parts.button.disabled).toBe(true);
  });
});
