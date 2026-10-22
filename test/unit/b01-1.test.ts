import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ dataPath: '', calls: [] as string[][], binDir: '', marked: false, beforeLink: null as null | (() => void) }));

vi.mock('../../src/docker/containerManager', () => ({
  getBot: (id: string) => (id === 'b1' ? { id: 'b1', sanitizedName: 'bot1' } : undefined),
}));
// A hook into the moment a new file is linked into place.
vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>();
  const linkSync = (a: fs.PathLike, b: fs.PathLike) => { h.beforeLink?.(); return real.linkSync(a, b); };
  return { ...real, default: { ...real, linkSync }, linkSync };
});
vi.mock('../../src/git/repoManager', () => ({ getDataPath: () => h.dataPath }));
vi.mock('../../src/casaos/detector', () => ({ getDeploymentMode: async () => 'docker' }));
vi.mock('../../src/templates/pcsProcessing', () => ({ grantFd: () => {}, grantToApp: () => {} }));

// A fake docker CLI: `ps` names two containers, and `exec` runs the argv on this
// machine. Like docker, an exec without -i gives the process no stdin at all,
// whatever the caller writes. With h.binDir set, the commands found there come
// first on PATH (a fake timeout or mv). The container `slow` never answers in
// time and has no bounded timeout; `slowb` never answers but reports one.
vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const { Writable } = await import('stream');
  const spawn = (cmd: string, args: string[], opts: any) => {
    h.calls.push(args);
    if (cmd !== 'docker') throw new Error(`unexpected spawn ${cmd}`);
    if (args[0] === 'ps') return real.spawn('sh', ['-c', "printf 'c1\\trunning\\nslow\\trunning\\nslowb\\trunning\\n'"], opts);
    if (args[0] !== 'exec') throw new Error(`unexpected docker ${args[0]}`);
    let i = 1;
    let interactive = false;
    while (args[i].startsWith('-')) { if (args[i] === '-i') interactive = true; i++; }
    const argv = args.slice(i + 1);
    const env = h.binDir ? { ...process.env, PATH: h.binDir + path.delimiter + process.env.PATH } : process.env;
    const child: any = args[i] === 'slow' ? real.spawn('sh', ['-c', 'sleep 3'], opts)
      : args[i] === 'slowb' ? real.spawn('sh', ['-c', 'echo SMDB_BOUNDED=1; sleep 3'], opts)
      : real.spawn(argv[0], argv.slice(1), { ...opts, env });
    if (args[i] === 'slowb') child.stdout.once('data', () => { h.marked = true; });
    if (!interactive) {
      child.stdin.end();
      child.stdin = new Writable({ write(_c, _e, cb) { cb(); } });
    }
    return child;
  };
  return { ...real, spawn };
});

import * as terminal from '../../src/webui/terminal';

let mod: typeof import('../../src/webui/fsWriteBody');
beforeAll(async () => { mod = await import('../../src/webui/fsWriteBody').catch(() => null as any); });

// Captured before any test fakes setTimeout: waits that must pass real time.
const realSetTimeout = globalThis.setTimeout;
const realSleep = (ms: number) => new Promise<void>((r) => { realSetTimeout(r, ms); });

// The container scope takes paths as the container's sh sees them.
const shPath = (p: string): string =>
  process.platform === 'win32' ? `/${p[0].toLowerCase()}${p.slice(2).replace(/\\/g, '/')}` : p;

let tmp: string;
let data: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'b01-1-'));
  data = path.join(tmp, 'data');
  fs.mkdirSync(data);
  h.dataPath = data;
  h.calls.length = 0;
  h.binDir = '';
  h.marked = false;
  h.beforeLink = null;
});

