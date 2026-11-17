import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm31-routes-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir };
});

vi.mock('child_process', async (importOriginal) => (await import('./nm31-run')).childProcessMock(await importOriginal(), require('fs')));
vi.mock('fs', async (importOriginal) => (await import('./nm31-run')).fsMock(await importOriginal()));
vi.mock('../../src/docker/dockerClient', async (importOriginal) => {
  const { run } = await import('./nm31-run');
  return {
    ...(await importOriginal<typeof import('../../src/docker/dockerClient')>()),
    volumeState: (name: string) => run.volumes[name] ?? 'absent',
    listBotContainersAsync: async () => [],
  };
});
vi.mock('../../src/instance/appHookClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/appHookClient')>()),
  callAppHook: async () => ({ ok: true, body: { saved: true } }),
}));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import * as fs from 'fs';
import * as path from 'path';
import * as envManager from '../../src/env/manager';
import { releaseFleetBackupBusy } from '../../src/instance/fleetBackupGuards';
import { KEPT_TEXT, keptDate, newStartDone, putBackDone } from '../../src/instance/keptData';
import { createBotRoutes } from '../../src/webui/routes/bots';
import { docker, resetDocker } from './nm2-docker';
import { clearRegistry, registryPath } from './nm2-harness';
import { resetRun, run } from './nm31-run';
import { answerDatabase, dataDirOf, resetSeed, seedExternal, stored, treeOf } from './nm31-seed';
import { asideDir, fwd, keptAfterStart, LATER_STAMP, resetBack } from './nm31-back';

const router = createBotRoutes({ clients: new Set() } as any);
const call = async (routePath: string, params: Record<string, string>, body: unknown = {}): Promise<{ status: number; body: any }> => {
  const layer = (router as any).stack.find((l: any) => l.route?.path === routePath && l.route.methods.post);
  expect(layer, `POST ${routePath}`).toBeTruthy();
  const res: any = { statusCode: 200 };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  await layer.route.stack[layer.route.stack.length - 1].handle({ params, query: {}, body }, res);
  return { status: res.statusCode, body: res.body };
};
const NEW_START = '/:id/fleet-db/new-start';
const PUT_BACK = '/:id/fleet-db/kept/:set/put-back';
const DELETE = '/:id/fleet-db/kept/:set/delete';
const ABANDON = '/:id/fleet-db/kept/abandon';
const set = () => fwd().stamp;
const NOT_FOUND = { status: 404, body: { success: false, error: 'Bot not found' } };

function failRename(match: (from: string, to: string) => boolean, message: string): void {
  let done = false;
  run.beforeRename = (from, to) => {
    if (!done && match(from, to)) {
      done = true;
      throw Object.assign(new Error(message), { code: message.split(':')[0] });
    }
  };
}

const tarFail: { cf?: string } = {};
/** tar as an in-process copy, as nm31-delete's fake: -cf keeps a snapshot of the folder, -xf copies it out. */
function tarFake(): void {
  let args: string[] = [];
  let n = 0;
  docker.overrides.push({
    match: a => {
      if (a[0] !== '-cf' && a[0] !== '-xf') return false;
      args = a;
      return true;
    },
    answer: () => {
      if (args[0] === '-cf') {
        if (tarFail.cf) { const e = tarFail.cf; delete tarFail.cf; return { ok: false, stderr: e }; }
        const [, file, , parent, base] = args;
        const snap = path.join(h.dir, 'snaps', String(++n));
        fs.cpSync(path.join(parent, base), path.join(snap, base), { recursive: true, verbatimSymlinks: true });
        fs.writeFileSync(file, snap);
        return { ok: true };
      }
      const [, file, , dir] = args;
      fs.cpSync(fs.readFileSync(file, 'utf-8'), dir, { recursive: true, verbatimSymlinks: true });
      return { ok: true };
    },
  });
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-17T12:00:00.000Z'));
  resetDocker();
  resetRun();
  clearRegistry();
  for (const d of ['bots', 'backups', 'snaps']) fs.rmSync(path.join(h.dir, d), { recursive: true, force: true });
  resetSeed();
  resetBack();
  delete tarFail.cf;
  tarFake();
});
afterEach(() => {
  releaseFleetBackupBusy('a');
  vi.restoreAllMocks();
});
afterAll(() => { fs.rmSync(h.dir, { recursive: true, force: true }); });

