import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A disk that fills mid-write: a write lands half its bytes and throws, a
// rename throws. failInPlace fails once, on a write to a file whose name does
// not start with a dot (the target, not a temp). Armed only around the call.
const h = vi.hoisted(() => ({ full: false, failInPlace: false, renames: 0, plainFds: new Set<number>() }));

vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>();
  const enospc = (p: unknown) => Object.assign(new Error(`ENOSPC: no space left on device, write '${p}'`), { code: 'ENOSPC' });
  const wrapped = {
    ...real,
    writeFileSync: (p: any, data: any, ...rest: any[]) => {
      if (h.full) {
        const s = String(data);
        (real.writeFileSync as any)(p, s.slice(0, Math.floor(s.length / 2)), ...rest);
        throw enospc(p);
      }
      return (real.writeFileSync as any)(p, data, ...rest);
    },
    renameSync: (a: any, b: any) => {
      h.renames++;
      if (h.full) throw enospc(b);
      return real.renameSync(a, b);
    },
    openSync: (p: any, ...rest: any[]) => {
      const fd = (real.openSync as any)(p, ...rest);
      if (/(^|[\\/])\.[^\\/]*$/.test(String(p))) h.plainFds.delete(fd); else h.plainFds.add(fd);
      return fd;
    },
    writeSync: (fd: any, buf: any, off?: any, len?: any, pos?: any) => {
      const inPlace = h.failInPlace && h.plainFds.has(fd);
      if ((h.full || inPlace) && Buffer.isBuffer(buf) && typeof off === 'number' && typeof len === 'number') {
        if (inPlace) h.failInPlace = false;
        (real.writeSync as any)(fd, buf, off, Math.floor(len / 2), pos);
        throw enospc(fd);
      }
      return (real.writeSync as any)(fd, buf, off, len, pos);
    },
  };
  return { ...wrapped, default: wrapped };
});

import {
  applyUserConfigOverrides, newDeliveryReport, prepareDockerBotFiles, redeliverDockerConfigFiles, writeConfigFiles,
} from '../../src/templates/pcsProcessing';

const OLD = 'token: the-old-delivered-body\nkeep: every byte\n';
const NEW = 'token: the-new-body\n';
const BOT = 'token: the-bot-wrote-this\n';

let tmp: string;
let dataRoot: string;
let logs: string[];
const savedDataRoot = process.env.DATA_ROOT;
const fwd = (p: string) => p.replace(/\\/g, '/');
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const log = (m: string) => { logs.push(m); };

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 't-cfgw-'));
  dataRoot = fwd(path.join(tmp, 'DATA'));
  process.env.DATA_ROOT = dataRoot;
  logs = [];
  h.full = false;
  h.failInPlace = false;
  h.renames = 0;
});

afterEach(() => {
  h.full = false;
  if (savedDataRoot === undefined) delete process.env.DATA_ROOT; else process.env.DATA_ROOT = savedDataRoot;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const bot = () => path.join(tmp, 'bot');
const local = () => path.join(bot(), 'application.yml');
const dockerCompose = 'services:\n  app:\n    image: x\n    volumes:\n      - /host/bot/application.yml:/app/application.yml\n';
const files = (body: string) => [{ path: '/app/application.yml', body }];
const strays = (dir: string) => fs.readdirSync(dir).filter((n) => n.startsWith('.'));
const putFile = (p: string, body: string) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); };
const putDir = (p: string) => { fs.mkdirSync(p, { recursive: true }); fs.writeFileSync(path.join(p, 'keep.txt'), 'data'); };

const casaosSrc = () => `${dataRoot}/AppData/app1/application.yml`;
const casaosCompose = () => `services:\n  app:\n    image: x\n    volumes:\n      - type: bind\n        source: ${casaosSrc()}\n        target: /app/application.yml\n`;
const writeOnlySrc = () => `${dataRoot}/AppData/app1/.smdb-config/app/new.yml`;

