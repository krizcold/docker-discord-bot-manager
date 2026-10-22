import { afterAll, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'b04-3-owner-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = dir;
  process.env.PUID = '1000';
  process.env.PGID = '1000';
  return { dir };
});

import * as fs from 'fs';
import * as path from 'path';
import { writePrivateFile } from '../../src/config/fileModes';
import { writeFileKeepingOwner } from '../../src/config/storeFile';
import { syncComposeEnvVars } from '../../src/docker/containerManager';
import { saveToCasaOSMetadata } from '../../src/templates/pcsProcessing';

afterAll(() => { fs.rmSync(tmp.dir, { recursive: true, force: true }); });

const asRoot = process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() === 0;
// Changing a file's owner needs Linux and root; elsewhere the owner rows cannot run.
const rootIt = asRoot ? it : it.skip;

let n = 0;
function seeded(content: string, uid: number, gid: number, mode: number): string {
  const dir = path.join(tmp.dir, `case${n++}`);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'docker-compose.yml');
  fs.writeFileSync(p, content);
  fs.chownSync(p, uid, gid);
  fs.chmodSync(p, mode);
  return p;
}

const owner = (p: string) => { const s = fs.statSync(p); return { uid: s.uid, gid: s.gid, mode: s.mode & 0o7777 }; };

describe('B04-3 a tmp plus rename write keeps the replaced file owner (Linux, root)', () => {
  rootIt('writePrivateFile keeps uid 1000 and mode 600', () => {
    const p = seeded('A=1\n', 1000, 1000, 0o600);
    writePrivateFile(p, 'A=2\n');
    expect(fs.readFileSync(p, 'utf-8')).toBe('A=2\n');
    expect(owner(p)).toEqual({ uid: 1000, gid: 1000, mode: 0o600 });
  });

  rootIt('rewriteComposeFile (an env sync, privateFile false) keeps the owner and mode', () => {
    const p = seeded('services:\n  app:\n    image: x\n    environment:\n      FOO: "0"\n', 1000, 1000, 0o600);
    syncComposeEnvVars({ id: 'o1', name: 'o1', envVars: { FOO: '1' } } as any, p, false);
    const text = fs.readFileSync(p, 'utf-8');
    expect(text).toMatch(/FOO: "?1"?/);
    expect(text).not.toContain('FOO: "0"');
    expect(owner(p)).toEqual({ uid: 1000, gid: 1000, mode: 0o600 });
  });

  rootIt('saveToCasaOSMetadata keeps a compose owned by another uid', async () => {
    const dir = path.join(tmp.dir, 'AppData', 'casaos', 'apps', 'ownapp');
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, 'docker-compose.yml');
    fs.writeFileSync(p, 'old');
    fs.chownSync(p, 2000, 2000);
    fs.chmodSync(p, 0o640);
    await saveToCasaOSMetadata('ownapp', 'services: {}\n', () => {});
    expect(fs.readFileSync(p, 'utf-8')).toBe('services: {}\n');
    expect(owner(p)).toEqual({ uid: 2000, gid: 2000, mode: 0o640 });
  });

  rootIt('a new file keeps the default owner', () => {
    const p = path.join(tmp.dir, 'fresh.env');
    writePrivateFile(p, 'A=1\n');
    expect(owner(p)).toEqual({ uid: 0, gid: 0, mode: 0o600 });
  });
});

describe('B04-3 the owner-keeping write on any platform', () => {
  it('creates a new file and leaves no tmp behind', () => {
    const p = path.join(tmp.dir, 'new.yml');
    writeFileKeepingOwner(p, 'x');
    expect(fs.readFileSync(p, 'utf-8')).toBe('x');
    expect(fs.existsSync(`${p}.tmp`)).toBe(false);
  });

  const linkIt = process.platform === 'win32' ? it.skip : it;
  // Symlinks need privileges on Windows.
  linkIt('a symlinked path is written through, the link stays a link', () => {
    const real = path.join(tmp.dir, 'real.yml');
    const link = path.join(tmp.dir, 'link.yml');
    fs.writeFileSync(real, 'old');
    fs.symlinkSync(real, link);
    writeFileKeepingOwner(link, 'new');
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(real, 'utf-8')).toBe('new');
  });
});
