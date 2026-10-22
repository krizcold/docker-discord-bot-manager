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

class Ev { type: string; bubbles: boolean; isTrusted: boolean; target: any = null;
  constructor(type: string, o: any = {}, trusted = false) { this.type = type; this.bubbles = !!o.bubbles; this.isTrusted = trusted; } }

class Node {
  tagName: string; dataset: Record<string, string> = {}; style: any = {}; children: Node[] = []; parent: Node | null = null;
  classList = { contains: (_c: string) => false }; value = ''; textContent = ''; className = ''; listeners: Record<string, Function[]> = {}; options: any[] = [];
  constructor(tag = 'DIV', cls = '') { this.tagName = tag; this.className = cls; }
  add(...c: Node[]) { for (const x of c) { x.parent = this; this.children.push(x); } return this; }
  get parentElement() { return this.parent; }
  insertBefore(n: Node, ref: Node) { n.parent = this; this.children.splice(this.children.indexOf(ref), 0, n); }
  matches(sel: string): boolean {
    const m = /^\[data-semantic="([^"]+)"\]$/.exec(sel);
    if (m) return this.dataset.semantic === m[1];
    if (sel.startsWith('.')) return this.className.split(' ').includes(sel.slice(1));
    return false;
  }
  all(): Node[] { return this.children.flatMap(c => [c, ...c.all()]); }
  querySelectorAll(sel: string): Node[] {
    const parts = sel.trim().split(/\s+/);
    return this.all().filter(n => {
      if (!n.matches(parts[parts.length - 1])) return false;
      let p = n.parent; let k = parts.length - 2;
      while (k >= 0 && p && p !== this.parent) { if (p.matches(parts[k])) k--; p = p.parent; }
      return k < 0;
    });
  }
  querySelector(sel: string) { return this.querySelectorAll(sel)[0] || null; }
  closest(sel: string): Node | null { let p: Node | null = this; while (p) { if (p.matches(sel)) return p; p = p.parent; } return null; }
  addEventListener(t: string, f: Function) { (this.listeners[t] ||= []).push(f); }
  dispatchEvent(e: Ev) { e.target = e.target || this; let p: Node | null = this;
    while (p) { (p.listeners[e.type] || []).forEach(f => f(e)); if (!e.bubbles) break; p = p.parent; } }
}

const valueRow = (semantic: string, key: string, list = false) => {
  const wrapper = new Node(); wrapper.dataset.semantic = semantic;
  const row = new Node('DIV', 'env-row'); const k = new Node('INPUT', 'env-key'); k.value = key;
  const v = new Node('INPUT', 'env-value');
  if (list) { const l = new Node('DIV', 'env-list'); const items = new Node('DIV', 'env-list-items'); l.add(v, items); row.add(k, l); }
  else row.add(k, v);
  wrapper.add(row);
  return { wrapper, v };
};

const MASTER = { id: 'm1', name: 'Master', secretSet: true, localCandidates: ['http://m1:1'], controlSecret: 'fleet-secret' };

const form = (opts: { role?: string; urls?: string; secret?: string; id?: string } = {}) => {
  const container = new Node(); container.dataset.x = ''; (container as any).id = opts.id || 'install-env-rows';
  const role = valueRow('peer-role', 'FLEET_ROLE'); role.wrapper.dataset.semanticValues = 'worker';
  role.v.value = opts.role ?? 'worker';
  const urls = valueRow('peer-list', 'MASTER_URLS', true); urls.v.value = opts.urls ?? '';
  const secret = valueRow('peer-secret', 'FLEET_SECRET'); secret.v.value = opts.secret ?? '';
  container.add(role.wrapper, urls.wrapper, secret.wrapper);
  return { container, role: role.v, urls: urls.v, secret: secret.v, urlsWrapper: urls.wrapper, secretWrapper: secret.wrapper };
};

const NAMES = ['semanticWrapper', 'semanticEnvKey', 'semanticEnvValue', 'semanticValuesOf', 'dialsOutRole', 'setEnvInputValue',
  'attachFleetSecretRoleCache', 'attachFleetMasterPrefill', 'generateEnvSecret', 'missingMasterCandidates'];

const page = (f: ReturnType<typeof form>, masters = [MASTER], extra: Record<string, unknown> = {}) => {
  let locSel: Node, masterSel: Node, tip: Node;
  const ctx = vm.createContext({
    Event: Ev, Option: class {}, envEditorBotId: 'self',
    escapeHtml: (s: string) => s, randomSecretHex: () => 'minted', envListRender: () => {}, updateEnvConditionals: () => {},
    attachFleetMasterUrlPreview: () => {},
    api: async () => ({ success: true, masters }),
    document: {
      getElementById: (id: string) => (id === (f.container as any).id ? f.container : null),
      createElement: () => {
        const b = new Node();
        locSel = new Node('SELECT', 'fleet-loc-select'); locSel.value = 'local';
        masterSel = new Node('SELECT', 'fleet-master-select'); masterSel.value = '0';
        tip = new Node('DIV', 'fleet-loc-tip');
        b.add(locSel, masterSel, tip);
        return b;
      },
    },
    ...extra,
  });
  vm.runInContext(NAMES.map(pageFunction).join('\n'), ctx);
  return { ctx, loc: () => locSel, tip: () => tip };
};
const change = (n: Node) => n.dispatchEvent(new Ev('change', { bubbles: true }));