describe('nm31 routes: POST /api/bots/:id/fleet-db/new-start', () => {
  it('new-start (1 of 4): an unknown bot answers 404', async () => {
    expect(await call(NEW_START, { id: 'none' })).toEqual(NOT_FOUND);
  });

  it('new-start (2 of 4): a refusal answers 409 with its text, nothing changed', async () => {
    await seedExternal('a');
    answerDatabase();
    envManager.setEnvVars('a', { DATA_BACKEND: 'json' });
    const folder = treeOf(dataDirOf('a'));
    expect(await call(NEW_START, { id: 'a' })).toEqual({ status: 409, body: { success: false, error: KEPT_TEXT.aJson } });
    expect(stored().keptOp).toBeUndefined();
    expect(treeOf(dataDirOf('a'))).toEqual(folder);
  });

  it('new-start (3 of 4): success answers 200 with the done text', async () => {
    await seedExternal('a');
    answerDatabase();
    const r = await call(NEW_START, { id: 'a' });
    expect(r).toEqual({ status: 200, body: { success: true, text: KEPT_TEXT.nDoneFolder({ outDir: fwd().outDir, certs: false }) } });
    expect(stored().keptSets.map((x: { id: string }) => x.id)).toEqual([set()]);
  });

  it('new-start (4 of 4): an open record answers 409 with open true and T-N-OPEN, naming the new folder N4 made (A4 code review 1)', async () => {
    await seedExternal('a');
    answerDatabase();
    failRename((from) => from === dataDirOf('a'), 'EBUSY: resource busy or locked');
    const r = await call(NEW_START, { id: 'a' });
    const rec = stored().keptOp;
    expect(r).toEqual({ status: 409, body: { success: false, open: true, error: KEPT_TEXT.nOpen('the data folder could not be renamed (EBUSY: resource busy or locked)', [...newStartDone(rec), 'the new data folder was made']) } });
  });
});

describe('nm31 routes: POST /api/bots/:id/fleet-db/kept/:set/put-back', () => {
  it('put-back (1 of 4): an unknown bot answers 404', async () => {
    expect(await call(PUT_BACK, { id: 'none', set: set() })).toEqual(NOT_FOUND);
  });

  it('put-back (2 of 4): a set the bot does not keep answers 409 T-P-NOSET', async () => {
    await keptAfterStart('folder');
    expect(await call(PUT_BACK, { id: 'a', set: 'no-such-set' })).toEqual({ status: 409, body: { success: false, error: KEPT_TEXT.pNoSet('no-such-set') } });
  });

  it('put-back (3 of 4): success answers 200 with the done text; reverse true on an open put-back record runs the reverse', async () => {
    await keptAfterStart('folder');
    failRename((from) => from === dataDirOf('a'), 'EBUSY: resource busy or locked');
    expect((await call(PUT_BACK, { id: 'a', set: set() })).body).toMatchObject({ success: false, open: true });
    expect(stored().keptOp).toMatchObject({ op: 'put-back', set: set() });
    const r = await call(PUT_BACK, { id: 'a', set: set() }, { reverse: true });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ success: true });
    expect(stored().keptOp).toBeUndefined();
    expect(stored().keptLast).toMatchObject({ outcome: 'done' });
    expect(stored().keptSets.map((x: { id: string }) => x.id)).toEqual([set()]);
    const again = await call(PUT_BACK, { id: 'a', set: set() }, { reverse: 'yes' });
    expect(again.status).toBe(200);
    expect(again.body.text).toMatch(new RegExp(`^Put back\\. The kept data of ${keptDate(set())} is in use again`));
    expect(stored().keptSets.map((x: { id: string }) => x.id)).toEqual([LATER_STAMP]);
    expect(fs.existsSync(asideDir())).toBe(true);
  });

  it('put-back (4 of 4): an open record answers 409 with open true and T-P-OPEN; Run it again without reverse goes on with the put-back', async () => {
    await keptAfterStart('folder');
    failRename((from) => from === dataDirOf('a'), 'EBUSY: resource busy or locked');
    const r = await call(PUT_BACK, { id: 'a', set: set() });
    const rec = stored().keptOp;
    expect(r).toEqual({ status: 409, body: { success: false, open: true, error: KEPT_TEXT.pOpen('the data folder could not be renamed (EBUSY: resource busy or locked)', putBackDone(rec)) } });
    const again = await call(PUT_BACK, { id: 'a', set: set() }, {});
    expect(again.status).toBe(200);
    expect(stored().keptSets.map((x: { id: string }) => x.id)).toEqual([LATER_STAMP]);
  });
});

describe('nm31 routes: POST /api/bots/:id/fleet-db/kept/:set/delete', () => {
  it('delete (1 of 4): an unknown bot answers 404', async () => {
    expect(await call(DELETE, { id: 'none', set: set() })).toEqual(NOT_FOUND);
  });

  it('delete (2 of 4): Run again with no open Delete answers 409 T-X-NOREC (the route passes again)', async () => {
    await keptAfterStart('folder', { off: false });
    expect(await call(DELETE, { id: 'a', set: set() }, { again: true })).toEqual({ status: 409, body: { success: false, error: KEPT_TEXT.xNoRec } });
    expect(stored().keptOp).toBeUndefined();
    expect(fs.existsSync(fwd().outDir)).toBe(true);
  });

  it('delete (3 of 4): success answers 200 with the done text', async () => {
    await keptAfterStart('folder', { off: false });
    const r = await call(DELETE, { id: 'a', set: set() });
    expect(r).toEqual({ status: 200, body: { success: true, text: KEPT_TEXT.xDone({ date: keptDate(set()), folder: fwd().outDir, archive: `${set()}.tar` }) } });
    expect(fs.existsSync(fwd().outDir)).toBe(false);
  });

  it('delete (4 of 4): an open record answers 409 with open true and the whole sentence; Run again goes on', async () => {
    await keptAfterStart('folder', { off: false });
    tarFail.cf = 'tar: write error: No space left on device';
    const r = await call(DELETE, { id: 'a', set: set() });
    expect(r).toEqual({ status: 409, body: { success: false, open: true, error: KEPT_TEXT.xArchive('tar: write error: No space left on device') } });
    expect(stored().keptOp).toMatchObject({ op: 'delete', set: set() });
    expect((await call(DELETE, { id: 'a', set: set() }, { again: true })).status).toBe(200);
    expect(stored().keptOp).toBeUndefined();
  });
});

