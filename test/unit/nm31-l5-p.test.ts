import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm31-l5-p-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  type Hooks = {
    on: boolean;
    log: string[];
    afterCopy: null | ((to: string) => void);
    beforeLstat: null | ((p: string) => void);
  };
  const g = globalThis as { __nm31p?: Hooks };
  const hooks: Hooks = (g.__nm31p ??= { on: false, log: [], afterCopy: null, beforeLstat: null });
  return { dir, hooks };
});

vi.mock('child_process', async (importOriginal) => (await import('./nm31-run')).childProcessMock(await importOriginal(), require('fs')));
vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>();
  const base = (await import('./nm31-run')).fsMock(real) as Record<string, any>;
  const g = globalThis as { __nm31p?: any };
  const hk = () => g.__nm31p;
  const rel = (p: unknown) => {
    const r = require('path').relative(process.env.DATA_DIR as string, String(p)).split('\\').join('/');
    return r;
  };
  const note = (s: string) => { if (hk()?.on) hk().log.push(s); };
  const fds = new Map<number, string>();
  let next = 900000;
  const wrap = {
    chownSync: (p: any, uid: number, gid: number) => { note(`chown ${rel(p)} ${uid}:${gid}`); base.chownSync(p, uid, gid); },
    chmodSync: (p: any, mode: number) => { note(`chmod ${rel(p)} ${mode.toString(8)}`); real.chmodSync(p, mode); },
    mkdirSync: (p: any, o?: any) => { note(`mkdir ${rel(p)} ${JSON.stringify(o ?? null)}`); return real.mkdirSync(p, o); },
    rmdirSync: (p: any, o?: any) => { note(`rmdir ${rel(p)}`); return real.rmdirSync(p, o); },
    rmSync: (p: any, o?: any) => { note(`rm ${rel(p)}`); return base.rmSync(p, o); },
    lstatSync: ((p: any, o?: any) => { hk()?.beforeLstat?.(String(p)); return base.lstatSync(p, o); }) as typeof real.lstatSync,
    copyFileSync: (a: any, b: any, m?: any) => { real.copyFileSync(a, b, m); hk()?.afterCopy?.(String(b)); },
    openSync: (p: any, flags?: any, mode?: any) => {
      let fd: number;
      if (flags === 'r' && real.existsSync(p) && real.statSync(p).isDirectory()) fd = next++;
      else fd = real.openSync(p, flags, mode);
      fds.set(fd, rel(p));
      if (fd >= 900000) note(`open ${rel(p)}`);
      return fd;
    },
    fsyncSync: (fd: number) => { note(`fsync ${fds.get(fd)}`); if (fd < 900000) real.fsyncSync(fd); },
    closeSync: (fd: number) => { note(`close ${fds.get(fd)}`); if (fd < 900000) real.closeSync(fd); },
  };
  return { ...base, ...wrap, default: { ...base.default, ...wrap } };
});
vi.mock('../../src/docker/dockerClient', async (importOriginal) => {
  const { run } = await import('./nm31-run');
  return {
    ...(await importOriginal<typeof import('../../src/docker/dockerClient')>()),
    volumeState: (name: string) => run.volumes[name] ?? 'absent',
    listBotContainersAsync: async () => [],
  };
});
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import * as fs from 'fs';
import * as path from 'path';
import { releaseFleetBackupBusy } from '../../src/instance/fleetBackupGuards';
import { KEPT_TEXT, newStartDone, newStartNames, startOnNewDatabase } from '../../src/instance/keptData';
import { resetDocker } from './nm2-docker';
import { clearRegistry } from './nm2-harness';
import { resetRun, run } from './nm31-run';
import { answerDatabase, dataDirOf, patchRegistry, resetSeed, seedExternal, stored } from './nm31-seed';

const NOW = Date.parse('2026-11-17T12:00:00.000Z');
const names = () => newStartNames({ sanitizedName: 'bota' }, dataDirOf('a'), NOW);
const rel = (p: string) => path.relative(h.dir, p).split('\\').join('/');
const realPlatform = process.platform;

