import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

type Mode = 'throw' | 'nostdio' | 'list' | 'tty';

const h = vi.hoisted(() => ({ mode: 'throw' as Mode, queue: [] as Mode[] }));

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const next = (): Mode => h.queue.shift() ?? h.mode;
  const spawn = () => {
    const mode = next();
    if (mode === 'throw') throw Object.assign(new Error('spawn ENOMEM'), { code: 'ENOMEM' });
    const child: any = new EventEmitter();
    child.kill = () => true;
    if (mode === 'tty') {
      child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      setImmediate(() => child.stderr.write('the input device is not a TTY'));
      return child;
    }
    if (mode === 'list') {
      child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      setImmediate(() => { child.stdout.write('app-bot-1\trunning\n'); child.stdout.end(); child.emit('close', 0); });
      return child;
    }
    child.stdin = null; child.stdout = null; child.stderr = null;
    process.nextTick(() => child.emit('error', Object.assign(new Error('spawn EMFILE'), { code: 'EMFILE' })));
    return child;
  };
  const execFile = (...a: any[]) => {
    if (next() === 'throw') throw Object.assign(new Error('spawn ENOMEM'), { code: 'ENOMEM' });
    const cb = a[a.length - 1];
    process.nextTick(() => cb(Object.assign(new Error('spawn EMFILE'), { code: 'EMFILE' }), '', ''));
    return new EventEmitter();
  };
  const refuse = () => { throw Object.assign(new Error('spawnSync ENOMEM'), { code: 'ENOMEM' }); };
  const fake = { spawn, execFile, execFileSync: refuse, execSync: refuse, spawnSync: refuse };
  return { ...real, ...fake, default: { ...real, ...fake } };
});
vi.mock('../../src/docker/containerManager', async (orig) => ({
  ...(await orig<any>()),
  getBot: () => ({ id: 'b1', sanitizedName: 'app' }),
}));

const faults: unknown[] = [];
const onFault = (e: unknown) => { faults.push(e); };
beforeEach(() => {
  h.mode = 'throw';
  h.queue.length = 0;
  faults.length = 0;
  process.on('uncaughtException', onFault);
  process.on('unhandledRejection', onFault);
});
afterEach(() => {
  process.off('uncaughtException', onFault);
  process.off('unhandledRejection', onFault);
});

const settle = () => new Promise(r => setTimeout(r, 20));
const settleOf = async <T>(p: () => Promise<T>): Promise<{ value?: T; error?: any }> => {
  try { return { value: await p() }; } catch (error) { return { error }; }
};

const modes: Mode[] = ['throw', 'nostdio'];

