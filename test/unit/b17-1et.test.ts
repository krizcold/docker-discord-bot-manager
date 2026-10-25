import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'b17-1et-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = dir;
  return { dir, chmodFaults: new Set<string>(), unlinkFaults: new Set<string>(), writeFaults: new Set<string>() };
});

vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>();
  const nodePath = require('path') as typeof import('path');
  const hit = (set: Set<string>, p: unknown) => typeof p === 'string' && set.has(nodePath.resolve(p));
  const fault = (code: string, p: unknown) => Object.assign(new Error(`${code}: injected, '${p}'`), { code });
  const wrapped = {
    ...real,
    chmodSync: (p: any, ...rest: any[]) => {
      if (hit(h.chmodFaults, p)) throw fault('EPERM', p);
      return (real.chmodSync as any)(p, ...rest);
    },
    unlinkSync: (p: any) => {
      if (hit(h.unlinkFaults, p)) throw fault('EBUSY', p);
      return real.unlinkSync(p);
    },
    writeFileSync: (p: any, data: any, ...rest: any[]) => {
      if (hit(h.writeFaults, p)) {
        (real.writeFileSync as any)(p, String(data).slice(0, 3), ...rest);
        throw fault('ENOSPC', p);
      }
      return (real.writeFileSync as any)(p, data, ...rest);
    },
  };
  return { ...wrapped, default: wrapped };
});

import * as fs from 'fs';
import * as path from 'path';
import { writeFileAtomic, writeFileKeepingOwner } from '../../src/config/storeFile';
import { writePrivateFile } from '../../src/config/fileModes';

afterAll(() => { fs.rmSync(h.dir, { recursive: true, force: true }); });
beforeEach(() => { h.chmodFaults.clear(); h.unlinkFaults.clear(); h.writeFaults.clear(); });

let n = 0;
const caseDir = () => { const d = path.join(h.dir, `case${n++}`); fs.mkdirSync(d, { recursive: true }); return d; };

const writers: Array<[string, (p: string, data: string) => void]> = [
  ['writeFileKeepingOwner', (p, d) => writeFileKeepingOwner(p, d)],
  ['writeFileKeepingOwner with a mode', (p, d) => writeFileKeepingOwner(p, d, 0o600)],
  ['writePrivateFile', writePrivateFile],
  ['writeFileAtomic', (p, d) => writeFileAtomic(p, d)],
  ['writeFileAtomic with a mode', (p, d) => writeFileAtomic(p, d, 0o600)],
];

describe('B17-1et a failed replace removes its tmp file and throws the original error', () => {
  for (const [name, write] of writers) {
    it(`${name}: a rename that throws (a directory at the target) leaves no tmp, the directory unchanged`, () => {
      const target = path.join(caseDir(), '.env');
      fs.mkdirSync(target);
      fs.writeFileSync(path.join(target, 'inside'), 'kept');
      let thrown: any = null;
      try { write(target, 'TOKEN=secret\n'); } catch (err) { thrown = err; }
      expect(thrown).not.toBeNull();
      expect(['EISDIR', 'EPERM', 'ENOTEMPTY', 'EEXIST']).toContain(thrown.code);
      expect(thrown.syscall).toBe('rename');
      expect(fs.existsSync(`${target}.tmp`)).toBe(false);
      expect(fs.statSync(target).isDirectory()).toBe(true);
      expect(fs.readFileSync(path.join(target, 'inside'), 'utf-8')).toBe('kept');
    });

    it(`${name}: a tmp write that fails part way leaves no tmp, the target unchanged`, () => {
      const target = path.join(caseDir(), '.env');
      fs.writeFileSync(target, 'TOKEN=old\n');
      h.writeFaults.add(path.resolve(`${target}.tmp`));
      expect(() => write(target, 'TOKEN=secret\n')).toThrow(/ENOSPC/);
      expect(fs.existsSync(`${target}.tmp`)).toBe(false);
      expect(fs.readFileSync(target, 'utf-8')).toBe('TOKEN=old\n');
    });

    it(`${name}: a write that succeeds leaves no tmp`, () => {
      const target = path.join(caseDir(), '.env');
      fs.writeFileSync(target, 'TOKEN=old\n');
      write(target, 'TOKEN=new\n');
      expect(fs.readFileSync(target, 'utf-8')).toBe('TOKEN=new\n');
      expect(fs.existsSync(`${target}.tmp`)).toBe(false);
    });
  }

  for (const [name, write] of writers.filter(([n]) => n.startsWith('writeFileKeepingOwner') || n === 'writePrivateFile')) {
    it(`${name}: a chmod that fails is logged with [Files] and the write still lands`, () => {
      const target = path.join(caseDir(), '.env');
      fs.writeFileSync(target, 'TOKEN=old\n');
      h.chmodFaults.add(path.resolve(`${target}.tmp`));
      const mode = name === 'writeFileKeepingOwner' ? (fs.statSync(target).mode & 0o7777).toString(8) : '600';
      const warns = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        write(target, 'TOKEN=secret\n');
        const logged = warns.mock.calls.map(c => c.join(' ')).join('\n');
        expect(logged).toMatch(/^\[Files\] /m);
        expect(logged).toContain(target);
        expect(logged).toContain(`mode ${mode} `);
        expect(logged).toContain('EPERM');
        expect(fs.readFileSync(target, 'utf-8')).toBe('TOKEN=secret\n');
        expect(fs.existsSync(`${target}.tmp`)).toBe(false);
      } finally {
        warns.mockRestore();
      }
    });
  }

  it('a cleanup that fails is logged with [Files] and the original error is still thrown', () => {
    const target = path.join(caseDir(), '.env');
    fs.writeFileSync(target, 'TOKEN=old\n');
    h.writeFaults.add(path.resolve(`${target}.tmp`));
    h.unlinkFaults.add(path.resolve(`${target}.tmp`));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => writePrivateFile(target, 'TOKEN=secret\n')).toThrow(/ENOSPC: injected/);
      const logged = errors.mock.calls.map(c => c.join(' ')).join('\n');
      expect(logged).toMatch(/^\[Files\] /m);
      expect(logged).toContain('.env.tmp');
      expect(logged).toContain('EBUSY');
      expect(fs.readFileSync(target, 'utf-8')).toBe('TOKEN=old\n');
    } finally {
      errors.mockRestore();
      h.unlinkFaults.clear();
      fs.rmSync(`${target}.tmp`, { force: true });
    }
  });
});