describe('T-CFGW a directory at a config target is kept', () => {
  it('docker build, declared bind: the directory and its contents survive and the file is reported failed', () => {
    putDir(local());
    const report = newDeliveryReport();
    prepareDockerBotFiles(dockerCompose, bot(), '/host/bot', null, files(NEW), log, report, {});
    expect(fs.readFileSync(path.join(local(), 'keep.txt'), 'utf8')).toBe('data');
    expect(report.failed).toContain('/app/application.yml');
    expect(report.delivered[local()]).toBeUndefined();
  });

  it('docker Start: the directory and its contents survive and the file is reported failed', () => {
    putDir(local());
    const report = (redeliverDockerConfigFiles as any)(dockerCompose, bot(), '/host/bot', files(NEW), newDeliveryReport(), {}, log);
    expect(fs.readFileSync(path.join(local(), 'keep.txt'), 'utf8')).toBe('data');
    expect(report.failed).toContain('/app/application.yml');
  });

  it('platform build, write-only bind: the directory and its contents survive and the file is reported failed', async () => {
    putDir(writeOnlySrc());
    const report = await writeConfigFiles('app1', [{ path: '/app/new.yml', body: NEW }], log, newDeliveryReport(), {});
    expect(fs.readFileSync(path.join(writeOnlySrc(), 'keep.txt'), 'utf8')).toBe('data');
    expect(report.failed).toContain('/app/new.yml');
  });

  it('an empty directory (what Docker creates at a missing file source) is replaced by the file', () => {
    fs.mkdirSync(local(), { recursive: true });
    const report = (redeliverDockerConfigFiles as any)(dockerCompose, bot(), '/host/bot', files(NEW), newDeliveryReport(), {}, log);
    expect(report.failed).toEqual([]);
    expect(fs.readFileSync(local(), 'utf8')).toBe(NEW);
  });
});

describe('T-CFGW a write that fails before the rename leaves the old body byte for byte', () => {
  it('docker build, declared bind', () => {
    putFile(local(), OLD);
    const report = newDeliveryReport();
    h.full = true;
    prepareDockerBotFiles(dockerCompose, bot(), '/host/bot', null, files(NEW), log, report, { [local()]: sha(OLD) });
    h.full = false;
    expect(fs.readFileSync(local(), 'utf8')).toBe(OLD);
    expect(report.failed).toContain('/app/application.yml');
    expect(report.delivered[local()]).toBeUndefined();
    expect(strays(bot())).toEqual([]);
  });

  it('docker Start', () => {
    putFile(local(), OLD);
    h.full = true;
    const report = (redeliverDockerConfigFiles as any)(dockerCompose, bot(), '/host/bot', files(NEW), newDeliveryReport(), { [local()]: sha(OLD) }, log);
    h.full = false;
    expect(fs.readFileSync(local(), 'utf8')).toBe(OLD);
    expect(report.failed).toContain('/app/application.yml');
    expect(report.delivered[local()]).toBeUndefined();
    expect(strays(bot())).toEqual([]);
  });

  it('platform build, write-only bind', async () => {
    putFile(writeOnlySrc(), OLD);
    h.full = true;
    const report = await writeConfigFiles('app1', [{ path: '/app/new.yml', body: NEW }], log, newDeliveryReport(), { [writeOnlySrc()]: sha(OLD) });
    h.full = false;
    expect(fs.readFileSync(writeOnlySrc(), 'utf8')).toBe(OLD);
    expect(report.failed).toContain('/app/new.yml');
    expect(report.delivered[writeOnlySrc()]).toBeUndefined();
    expect(strays(path.dirname(writeOnlySrc()))).toEqual([]);
  });

  it('platform build and Start, declared bind', async () => {
    putFile(casaosSrc(), OLD);
    const report = newDeliveryReport();
    h.full = true;
    await applyUserConfigOverrides(casaosCompose(), 'app1', files(NEW), log, report, { [casaosSrc()]: sha(OLD) });
    h.full = false;
    expect(fs.readFileSync(casaosSrc(), 'utf8')).toBe(OLD);
    expect(report.failed).toContain('/app/application.yml');
    expect(report.delivered[casaosSrc()]).toBeUndefined();
    expect(strays(path.dirname(casaosSrc()))).toEqual([]);
  });
});

