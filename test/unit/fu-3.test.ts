import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// crash: the next write into a file whose name does not start with a dot (the
// target, not a temp) lands half its bytes and the process "dies": every later
// fs mutation throws until the test resets `dead`. crashOnDotUnlink dies on the
// first removal of a dot file. noLink makes link(2) fail with that code;
// appear writes BOT at the link target first (a file that appeared meanwhile).
// eio: the next write into a target lands half its bytes and fails EIO, and every
// later write to that fd fails EIO too; unlinkPlain makes removing a target fail.
const h = vi.hoisted(() => ({
  crash: false, crashOnDotUnlink: false, dead: false, noLink: '' as string, appear: '' as string,
  plainFds: new Set<number>(), links: 0, eio: false, eioFd: -1, unlinkPlain: '' as string,
}));

vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>();
  const died = () => Object.assign(new Error('the process died'), { code: 'EDIED' });
  const guard = <T extends (...a: any[]) => any>(fn: T): T => ((...a: any[]) => { if (h.dead) throw died(); return fn(...a); }) as T;
  const isDot = (p: unknown) => /(^|[\\/])\.[^\\/]*$/.test(String(p));
  const wrapped = {
    ...real,
    openSync: guard((p: any, ...rest: any[]) => {
      const fd = (real.openSync as any)(p, ...rest);
      if (isDot(p)) h.plainFds.delete(fd); else h.plainFds.add(fd);
      return fd;
    }),
    writeSync: guard((fd: any, buf: any, off?: any, len?: any, pos?: any) => {
      const eio = () => Object.assign(new Error('EIO: i/o error, write'), { code: 'EIO' });
      if (fd === h.eioFd) throw eio();
      if (h.eio && h.plainFds.has(fd) && Buffer.isBuffer(buf) && typeof off === 'number' && typeof len === 'number') {
        h.eio = false;
        h.eioFd = fd;
        (real.writeSync as any)(fd, buf, off, Math.floor(len / 2), pos);
        throw eio();
      }
      if (h.crash && h.plainFds.has(fd) && Buffer.isBuffer(buf) && typeof off === 'number' && typeof len === 'number') {
        h.crash = false;
        (real.writeSync as any)(fd, buf, off, Math.floor(len / 2), pos);
        h.dead = true;
        throw died();
      }
      return (real.writeSync as any)(fd, buf, off, len, pos);
    }),
    unlinkSync: guard((p: any) => {
      if (h.crashOnDotUnlink && isDot(p)) { h.crashOnDotUnlink = false; h.dead = true; throw died(); }
      if (h.unlinkPlain && !isDot(p)) throw Object.assign(new Error(`${h.unlinkPlain}: resource busy, unlink '${p}'`), { code: h.unlinkPlain });
      return real.unlinkSync(p);
    }),
    linkSync: guard((a: any, b: any) => {
      h.links++;
      if (h.appear) real.writeFileSync(b, h.appear);
      if (h.noLink) throw Object.assign(new Error(`${h.noLink}: operation not permitted, link '${a}' -> '${b}'`), { code: h.noLink });
      return real.linkSync(a, b);
    }),
    renameSync: guard(real.renameSync),
    ftruncateSync: guard(real.ftruncateSync),
    fsyncSync: guard(real.fsyncSync),
    fchmodSync: guard(real.fchmodSync),
    rmdirSync: guard(real.rmdirSync),
    mkdirSync: guard(real.mkdirSync),
    writeFileSync: guard(real.writeFileSync),
  };
  return { ...wrapped, default: wrapped };
});

import {
  applyUserConfigOverrides, createVolumeDirectories, newDeliveryReport, prepareDockerBotFiles, redeliverConfigFiles,
  redeliverDockerConfigFiles,
} from '../../src/templates/pcsProcessing';
import { detectBotType } from '../../src/detection';

const OLD = 'token: the-old-delivered-body\nkeep: every byte of it\n';
const NEW = 'token: the-new-body\nmore: lines than before\nand: more\n';
const BOT = 'token: the-bot-wrote-this\n';

let tmp: string;
let dataRoot: string;
let logs: string[];
const savedDataRoot = process.env.DATA_ROOT;
const fwd = (p: string) => p.replace(/\\/g, '/');
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const log = (m: string) => { logs.push(m); };

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fu-3-'));
  dataRoot = fwd(path.join(tmp, 'DATA'));
  process.env.DATA_ROOT = dataRoot;
  logs = [];
  Object.assign(h, { crash: false, crashOnDotUnlink: false, dead: false, noLink: '', appear: '', links: 0, eio: false, eioFd: -1, unlinkPlain: '' });
});

