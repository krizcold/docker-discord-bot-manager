import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// crash: the next write into (or truncate of) an fd opened on h.target lands half
// its bytes (or nothing) and every later fs mutation throws until h.dead is reset.
const h = vi.hoisted(() => ({
  dataPath: '',
  target: '',
  crash: null as null | 'write' | 'truncate',
  writeError: '',
  dead: false,
  linkError: '',
  beforeLink: null as null | (() => void),
  failUnlink: null as null | RegExp,
  fds: new Set<number>(),
  preExec: '',
}));

vi.mock('../../src/docker/containerManager', () => ({
  getBot: (id: string) => (id === 'b1' ? { id: 'b1', sanitizedName: 'bot1' } : undefined),
}));
vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>();
  const crashed = (): never => { h.dead = true; throw Object.assign(new Error('simulated crash'), { code: 'ECRASH' }); };
  const alive = (): void => { if (h.dead) throw Object.assign(new Error('the process is gone'), { code: 'ECRASH' }); };
  const wrap = {
    openSync: (p: fs.PathLike, flags?: any, mode?: any) => {
      alive();
      const fd = real.openSync(p, flags, mode);
      if (h.target && String(p).replace(/\\/g, '/').endsWith(`/${h.target}`)) h.fds.add(fd);
      return fd;
    },
    closeSync: (fd: number) => { h.fds.delete(fd); return real.closeSync(fd); },
    writeSync: (fd: number, buf: any, off?: any, len?: any, pos?: any) => {
      alive();
      if (h.fds.has(fd) && h.writeError) {
        const half = Math.max(1, Math.floor((len ?? buf.length) / 2));
        real.writeSync(fd, buf, off, half, pos);
        throw Object.assign(new Error('simulated write error'), { code: h.writeError });
      }
      if (h.fds.has(fd) && h.crash === 'write') {
        const half = Math.max(1, Math.floor((len ?? buf.length) / 2));
        real.writeSync(fd, buf, off, half, pos);
        crashed();
      }
      return real.writeSync(fd, buf, off, len, pos);
    },
    ftruncateSync: (fd: number, len?: number) => {
      alive();
      if (h.fds.has(fd) && h.crash === 'truncate') crashed();
      return real.ftruncateSync(fd, len);
    },
    fsyncSync: (fd: number) => { alive(); return real.fsyncSync(fd); },
    unlinkSync: (p: fs.PathLike) => {
      alive();
      if (h.failUnlink && h.failUnlink.test(String(p))) { h.failUnlink = null; crashed(); }
      return real.unlinkSync(p);
    },
    renameSync: (a: fs.PathLike, b: fs.PathLike) => { alive(); return real.renameSync(a, b); },
    linkSync: (a: fs.PathLike, b: fs.PathLike) => {
      alive();
      h.beforeLink?.();
      if (h.linkError) throw Object.assign(new Error(`${h.linkError}: operation not permitted, link`), { code: h.linkError });
      return real.linkSync(a, b);
    },
  };
  return { ...real, ...wrap, default: { ...real, ...wrap } };
});
vi.mock('../../src/git/repoManager', () => ({ getDataPath: () => h.dataPath }));
vi.mock('../../src/casaos/detector', () => ({ getDeploymentMode: async () => 'docker' }));
vi.mock('../../src/templates/pcsProcessing', () => ({ grantFd: () => {}, grantToApp: () => {} }));

// A fake docker CLI: `ps` names one container, and `exec` runs the argv on this machine.
vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const { Writable } = await import('stream');
  const spawn = (cmd: string, args: string[], opts: any) => {
    if (cmd !== 'docker') throw new Error(`unexpected spawn ${cmd}`);
    if (args[0] === 'ps') return real.spawn('sh', ['-c', "printf 'c1\\trunning\\n'"], opts);
    if (args[0] !== 'exec') throw new Error(`unexpected docker ${args[0]}`);
    let i = 1;
    let interactive = false;
    while (args[i].startsWith('-')) { if (args[i] === '-i') interactive = true; i++; }
    const argv = args.slice(i + 1);
    // exec keeps the pid, so preExec sees the same $$ as the script it runs.
    const child: any = h.preExec
      ? real.spawn('sh', ['-c', `${h.preExec}\nexec "$@"`, 'sh', ...argv], opts)
      : real.spawn(argv[0], argv.slice(1), opts);
    if (!interactive) {
      child.stdin.end();
      child.stdin = new Writable({ write(_c, _e, cb) { cb(); } });
    }
    return child;
  };
  return { ...real, spawn };
});

