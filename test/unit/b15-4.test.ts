import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vm from 'vm';

const st = vi.hoisted(() => ({ bots: [] as any[], deletedBots: [] as any[] }));

vi.mock('../../src/docker/containerManager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/docker/containerManager')>()),
  getAllBots: () => st.bots,
  foreignDockerProjects: async () => new Map(),
}));
vi.mock('../../src/webui/routes/vault', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/webui/routes/vault')>()),
  readVault: () => ({ state: 'ok', config: { standalone: [], deletedBots: st.deletedBots } }),
}));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import { createValidationRoutes } from '../../src/webui/routes/bots';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'b15-4-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const routeCall = async (route: string, query: any) => {
  const router: any = createValidationRoutes();
  const layer = router.stack.find((l: any) => l.route?.path === route && l.route.methods.get);
  const out = { status: 200, body: undefined as any };
  const res = { status(code: number) { out.status = code; return res; }, json(b: any) { out.body = b; return res; } };
  await layer.route.stack[layer.route.stack.length - 1].handle({ query, body: {}, params: {} }, res);
  return out.body;
};

const writeCompose = (sanitized: string, env: Record<string, string>) => {
  const dir = path.join(process.env.DATA_ROOT!, 'AppData', 'casaos', 'apps', sanitized);
  fs.mkdirSync(dir, { recursive: true });
  const lines = Object.entries(env).map(([k, v]) => `      ${k}: "${v}"`).join('\n');
  fs.writeFileSync(path.join(dir, 'docker-compose.yml'), `services:\n  app:\n    image: x\n    environment:\n${lines}\n`);
};

beforeEach(() => {
  process.env.DATA_ROOT = fs.mkdtempSync(path.join(root, 'd-'));
  st.bots = [];
  st.deletedBots = [];
});

describe('recover-envs reads what the install will save', () => {
  it('reads the uniquified name that validate-name reports, not the typed one', async () => {
    st.bots = [{ id: 'b1', name: 'Alpha', sanitizedName: 'alpha' }];
    st.deletedBots = [{ sanitizedName: 'alpha2', deletedAt: 1, entries: [{ key: 'K2', value: 'v2' }] }];
    const v = await routeCall('/validate-name', { name: 'Alpha' });
    expect(v.sanitizedName).toBe('alpha2');
    expect(v.envsAvailable).toBe(true);
    const r = await routeCall('/recover-envs', { name: 'Alpha' });
    expect(r.envs.map((e: any) => e.key)).toEqual(['K2']);
  });

  it('never reads the compose of a live instance', async () => {
    writeCompose('alpha', { SECRET_OF_LIVE: 'x' });
    st.bots = [{ id: 'b1', name: 'Alpha', sanitizedName: 'alpha' }];
    const r = await routeCall('/recover-envs', { name: 'Alpha' });
    expect(r.envs.map((e: any) => e.key)).not.toContain('SECRET_OF_LIVE');
  });

  it('counts a key held by both vault and compose once', async () => {
    writeCompose('beta', { A: 'c', B: 'c', BOT_ID: 'x' });
    st.deletedBots = [{ sanitizedName: 'beta', deletedAt: 1, entries: [{ key: 'A', value: 'v' }] }];
    const r = await routeCall('/recover-envs', { name: 'Beta' });
    expect(r.envs.length).toBe(2);
    expect(r.sources).toEqual({ vault: 1, compose: 1 });
  });
});

const pageHtml = fs.readFileSync(path.resolve(__dirname, '../../src/webui/public/index.html'), 'utf8');
const pageFunction = (name: string): string => {
  let start = pageHtml.indexOf(`function ${name}(`);
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

const row = (key: string, autowired = false) => {
  const keyEl = { value: key };
  const valueEl = { value: 'orig' };
  return {
    valueEl,
    el: {
      classList: { contains: (c: string) => autowired && c === 'env-autowired' },
      querySelector: (s: string) => s === '.env-key' ? keyEl : s === '.env-value' ? valueEl : null,
    },
  };
};

describe('Load envs in the wizard', () => {
  it('asks for the selected source, leaves auto-wired rows alone, names them and counts only loaded rows', async () => {
    const auto = row('FLEET_SECRET', true);
    const plain = row('TOKEN');
    const detail = { textContent: '' };
    const urls: string[] = [];
    const added: string[] = [];
    const container = { querySelectorAll: () => [auto.el, plain.el], querySelector: () => null };
    const ctx = vm.createContext({
      installSourceId: 's1', installSeq: 1, urls, Event: class {}, Object, Array, Set,
      api: async (_m: string, u: string) => {
        urls.push(u);
        return { success: true, envs: [
          { key: 'FLEET_SECRET', value: 'old', source: 'vault' },
          { key: 'TOKEN', value: 't', source: 'vault' },
          { key: 'NEW', value: 'n', source: 'compose' },
        ], sources: { vault: 2, compose: 5 } };
      },
      setEnvInputValue: (el: any, v: string) => { el.value = v; },
      addInstallEnvRow: (k: string) => { added.push(k); },
      semanticWrapper: () => null,
      document: {
        getElementById: (id: string) => id === 'install-name' ? { value: 'Alpha' }
          : id === 'install-env-rows' ? container : id === 'install-reuse-detail' ? detail
          : id === 'install-reuse-btn' ? { disabled: false, textContent: '' } : null,
      },
    });
    vm.runInContext(pageFunction('loadPreviousEnvs'), ctx);
    await ctx.loadPreviousEnvs();
    expect(urls[0]).toContain('sourceId=s1');
    expect(auto.valueEl.value).toBe('orig');
    expect(plain.valueEl.value).toBe('t');
    expect(added).toEqual(['NEW']);
    expect(detail.textContent).toMatch(/^Loaded 2 env\(s\) into the form \(1 from vault, 1 from compose\)/);
    expect(detail.textContent).toContain('FLEET_SECRET');
  });
});