async function press(linux = false) {
  h.hooks.log.length = 0;
  h.hooks.on = true;
  if (linux) Object.defineProperty(process, 'platform', { value: 'linux' });
  try {
    return await startOnNewDatabase('a');
  } finally {
    Object.defineProperty(process, 'platform', { value: realPlatform });
    h.hooks.on = false;
  }
}

function failOnce(match: (from: string) => boolean): void {
  let done = false;
  run.beforeRename = (from) => {
    if (!done && match(from)) {
      done = true;
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    }
  };
}

function openText(reason: string, onDisk: string[]): string {
  return KEPT_TEXT.nOpen(reason, [...newStartDone(stored().keptOp), ...onDisk]);
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  resetDocker();
  resetRun();
  clearRegistry();
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
  resetSeed();
  h.hooks.afterCopy = null;
  h.hooks.beforeLstat = null;
});
afterEach(() => {
  releaseFleetBackupBusy('a');
  vi.restoreAllMocks();
});
afterAll(() => { fs.rmSync(h.dir, { recursive: true, force: true }); });

describe('nm31 l5 p: N4 builds the new folder', () => {
  it('a record without the folder owner opens with the guard text and builds nothing', async () => {
    await seedExternal('a', { certs: true });
    answerDatabase();
    failOnce((from) => from.endsWith('maintenance.json.tmp'));
    expect(await press()).toMatchObject({ success: false, open: true });
    const rec = stored().keptOp;
    delete rec.owner;
    patchRegistry('a', { keptOp: rec });
    const answer = await press();
    const reason = 'the new data folder could not be made (the record holds no owner for the new folder)';
    expect(stored().keptOp.lastError).toBe(reason);
    expect(answer).toEqual({ success: false, status: 409, open: true, error: openText(reason, []) });
  });

  it('on Linux: the owner, modes and syncs of every part, the state file synced and closed before its rename, then the move-in', async () => {
    await seedExternal('a', { certs: true });
    answerDatabase();
    const answer = await press(true);
    expect(answer).toMatchObject({ success: true });
    const n = names();
    const owner = (() => { const st = fs.statSync(dataDirOf('a')); return { uid: st.uid, gid: st.gid, mode: st.mode & 0o7777 }; })();
    const inD = rel(n.inDir);
    const dataD = rel(dataDirOf('a'));
    const parent = rel(path.dirname(dataDirOf('a')));
    const cert = fs.readdirSync(path.join(dataDirOf('a'), 'db-certs'));
    expect(cert).toHaveLength(1);
    const ug = `${owner.uid}:${owner.gid}`;
    const build = h.hooks.log.filter(l => /^(chown|chmod|mkdir|rmdir|rm|open|fsync|close) /.test(l) && (l.includes(inD) || l.endsWith(` ${parent}`) || l.includes(` ${dataD}`)));
    expect(build).toEqual([
      `mkdir ${inD} ${JSON.stringify({ mode: owner.mode })}`,
      `chown ${inD} ${ug}`,
      `chmod ${inD} ${owner.mode.toString(8)}`,
      `mkdir ${inD}/db-certs {"recursive":true,"mode":493}`,
      `chown ${inD}/db-certs ${ug}`,
      `chmod ${inD}/db-certs 755`,
      `chown ${inD}/db-certs/${cert[0]} ${ug}`,
      `chmod ${inD}/db-certs/${cert[0]} 644`,
      `open ${inD}/db-certs`,
      `fsync ${inD}/db-certs`,
      `close ${inD}/db-certs`,
      `fsync ${inD}/maintenance.json.tmp`,
      `close ${inD}/maintenance.json.tmp`,
      `chown ${inD}/maintenance.json ${ug}`,
      `chmod ${inD}/maintenance.json 644`,
      `open ${inD}`,
      `fsync ${inD}`,
      `close ${inD}`,
      `open ${parent}`,
      `fsync ${parent}`,
      `close ${parent}`,
      `open ${parent}`,
      `fsync ${parent}`,
      `close ${parent}`,
    ]);
  });

  it('a certificate left in a partial new folder that the data folder no longer holds is removed, and only it', async () => {
    await seedExternal('a', { certs: true });
    answerDatabase();
    failOnce((from) => from.endsWith('maintenance.json.tmp'));
    expect(await press()).toMatchObject({ success: false, open: true });
    const n = names();
    fs.writeFileSync(path.join(n.inDir, 'db-certs', 'old.crt'), 'stale');
    expect(await press()).toMatchObject({ success: true });
    const rms = h.hooks.log.filter(l => l.startsWith('rm ') && l.includes('db-certs'));
    expect(rms).toEqual([`rm ${rel(path.join(n.inDir, 'db-certs', 'old.crt'))}`]);
    expect(fs.readdirSync(path.join(dataDirOf('a'), 'db-certs'))).not.toContain('old.crt');
  });

  it('a certificate copy that reads back different opens with its name', async () => {
    await seedExternal('a', { certs: true });
    answerDatabase();
    const cert = fs.readdirSync(path.join(dataDirOf('a'), 'db-certs'))[0];
    h.hooks.afterCopy = (to) => { if (to.includes(names().inDir)) fs.appendFileSync(to, 'x'); };
    const answer = await press();
    const reason = `the new data folder could not be made (the copy of ${cert} does not read back equal)`;
    expect(stored().keptOp.lastError).toBe(reason);
    expect(answer).toEqual({ success: false, status: 409, open: true, error: openText(reason, []) });
  });
});