describe('the Fleet Location block never overwrites an operator value', () => {
  it('a programmatic fill (vault pick, Load envs) makes the value operator-owned', () => {
    const f = form(); const p = page(f);
    f.urls.dataset.autofilled = '1';
    p.ctx.setEnvInputValue(f.urls, 'http://picked:1');
    expect(f.urls.dataset.autofilled).toBeUndefined();
  });

  it('a generated secret is not machine-owned by the same-server fill', () => {
    const f = form(); const p = page(f);
    const btn = { closest: () => ({ querySelector: () => f.secret }) };
    f.secret.dataset.autofilled = '1';
    p.ctx.generateEnvSecret(btn);
    expect(f.secret.dataset.autofilled).toBeUndefined();
  });

  it('typing into a visible list item clears the machine mark on the hidden value', () => {
    const f = form(); const p = page(f);
    p.ctx.attachFleetSecretRoleCache(f.container);
    f.urls.dataset.autofilled = '1';
    const item = new Node('INPUT'); f.urls.parent!.children[1].add(item);
    item.dispatchEvent(new Ev('input', { bubbles: true }, true));
    expect(f.urls.dataset.autofilled).toBeUndefined();
  });

  it('same-server mode keeps typed candidates and a typed secret', async () => {
    const f = form({ urls: 'http://mine:1', secret: 'typed' }); const p = page(f);
    // Initial mode is remote for a value that matches no master; the operator then picks this server.
    await p.ctx.attachFleetMasterPrefill('install-env-rows', [{ semantic: 'peer-role' }]);
    p.loc().value = 'local'; change(p.loc());
    expect(f.urls.value).toBe('http://mine:1');
    expect(f.secret.value).toBe('typed');
    expect(f.urlsWrapper.dataset.forceHide).toBe('');
  });

  it('a blank form fills from the master and hides the rows', async () => {
    const f = form(); const p = page(f);
    await p.ctx.attachFleetMasterPrefill('install-env-rows', [{ semantic: 'peer-role' }]);
    expect(f.urls.value).toBe('http://m1:1');
    expect(f.secret.value).toBe('fleet-secret');
    expect(f.urlsWrapper.dataset.forceHide).toBe('1');
  });

  it('an editor whose stored values match a local master keeps them and hides the rows', async () => {
    const f = form({ id: 'env-editor-rows', urls: 'http://m1:1', secret: 'fleet-secret' }); const p = page(f);
    await p.ctx.attachFleetMasterPrefill('env-editor-rows', [{ semantic: 'peer-role' }]);
    expect(p.loc().value).toBe('local');
    expect(f.urls.value).toBe('http://m1:1');
    expect(f.urlsWrapper.dataset.forceHide).toBe('1');
    expect(f.secretWrapper.dataset.forceHide).toBe('1');
  });

  it('in manual mode an unrelated change never wipes a value', async () => {
    const f = form(); const p = page(f);
    await p.ctx.attachFleetMasterPrefill('install-env-rows', [{ semantic: 'peer-role' }]);
    p.loc().value = 'remote'; change(p.loc());
    expect(f.urls.value).toBe('');
    f.urls.value = 'http://x:1'; f.urls.dataset.autofilled = '1';
    change(f.container);
    expect(f.urls.value).toBe('http://x:1');
  });

  it('Load envs re-derives the mode: loaded remote candidates switch to manual entry and stay', async () => {
    const f = form(); const p = page(f);
    await p.ctx.attachFleetMasterPrefill('install-env-rows', [{ semantic: 'peer-role' }]);
    p.ctx.setEnvInputValue(f.urls, 'http://remote:1');
    p.ctx.setEnvInputValue(f.secret, 'loaded');
    expect(typeof (f.container as any).fleetLocationResync).toBe('function');
    (f.container as any).fleetLocationResync();
    expect(p.loc().value).toBe('remote');
    expect(f.urls.value).toBe('http://remote:1');
    expect(f.secret.value).toBe('loaded');
    expect(pageFunction('loadPreviousEnvs')).toMatch(/fleetLocationResync\(\)/);
  });
});