describe('T-CFGW docker Start asks the delivery record before it writes', () => {
  it('a file the bot changed since the last delivery, stored body unchanged, is kept and the log says so', () => {
    putFile(local(), BOT);
    const report = (redeliverDockerConfigFiles as any)(dockerCompose, bot(), '/host/bot', files(OLD), newDeliveryReport(), { [local()]: sha(OLD) }, log);
    expect(fs.readFileSync(local(), 'utf8')).toBe(BOT);
    expect(report.failed).toEqual([]);
    expect(logs.some((l) => l.includes('Kept existing') && l.includes('changed since'))).toBe(true);
  });

  it('a file the bot changed since the last delivery, stored body changed, is kept and reported failed', () => {
    putFile(local(), BOT);
    const report = (redeliverDockerConfigFiles as any)(dockerCompose, bot(), '/host/bot', files(NEW), newDeliveryReport(), { [local()]: sha(OLD) }, log);
    expect(fs.readFileSync(local(), 'utf8')).toBe(BOT);
    expect(report.failed).toContain('/app/application.yml');
    expect(report.delivered[local()]).toBeUndefined();
  });

  it('a file with no delivery record is kept and reported failed', () => {
    putFile(local(), BOT);
    const report = (redeliverDockerConfigFiles as any)(dockerCompose, bot(), '/host/bot', files(NEW), newDeliveryReport(), {}, log);
    expect(fs.readFileSync(local(), 'utf8')).toBe(BOT);
    expect(report.failed).toContain('/app/application.yml');
  });

  it('a file still holding the body last delivered is replaced, recorded, and leaves no temp file', () => {
    putFile(local(), OLD);
    const report = (redeliverDockerConfigFiles as any)(dockerCompose, bot(), '/host/bot', files(NEW), newDeliveryReport(), { [local()]: sha(OLD) }, log);
    expect(report.failed).toEqual([]);
    expect(fs.readFileSync(local(), 'utf8')).toBe(NEW);
    expect(report.delivered[local()]).toBe(sha(NEW));
    expect(strays(bot())).toEqual([]);
    if (process.platform !== 'win32') expect(fs.statSync(local()).mode & 0o777).toBe(0o644);
  });
});

describe('T-CFGW docker build over a declared bind asks the delivery record too', () => {
  it('a file with content the manager has no record of is kept and the build fails for it', () => {
    putFile(local(), BOT);
    const report = newDeliveryReport();
    prepareDockerBotFiles(dockerCompose, bot(), '/host/bot', null, files(NEW), log, report, {});
    expect(fs.readFileSync(local(), 'utf8')).toBe(BOT);
    expect(report.failed).toContain('/app/application.yml');
  });

  it('a file still byte for byte the repo template takes the stored body', () => {
    const repo = path.join(tmp, 'repo');
    putFile(path.join(repo, 'application.yml'), OLD);
    putFile(local(), OLD);
    const report = newDeliveryReport();
    prepareDockerBotFiles(dockerCompose, bot(), '/host/bot', repo, files(NEW), log, report, {});
    expect(report.failed).toEqual([]);
    expect(fs.readFileSync(local(), 'utf8')).toBe(NEW);
    expect(report.delivered[local()]).toBe(sha(NEW));
    expect(strays(bot())).toEqual([]);
  });
});

// A running container's single-file bind follows the inode, so a write must keep it.
const ino = (p: string) => fs.statSync(p, { bigint: true }).ino;

