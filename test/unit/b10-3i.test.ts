import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'b10-3i-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir, broadcasts: [] as Array<{ type: string; data: any }> };
});

vi.mock('../../src/webui/server', () => ({ broadcastToClients: (_w: unknown, type: string, data: any) => { h.broadcasts.push({ type, data }); } }));

import * as containerManager from '../../src/docker/containerManager';
import { createBotRoutes } from '../../src/webui/routes/bots';

const recordFile = path.join(h.dir, 'active-ops.json');
const stored = (): any => JSON.parse(fs.readFileSync(recordFile, 'utf-8'));
const bot = (id: string) => ({
  id, sanitizedName: id, displayName: id, titleName: id, status: 'stopped',
  sourceType: 'docker-image', imageRef: 'img:1', envVars: {}, lastBuiltCommit: null,
  createdAt: '2026-10-25T00:00:00.000Z', updatedAt: '2026-10-25T00:00:00.000Z',
});

/** Runs fn while op holds b1's lock; returns the record file as it stood then. */
const recordDuring = async (op: string, botId = 'b1'): Promise<string> => {
  let during = '';
  await containerManager.withExternalBotOp(botId, op, async () => { during = fs.readFileSync(recordFile, 'utf-8'); });
  return during;
};
/** A manager restart that cut op on b1: the file as the op left it, then the boot read. */
const restartDuring = async (op: string): Promise<void> => {
  const during = await recordDuring(op);
  fs.writeFileSync(recordFile, during);
  containerManager.loadOpRecords();
};

const router = createBotRoutes({ clients: new Set() } as any);
const routeHandler = (routePath: string, method: string) => {
  const layer = (router as any).stack.find((l: any) => l.route?.path === routePath && l.route.methods[method]);
  return layer.route.stack[layer.route.stack.length - 1].handle;
};
const stream = (id: string): any[] => {
  const frames: any[] = [];
  const res: any = {
    writable: true, writeHead: () => res, end: () => {}, status: () => res, json: () => res,
    write: (chunk: string) => { if (chunk.startsWith('data: ')) frames.push(JSON.parse(chunk.slice(6))); return true; },
  };
  routeHandler('/:id/build-logs', 'get')({ params: { id }, query: {}, on: () => {} }, res);
  return frames;
};
const dismiss = async (id: string): Promise<{ status: number; body: any }> => {
  const res: any = { statusCode: 200 };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  await routeHandler('/:id/cut-op', 'delete')({ params: { id }, query: {}, body: {} }, res);
  return { status: res.statusCode, body: res.body };
};

beforeEach(() => {
  h.broadcasts.length = 0;
  fs.rmSync(recordFile, { force: true });
  fs.rmSync(`${recordFile}.tmp`, { recursive: true, force: true });
  fs.writeFileSync(path.join(h.dir, 'instances.json'), JSON.stringify({ instances: { b1: bot('b1'), b2: bot('b2') } }));
  containerManager.loadOpRecords();
});

afterAll(() => {
  fs.rmSync(h.dir, { recursive: true, force: true });
});

