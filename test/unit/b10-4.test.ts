import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  calls: [] as string[][],
  labelFails: false,
  bot: { id: 'b1', sanitizedName: 'app' } as any,
  containers: [{ name: 'app-bot-1', state: 'running', status: 'Up' }] as any[] | null,
  piped: [] as string[],
}));

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const execFile = (_cmd: string, args: any, opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    h.calls.push(args);
    if (h.labelFails && String(args.join(' ')).includes('label=')) done(Object.assign(new Error('docker: not answering'), { stderr: 'x' }), '', '');
    else done(null, { stdout: 'other-app-bot-1\trunning\tUp\n', stderr: '' });
  };
  return { ...real, execFile, default: { ...real, execFile } };
});
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

beforeEach(() => {
  h.calls.length = 0;
  h.labelFails = false;
  h.bot = { id: 'b1', sanitizedName: 'app' };
  h.containers = [{ name: 'app-bot-1', state: 'running', status: 'Up' }];
  h.piped.length = 0;
});

describe('B10-4 listProjectContainers lists by project label only', () => {
  it('answers null and runs no name query when the label query fails', async () => {
    h.labelFails = true;
    const dc = await import('../../src/docker/dockerClient');
    expect(await dc.listProjectContainers('app')).toBeNull();
    expect(h.calls.some((a) => a.some((x) => String(x).startsWith('name=')))).toBe(false);
  });
});