afterEach(() => {
  h.dead = false;
  if (savedDataRoot === undefined) delete process.env.DATA_ROOT; else process.env.DATA_ROOT = savedDataRoot;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const bot = () => path.join(tmp, 'bot');
const local = (name = 'application.yml') => path.join(bot(), name);
const dockerCompose = 'services:\n  app:\n    image: x\n    volumes:\n      - /host/bot/application.yml:/app/application.yml\n      - /host/bot/second.yml:/app/second.yml\n';
const files = (body: string) => [{ path: '/app/application.yml', body }];
const dots = (dir: string) => fs.readdirSync(dir).filter((n) => n.startsWith('.'));
const putFile = (p: string, body: string) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); };
const casaosSrc = () => `${dataRoot}/AppData/app1/application.yml`;
const casaosCompose = () => `services:\n  app:\n    image: x\n    volumes:\n      - type: bind\n        source: ${casaosSrc()}\n        target: /app/application.yml\n`;

// After the crash: the complete new body still exists beside the target, the
// file is reported failed, and one log line names the target and that copy.
function expectBothKept(target: string, report: { failed: string[] }, failedName: string, tag: string): void {
  const dir = path.dirname(target);
  const copies = dots(dir).filter((n) => fs.readFileSync(path.join(dir, n), 'utf8') === NEW);
  expect(copies.length).toBe(1);
  expect(fs.existsSync(target)).toBe(true);
  expect(report.failed).toContain(failedName);
  const copy = fwd(path.join(dir, copies[0]));
  expect(logs.some((l) => l.includes(tag) && fwd(l).includes(fwd(target)) && fwd(l).includes(copy))).toBe(true);
}

describe('B01-1r a crash inside the in-place rewrite never loses the only complete copy', () => {
  it('docker Start: the next Start keeps the target and the complete copy and names both', () => {
    putFile(local(), OLD);
    const delivered = { [local()]: sha(OLD) };
    h.crash = true;
    (redeliverDockerConfigFiles as any)(dockerCompose, bot(), '/host/bot', files(NEW), newDeliveryReport(), delivered, log);
    expect(h.dead).toBe(true);
    h.dead = false;
    expect(fs.readFileSync(local(), 'utf8')).not.toBe(NEW);
    logs = [];
    const report = (redeliverDockerConfigFiles as any)(dockerCompose, bot(), '/host/bot', files(NEW), newDeliveryReport(), delivered, log);
    expectBothKept(local(), report, '/app/application.yml', '[Docker]');
    const again = (redeliverDockerConfigFiles as any)(dockerCompose, bot(), '/host/bot', files(NEW), newDeliveryReport(), delivered, log);
    expectBothKept(local(), again, '/app/application.yml', '[Docker]');
  });

  it('platform Start: the next Start keeps the target and the complete copy and names both in a [PCS] line', async () => {
    putFile(casaosSrc(), OLD);
    const delivered = { [casaosSrc()]: sha(OLD) };
    h.crash = true;
    await redeliverConfigFiles(casaosCompose(), 'app1', files(NEW), log, newDeliveryReport(), delivered);
    expect(h.dead).toBe(true);
    h.dead = false;
    logs = [];
    const report = await redeliverConfigFiles(casaosCompose(), 'app1', files(NEW), log, newDeliveryReport(), delivered);
    expectBothKept(casaosSrc(), report, '/app/application.yml', '[PCS]');
  });

  it('docker build restoring a repo template: the next build keeps the complete copy instead of deleting it', () => {
    const repo = path.join(tmp, 'repo');
    putFile(path.join(repo, 'application.yml'), NEW);
    putFile(local(), OLD);
    const restore = { [local()]: sha(OLD) };
    h.crash = true;
    prepareDockerBotFiles(dockerCompose, bot(), '/host/bot', repo, [], log, newDeliveryReport(), restore);
    expect(h.dead).toBe(true);
    h.dead = false;
    logs = [];
    const report = newDeliveryReport();
    prepareDockerBotFiles(dockerCompose, bot(), '/host/bot', repo, [], log, report, restore);
    expectBothKept(local(), report, local(), '[Docker]');
  });

  it('a crash after the target took the whole body: the next Start finishes cleanly and leaves no temp', () => {
    putFile(local(), OLD);
    const delivered = { [local()]: sha(OLD) };
    h.crashOnDotUnlink = true;
    (redeliverDockerConfigFiles as any)(dockerCompose, bot(), '/host/bot', files(NEW), newDeliveryReport(), delivered, log);
    h.dead = false;
    expect(fs.readFileSync(local(), 'utf8')).toBe(NEW);
    const report = (redeliverDockerConfigFiles as any)(dockerCompose, bot(), '/host/bot', files(NEW), newDeliveryReport(), delivered, log);
    expect(report.failed).toEqual([]);
    expect(fs.readFileSync(local(), 'utf8')).toBe(NEW);
    expect(dots(bot())).toEqual([]);
  });

  it('a crash before the target was touched: the old body is intact and the next Start delivers', () => {
    putFile(local(), OLD);
    const delivered = { [local()]: sha(OLD) };
    h.dead = true;
    (redeliverDockerConfigFiles as any)(dockerCompose, bot(), '/host/bot', files(NEW), newDeliveryReport(), delivered, log);
    h.dead = false;
    expect(fs.readFileSync(local(), 'utf8')).toBe(OLD);
    const report = (redeliverDockerConfigFiles as any)(dockerCompose, bot(), '/host/bot', files(NEW), newDeliveryReport(), delivered, log);
    expect(report.failed).toEqual([]);
    expect(fs.readFileSync(local(), 'utf8')).toBe(NEW);
    expect(dots(bot())).toEqual([]);
  });

  it('once the operator puts a body at the target that is neither, the copy is still kept and named', () => {
    putFile(local(), OLD);
    const delivered = { [local()]: sha(OLD) };
    h.crash = true;
    (redeliverDockerConfigFiles as any)(dockerCompose, bot(), '/host/bot', files(NEW), newDeliveryReport(), delivered, log);
    h.dead = false;
    fs.writeFileSync(local(), BOT);
    logs = [];
    const report = (redeliverDockerConfigFiles as any)(dockerCompose, bot(), '/host/bot', files(NEW), newDeliveryReport(), delivered, log);
    expectBothKept(local(), report, '/app/application.yml', '[Docker]');
    expect(fs.readFileSync(local(), 'utf8')).toBe(BOT);
  });
});