describe('T-CFGW a config write keeps the inode a running bind holds', () => {
  it('docker Start with the file already holding the body: nothing is rewritten', () => {
    putFile(local(), NEW);
    const before = ino(local());
    const report = (redeliverDockerConfigFiles as any)(dockerCompose, bot(), '/host/bot', files(NEW), newDeliveryReport(), { [local()]: sha(NEW) }, log);
    expect(report.failed).toEqual([]);
    expect(h.renames).toBe(0);
    expect(ino(local())).toBe(before);
    expect(report.delivered[local()]).toBe(sha(NEW));
  });

  it('platform Apply with the file already holding the body: nothing is rewritten', async () => {
    putFile(casaosSrc(), NEW);
    const before = ino(casaosSrc());
    const report = newDeliveryReport();
    await applyUserConfigOverrides(casaosCompose(), 'app1', files(NEW), log, report, { [casaosSrc()]: sha(NEW) });
    expect(report.failed).toEqual([]);
    expect(h.renames).toBe(0);
    expect(ino(casaosSrc())).toBe(before);
  });

  it('docker Start with a changed body: the same inode holds the new body', () => {
    putFile(local(), OLD);
    const before = ino(local());
    const report = (redeliverDockerConfigFiles as any)(dockerCompose, bot(), '/host/bot', files(NEW), newDeliveryReport(), { [local()]: sha(OLD) }, log);
    expect(report.failed).toEqual([]);
    expect(fs.readFileSync(local(), 'utf8')).toBe(NEW);
    expect(ino(local())).toBe(before);
    expect(strays(bot())).toEqual([]);
  });

  it('platform Apply with a changed body: the same inode holds the new body', async () => {
    putFile(casaosSrc(), OLD);
    const before = ino(casaosSrc());
    const report = newDeliveryReport();
    await applyUserConfigOverrides(casaosCompose(), 'app1', files(NEW), log, report, { [casaosSrc()]: sha(OLD) });
    expect(report.failed).toEqual([]);
    expect(fs.readFileSync(casaosSrc(), 'utf8')).toBe(NEW);
    expect(ino(casaosSrc())).toBe(before);
    expect(report.delivered[casaosSrc()]).toBe(sha(NEW));
  });

  it('platform build, write-only bind, changed body: the same inode holds the new body', async () => {
    putFile(writeOnlySrc(), OLD);
    const before = ino(writeOnlySrc());
    const report = await writeConfigFiles('app1', [{ path: '/app/new.yml', body: NEW }], log, newDeliveryReport(), { [writeOnlySrc()]: sha(OLD) });
    expect(report.failed).toEqual([]);
    expect(fs.readFileSync(writeOnlySrc(), 'utf8')).toBe(NEW);
    expect(ino(writeOnlySrc())).toBe(before);
  });

  it('a write into the file that fails halfway puts the old body back and reports the file', () => {
    putFile(local(), OLD);
    h.failInPlace = true;
    const report = (redeliverDockerConfigFiles as any)(dockerCompose, bot(), '/host/bot', files(NEW + NEW + NEW), newDeliveryReport(), { [local()]: sha(OLD) }, log);
    expect(h.failInPlace).toBe(false);
    expect(fs.readFileSync(local(), 'utf8')).toBe(OLD);
    expect(report.failed).toContain('/app/application.yml');
    expect(report.delivered[local()]).toBeUndefined();
    expect(strays(bot())).toEqual([]);
  });

  it('docker build over a file still byte for byte the recorded repo template: no rename, no "Restored" log', () => {
    const repo = path.join(tmp, 'repo');
    putFile(path.join(repo, 'application.yml'), OLD);
    putFile(local(), OLD);
    const before = ino(local());
    const report = newDeliveryReport();
    prepareDockerBotFiles(dockerCompose, bot(), '/host/bot', repo, [], log, report, { [local()]: sha(OLD) });
    expect(report.failed).toEqual([]);
    expect(h.renames).toBe(0);
    expect(ino(local())).toBe(before);
    expect(logs.some((l) => l.includes('Restored'))).toBe(false);
    expect(report.delivered[local()]).toBe(sha(OLD));
  });

  it('docker build over the recorded old repo template takes the new template in the same inode', () => {
    const repo = path.join(tmp, 'repo');
    putFile(path.join(repo, 'application.yml'), NEW);
    putFile(local(), OLD);
    const before = ino(local());
    const report = newDeliveryReport();
    prepareDockerBotFiles(dockerCompose, bot(), '/host/bot', repo, [], log, report, { [local()]: sha(OLD) });
    expect(report.failed).toEqual([]);
    expect(fs.readFileSync(local(), 'utf8')).toBe(NEW);
    expect(ino(local())).toBe(before);
    expect(report.delivered[local()]).toBe(sha(NEW));
    expect(strays(bot())).toEqual([]);
  });

  // Needs root to hand the file to another uid; the main session runs it on Linux.
  it.skipIf(process.platform === 'win32' || process.getuid?.() !== 0)('platform Apply keeps the owner a service gave its config file', async () => {
    putFile(casaosSrc(), OLD);
    fs.chownSync(casaosSrc(), 999, 999);
    const report = newDeliveryReport();
    await applyUserConfigOverrides(casaosCompose(), 'app1', files(NEW), log, report, { [casaosSrc()]: sha(OLD) });
    expect(report.failed).toEqual([]);
    expect(fs.readFileSync(casaosSrc(), 'utf8')).toBe(NEW);
    expect(fs.statSync(casaosSrc()).uid).toBe(999);
    expect(fs.statSync(casaosSrc()).gid).toBe(999);
  });
});