describe('B10-4 the log stream refuses a container the bot does not own', () => {
  const load = async () => {
    vi.resetModules();
    vi.doMock('../../src/docker/containerManager', async (orig) => ({
      ...(await orig<any>()),
      getBot: () => h.bot,
    }));
    vi.doMock('../../src/docker/dockerClient', async (orig) => ({
      ...(await orig<any>()),
      listProjectContainers: async () => h.containers,
    }));
    vi.doMock('../../src/webui/logStream', () => ({ pipeContainerLogs: (_q: any, _r: any, name: string) => { h.piped.push(name); } }));
    const { createBotRoutes } = await import('../../src/webui/routes/bots');
    return createBotRoutes({ clients: new Set() } as any);
  };
  const call = async (router: any, container: string) => {
    const layer = router.stack.find((l: any) => l.route?.path === '/:id/containers/:container/logs/stream');
    const out: any = { status: 200, body: undefined, headers: {} as any, written: '' };
    const res: any = {
      status(c: number) { out.status = c; return res; },
      json(b: any) { out.body = b; return res; },
      setHeader(k: string, v: string) { out.headers[k] = v; },
      write(c: string) { out.written += c; return true; },
    };
    await layer.route.stack[layer.route.stack.length - 1].handle({ params: { id: 'b1', container }, query: {} }, res);
    return out;
  };

  it('streams a container of the bot', async () => {
    const r = await call(await load(), 'app-bot-1');
    expect(h.piped).toEqual(['app-bot-1']);
    expect(r.written).toMatch(/connected/);
  });

  it('refuses another project container with 403 and streams nothing', async () => {
    const r = await call(await load(), 'other-bot-1');
    expect(r.status).toBe(403);
    expect(r.body.success).toBe(false);
    expect(h.piped).toEqual([]);
  });

  it('answers 503 when docker does not answer', async () => {
    h.containers = null;
    const r = await call(await load(), 'app-bot-1');
    expect(r.status).toBe(503);
    expect(h.piped).toEqual([]);
  });

  it('answers 404 for an unknown bot', async () => {
    h.bot = null;
    const r = await call(await load(), 'app-bot-1');
    expect(r.status).toBe(404);
    expect(h.piped).toEqual([]);
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

const fakeDom = () => {
  const els: Record<string, any> = {};
  return {
    els,
    getElementById: (id: string) => els[id] ||= {
      id, innerHTML: '', textContent: '', value: '',
      classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    },
  };
};

// api answers are released by the test, so two opens can be interleaved.
const deferredApi = () => {
  const pending: Array<{ endpoint: string; resolve: (v: any) => void; reject: (e: any) => void }> = [];
  const api = (_m: string, endpoint: string) => new Promise((resolve, reject) => pending.push({ endpoint, resolve, reject }));
  return { api, pending };
};
const tick = () => new Promise((r) => setTimeout(r, 0));
const answer = (names: string[]) => ({ success: true, containers: names.map((n) => ({ name: n, state: 'running', status: 'Up' })) });

const makeCtx = (fns: string[], extra: any) => {
  const dom = fakeDom();
  const { api, pending } = deferredApi();
  const ctx: any = vm.createContext({
    document: dom, api, escapeHtml: (s: any) => String(s), jsArg: (s: any) => JSON.stringify(s),
    showMessage: () => {}, wsSend: () => {}, window: { Terminal: function () {} },
    logsOpenSeq: 0, consoleOpenSeq: 0, filesShowSeq: 0, ...extra,
  });
  for (const f of fns) vm.runInContext(pageFunction(f), ctx);
  return { ctx, dom, pending };
};

describe('B10-4 the Logs popup shows only the bot it is open for', () => {
  const logsExtra = () => ({
    logsState: { botId: null, botName: '', selectedContainer: null, containers: [], eventSource: null, logHistory: {}, autoScroll: true },
    EventSource: class { addEventListener() {} close() {} },
  });

  it('a late answer for the previous bot does not replace the current bot list', async () => {
    const { ctx, dom, pending } = makeCtx(['showLogs', 'renderServiceSidebar', 'selectContainer'], logsExtra());
    const a = ctx.showLogs('A', 'Bot A');
    const b = ctx.showLogs('B', 'Bot B');
    pending[1].resolve(answer(['b-bot-1']));
    await b;
    pending[0].resolve(answer(['a-bot-1']));
    await a;
    expect(ctx.logsState.botId).toBe('B');
    expect(ctx.logsState.containers.map((c: any) => c.name)).toEqual(['b-bot-1']);
    expect(dom.els['slp-service-list'].innerHTML).not.toMatch(/a-bot-1/);
  });

  it('a failed request clears the previous bot containers', async () => {
    const { ctx, dom, pending } = makeCtx(['showLogs', 'renderServiceSidebar', 'selectContainer'], logsExtra());
    const a = ctx.showLogs('A', 'Bot A');
    pending[0].resolve(answer(['a-bot-1']));
    await a;
    const b = ctx.showLogs('B', 'Bot B');
    pending[1].reject(new Error('offline'));
    await b;
    expect(ctx.logsState.containers).toEqual([]);
    expect(dom.els['slp-service-list'].innerHTML).not.toMatch(/a-bot-1/);
    expect(dom.els['slp-service-title'].textContent).not.toMatch(/a-bot-1/);
  });

  it('an answer arriving after the popup closed opens no stream', async () => {
    let streams = 0;
    const extra = { ...logsExtra(), EventSource: class { constructor() { streams++; } addEventListener() {} close() {} } };
    const { ctx, pending } = makeCtx(['showLogs', 'renderServiceSidebar', 'selectContainer', 'closeLogsPopup'], extra);
    const a = ctx.showLogs('A', 'Bot A');
    ctx.closeLogsPopup();
    pending[0].resolve(answer(['a-bot-1']));
    await a;
    expect(streams).toBe(0);
  });
});

describe('B10-4 the Console shows only the bot it is open for', () => {
  it('a failed request clears the previous bot containers', async () => {
    const { ctx, dom, pending } = makeCtx(['showConsole'], { consoleBotId: null, consoleTerm: null, consoleFit: null, connectConsole: () => {} });
    dom.getElementById('console-container').innerHTML = '<option value="a-bot-1">a-bot-1</option>';
    const b = ctx.showConsole('B', 'Bot B');
    pending[0].reject(new Error('offline'));
    await b;
    expect(dom.els['console-container'].innerHTML).not.toMatch(/a-bot-1/);
  });

  it('a late answer for the previous bot does not replace the current list', async () => {
    let connects = 0;
    const { ctx, dom, pending } = makeCtx(['showConsole'], {
      consoleBotId: null, consoleTerm: null, consoleFit: null, connectConsole: () => { connects++; },
      Terminal: class { loadAddon() {} open() {} onData() {} onResize() {} dispose() {} },
      FitAddon: { FitAddon: class { fit() {} } }, setTimeout: () => 0,
    });
    const a = ctx.showConsole('A', 'Bot A');
    const b = ctx.showConsole('B', 'Bot B');
    pending[1].resolve(answer(['b-bot-1']));
    await b;
    pending[0].resolve(answer(['a-bot-1']));
    await a;
    expect(dom.els['console-container'].innerHTML).toMatch(/b-bot-1/);
    expect(dom.els['console-container'].innerHTML).not.toMatch(/a-bot-1/);
    expect(connects).toBe(1);
  });
});

describe('B10-4 the Files modal shows only the bot it is open for', () => {
  const filesExtra = () => ({
    filesBotId: null, filesScope: 'host', filesCwd: '', filesBase: '/', filesListing: null, filesEntries: [],
    filesEditorIdle: () => {}, filesList: async () => {},
  });

  it('a failed request leaves only the host scope', async () => {
    const { ctx, dom, pending } = makeCtx(['showFiles', 'filesCall'], filesExtra());
    dom.getElementById('files-scope').innerHTML = '<option value="a-bot-1">Container: a-bot-1</option>';
    const b = ctx.showFiles('B', 'Bot B');
    await tick();
    pending[0].reject(new Error('offline'));
    await b;
    expect(dom.els['files-scope'].innerHTML).not.toMatch(/a-bot-1/);
    expect(dom.els['files-scope'].innerHTML).toMatch(/host/);
  });

  it('a late answer for the previous bot does not replace the current scopes', async () => {
    const { ctx, dom, pending } = makeCtx(['showFiles', 'filesCall'], filesExtra());
    const a = ctx.showFiles('A', 'Bot A');
    const b = ctx.showFiles('B', 'Bot B');
    await tick();
    pending[1].resolve(answer(['b-bot-1']));
    await b;
    pending[0].resolve(answer(['a-bot-1']));
    await a;
    expect(dom.els['files-scope'].innerHTML).toMatch(/b-bot-1/);
    expect(dom.els['files-scope'].innerHTML).not.toMatch(/a-bot-1/);
  });
});

describe('B10-4 Files and Console say docker did not answer when the container list fails', () => {
  const NO_ANSWER = 'Docker did not answer, so the containers of this bot could not be listed';
  const load = async (psScript: string) => {
    vi.resetModules();
    vi.doMock('child_process', async (orig) => {
      const real = await orig<typeof import('child_process')>();
      const spawn = (_cmd: string, _args: string[], opts: any) => real.spawn('sh', ['-c', psScript], opts);
      return { ...real, spawn, default: { ...real, spawn } };
    });
    vi.doMock('../../src/docker/containerManager', async (orig) => ({ ...(await orig<any>()), getBot: () => h.bot }));
    return import('../../src/webui/terminal');
  };
  const consoleError = async (t: any): Promise<string> => {
    const sent: string[] = [];
    const ws: any = { readyState: 1, send: (s: string) => sent.push(s) };
    t.handleTerminalMessage(ws, JSON.stringify({ type: 'terminal:start', botId: 'b1', container: 'app-bot-1' }));
    for (let i = 0; i < 100 && sent.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    return JSON.parse(sent[0]).message;
  };

  it('Files answers the could-not-list text when docker exits 1', async () => {
    const t = await load('echo boom >&2; exit 1');
    expect(await t.fsList('b1', 'app-bot-1', '/')).toEqual({ success: false, error: NO_ANSWER });
  });
  it('Console answers the could-not-list text when docker exits 1', async () => {
    const t = await load('echo boom >&2; exit 1');
    expect(await consoleError(t)).toBe(NO_ANSWER);
  });
  it('a real miss still says the container does not belong to this bot', async () => {
    const t = await load("printf 'other-1\trunning\n'");
    expect(await t.fsList('b1', 'app-bot-1', '/')).toEqual({ success: false, error: 'Container does not belong to this bot' });
    expect(await consoleError(t)).toBe('Container does not belong to this bot');
  });
});