describe('nm31 routes: POST /api/bots/:id/fleet-db/kept/abandon', () => {
  it('abandon (1 of 4): an unknown bot answers 404', async () => {
    expect(await call(ABANDON, { id: 'none' })).toEqual(NOT_FOUND);
  });

  it('abandon (2 of 4): no open Delete answers 409 with its text', async () => {
    await keptAfterStart('folder', { off: false });
    expect(await call(ABANDON, { id: 'a' })).toEqual({ status: 409, body: { success: false, error: KEPT_TEXT.xNoKeep } });
  });

  it('abandon (3 of 4): Keep it on an open Delete answers 200 with T-X-KEPT; the record is gone and the folder stays', async () => {
    await keptAfterStart('folder', { off: false });
    tarFail.cf = 'tar: write error: No space left on device';
    await call(DELETE, { id: 'a', set: set() });
    expect(await call(ABANDON, { id: 'a' })).toEqual({ status: 200, body: { success: true, text: KEPT_TEXT.xKept({ date: keptDate(set()) }) } });
    expect(stored().keptOp).toBeUndefined();
    expect(fs.existsSync(fwd().outDir)).toBe(true);
  });

  it('abandon (4 of 4): a Delete that began removing answers 409 T-X-NOABANDON and stays open', async () => {
    await keptAfterStart('folder', { off: false });
    run.beforeRm = (target) => {
      if (target === fwd().outDir) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
    };
    expect((await call(DELETE, { id: 'a', set: set() })).body).toMatchObject({ success: false, open: true });
    expect(stored().keptOp).toMatchObject({ step: 'removing' });
    expect(await call(ABANDON, { id: 'a' })).toEqual({ status: 409, body: { success: false, error: KEPT_TEXT.xNoAbandon } });
    expect(stored().keptOp).toMatchObject({ step: 'removing' });
  });
});

describe('nm31 routes: code review 1, fix 2', () => {
  const callAs = async (method: 'put' | 'post', routePath: string, params: Record<string, string>, body: unknown = {}): Promise<{ status: number; body: any }> => {
    const layer = (router as any).stack.find((l: any) => l.route?.path === routePath && l.route.methods[method]);
    expect(layer, `${method.toUpperCase()} ${routePath}`).toBeTruthy();
    const res: any = { statusCode: 200 };
    res.status = (c: number) => { res.statusCode = c; return res; };
    res.json = (b: unknown) => { res.body = b; return res; };
    await layer.route.stack[layer.route.stack.length - 1].handle({ params, query: {}, body }, res);
    return { status: res.statusCode, body: res.body };
  };
  const gate = (what: string) => `Start on a new database did not finish on this bot, so ${what} is refused until it does; open the Database window to run it again; nothing was changed`;

  async function openNewStart(): Promise<void> {
    await seedExternal('a');
    answerDatabase();
    failRename((from) => from === dataDirOf('a'), 'EBUSY: resource busy or locked');
    expect((await call(NEW_START, { id: 'a' })).status).toBe(409);
    expect(stored().keptOp).toMatchObject({ op: 'new-start', step: 'swapped' });
  }

  it('C1 (code review 1): PUT fs/write during an open new-start record answers 409 T-G-files, and the data folder is unchanged', async () => {
    await openNewStart();
    const folder = treeOf(dataDirOf('a'));
    const r = await callAs('put', '/:id/fs/write', { id: 'a' }, { target: 'host', path: 'written.txt', body: 'x' });
    expect(r).toEqual({ status: 409, body: { success: false, error: gate('a change of its files') } });
    expect(treeOf(dataDirOf('a'))).toEqual(folder);
  });

  it('C1 (code review 1): POST join-code renew during an open new-start record answers 409 T-G-db', async () => {
    await openNewStart();
    const before = fs.readFileSync(registryPath(), 'utf-8');
    const r = await callAs('post', '/:id/fleet-replication/join-code/renew', { id: 'a' });
    expect(r).toEqual({ status: 409, body: { success: false, error: gate('a change of its database setup') } });
    expect(fs.readFileSync(registryPath(), 'utf-8')).toBe(before);
  });
});
