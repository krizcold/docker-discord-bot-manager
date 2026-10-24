import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { describe, expect, it, vi } from 'vitest';

const cm = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'b10-3-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  nodeFs.writeFileSync(nodePath.join(dir, 'instances.json'), JSON.stringify({ instances: {
    'b10-3-op': { id: 'b10-3-op', name: 'b10-3-op', sanitizedName: 'b10-3-op', status: 'stopped', recoveryRescue: true },
  } }));
  return { status: 'running' };
});

vi.mock('../../src/docker/containerManager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/docker/containerManager')>()),
  getBot: (id: string) => ({ id, sourceType: 'git', status: cm.status }) as any,
}));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import { createBotRoutes } from '../../src/webui/routes/bots';
import { logCollectors } from '../../src/build/logCollector';
import { startBot } from '../../src/docker/containerManager';

const router = createBotRoutes({ clients: new Set() } as any);
const stream = (id: string): any[] => {
  const layer = (router as any).stack.find((l: any) => l.route?.path === '/:id/build-logs' && l.route.methods.get);
  const frames: any[] = [];
  const res: any = {
    writable: true,
    writeHead: () => res,
    write: (chunk: string) => { if (chunk.startsWith('data: ')) frames.push(JSON.parse(chunk.slice(6))); return true; },
    end: () => {},
    status: () => res,
    json: () => res,
  };
  layer.route.stack[layer.route.stack.length - 1].handle({ params: { id }, query: {}, on: () => {} }, res);
  return frames;
};

describe('B10-3 build-log frames', () => {
  it('a replayed terminal frame carries the status at op end, not the current one', () => {
    const c = logCollectors.get('b10-3-a');
    c.beginOp('stop');
    c.endOp('done', undefined, 'stopped');
    const endedAt = c.opEndedAt;
    cm.status = 'running';
    const last = stream('b10-3-a').at(-1);
    expect(last.type).toBe('done');
    expect(last.finalStatus).toBe('stopped');
    expect(last.currentStatus).toBe('running');
    expect(last.timestamp).toBe(endedAt);
  });

  it('a failed op with no recorded end status says unknown rather than the current status', () => {
    const c = logCollectors.get('b10-3-b');
    c.beginOp('build');
    c.endOp('failed', 'boom');
    cm.status = 'running';
    const last = stream('b10-3-b').at(-1);
    expect(last.type).toBe('failed');
    expect(last.finalStatus).toBe('unknown');
    expect(last.error).toBe('boom');
  });

  it('every frame carries the same boot id', () => {
    const c = logCollectors.get('b10-3-c');
    c.beginOp('build');
    c.addLog('line one');
    c.endOp('done', undefined, 'stopped');
    const frames = stream('b10-3-c');
    expect(frames.length).toBe(2);
    expect(typeof frames[0].bootId).toBe('string');
    expect(frames.every((f) => f.bootId === frames[0].bootId)).toBe(true);
    const idle = stream('b10-3-none');
    expect(idle[0].type).toBe('idle');
    expect(idle[0].bootId).toBe(frames[0].bootId);
  });

  it('a real op stores the status the bot had when it ended', async () => {
    const result = await startBot('b10-3-op');
    expect(result.success).toBe(false);
    cm.status = 'running';
    const last = stream('b10-3-op').at(-1);
    expect(last.type).toBe('failed');
    expect(last.finalStatus).toBe('stopped');
    expect(last.currentStatus).toBe('running');
  });
});

const pageHtml = fs.readFileSync(path.resolve(__dirname, '../../src/webui/public/index.html'), 'utf8');
const pageFunction = (name: string): string => {
  const start = pageHtml.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`no function ${name}`);
  let i = pageHtml.indexOf('{', pageHtml.indexOf(')', start));
  for (let depth = 0; ; i++) {
    if (pageHtml[i] === '{') depth++;
    else if (pageHtml[i] === '}' && --depth === 0) return pageHtml.slice(start, i + 1);
  }
};