describe('B10-3i an operation is recorded while it runs', () => {
  it('the record names the bot, the op and its start time while the op holds the lock', async () => {
    const during = JSON.parse(await recordDuring('build'));
    expect(during.b1.op).toBe('build');
    expect(Number.isNaN(Date.parse(during.b1.startedAt))).toBe(false);
  });

  it('the record is removed when the op ends, whether it succeeds or throws', async () => {
    await recordDuring('build');
    expect(stored()).toEqual({});
    await expect(containerManager.withExternalBotOp('b1', 'build', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(stored()).toEqual({});
  });

  it('a record that cannot be written does not block the op, and says so with [Error]', async () => {
    fs.mkdirSync(`${recordFile}.tmp`);
    fs.writeFileSync(path.join(`${recordFile}.tmp`, 'x'), 'x');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    let ran = false;
    await containerManager.withExternalBotOp('b1', 'build', async () => { ran = true; });
    expect(ran).toBe(true);
    expect(errors.mock.calls.some(c => /^\[Error\] b1: the build was not recorded/.test(String(c[0])))).toBe(true);
    errors.mockRestore();
  });
});

describe('B10-3i a restart that cut an operation is reported, not called Idle', () => {
  it('boot reads the left record as the cut op', async () => {
    await restartDuring('build');
    const cut: any = containerManager.cutOpOf('b1');
    expect(cut.op).toBe('build');
    expect(typeof cut.startedAt).toBe('string');
    expect(containerManager.cutOpOf('b2')).toBeNull();
  });

  it('the build-logs idle frame carries the cut op', async () => {
    await restartDuring('update');
    const idle = stream('b1').at(-1);
    expect(idle.type).toBe('idle');
    expect(idle.cutOp.op).toBe('update');
    expect(stream('b2').at(-1).cutOp).toBeUndefined();
  });

  it('the bot record sent to the browser carries the cut op, and null without one', async () => {
    await restartDuring('restart');
    expect((containerManager.withoutRecordSecrets(containerManager.getBot('b1')) as any).cutOp.op).toBe('restart');
    expect((containerManager.withoutRecordSecrets(containerManager.getBot('b2')) as any).cutOp).toBeNull();
  });

  it('the note survives a second restart until it is cleared', async () => {
    await restartDuring('build');
    containerManager.loadOpRecords();
    expect((containerManager.cutOpOf('b1') as any).op).toBe('build');
  });

  it('a new op on the bot clears the note, in memory and in the file', async () => {
    await restartDuring('build');
    await recordDuring('stop');
    expect(containerManager.cutOpOf('b1')).toBeNull();
    expect(stored()).toEqual({});
    containerManager.loadOpRecords();
    expect(containerManager.cutOpOf('b1')).toBeNull();
  });

  it('an op on another bot keeps the note', async () => {
    await restartDuring('build');
    await recordDuring('stop', 'b2');
    expect((containerManager.cutOpOf('b1') as any).op).toBe('build');
    expect(stored().b1.op).toBe('build');
  });

  it('dismissing clears the note for good and tells the open tabs', async () => {
    await restartDuring('build');
    const r = await dismiss('b1');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ success: true, dismissed: true });
    expect(containerManager.cutOpOf('b1')).toBeNull();
    expect(h.broadcasts.some(b => b.type === 'bot:updated' && b.data.id === 'b1' && b.data.cutOp === null)).toBe(true);
    containerManager.loadOpRecords();
    expect(containerManager.cutOpOf('b1')).toBeNull();
  });

  it('a dismiss whose removal cannot be written fails and keeps the note', async () => {
    await restartDuring('build');
    fs.mkdirSync(`${recordFile}.tmp`);
    fs.writeFileSync(path.join(`${recordFile}.tmp`, 'x'), 'x');
    const r = await dismiss('b1');
    expect(r.status).toBe(500);
    expect(r.body.success).toBe(false);
    expect(r.body.error).toMatch(/not cleared/);
    expect((containerManager.cutOpOf('b1') as any).op).toBe('build');
  });
});