// A fake command in h.binDir, as an sh script.
const fakeBin = (name: string, script: string): void => {
  if (!h.binDir) { h.binDir = path.join(tmp, 'bin'); fs.mkdirSync(h.binDir); }
  const file = path.join(h.binDir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${script}\n`);
  fs.chmodSync(file, 0o755);
};

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const leftovers = (dir: string): string[] => fs.readdirSync(dir).filter((n) => n.includes('smdb'));

describe('a container-scope save', () => {
  it('lands the whole body and says saved only then', async () => {
    const file = path.join(tmp, 'config.yml');
    fs.writeFileSync(file, 'a: 1\nb: 2\n');
    const res = await terminal.fsWrite('b1', 'c1', shPath(file), 'a: 1\nb: 3\n');
    expect(res.success).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe('a: 1\nb: 3\n');
    expect(leftovers(tmp)).toEqual([]);
  });

  it('round-trips a CRLF file byte for byte', async () => {
    const file = path.join(tmp, 'win.ini');
    fs.writeFileSync(file, 'x=1\r\ny=2\r\n');
    const read = await terminal.fsRead('b1', 'c1', shPath(file));
    expect(read.success).toBe(true);
    expect(read.eol).toBe('crlf');
    const edited = read.body.replace(/\r\n/g, '\n').replace('y=2', 'y=3');
    const res = await terminal.fsWrite('b1', 'c1', shPath(file), edited, { eol: read.eol });
    expect(res.success).toBe(true);
    expect(fs.readFileSync(file).equals(Buffer.from('x=1\r\ny=3\r\n'))).toBe(true);
  });

  it('refuses to write over a folder and leaves it as it was', async () => {
    const dir = path.join(tmp, 'folder');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'keep'), 'k');
    const res = await terminal.fsWrite('b1', 'c1', shPath(dir), 'x');
    expect(res.success).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'keep'), 'utf8')).toBe('k');
  });
});

describe('reading a file for the editor', () => {
  it('refuses bytes that do not round-trip through UTF-8, in both scopes', async () => {
    fs.writeFileSync(path.join(data, 'latin1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
    const host = await terminal.fsRead('b1', 'host', 'latin1.txt');
    expect(host.success).toBe(false);
    const box = await terminal.fsRead('b1', 'c1', shPath(path.join(data, 'latin1.txt')));
    expect(box.success).toBe(false);
  });

  it('refuses mixed line endings, which the editor could not keep', async () => {
    fs.writeFileSync(path.join(data, 'mixed.txt'), 'a\r\nb\nc\r\n');
    expect((await terminal.fsRead('b1', 'host', 'mixed.txt')).success).toBe(false);
  });

  it('reports LF files as lf', async () => {
    fs.writeFileSync(path.join(data, 'plain.txt'), 'a\nb\n');
    const res = await terminal.fsRead('b1', 'host', 'plain.txt');
    expect(res).toMatchObject({ success: true, body: 'a\nb\n', eol: 'lf' });
  });
});

describe('a host-scope save', () => {
  it('replaces the file whole and leaves no temp file behind', async () => {
    fs.writeFileSync(path.join(data, 'c.json'), '{"a":1}\n');
    const res = await terminal.fsWrite('b1', 'host', 'c.json', '{"a":2}\n');
    expect(res.success).toBe(true);
    expect(fs.readFileSync(path.join(data, 'c.json'), 'utf8')).toBe('{"a":2}\n');
    expect(leftovers(data)).toEqual([]);
  });

  it('restores CRLF line endings recorded at read time', async () => {
    fs.writeFileSync(path.join(data, 'w.txt'), 'a\r\nb\r\n');
    const res = await terminal.fsWrite('b1', 'host', 'w.txt', 'a\nc\n', { eol: 'crlf' });
    expect(res.success).toBe(true);
    expect(fs.readFileSync(path.join(data, 'w.txt'), 'utf8')).toBe('a\r\nc\r\n');
  });

  it('refuses to replace a file over the 1 MB editor cap', async () => {
    const big = Buffer.alloc(1024 * 1024 + 10, 0x61);
    fs.writeFileSync(path.join(data, 'big.log'), big);
    const res = await terminal.fsWrite('b1', 'host', 'big.log', 'tiny');
    expect(res.success).toBe(false);
    expect(fs.readFileSync(path.join(data, 'big.log')).equals(big)).toBe(true);
  });

  it('refuses a body over the 1 MB cap', async () => {
    const res = await terminal.fsWrite('b1', 'host', 'new.txt', 'a'.repeat(1024 * 1024 + 1));
    expect(res.success).toBe(false);
    expect(fs.existsSync(path.join(data, 'new.txt'))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('keeps the file mode', async () => {
    const file = path.join(data, 'run.sh');
    fs.writeFileSync(file, 'echo 1\n');
    fs.chmodSync(file, 0o750);
    expect((await terminal.fsWrite('b1', 'host', 'run.sh', 'echo 2\n')).success).toBe(true);
    expect(fs.statSync(file).mode & 0o7777).toBe(0o750);
  });
});

describe('New File', () => {
  it('creates an empty file in the host scope', async () => {
    const res = await terminal.fsCreate('b1', 'host', 'fresh.txt');
    expect(res.success).toBe(true);
    expect(fs.readFileSync(path.join(data, 'fresh.txt'), 'utf8')).toBe('');
  });

  it('never overwrites an existing name in the host scope', async () => {
    fs.writeFileSync(path.join(data, 'taken.txt'), 'precious');
    const res = await terminal.fsCreate('b1', 'host', 'taken.txt');
    expect(res).toMatchObject({ success: false, exists: true });
    expect(fs.readFileSync(path.join(data, 'taken.txt'), 'utf8')).toBe('precious');
  });

  it('never overwrites an existing name in a container scope', async () => {
    const file = path.join(tmp, 'taken.txt');
    fs.writeFileSync(file, 'precious');
    const res = await terminal.fsCreate('b1', 'c1', shPath(file));
    expect(res).toMatchObject({ success: false, exists: true });
    expect(fs.readFileSync(file, 'utf8')).toBe('precious');
    const made = await terminal.fsCreate('b1', 'c1', shPath(path.join(tmp, 'new.txt')));
    expect(made.success).toBe(true);
    expect(fs.readFileSync(path.join(tmp, 'new.txt'), 'utf8')).toBe('');
  });
});

describe('rename', () => {
  it('refuses an existing target in the host scope unless overwrite is confirmed', async () => {
    fs.writeFileSync(path.join(data, 'a.txt'), 'A');
    fs.writeFileSync(path.join(data, 'b.txt'), 'B');
    const res = await terminal.fsRename('b1', 'host', 'a.txt', 'b.txt');
    expect(res).toMatchObject({ success: false, exists: true });
    expect(fs.readFileSync(path.join(data, 'b.txt'), 'utf8')).toBe('B');
    expect(fs.readFileSync(path.join(data, 'a.txt'), 'utf8')).toBe('A');
    const forced = await terminal.fsRename('b1', 'host', 'a.txt', 'b.txt', { overwrite: true });
    expect(forced.success).toBe(true);
    expect(fs.readFileSync(path.join(data, 'b.txt'), 'utf8')).toBe('A');
  });

  it('refuses an existing target in a container scope unless overwrite is confirmed', async () => {
    const a = path.join(tmp, 'a.txt');
    const b = path.join(tmp, 'b.txt');
    fs.writeFileSync(a, 'A');
    fs.writeFileSync(b, 'B');
    const res = await terminal.fsRename('b1', 'c1', shPath(a), shPath(b));
    expect(res).toMatchObject({ success: false, exists: true });
    expect(fs.readFileSync(b, 'utf8')).toBe('B');
    const forced = await terminal.fsRename('b1', 'c1', shPath(a), shPath(b), { overwrite: true });
    expect(forced.success).toBe(true);
    expect(fs.readFileSync(b, 'utf8')).toBe('A');
    expect(fs.existsSync(a)).toBe(false);
  });

  it('refuses a folder as the target even with overwrite, in both scopes', async () => {
    fs.writeFileSync(path.join(data, 'f.txt'), 'F');
    fs.mkdirSync(path.join(data, 'dir'));
    const host = await terminal.fsRename('b1', 'host', 'f.txt', 'dir', { overwrite: true });
    expect(host.success).toBe(false);
    const box = await terminal.fsRename('b1', 'c1', shPath(path.join(data, 'f.txt')), shPath(path.join(data, 'dir')), { overwrite: true });
    expect(box.success).toBe(false);
    expect(fs.readFileSync(path.join(data, 'f.txt'), 'utf8')).toBe('F');
    expect(fs.readdirSync(path.join(data, 'dir'))).toEqual([]);
  });
});

describe('delete', () => {
  it('says whether something was removed, in both scopes', async () => {
    fs.writeFileSync(path.join(data, 'x.txt'), 'x');
    expect(await terminal.fsDelete('b1', 'host', 'x.txt')).toMatchObject({ success: true, removed: true });
    expect(await terminal.fsDelete('b1', 'host', 'x.txt')).toMatchObject({ success: true, removed: false });
    const y = path.join(tmp, 'y.txt');
    fs.writeFileSync(y, 'y');
    expect(await terminal.fsDelete('b1', 'c1', shPath(y))).toMatchObject({ success: true, removed: true });
    expect(fs.existsSync(y)).toBe(false);
    expect(await terminal.fsDelete('b1', 'c1', shPath(y))).toMatchObject({ success: true, removed: false });
  });
});

describe('a host save of a file something else holds by its inode', () => {
  it('writes a file with a second hard link in place, so both names see the save', async () => {
    fs.writeFileSync(path.join(data, 'a.txt'), 'old\n');
    fs.linkSync(path.join(data, 'a.txt'), path.join(data, 'b.txt'));
    const res = await terminal.fsWrite('b1', 'host', 'a.txt', 'new\n');
    expect(res.success).toBe(true);
    expect(fs.readFileSync(path.join(data, 'b.txt'), 'utf8')).toBe('new\n');
    expect(leftovers(data)).toEqual([]);
  });

  it('writes a file in the config folder (bind-mounted into the bot alone) in place', async () => {
    fs.mkdirSync(path.join(data, 'config'));
    const file = path.join(data, 'config', 'settings.yml');
    fs.writeFileSync(file, 'a: 1\n');
    const before = fs.statSync(file).ino;
    const res = await terminal.fsWrite('b1', 'host', 'config/settings.yml', 'a: 2\n');
    expect(res.success).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe('a: 2\n');
    expect(fs.statSync(file).ino).toBe(before);
    expect(leftovers(path.join(data, 'config'))).toEqual([]);
  });

  it('keeps the inode of any existing file (a bind the bot holds is invisible here)', async () => {
    const file = path.join(data, 'plain.txt');
    fs.writeFileSync(file, 'a\n');
    const before = fs.statSync(file).ino;
    expect((await terminal.fsWrite('b1', 'host', 'plain.txt', 'b\n')).success).toBe(true);
    expect(fs.statSync(file).ino).toBe(before);
    expect(fs.readFileSync(file, 'utf8')).toBe('b\n');
    expect(leftovers(data)).toEqual([]);
  });

  it('never replaces a file the bot created after the save judged the name free', async () => {
    h.beforeLink = () => fs.writeFileSync(path.join(data, 'race.txt'), 'bot wrote this');
    const res = await terminal.fsWrite('b1', 'host', 'race.txt', 'operator');
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/appeared meanwhile; nothing was saved/);
    expect(fs.readFileSync(path.join(data, 'race.txt'), 'utf8')).toBe('bot wrote this');
    expect(leftovers(data)).toEqual([]);
  });

  it('creates a new file whole through a temp file', async () => {
    expect((await terminal.fsWrite('b1', 'host', 'sub/new.txt', 'n\n')).success).toBe(true);
    expect(fs.readFileSync(path.join(data, 'sub', 'new.txt'), 'utf8')).toBe('n\n');
    expect(leftovers(path.join(data, 'sub'))).toEqual([]);
  });
});

describe('a container save onto a path mv cannot replace', () => {
  it('falls back to an in-place write with a backup when mv answers busy', async () => {
    fakeBin('mv', 'echo "mv: cannot move: Device or resource busy" >&2; exit 1');
    const file = path.join(tmp, 'mounted.yml');
    fs.writeFileSync(file, 'a: 1\n');
    const res = await terminal.fsWrite('b1', 'c1', shPath(file), 'a: 2\n');
    expect(res.success).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe('a: 2\n');
    expect(leftovers(tmp)).toEqual([]);
  });

  it('reports any other mv failure and leaves the file as it was', async () => {
    fakeBin('mv', 'echo "mv: cannot move: Permission denied" >&2; exit 1');
    const file = path.join(tmp, 'kept.yml');
    fs.writeFileSync(file, 'a: 1\n');
    const res = await terminal.fsWrite('b1', 'c1', shPath(file), 'a: 2\n');
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Permission denied/);
    expect(fs.readFileSync(file, 'utf8')).toBe('a: 1\n');
    expect(leftovers(tmp)).toEqual([]);
  });
});

describe('the in-container bound on delete and rename', () => {
  it('runs rm and mv under timeout -s KILL when the probe finds it', async () => {
    const log = path.join(tmp, 'timeout.log');
    fakeBin('timeout', `echo "$@" >> '${shPath(log)}'; shift 3; exec "$@"`);
    const y = path.join(tmp, 'y.txt');
    fs.writeFileSync(y, 'y');
    expect(await terminal.fsDelete('b1', 'c1', shPath(y))).toMatchObject({ success: true, removed: true });
    fs.writeFileSync(y, 'y');
    expect((await terminal.fsRename('b1', 'c1', shPath(y), shPath(path.join(tmp, 'z.txt')))).success).toBe(true);
    const lines = fs.readFileSync(log, 'utf8');
    expect(lines).toMatch(/-s KILL 12 rm -rf/);
    expect(lines).toMatch(/-s KILL 12 mv -f/);
  });

  it('runs them unbounded when the image has no timeout of that form', async () => {
    fakeBin('timeout', 'exit 125');
    const y = path.join(tmp, 'y.txt');
    fs.writeFileSync(y, 'y');
    expect(await terminal.fsDelete('b1', 'c1', shPath(y))).toMatchObject({ success: true, removed: true });
    expect(fs.existsSync(y)).toBe(false);
    fs.writeFileSync(y, 'y');
    expect((await terminal.fsRename('b1', 'c1', shPath(y), shPath(path.join(tmp, 'z.txt')))).success).toBe(true);
    expect(fs.existsSync(path.join(tmp, 'z.txt'))).toBe(true);
  });

  it('answers a bound that fired as stopped, not as done', async () => {
    fakeBin('timeout', 'if [ "$3" = 1 ]; then exit 0; fi; exit 137');
    const y = path.join(tmp, 'y.txt');
    fs.writeFileSync(y, 'y');
    const del = await terminal.fsDelete('b1', 'c1', shPath(y));
    expect(del.success).toBe(false);
    expect(del.error).toMatch(/stopped after 12 s/);
    const ren = await terminal.fsRename('b1', 'c1', shPath(y), shPath(path.join(tmp, 'z.txt')));
    expect(ren.success).toBe(false);
    expect(ren.error).toMatch(/stopped after 12 s/);
  });
});

describe('a container delete or rename that outlives the client bound', () => {
  const firstExec = async (): Promise<void> => {
    while (!h.calls.some((c) => c[0] === 'exec')) await realSleep(20);
  };

  it('without a bound: answers not confirmed yet, never kills the CLI, and stays busy until it exits', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const first = terminal.fsRename('b1', 'slow', '/srv/a', '/srv/b');
    await firstExec();
    const retry = await terminal.fsRename('b1', 'slow', '/srv/a', '/srv/c');
    expect(retry.error).toMatch(/may still be running/);
    await vi.advanceTimersByTimeAsync(15000);
    const res = await first;
    expect(res).toMatchObject({ success: false, unconfirmed: true });
    expect(res.error).toMatch(/could not be confirmed yet/);
    await vi.advanceTimersByTimeAsync(13000);
    expect((await terminal.fsDelete('b1', 'slow', '/srv/a')).error).toMatch(/may still be running/);
    const execCount = (): number => h.calls.filter((c) => c[0] === 'exec').length;
    const start = performance.now();
    let free = false;
    while (!free && performance.now() - start < 10000) {
      const execs = execCount();
      let answer: any = null;
      const probe = terminal.fsDelete('b1', 'slow', '/srv/a');
      probe.then((a) => { answer = a; });
      while (answer === null && execCount() === execs) await realSleep(20);
      if (execCount() > execs) {
        free = true;
        await vi.advanceTimersByTimeAsync(15000);
        await probe;
      } else {
        expect(answer.error).toMatch(/may still be running/);
        await realSleep(100);
      }
    }
    expect(free).toBe(true);
  }, 20000);

  it('with a bound: kills the CLI and stays busy for the bound after the client timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const first = terminal.fsDelete('b1', 'slowb', '/srv/a');
    while (!h.marked) await realSleep(20);
    await vi.advanceTimersByTimeAsync(15000);
    const res = await first;
    expect(res).toMatchObject({ success: false, unconfirmed: true });
    expect((await terminal.fsDelete('b1', 'slowb', '/srv/a')).error).toMatch(/may still be running/);
    await vi.advanceTimersByTimeAsync(12001);
    const later = terminal.fsDelete('b1', 'slowb', '/srv/a');
    const execs = h.calls.filter((c) => c[0] === 'exec').length;
    while (h.calls.filter((c) => c[0] === 'exec').length === execs) await realSleep(20);
    await vi.advanceTimersByTimeAsync(15000);
    expect((await later).unconfirmed).toBe(true);
  });

  it('refuses a path with a NUL byte before spawning, and never locks it', async () => {
    const res = await terminal.fsRename('b1', 'c1', '/srv/a\0b', '/srv/c');
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/NUL/);
    expect((await terminal.fsDelete('b1', 'c1', '/srv/a\0b')).error).toMatch(/NUL/);
    expect((await terminal.fsWrite('b1', 'c1', '/srv/a\0b', 'x')).error).toMatch(/NUL/);
    expect(h.calls.filter((c) => c[0] === 'exec')).toEqual([]);
  });
});

describe('the request body of a save', () => {
  const fakeReq = (json: string) => Object.assign(Readable.from([Buffer.from(json)]), {
    method: 'PUT',
    url: '/api/bots/b1/fs/write',
    path: '/api/bots/b1/fs/write',
    headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(json)) },
  });
  const fakeRes = () => {
    const r: any = { code: 0, sent: null };
    r.status = (c: number) => { r.code = c; return r; };
    r.json = (o: unknown) => { r.sent = o; return r; };
    return r;
  };
  const run = (mw: any, req: any, res: any) => new Promise<unknown>((resolve) => {
    res.json = ((orig) => (o: unknown) => { orig(o); resolve('answered'); return res; })(res.json);
    mw(req, res, (err?: unknown) => resolve(err || 'next'));
  });

  it('passes a save up to the 1 MB cap, which the global 100 kB parser would refuse', async () => {
    const body = mod.jsonBodies();
    const req: any = fakeReq(JSON.stringify({ path: '/x', body: 'a'.repeat(900 * 1024) }));
    expect(await run(body, req, fakeRes())).toBe('next');
    expect(await run(mod.fsWriteBody, req, fakeRes())).toBe('next');
    expect(req.body.body.length).toBe(900 * 1024);
  });

  it('answers a body over its limit with the 1 MB rule and says the file was not changed', async () => {
    const req: any = fakeReq(JSON.stringify({ path: '/x', body: 'a'.repeat(3 * 1024 * 1024) }));
    const res = fakeRes();
    expect(await run(mod.fsWriteBody, req, res)).toBe('answered');
    expect(res.code).toBe(413);
    expect(res.sent.error).toMatch(/over 1 MB.*not changed/);
  });

  it('keeps the default parser for every other route', async () => {
    const req: any = Object.assign(fakeReq(JSON.stringify({ a: 'b'.repeat(200 * 1024) })), { method: 'POST', path: '/api/bots/b1/fs/rename' });
    const out: any = await run(mod.jsonBodies(), req, fakeRes());
    expect(out.type).toBe('entity.too.large');
  });
});