const page = () => {
  const children: any[] = [];
  const body: any = {
    children, scrollTop: 0, clientHeight: 0, scrollHeight: 0,
    appendChild: (l: any) => children.push(l),
    removeChild: () => children.shift(),
    get firstChild() { return children[0]; },
    set innerHTML(_v: string) { children.length = 0; },
  };
  const sources: any[] = [];
  class FakeEventSource {
    static CLOSED = 2;
    readyState = 1;
    onopen: any; onmessage: any; onerror: any;
    constructor(public url: string) { sources.push(this); }
    close() { this.readyState = 2; }
  }
  const status: string[] = [];
  const ctx = vm.createContext({
    EventSource: FakeEventSource, setInterval: () => 1, clearInterval: () => {},
    document: {
      getElementById: (id: string) => (id === 'terminal-body' ? body : null),
      createElement: () => ({ setAttribute() {} }),
      body: { appendChild() {} },
    },
    escapeHtml: (t: string) => t, closeTerminalPopup: () => {}, updateTerminalSilence: () => {},
    setTerminalStatus: (t: string) => status.push(t), resetTerminalSilence: () => {},
    terminalEventSource: null, terminalTickTimer: null, terminalBotId: null, terminalOp: null,
    terminalFinished: false, terminalBootId: null, terminalPendingClear: false,
  });
  vm.runInContext(['openTerminalPopup', 'streamBuildLogs', 'appendWithHousekeeping', 'renderProgressLine',
    'addTerminalLog', 'markTerminalComplete'].map(pageFunction).join('\n'), ctx);
  const lines = (): string[] => children.map((c) => c.textContent);
  const connect = (frames: any[]) => {
    const es = sources.at(-1);
    es.onopen();
    for (const f of frames) es.onmessage({ data: JSON.stringify(f) });
  };
  return { ctx, lines, status, connect };
};
const restartLine = (l: string) => /manager restarted/.test(l);

describe('B10-3 build-log popup across a manager restart', () => {
  it('keeps the log and marks the op failed when the boot id changes mid-op', () => {
    const p = page();
    p.ctx.openTerminalPopup('b1', 'Bot', 'Build');
    p.ctx.streamBuildLogs('b1');
    p.connect([{ type: 'status', op: 'build', bootId: 'A' }, { type: 'info', message: 'step 1', bootId: 'A' }]);
    p.connect([{ type: 'idle', status: 'stopped', bootId: 'B' }]);
    expect(p.lines()).toContain('step 1');
    expect(p.lines()).toContain('[the manager restarted while build was running; it did not finish]');
    expect(p.status.at(-1)).toBe('Failed');
  });

  it('clears and replays on a reconnect with the same boot id', () => {
    const p = page();
    p.ctx.openTerminalPopup('b1', 'Bot', 'Build');
    p.ctx.streamBuildLogs('b1');
    p.connect([{ type: 'status', op: 'build', bootId: 'A' }, { type: 'info', message: 'step 1', bootId: 'A' }]);
    p.connect([{ type: 'status', op: 'build', bootId: 'A' }, { type: 'info', message: 'step 1', bootId: 'A' }]);
    expect(p.lines().filter((l) => l === 'step 1').length).toBe(1);
    expect(p.lines().some(restartLine)).toBe(false);
  });

  it('a fresh popup ignores the boot id of an earlier popup', () => {
    const p = page();
    p.ctx.openTerminalPopup('b1', 'Bot', 'Build');
    p.ctx.streamBuildLogs('b1');
    p.connect([{ type: 'status', op: 'build', bootId: 'A' }]);
    p.ctx.openTerminalPopup('b1', 'Bot', 'Build');
    expect(p.ctx.terminalBootId).toBe(null);
    p.ctx.streamBuildLogs('b1');
    p.connect([{ type: 'status', op: 'build', bootId: 'B' }, { type: 'info', message: 'step 1', bootId: 'B' }]);
    expect(p.lines().some(restartLine)).toBe(false);
    expect(p.lines()).toContain('step 1');
  });
});