describe('a co-worker with no Master Candidates is refused', () => {
  it('the check flags a worker role with blank candidates only', () => {
    const p = page(form());
    expect(typeof p.ctx.missingMasterCandidates).toBe('function');
    expect(p.ctx.missingMasterCandidates(form().container, false)).toBe(true);
    expect(p.ctx.missingMasterCandidates(form({ urls: 'http://a:1' }).container, false)).toBe(false);
    expect(p.ctx.missingMasterCandidates(form({ role: 'master' }).container, false)).toBe(false);
    const masked = form(); masked.urls.dataset.sensitive = 'true';
    expect(p.ctx.missingMasterCandidates(masked.container, true)).toBe(false);
  });

  it('doInstall refuses before creating anything', async () => {
    const f = form(); const calls: string[] = []; const msgs: string[] = [];
    const btn = { disabled: false, dataset: {}, textContent: '' };
    const p = page(f, [MASTER], {
      installSourceId: 's1', installSeq: 1, installBotId: null,
      api: async (m: string, u: string) => { calls.push(m + ' ' + u); return { success: true }; },
      showMessage: (_t: string, m: string) => msgs.push(m), guidedReadyToSave: async () => true,
      document: {
        getElementById: (id: string) => id === 'install-btn' ? btn : id === 'install-name' ? { value: 'w' }
          : id === 'install-env-rows' ? f.container : id === 'install-modal' ? { classList: { contains: () => false } } : null,
        querySelectorAll: (s: string) => s.startsWith('#install-env-rows') ? f.container.querySelectorAll('.env-row') : [],
      },
    });
    vm.runInContext(pageFunction('doInstall'), p.ctx);
    await p.ctx.doInstall();
    expect(calls).toEqual([]);
    expect(msgs.join(' ')).toMatch(/Master Candidate.*Nothing was created/);
  });

  it('saveEnvEditor refuses before saving anything', async () => {
    const f = form({ id: 'env-editor-rows' }); const calls: string[] = []; const msgs: string[] = [];
    const p = page(f, [MASTER], {
      envEditorBotId: 'b1', envEditorSeq: 1, envEditorStored: [], botLabel: () => 'b1',
      api: async (m: string, u: string) => { calls.push(m + ' ' + u); return { success: true }; },
      showMessage: (_t: string, m: string) => msgs.push(m),
      document: {
        getElementById: (id: string) => id === 'env-editor-rows' ? f.container : null,
        querySelectorAll: (s: string) => s.startsWith('#env-editor-rows') ? f.container.querySelectorAll('.env-row') : [],
        querySelector: () => ({ disabled: false, textContent: '' }),
      },
    });
    vm.runInContext(pageFunction('saveEnvEditor'), p.ctx);
    await p.ctx.saveEnvEditor();
    expect(calls).toEqual([]);
    expect(msgs.join(' ')).toMatch(/Master Candidate.*Nothing was saved/);
  });
});

describe('review fixes', () => {
  it('a removed Master Candidates row on a co-worker is refused', () => {
    const f = form(); const p = page(f);
    f.container.children.splice(f.container.children.indexOf(f.urlsWrapper), 1);
    expect(p.ctx.missingMasterCandidates(f.container, false)).toBe(true);
    expect(p.ctx.missingMasterCandidates(f.container, true)).toBe(true);
  });

  const loadPage = (f: ReturnType<typeof form>, envs: { key: string; value: string }[]) => {
    const p = page(f, [MASTER]);
    const base = (p.ctx as any).document;
    (p.ctx as any).installSourceId = 's1'; (p.ctx as any).installSeq = 1;
    (p.ctx as any).addInstallEnvRow = () => {};
    (p.ctx as any).api = async (_m: string, u: string) => u.startsWith('/recover-envs')
      ? { success: true, envs, sources: {} } : { success: true, masters: [MASTER] };
    (p.ctx as any).document = {
      ...base,
      getElementById: (id: string) => id === 'install-name' ? { value: 'w' } : id === 'install-env-rows' ? f.container : null,
    };
    vm.runInContext(pageFunction('loadPreviousEnvs'), p.ctx);
    return p;
  };

  it('Load envs of remote worker values survives the next change event', async () => {
    const f = form(); const p = loadPage(f, [
      { key: 'FLEET_ROLE', value: 'worker' }, { key: 'MASTER_URLS', value: 'http://remote:1' }, { key: 'FLEET_SECRET', value: 'loaded' }]);
    await p.ctx.attachFleetMasterPrefill('install-env-rows', [{ semantic: 'peer-role' }]);
    await p.ctx.loadPreviousEnvs();
    change(f.container);
    expect(f.urls.value).toBe('http://remote:1');
    expect(f.secret.value).toBe('loaded');
    expect(p.loc().value).toBe('remote');
  });

  it('Load envs into a master form drops the minted secret for the local master secret', async () => {
    const f = form({ role: 'master', secret: 'minted' }); f.secret.dataset.generated = '1';
    const p = loadPage(f, [{ key: 'FLEET_ROLE', value: 'worker' }, { key: 'MASTER_URLS', value: 'http://m1:1' }]);
    await p.ctx.attachFleetMasterPrefill('install-env-rows', [{ semantic: 'peer-role' }]);
    await p.ctx.loadPreviousEnvs();
    expect(p.loc().value).toBe('local');
    expect(f.secret.value).toBe('fleet-secret');
  });
});