describe('nm31 l5 p: N6 and the folder words read from the disk', () => {
  it('an empty data folder made between the renames is removed before the move-in', async () => {
    await seedExternal('a', { certs: true });
    answerDatabase();
    run.afterRename = (from) => { if (from === dataDirOf('a')) fs.mkdirSync(dataDirOf('a')); };
    expect(await press()).toMatchObject({ success: true });
    expect(h.hooks.log.filter(l => l.startsWith('rmdir '))).toEqual([`rmdir ${rel(dataDirOf('a'))}`]);
  });

  it('a moved-in folder that is no longer ours: the new folder counts as made only when the data folder holds it built', async () => {
    await seedExternal('a', { certs: true });
    answerDatabase();
    const n = names();
    run.afterRename = (from) => { if (from === n.inDir) fs.writeFileSync(path.join(n.outDir, 'db-certs', 'extra.crt'), 'x'); };
    const answer = await press();
    const reason = stored().keptOp.lastError;
    expect(reason).toMatch(/that this start did not write/);
    expect(answer).toEqual({ success: false, status: 409, open: true, error: openText(reason, ['the new data folder was made', 'the data folder was set aside']) });
  });

  it('a moved-in folder replaced by a foreign one: only the set-aside folder is named', async () => {
    await seedExternal('a', { certs: true });
    answerDatabase();
    const n = names();
    run.afterRename = (from) => {
      if (from !== n.inDir) return;
      fs.rmSync(path.join(dataDirOf('a'), 'maintenance.json'));
      fs.writeFileSync(path.join(dataDirOf('a'), 'state.json'), '{}');
    };
    const answer = await press();
    expect(answer).toEqual({ success: false, status: 409, open: true, error: openText(KEPT_TEXT.nNotOurs(dataDirOf('a'), ['state.json']), ['the data folder was set aside']) });
  });

  it('the disk cannot be read: the open answer names no folder steps', async () => {
    await seedExternal('a', { certs: true });
    answerDatabase();
    const n = names();
    let broken = false;
    run.afterRename = (from) => { if (from === n.inDir) broken = true; };
    h.hooks.beforeLstat = (p) => {
      if (broken && path.resolve(p) === path.resolve(n.outDir)) throw Object.assign(new Error('EACCES: permission denied, lstat'), { code: 'EACCES' });
    };
    const answer = await press();
    const reason = stored().keptOp.lastError;
    expect(reason).toMatch(/EACCES/);
    expect(answer).toEqual({ success: false, status: 409, open: true, error: openText(reason, []) });
  });
});
