import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm34-l5-c-'));
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
import YAML from 'yaml';
import * as containerManager from '../../src/docker/containerManager';
import * as dbLogin from '../../src/instance/dbLogin';
import * as maintenance from '../../src/instance/maintenance';
import * as envManager from '../../src/env/manager';
import { claimFleetBackupBusy, releaseFleetBackupBusy } from '../../src/instance/fleetBackupGuards';
import { KEPT_TEXT, keptDate, keptRunningOp, putBackDone } from '../../src/instance/keptData';
import type { KeptOpRecord } from '../../src/types';
import { docker, resetDocker } from './nm2-docker';
import { clearRegistry, registryPath } from './nm2-harness';
import { resetRun, run } from './nm31-run';
import { composePathOf, COPY_CONTAINER, COPY_VOLUME, CONTAINER, dataDirOf, patchRegistry, resetSeed, treeOf } from './nm31-seed';
import { answerOrders, asideDir, Before, bot, fwd, keptAfterStart, LATER, LATER_STAMP, login, orders, pressBack, resetBack, stored } from './nm31-back';
import { dropOverride, NO_ADMIN_STDERR, noAdmin, offOrderNoAdmin, owner, resetOwner, s1Stdout, scriptOf, Scripted, useOwner, isOwnerShape } from './nm34-seed';

const LATER_ISO = new Date(LATER).toISOString();
const DATE = keptDate(fwd().stamp);
const realSave = containerManager.saveKeptOpIf;
const realSwap = containerManager.swapKeptData;
const realCreate = containerManager.createKeptOpIf;
const user = () => bot().fleetDb!.user;
const orderText = (i = orders.length - 1) => (orders[i] as { text: string }).text;
const NOTHING = '; nothing was changed';
const dOf = (args: string[]) => args[args.indexOf('-d') + 1];

async function naKept(): Promise<Before> {
  const before = await keptAfterStart('main', { off: false });
  vi.mocked(dbLogin.ensureManagerDbRole).mockRestore();
  await offOrderNoAdmin('a');
  expect(maintenance.noAdminOff(bot().maintenance!)).toBe(true);
  answerOrders();
  useOwner();
  login.canLogin = false;
  orders.length = 0;
  return before;
}

function clearCalls(): void {
  docker.calls.length = 0;
  run.psqlCalls.length = 0;
  run.execCalls.length = 0;
  owner.calls.length = 0;
}

function crashOnStep(step: string): void {
  let done = false;
  vi.spyOn(containerManager, 'saveKeptOpIf').mockImplementation((id, key, patch) => {
    if (!done && patch.step === step) {
      done = true;
      throw new Error('the manager stopped here');
    }
    return realSave(id, key, patch);
  });
}

function probeFails(stderr: string): void {
  docker.overrides.unshift({ match: a => a[0] === 'exec' && a.includes(dbLogin.MANAGER_DB_ROLE) && a.join(' ').includes('pg_is_in_recovery'), answer: { ok: false, stderr } });
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-17T12:00:00.000Z'));
  resetDocker();
  resetRun();
  clearRegistry();
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
  resetSeed();
  resetBack();
  resetOwner();
  dbLogin.resetManagerRoleCache();
});
afterEach(() => {
  vi.useRealTimers();
  releaseFleetBackupBusy('a');
  vi.restoreAllMocks();
});
afterAll(() => { fs.rmSync(h.dir, { recursive: true, force: true }); });

describe('nm34 l5 c: S1 and S3 as the bot role', () => {
  it('C1: S1 reads no session first and one in the second count: admitted, and both S1 reads run on the postgres database', async () => {
    await naKept();
    owner.sessions = [0, 2];
    clearCalls();
    const answer = await pressBack();
    expect(answer).toMatchObject({ success: true });
    expect(bot().keptOp).toBeUndefined();
    expect(owner.calls.map(scriptOf)).toEqual(['S1', 'S1']);
    for (const c of owner.calls) expect(dOf(c.args)).toBe('postgres');
  });

  it('C2: S3 of the live copy runs on the postgres database', async () => {
    probeFails(NO_ADMIN_STDERR);
    await keptAfterStart('copy');
    useOwner();
    clearCalls();
    const answer: any = await pressBack();
    expect(answer).toMatchObject({ success: true });
    expect(owner.calls.map(scriptOf)).toEqual(['S3']);
    expect(dOf(owner.calls[0].args)).toBe('postgres');
  });
});