import * as terminal from '../../src/webui/terminal';
import { writeFileAtomic } from '../../src/config/storeFile';

const shPath = (p: string): string =>
  process.platform === 'win32' ? `/${p[0].toLowerCase()}${p.slice(2).replace(/\\/g, '/')}` : p;

let tmp: string;
let data: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fu-t-'));
  data = path.join(tmp, 'data');
  fs.mkdirSync(data);
  h.dataPath = data;
  h.target = '';
  h.crash = null;
  h.writeError = '';
  h.dead = false;
  h.linkError = '';
  h.beforeLink = null;
  h.failUnlink = null;
  h.fds.clear();
  h.preExec = '';
});

afterEach(() => {
  h.dead = false;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const leftovers = (dir: string): string[] => fs.readdirSync(dir).filter((n) => n.includes('smdb'));
const tag = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16);

describe('B01-1r a host-scope save that stops inside the file', () => {
  it('after a crash mid-write, the next open and save refuse, name both files and keep the old content', async () => {
    const file = path.join(data, 'c.json');
    fs.writeFileSync(file, '{"old":"operator data"}\n');
    h.target = 'c.json';
    h.crash = 'write';
    const first = await terminal.fsWrite('b1', 'host', 'c.json', '{"new":"the save that stopped"}\n');
    expect(first.success).toBe(false);
    h.dead = false;
    h.crash = null;

    const copies = leftovers(data);
    expect(copies).toHaveLength(1);
    const copy = copies[0];
    expect(fs.readFileSync(path.join(data, copy), 'utf8')).toBe('{"old":"operator data"}\n');

    const read = await terminal.fsRead('b1', 'host', 'c.json');
    expect(read.success).toBe(false);
    expect(read.error).toContain('c.json');
    expect(read.error).toContain(copy);
    expect(read.error).toMatch(/held before that save is in/);

    const save = await terminal.fsWrite('b1', 'host', 'c.json', '{"third":1}\n');
    expect(save.success).toBe(false);
    expect(save.error).toContain(copy);
    expect(save.error).toMatch(/Nothing was saved/);
    expect(fs.readFileSync(path.join(data, copy), 'utf8')).toBe('{"old":"operator data"}\n');
    expect(fs.readFileSync(file, 'utf8')).not.toBe('{"third":1}\n');

    expect((await terminal.fsDelete('b1', 'host', copy)).success).toBe(true);
    expect((await terminal.fsRead('b1', 'host', 'c.json')).success).toBe(true);
  });

  it('after a crash before the file was touched, the next open drops the copy and reads the old file', async () => {
    const file = path.join(data, 'a.yml');
    fs.writeFileSync(file, 'a: 1\n');
    h.target = 'a.yml';
    h.crash = 'truncate';
    expect((await terminal.fsWrite('b1', 'host', 'a.yml', 'a: 2\n')).success).toBe(false);
    h.dead = false;
    h.crash = null;
    const read = await terminal.fsRead('b1', 'host', 'a.yml');
    expect(read.success).toBe(true);
    expect(read.body).toBe('a: 1\n');
    expect(leftovers(data)).toEqual([]);
  });

  it('after a crash once the file held the whole body, the next save drops the copy and saves', async () => {
    const file = path.join(data, 'b.yml');
    fs.writeFileSync(file, 'b: 1\n');
    h.failUnlink = /smdb-backup/;
    await terminal.fsWrite('b1', 'host', 'b.yml', 'b: 2\n');
    h.dead = false;
    expect(fs.readFileSync(file, 'utf8')).toBe('b: 2\n');
    const save = await terminal.fsWrite('b1', 'host', 'b.yml', 'b: 3\n');
    expect(save.success).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe('b: 3\n');
    expect(leftovers(data)).toEqual([]);
  });

  it('a copy beside a file that is gone keeps the copy and refuses a new save at that name', async () => {
    const copy = `.gone.txt.smdb-backup.${tag('was here\n')}.${tag('next\n')}`;
    fs.writeFileSync(path.join(data, copy), 'was here\n');
    const save = await terminal.fsWrite('b1', 'host', 'gone.txt', 'fresh\n');
    expect(save.success).toBe(false);
    expect(save.error).toContain(copy);
    expect(save.error).toMatch(/missing/);
    expect(fs.existsSync(path.join(data, 'gone.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(data, copy), 'utf8')).toBe('was here\n');
  });
});

describe('B01-1r a container-scope save that stopped inside the file', () => {
  it('a partial file beside its backup: open and save refuse, name both, and keep the backup', async () => {
    const file = path.join(tmp, 'mounted.yml');
    fs.writeFileSync(file, 'a: ');
    fs.writeFileSync(path.join(tmp, '.mounted.yml.smdb-backup.999999991'), 'a: 1\n');
    const read = await terminal.fsRead('b1', 'c1', shPath(file));
    expect(read.success).toBe(false);
    expect(read.error).toContain('.mounted.yml.smdb-backup.999999991');
    const save = await terminal.fsWrite('b1', 'c1', shPath(file), 'a: 3\n');
    expect(save.success).toBe(false);
    expect(save.error).toContain('.mounted.yml.smdb-backup.999999991');
    expect(fs.readFileSync(file, 'utf8')).toBe('a: ');
    expect(fs.readFileSync(path.join(tmp, '.mounted.yml.smdb-backup.999999991'), 'utf8')).toBe('a: 1\n');
  });

  it('a backup equal to the file is dropped and the save goes ahead', async () => {
    const file = path.join(tmp, 'same.yml');
    fs.writeFileSync(file, 'a: 1\n');
    fs.writeFileSync(path.join(tmp, '.same.yml.smdb-backup.999999992'), 'a: 1\n');
    const save = await terminal.fsWrite('b1', 'c1', shPath(file), 'a: 2\n');
    expect(save.success).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe('a: 2\n');
    expect(leftovers(tmp)).toEqual([]);
  });

  it('a file that holds the whole body of the save that stopped drops both copies on open', async () => {
    const file = path.join(tmp, 'done.yml');
    fs.writeFileSync(file, 'a: 2\n');
    fs.writeFileSync(path.join(tmp, '.done.yml.smdb-backup.999999993'), 'a: 1\n');
    fs.writeFileSync(path.join(tmp, '.done.yml.smdb-save.999999993'), 'a: 2\n');
    const read = await terminal.fsRead('b1', 'c1', shPath(file));
    expect(read.success).toBe(true);
    expect(read.body).toBe('a: 2\n');
    expect(leftovers(tmp)).toEqual([]);
  });

  it('a backup whose save is still running is left alone: open and save refuse and keep both copies', async () => {
    const cp = await vi.importActual<typeof import('child_process')>('child_process');
    const saver = cp.spawn('sh', ['-c', 'echo $$; exec sleep 30'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const pid = await new Promise<string>((resolve) => saver.stdout!.once('data', (d) => resolve(String(d).trim())));
    try {
      const file = path.join(tmp, 'busy.yml');
      fs.writeFileSync(file, 'a: 1\n');
      fs.writeFileSync(path.join(tmp, `.busy.yml.smdb-backup.${pid}`), 'a: 1\n');
      fs.writeFileSync(path.join(tmp, `.busy.yml.smdb-save.${pid}`), 'a: 2\n');
      const read = await terminal.fsRead('b1', 'c1', shPath(file));
      expect(read.success).toBe(false);
      expect(read.error).toContain('may still be running');
      expect(read.error).toContain(`.busy.yml.smdb-backup.${pid}`);
      const save = await terminal.fsWrite('b1', 'c1', shPath(file), 'a: 3\n');
      expect(save.success).toBe(false);
      expect(save.error).toContain('may still be running');
      expect(save.error).toContain(`.busy.yml.smdb-backup.${pid}`);
      expect(fs.readFileSync(file, 'utf8')).toBe('a: 1\n');
      expect(leftovers(tmp).sort()).toEqual([`.busy.yml.smdb-backup.${pid}`, `.busy.yml.smdb-save.${pid}`]);
    } finally {
      cp.spawnSync('sh', ['-c', `kill ${pid}`]);
      saver.kill();
    }
  });

  it("a backup named after the reading or saving script's own pid is settled as a dead save's", async () => {
    const file = path.join(tmp, 'own.yml');
    fs.writeFileSync(file, 'a: 1\n');
    h.preExec = `printf 'a: 1\\n' > "${shPath(tmp)}/.own.yml.smdb-backup.$$"`;
    const read = await terminal.fsRead('b1', 'c1', shPath(file));
    expect(read.success).toBe(true);
    expect(read.body).toBe('a: 1\n');
    expect(leftovers(tmp)).toEqual([]);
    const save = await terminal.fsWrite('b1', 'c1', shPath(file), 'a: 2\n');
    expect(save.success).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe('a: 2\n');
    expect(leftovers(tmp)).toEqual([]);
  });
});

describe('T-CFGWt a new host-scope file where link(2) is refused', () => {
  for (const code of ['EPERM', 'ENOTSUP', 'EXDEV']) {
    it(`creates the file whole with ${code} from link`, async () => {
      h.linkError = code;
      const res = await terminal.fsWrite('b1', 'host', 'sub/new.txt', 'n\n');
      expect(res.success).toBe(true);
      expect(fs.readFileSync(path.join(data, 'sub', 'new.txt'), 'utf8')).toBe('n\n');
      expect(leftovers(path.join(data, 'sub'))).toEqual([]);
    });
  }

  it('never replaces a file that appeared before the fallback create', async () => {
    h.linkError = 'EPERM';
    h.beforeLink = () => fs.writeFileSync(path.join(data, 'race.txt'), 'bot wrote this');
    const res = await terminal.fsWrite('b1', 'host', 'race.txt', 'operator');
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/appeared meanwhile; nothing was saved/);
    expect(fs.readFileSync(path.join(data, 'race.txt'), 'utf8')).toBe('bot wrote this');
    expect(leftovers(data)).toEqual([]);
  });

  it('a write error inside the fallback create removes its partial file and says nothing was saved', async () => {
    h.linkError = 'EPERM';
    h.target = 'w.txt';
    h.writeError = 'EIO';
    const res = await terminal.fsWrite('b1', 'host', 'w.txt', 'whole body\n');
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/nothing was saved/);
    expect(fs.existsSync(path.join(data, 'w.txt'))).toBe(false);
    expect(leftovers(data)).toEqual([]);
  });

  it('after a crash inside the fallback create, the next open names the file and the complete copy', async () => {
    h.linkError = 'EPERM';
    h.target = 'n.json';
    h.crash = 'write';
    expect((await terminal.fsWrite('b1', 'host', 'n.json', '{"whole":"body"}\n')).success).toBe(false);
    h.dead = false;
    h.crash = null;
    h.linkError = '';
    const copies = leftovers(data);
    expect(copies).toHaveLength(1);
    expect(fs.readFileSync(path.join(data, copies[0]), 'utf8')).toBe('{"whole":"body"}\n');
    const read = await terminal.fsRead('b1', 'host', 'n.json');
    expect(read.success).toBe(false);
    expect(read.error).toContain('n.json');
    expect(read.error).toContain(copies[0]);
    expect(read.error).toMatch(/the whole body of that save is in/);
  });
});

describe('FU-1m writeFileAtomic and a stale tmp file', () => {
  it('writes over a stale read-only tmp file', () => {
    const target = path.join(tmp, 'store.json');
    fs.writeFileSync(`${target}.tmp`, 'stale');
    fs.chmodSync(`${target}.tmp`, 0o444);
    writeFileAtomic(target, '{"a":1}', 0o600);
    expect(fs.readFileSync(target, 'utf8')).toBe('{"a":1}');
    expect(fs.existsSync(`${target}.tmp`)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('the result has the requested mode, not the stale tmp file\'s', () => {
    const target = path.join(tmp, '.env');
    fs.writeFileSync(`${target}.tmp`, 'stale');
    fs.chmodSync(`${target}.tmp`, 0o644);
    writeFileAtomic(target, 'TOKEN=x\n', 0o600);
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === 'win32')('a stale tmp symlink is replaced, never written through', () => {
    const target = path.join(tmp, 'reg.json');
    const elsewhere = path.join(tmp, 'elsewhere.txt');
    fs.writeFileSync(elsewhere, 'keep me');
    fs.symlinkSync(elsewhere, `${target}.tmp`);
    writeFileAtomic(target, '{}', 0o600);
    expect(fs.readFileSync(elsewhere, 'utf8')).toBe('keep me');
    expect(fs.readFileSync(target, 'utf8')).toBe('{}');
  });
});
