import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'b06-3-'));
  process.env.DATA_DIR = dir;
  return { dir };
});

vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>();
  const mocked = {
    ...real,
    writeFileSync: vi.fn(real.writeFileSync),
    chmodSync: vi.fn(real.chmodSync),
    mkdirSync: vi.fn(real.mkdirSync),
    createWriteStream: vi.fn(real.createWriteStream),
    statSync: vi.fn(real.statSync),
  };
  return { ...mocked, default: mocked };
});

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const execFile = vi.fn((_cmd: string, _args: string[], optsOrCb: unknown, maybeCb?: unknown) =>
    ((typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as (err: Error | null, stdout: string) => void)(null, 'true\n'));
  const spawn = vi.fn(() => {
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: () => void };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    setTimeout(() => {
      child.stdout.end('PGDMP fake dump');
      child.stdout.on('end', () => setTimeout(() => child.emit('close', 0), 5));
    }, 5);
    return child;
  });
  const heldSpawn = (await import('./dump-fake')).withDumpHolder(spawn as any);
  return { ...real, execFile, spawn: heldSpawn, default: { ...real, execFile, spawn: heldSpawn } };
});

const detector = vi.hoisted(() => ({ mode: 'docker' as 'docker' | 'casaos' }));
vi.mock('../../src/casaos/detector', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/casaos/detector')>()),
  getDeploymentMode: vi.fn(async () => detector.mode),
}));

import * as fs from 'fs';
import * as path from 'path';
import { writeComposeFile } from '../../src/templates/compose';
import { runFleetDump } from '../../src/instance/fleetBackup';
import { syncComposeEnvVars, writeDockerEnvFile } from '../../src/docker/containerManager';
import { writeEnvFile } from '../../src/env/manager';
import { dataRootModeWarning, warnOnOpenDataRoot, writePrivateFile } from '../../src/config/fileModes';

const realStat = (await vi.importActual<typeof import('fs')>('fs')).statSync;
const repo = path.resolve(__dirname, '../..');
const onWindows = process.platform === 'win32';

const writeCalls = () => (fs.writeFileSync as unknown as ReturnType<typeof vi.fn>).mock.calls;
const chmodCalls = () => (fs.chmodSync as unknown as ReturnType<typeof vi.fn>).mock.calls;
const mkdirCalls = () => (fs.mkdirSync as unknown as ReturnType<typeof vi.fn>).mock.calls;
const streamCalls = () => (fs.createWriteStream as unknown as ReturnType<typeof vi.fn>).mock.calls;

const modeOf = (opts: unknown): number | undefined =>
  opts && typeof opts === 'object' ? (opts as { mode?: number }).mode : undefined;

beforeEach(() => { vi.clearAllMocks(); });
afterAll(() => { fs.rmSync(tmp.dir, { recursive: true, force: true }); });

describe('R19-J4: a bot compose is private to the manager', () => {
  it('creates the compose with mode 600 and tightens one already there', () => {
    const botDir = path.join(tmp.dir, 'bots', 'b1');
    fs.mkdirSync(botDir, { recursive: true });
    const composePath = path.join(botDir, 'docker-compose.yml');
    fs.writeFileSync(composePath, 'old', { mode: 0o644 });
    vi.clearAllMocks();

    writeComposeFile(botDir, 'services: {}\n');

    const write = writeCalls().find(c => c[0] === `${composePath}.tmp`);
    expect(modeOf(write?.[2])).toBe(0o600);
    expect(chmodCalls()).toContainEqual([`${composePath}.tmp`, 0o600]);
    if (!onWindows) expect(fs.statSync(composePath).mode & 0o777).toBe(0o600);
  });

  it('writePrivateFile tightens an existing group-readable file', () => {
    const p = path.join(tmp.dir, 'secret.env');
    fs.writeFileSync(p, 'A=1\n', { mode: 0o644 });
    vi.clearAllMocks();
    writePrivateFile(p, 'A=2\n');
    expect(modeOf(writeCalls()[0]?.[2])).toBe(0o600);
    expect(chmodCalls()).toContainEqual([`${p}.tmp`, 0o600]);
    expect(fs.readFileSync(p, 'utf-8')).toBe('A=2\n');
    if (!onWindows) expect(fs.statSync(p).mode & 0o777).toBe(0o600);
  });
});