describe('nm34 l5 c: the re-check before P1 refuses', () => {
  const refuseSecond = () => { owner.s1Queue = [{ code: 0, stdout: s1Stdout() }, { code: 0, stdout: 'f\n' }]; };

  it('C4: the record is closed: the warning names the bot and the refusal', async () => {
    await naKept();
    refuseSecond();
    clearCalls();
    const answer = await pressBack();
    const text = KEPT_TEXT.aNaNotSuper(user());
    expect(answer).toEqual({ success: false, status: 409, error: text });
    expect(console.warn).toHaveBeenCalledWith(`[KeptData] ${bot().displayName}: Put back refused before P1, record closed: ${text}`);
  });

  it('C5: the close throws: T-P-OPEN with the refusal and the error, 500, the record stays open', async () => {
    await naKept();
    refuseSecond();
    vi.spyOn(containerManager, 'closeKeptOp').mockImplementation(() => { throw new Error('ENOSPC: no space left on device'); });
    clearCalls();
    const answer = await pressBack();
    const text = KEPT_TEXT.aNaNotSuper(user());
    expect(text.endsWith(NOTHING)).toBe(true);
    const reason = `${text.slice(0, -NOTHING.length)}; the record could not be closed (ENOSPC: no space left on device)`;
    expect(answer).toEqual({ success: false, status: 500, open: true, error: KEPT_TEXT.pOpen(reason, []) });
    expect(stored().keptOp).toMatchObject({ op: 'put-back', step: 'recorded', lastError: reason });
  });

  it('C6: the close finds the record changed: the closed answer, no refused-before-P1 warning', async () => {
    await naKept();
    refuseSecond();
    vi.spyOn(containerManager, 'closeKeptOp').mockReturnValue('the record changed');
    clearCalls();
    const answer = await pressBack();
    expect(answer).toEqual({ success: false, status: 409, error: `Put back stopped: ${containerManager.KEPT_RECORD_CLOSED}; nothing more was done` });
    expect(vi.mocked(console.warn).mock.calls.filter(c => String(c[0]).includes('refused before P1'))).toEqual([]);
  });
});

describe('nm34 l5 c: Invariant A gates', () => {
  it('C7: the reverse of a put-back record carrying noAdminOff, the database running: no re-check read', async () => {
    await naKept();
    crashOnStep('settled');
    expect(await pressBack()).toMatchObject({ success: false, open: true });
    expect(stored().keptOp).toMatchObject({ op: 'put-back', step: 'db-in', noAdminOff: expect.any(String) });
    vi.mocked(containerManager.saveKeptOpIf).mockRestore();
    docker.running[CONTAINER] = true;
    owner.superuser = false;
    clearCalls();
    const answer = await pressBack(fwd().stamp, { reverse: true });
    expect(owner.calls.map(scriptOf)).toEqual([]);
    expect(answer).not.toEqual({ success: false, status: 409, error: KEPT_TEXT.aNaNotSuper(user()) });
  });

  it('C8: the Off is the no-dbm_admin one, but the URL now names another host (kind not database): T-A-UNSETTLED, nothing read', async () => {
    await naKept();
    envManager.setEnvVars('a', { DATA_BACKEND_URL: 'postgresql://smdb:pw@db.example:5432/smdb' });
    clearCalls();
    const answer = await pressBack();
    expect(answer).toEqual({ success: false, status: 409, error: KEPT_TEXT.aUnsettled(maintenance.NO_ADMIN_OFF_REASON) });
    expect(owner.calls).toEqual([]);
    expect(bot().keptOp).toBeUndefined();
  });
});