describe.each(modes)('NM19 spawn sites, %s', (mode) => {
  beforeEach(() => { h.mode = mode; });
  const reason = mode === 'throw' ? 'spawn ENOMEM' : 'spawn EMFILE';

  it('deployApp answers its start failure', async () => {
    const { deployApp } = await import('../../src/casaos/api');
    const r = await settleOf(() => deployApp('app', '/x/compose.yml', undefined, 60_000));
    await settle();
    expect(r.value).toEqual({ success: false, error: `Failed to start deploy: ${reason}` });
    expect(faults).toEqual([]);
  });

  it('composeDown answers its start failure', async () => {
    const { composeDown } = await import('../../src/casaos/api');
    const r = await settleOf(() => composeDown('app', '/x/compose.yml', undefined, 60_000));
    await settle();
    expect(r.value).toEqual({ success: false, error: `Failed to start compose down: ${reason}` });
    expect(faults).toEqual([]);
  });

  for (const name of ['buildImage', 'pullImage', 'composeUp'] as const) {
    it(`${name} rejects with the reason`, async () => {
      const dc = await import('../../src/docker/dockerClient');
      const run = name === 'buildImage' ? () => dc.buildImage('/ctx', 'img') : name === 'pullImage' ? () => dc.pullImage('img') : () => dc.composeUp('/x/compose.yml', 'app');
      const r = await settleOf(run);
      await settle();
      expect(r.error?.message).toBe(reason);
      expect(faults).toEqual([]);
    });
  }

  it('probeDatabaseUrl answers that docker could not run', async () => {
    const { probeDatabaseUrl } = await import('../../src/webui/dbProbe');
    const r = await settleOf(() => probeDatabaseUrl('postgresql://u:p@h:5432/d', null));
    await settle();
    expect(r.value).toEqual({ ok: false, error: `Failed to run docker: ${reason}`, notTested: true });
    expect(faults).toEqual([]);
  });

  it('pipeContainerLogs sends the end event and ends the response', async () => {
    const { pipeContainerLogs } = await import('../../src/webui/logStream');
    const req: any = new EventEmitter();
    let written = '';
    let ended = false;
    const res: any = Object.assign(new EventEmitter(), {
      writable: true,
      write(c: string) { written += c; return true; },
      end() { ended = true; res.writable = false; },
    });
    let threw: unknown = null;
    try { pipeContainerLogs(req, res, 'app-bot-1', 10, false); } catch (e) { threw = e; }
    await settle();
    req.emit('close');
    expect(threw).toBeNull();
    expect(written).toContain(`event: end\ndata: ${JSON.stringify({ code: null, error: reason })}`);
    expect(ended).toBe(true);
    expect(faults).toEqual([]);
  });

  it('spawnCapture answers code 1 with the failure', async () => {
    const { spawnCapture } = await import('../../src/webui/terminal');
    const r = await settleOf(() => spawnCapture('docker', ['ps']));
    await settle();
    expect(r.value?.code).toBe(1);
    expect(r.value?.stderr).toBe(mode === 'throw' ? reason : 'spawn failed');
    expect(faults).toEqual([]);
  });

  it('the terminal sends its error and no ready', async () => {
    h.queue.push('list');
    const { WebSocket } = await import('ws');
    const { handleTerminalMessage } = await import('../../src/webui/terminal');
    const sent: any[] = [];
    const ws: any = { readyState: WebSocket.OPEN, send: (m: string) => sent.push(JSON.parse(m)) };
    handleTerminalMessage(ws, JSON.stringify({ type: 'terminal:start', botId: 'b1', container: 'app-bot-1' }));
    await settle();
    expect(sent.map(m => m.type)).toEqual(mode === 'throw' ? ['terminal:error'] : ['terminal:ready', 'terminal:error']);
    expect(sent.find(m => m.type === 'terminal:error').message).toBe(reason);
    if (mode === 'throw') expect(ws.__term).toBeUndefined();
    expect(faults).toEqual([]);
  });
});

describe('NM19 terminal no-TTY retry', () => {
  it('a retry that cannot start leaves no session behind', async () => {
    h.queue.push('list', 'tty', 'throw');
    const { WebSocket } = await import('ws');
    const { handleTerminalMessage } = await import('../../src/webui/terminal');
    const sent: any[] = [];
    const ws: any = { readyState: WebSocket.OPEN, send: (m: string) => sent.push(JSON.parse(m)) };
    handleTerminalMessage(ws, JSON.stringify({ type: 'terminal:start', botId: 'b1', container: 'app-bot-1' }));
    await settle();
    expect(sent.map(m => m.type)).toEqual(['terminal:ready', 'terminal:error']);
    expect(ws.__term).toBeUndefined();
    expect(faults).toEqual([]);
  });
});

describe('NM19 execFile sites, throw', () => {
  it('sidecarRunning answers null', async () => {
    const { sidecarRunning } = await import('../../src/instance/dbLogin');
    const r = await settleOf(() => sidecarRunning('db'));
    await settle();
    expect(r).toEqual({ value: null });
    expect(faults).toEqual([]);
  });

  it('sidecarState answers null', async () => {
    const { sidecarState } = await import('../../src/instance/dbLogin');
    const r = await settleOf(() => sidecarState('db'));
    await settle();
    expect(r).toEqual({ value: null });
    expect(faults).toEqual([]);
  });

  it('ensureManagerDbRole answers the psql failure', async () => {
    const { ensureManagerDbRole } = await import('../../src/instance/dbLogin');
    const r = await settleOf(() => ensureManagerDbRole({ container: 'db', user: 'botuser' }));
    await settle();
    expect(r.value).toMatchObject({ ok: false, error: 'docker could not start (spawn ENOMEM)' });
    expect(faults).toEqual([]);
  });
});