describe('R19-J4: the docker-mode .env and compose rewrite are private', () => {
  it('writeDockerEnvFile writes with mode 600 and tightens one already there', () => {
    const botDir = path.join(tmp.dir, 'bots', 'b3');
    fs.mkdirSync(botDir, { recursive: true });
    const envFile = path.join(botDir, '.env');
    fs.writeFileSync(envFile, 'OLD=1\n', { mode: 0o644 });
    vi.clearAllMocks();

    writeDockerEnvFile(botDir, { TOKEN: 'x' });

    expect(fs.readFileSync(envFile, 'utf-8')).toBe('TOKEN=x\n');
    expect(modeOf(writeCalls().find(c => c[0] === `${envFile}.tmp`)?.[2])).toBe(0o600);
    expect(chmodCalls()).toContainEqual([`${envFile}.tmp`, 0o600]);
    if (!onWindows) expect(fs.statSync(envFile).mode & 0o777).toBe(0o600);
  });

  const seedCompose = (id: string) => {
    const dir = path.join(tmp.dir, 'bots', id);
    fs.mkdirSync(dir, { recursive: true });
    const composePath = path.join(dir, 'docker-compose.yml');
    fs.writeFileSync(composePath, 'services:\n  app:\n    image: x\n', { mode: 0o644 });
    vi.clearAllMocks();
    return composePath;
  };
  const instanceFor = (id: string): any => ({ id, displayName: id, envVars: { TOKEN: 'x' } });

  it('syncComposeEnvVars rewrites the bot-dir compose at mode 600', () => {
    const composePath = seedCompose('b4');
    syncComposeEnvVars(instanceFor('b4'), composePath, true);
    expect(fs.readFileSync(composePath, 'utf-8')).toContain('TOKEN');
    expect(modeOf(writeCalls().find(c => c[0] === `${composePath}.tmp`)?.[2])).toBe(0o600);
    expect(chmodCalls()).toContainEqual([`${composePath}.tmp`, 0o600]);
    if (!onWindows) expect(fs.statSync(composePath).mode & 0o777).toBe(0o600);
  });

  it('syncComposeEnvVars leaves the CasaOS metadata copy at the mode it has', () => {
    const composePath = seedCompose('b5');
    const before = realStat(composePath).mode & 0o7777;
    syncComposeEnvVars(instanceFor('b5'), composePath);
    expect(fs.readFileSync(composePath, 'utf-8')).toContain('TOKEN');
    expect(modeOf(writeCalls().find(c => c[0] === `${composePath}.tmp`)?.[2])).toBe(before);
    expect(chmodCalls().some(c => c[0] === `${composePath}.tmp` && c[1] !== before)).toBe(false);
  });
});

describe('R19-J4: the env store .env is private to the manager', () => {
  it('writeEnvFile writes with mode 600 and tightens one already there', () => {
    const envDir = path.join(tmp.dir, 'bots', 'b2', 'env');
    fs.mkdirSync(envDir, { recursive: true });
    const envFile = path.join(envDir, '.env');
    fs.writeFileSync(envFile, 'OLD=1', { mode: 0o644 });
    vi.clearAllMocks();

    expect(writeEnvFile('b2')).toBe(envFile);

    const write = writeCalls().find(c => c[0] === `${envFile}.tmp`);
    expect(modeOf(write?.[2])).toBe(0o600);
    expect(chmodCalls()).toContainEqual([`${envFile}.tmp`, 0o600]);
    if (!onWindows) expect(fs.statSync(envFile).mode & 0o777).toBe(0o600);
  });
});