describe('B01-1r a write that fails inside the target never says nothing was changed', () => {
  const failedLine = () => logs.filter((l) => fwd(l).includes(fwd(local())) && l.includes('.smdb-ready.'));

  it('an in-place rewrite whose restore also fails names the write error and does not claim the file is untouched', () => {
    putFile(local(), OLD);
    h.eio = true;
    const report = (redeliverDockerConfigFiles as any)(dockerCompose, bot(), '/host/bot', files(NEW), newDeliveryReport(), { [local()]: sha(OLD) }, log);
    expect(report.failed).toContain('/app/application.yml');
    const content = fs.readFileSync(local(), 'utf8');
    expect(content === OLD || content === NEW).toBe(false);
    expect(failedLine().length).toBe(1);
    expect(failedLine()[0]).toContain('EIO');
    expect(failedLine()[0]).not.toContain('Nothing was changed');
  });

  it('a fallback create that fails and cannot remove its partial file names the write error', () => {
    h.noLink = 'EPERM';
    h.eio = true;
    h.unlinkPlain = 'EBUSY';
    const report = (redeliverDockerConfigFiles as any)(dockerCompose, bot(), '/host/bot', files(NEW), newDeliveryReport(), {}, log);
    expect(report.failed).toContain('/app/application.yml');
    expect(failedLine().length).toBe(1);
    expect(failedLine()[0]).toContain('EIO');
    expect(failedLine()[0]).not.toContain('Nothing was changed');
  });

  it('the next delivery after a crash says it changed neither file', () => {
    putFile(local(), OLD);
    const delivered = { [local()]: sha(OLD) };
    h.crash = true;
    (redeliverDockerConfigFiles as any)(dockerCompose, bot(), '/host/bot', files(NEW), newDeliveryReport(), delivered, log);
    h.dead = false;
    logs = [];
    (redeliverDockerConfigFiles as any)(dockerCompose, bot(), '/host/bot', files(NEW), newDeliveryReport(), delivered, log);
    expect(failedLine().length).toBe(1);
    expect(failedLine()[0]).toContain('This delivery changed neither file');
  });
});