describe('B10-3i a record that cannot be read is reported as unknown', () => {
  it('an unreadable file makes every bot unknown, is never written over, and does not block ops', async () => {
    fs.writeFileSync(recordFile, '{ not json');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    containerManager.loadOpRecords();
    expect(containerManager.cutOpOf('b1')).toEqual({ unknown: true });
    expect(containerManager.cutOpOf('b2')).toEqual({ unknown: true });
    expect(stream('b2').at(-1).cutOp).toEqual({ unknown: true });
    let ran = false;
    await containerManager.withExternalBotOp('b1', 'build', async () => { ran = true; });
    expect(ran).toBe(true);
    expect(fs.readFileSync(recordFile, 'utf-8')).toBe('{ not json');
    expect(containerManager.cutOpOf('b1')).toBeNull();
    expect(containerManager.cutOpOf('b2')).toEqual({ unknown: true });
    errors.mockRestore();
  });

  it('dismissing an unknown note from an unreadable file says it comes back after a restart', async () => {
    fs.writeFileSync(recordFile, '[]');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    containerManager.loadOpRecords();
    const r = await dismiss('b2');
    expect(r.body.success).toBe(true);
    expect(r.body.warning).toMatch(/comes back after the next manager restart/);
    expect(containerManager.cutOpOf('b2')).toBeNull();
    errors.mockRestore();
  });

  it('a malformed entry is unknown for its bot and is kept when another bot writes the file', async () => {
    fs.writeFileSync(recordFile, JSON.stringify({ b1: { op: 7 } }));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    containerManager.loadOpRecords();
    expect(containerManager.cutOpOf('b1')).toEqual({ unknown: true });
    expect(containerManager.cutOpOf('b2')).toBeNull();
    await recordDuring('stop', 'b2');
    expect(stored()).toEqual({ b1: { op: 7 } });
    containerManager.loadOpRecords();
    expect(containerManager.cutOpOf('b1')).toEqual({ unknown: true });
    errors.mockRestore();
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
  const footerKids: any[] = [{ textContent: 'status' }, { textContent: 'Close' }];
  const footer: any = {
    querySelector: (sel: string) => footerKids.find(k => sel === '.terminal-dismiss-cut' && /terminal-dismiss-cut/.test(k.className || '')) || null,
    insertBefore: (n: any, ref: any) => footerKids.splice(footerKids.indexOf(ref), 0, n),
    get lastElementChild() { return footerKids[footerKids.length - 1]; },
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
      querySelector: (sel: string) => (sel === '#terminal-popup .terminal-footer' ? footer : null),
      createElement: () => ({ setAttribute() {} }),
      body: { appendChild() {} },
    },
    escapeHtml: (t: string) => t, closeTerminalPopup: () => {}, updateTerminalSilence: () => {},
    setTerminalStatus: (t: string) => status.push(t), resetTerminalSilence: () => {},
    terminalEventSource: null, terminalTickTimer: null, terminalBotId: null, terminalOp: null,
    terminalFinished: false, terminalBootId: null, terminalPendingClear: false,
  });
  vm.runInContext(['openTerminalPopup', 'streamBuildLogs', 'appendWithHousekeeping', 'renderProgressLine',
    'addTerminalLog', 'markTerminalComplete', 'cutOpText', 'showTerminalCutOp'].map(pageFunction).join('\n'), ctx);
  const lines = (): string[] => children.map((c) => c.textContent);
  const connect = (frames: any[]) => {
    vm.runInContext('streamBuildLogs("b1")', ctx);
    const es = sources.at(-1);
    es.onopen();
    for (const f of frames) es.onmessage({ data: JSON.stringify(f) });
  };
  return { lines, status, connect, footerKids };
};

describe('B10-3i the build-logs popup after a restart that cut an op', () => {
  it('names the cut op and its unknown outcome instead of Idle, and offers a dismiss', () => {
    const p = page();
    p.connect([{ type: 'idle', status: 'stopped', cutOp: { op: 'build', startedAt: '2026-10-25T10:00:00.000Z' }, bootId: 'x' }]);
    expect(p.status.at(-1)).toBe('build cut by a restart - bot is stopped');
    expect(p.status.some(s => /^Idle/.test(s))).toBe(false);
    expect(p.lines().some(l => /A build started .* was running when the manager restarted, so its outcome can't be confirmed/.test(l))).toBe(true);
    expect(p.footerKids.some(k => k.textContent === 'Dismiss note')).toBe(true);
  });

  it('an unknown record says the last operation is unknown', () => {
    const p = page();
    p.connect([{ type: 'idle', status: 'unknown', cutOp: { unknown: true }, bootId: 'x' }]);
    expect(p.status.at(-1)).toBe('Last operation unknown');
    expect(p.lines().some(l => /can't be confirmed/.test(l))).toBe(true);
  });

  it('an idle frame with no cut op still says Idle', () => {
    const p = page();
    p.connect([{ type: 'idle', status: 'stopped', bootId: 'x' }]);
    expect(p.status.at(-1)).toBe('Idle - bot is stopped');
    expect(p.footerKids.length).toBe(2);
  });
});