describe('R19-J4: fleet dumps are private to the manager', () => {
  it('writes the dump with mode 600 inside a mode 700 directory', async () => {
    const instance: any = { id: 'bot-x', fleetDb: { containerName: 'pg', user: 'u', db: 'd' } };
    const res = await runFleetDump(instance);
    expect(res.success).toBe(true);

    const dir = path.join(tmp.dir, 'backups', 'bot-x', 'fleet-postgres');
    const mk = mkdirCalls().find(c => c[0] === dir);
    expect(modeOf(mk?.[1])).toBe(0o700);
    expect(chmodCalls()).toContainEqual([dir, 0o700]);

    const stream = streamCalls()[0];
    expect(String(stream?.[0]).startsWith(dir)).toBe(true);
    expect(modeOf(stream?.[1])).toBe(0o600);

    if (!onWindows) {
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(path.join(dir, res.file!)).mode & 0o777).toBe(0o600);
    }
  });
});

describe('R19-J4: boot warning when the data root is open to other accounts', () => {
  it('warns for a group- or world-accessible root and names the host path', () => {
    const w = dataRootModeWarning('/data/data', 0o40755, '/opt/dbm/data', 'linux');
    expect(w).toContain('/opt/dbm/data');
    expect(w).toContain('chmod 700 /opt/dbm/data');
    expect(w).toContain('755');
    expect(dataRootModeWarning('/data/data', 0o40750, undefined, 'linux')).toContain('/data/data');
  });

  it('stays quiet for a 700 root, a Windows host path and a Windows run', () => {
    expect(dataRootModeWarning('/data/data', 0o40700, '/opt/dbm/data', 'linux')).toBeNull();
    expect(dataRootModeWarning('/data/data', 0o40777, 'C:/dbm/data', 'linux')).toBeNull();
    expect(dataRootModeWarning('D:\\dbm\\data', 0o40666, undefined, 'win32')).toBeNull();
  });

  describe('warnOnOpenDataRoot at boot', () => {
    const statMock = () => fs.statSync as unknown as ReturnType<typeof vi.fn>;
    const run = async (mode: number, hostDataDir: string | undefined, deployment: 'docker' | 'casaos') => {
      detector.mode = deployment;
      statMock().mockReturnValueOnce({ mode } as fs.Stats);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await warnOnOpenDataRoot('/data/data', hostDataDir, 'linux');
        return warn.mock.calls.map(c => String(c[0]));
      } finally {
        warn.mockRestore();
        statMock().mockReset();
        statMock().mockImplementation(realStat);
        detector.mode = 'docker';
      }
    };

    it('warns for an open root', async () => {
      const out = await run(0o40755, '/opt/dbm/data', 'docker');
      expect(out).toHaveLength(1);
      expect(out[0]).toContain('chmod 700 /opt/dbm/data');
    });

    it('stays quiet for a 700 root', async () => {
      expect(await run(0o40700, '/opt/dbm/data', 'docker')).toEqual([]);
    });

    it('skips the check in casaos mode', async () => {
      expect(await run(0o40755, undefined, 'casaos')).toEqual([]);
      expect(statMock()).not.toHaveBeenCalled();
    });

    it('stays quiet for a Windows host path', async () => {
      expect(await run(0o40777, 'C:/dbm/data', 'docker')).toEqual([]);
    });
  });
});

describe('R19-J4: the README manual path creates a private data root', () => {
  it('step 1 makes the data dir mode 700, as setup.sh does', () => {
    const readme = fs.readFileSync(path.join(repo, 'README.md'), 'utf-8');
    const step = readme.slice(readme.indexOf('1. **Host prep:**'), readme.indexOf('2. **Authelia secrets**'));
    expect(step).toMatch(/chmod 700 \/opt\/dbm\/data/);
  });
});