describe('T-CFGWl a filesystem without hard links still takes a new file', () => {
  for (const code of ['EPERM', 'ENOTSUP', 'EXDEV']) {
    it(`docker Start with link(2) failing ${code}: both new files land and the fallback is logged once`, () => {
      h.noLink = code;
      const report = (redeliverDockerConfigFiles as any)(dockerCompose, bot(), '/host/bot',
        [{ path: '/app/application.yml', body: NEW }, { path: '/app/second.yml', body: OLD }], newDeliveryReport(), {}, log);
      expect(report.failed).toEqual([]);
      expect(fs.readFileSync(local(), 'utf8')).toBe(NEW);
      expect(fs.readFileSync(local('second.yml'), 'utf8')).toBe(OLD);
      expect(report.delivered[local()]).toBe(sha(NEW));
      expect(logs.filter((l) => l.includes('hard link')).length).toBe(1);
      expect(dots(bot())).toEqual([]);
    });
  }

  it('docker build seeding a repo template with link(2) failing EPERM: the template lands', () => {
    const repo = path.join(tmp, 'repo');
    putFile(path.join(repo, 'application.yml'), NEW);
    h.noLink = 'EPERM';
    const report = newDeliveryReport();
    prepareDockerBotFiles(dockerCompose, bot(), '/host/bot', repo, [], log, report, {});
    expect(report.failed).toEqual([]);
    expect(fs.readFileSync(local(), 'utf8')).toBe(NEW);
    expect(logs.filter((l) => l.includes('hard link')).length).toBe(1);
  });

  it('platform build seeding a repo template with link(2) failing EPERM: the template lands', async () => {
    const repo = path.join(tmp, 'repo');
    putFile(path.join(repo, 'application.yml'), NEW);
    h.noLink = 'EPERM';
    const report = await createVolumeDirectories(casaosCompose(), 'app1', repo, log, newDeliveryReport(), {});
    expect(report.failed).toEqual([]);
    expect(fs.readFileSync(casaosSrc(), 'utf8')).toBe(NEW);
    expect(logs.filter((l) => l.includes('[PCS]') && l.includes('hard link')).length).toBe(1);
  });

  it('a file that appears at the target before the fallback create is kept', () => {
    h.noLink = 'EPERM';
    h.appear = BOT;
    const report = (redeliverDockerConfigFiles as any)(dockerCompose, bot(), '/host/bot', files(NEW), newDeliveryReport(), {}, log);
    expect(fs.readFileSync(local(), 'utf8')).toBe(BOT);
    expect(report.failed).toContain('/app/application.yml');
  });

  it('a crash inside the fallback create keeps the partial file and the complete copy and names both', () => {
    h.noLink = 'EPERM';
    h.crash = true;
    (redeliverDockerConfigFiles as any)(dockerCompose, bot(), '/host/bot', files(NEW), newDeliveryReport(), {}, log);
    expect(h.dead).toBe(true);
    h.dead = false;
    logs = [];
    const report = (redeliverDockerConfigFiles as any)(dockerCompose, bot(), '/host/bot', files(NEW), newDeliveryReport(), {}, log);
    expectBothKept(local(), report, '/app/application.yml', '[Docker]');
  });

  it('with hard links working, the fallback is not used or logged', () => {
    const report = (redeliverDockerConfigFiles as any)(dockerCompose, bot(), '/host/bot', files(NEW), newDeliveryReport(), {}, log);
    expect(report.failed).toEqual([]);
    expect(h.links).toBe(1);
    expect(logs.some((l) => l.includes('hard link'))).toBe(false);
  });
});

describe('T-WRITABLEc a drive-letter source splits at the separator, not the drive colon', () => {
  // On Linux dataRoot has no drive letter and these rows pass on the old split too; on win32 they are the defect.
  const stringCompose = () => `services:\n  app:\n    image: x\n    volumes:\n      - "${casaosSrc()}:/app/application.yml:rw"\n`;

  it('platform Apply finds the declared bind of a string volume', async () => {
    putFile(casaosSrc(), OLD);
    const report = newDeliveryReport();
    const handled = await applyUserConfigOverrides(stringCompose(), 'app1', files(NEW), log, report, { [casaosSrc()]: sha(OLD) });
    expect([...handled]).toEqual(['/app/application.yml']);
    expect(fs.readFileSync(casaosSrc(), 'utf8')).toBe(NEW);
  });

  it('platform build prepares the source of a string volume', async () => {
    const repo = path.join(tmp, 'repo');
    putFile(path.join(repo, 'application.yml'), NEW);
    const report = await createVolumeDirectories(stringCompose(), 'app1', repo, log, newDeliveryReport(), {});
    expect(report.failed).toEqual([]);
    expect(fs.readFileSync(casaosSrc(), 'utf8')).toBe(NEW);
  });

  it('detection reads the in-container path of a bind whose source has a drive letter', () => {
    const repo = path.join(tmp, 'repo');
    putFile(path.join(repo, 'config.json.example'), '{ "token": "" }\n');
    putFile(path.join(repo, 'docker-compose.yml'), 'services:\n  app:\n    image: x\n    volumes:\n      - \'C:\\cfg\\config.json:/app/config.json:ro\'\n');
    const cf = detectBotType(repo).configFiles.find((c) => c.targetName === 'config.json');
    expect(cf?.inContainerPath).toBe('/app/config.json');
  });

  it('detection still reads a relative bind with a mode suffix', () => {
    const repo = path.join(tmp, 'repo');
    putFile(path.join(repo, 'cfg', 'app.yml'), 'key: value\n');
    putFile(path.join(repo, 'docker-compose.yml'), 'services:\n  app:\n    image: x\n    volumes:\n      - ./cfg/app.yml:/opt/app.yml:ro\n');
    const cf = detectBotType(repo).configFiles.find((c) => c.targetName === 'app.yml');
    expect(cf?.inContainerPath).toBe('/opt/app.yml');
  });
});
