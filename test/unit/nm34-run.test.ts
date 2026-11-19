import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm34-run-'));
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
import * as envManager from '../../src/env/manager';
import * as dbLogin from '../../src/instance/dbLogin';
import * as maintenance from '../../src/instance/maintenance';
import { releaseFleetBackupBusy } from '../../src/instance/fleetBackupGuards';
import { KEPT_TEXT, keptRunningOp, newStartNames, putBack, startOnNewDatabase } from '../../src/instance/keptData';
import { docker, resetDocker } from './nm2-docker';
import { clearRegistry, registryPath } from './nm2-harness';
import { resetRun, run } from './nm31-run';
import { answerDatabase, composePathOf, CONTAINER, dataDirOf, OFF_MESSAGE, patchRegistry, resetSeed, seedMain, stored, treeOf } from './nm31-seed';
import { dropOverride, noAdmin, offOrderNoAdmin, owner, resetOwner, scriptOf, useOwner, isOwnerShape } from './nm34-seed';
import type { InstanceConfig } from '../../src/types';

const NOW = Date.parse('2026-11-17T12:00:00.000Z');
const ISO = new Date(NOW).toISOString();
const names = () => newStartNames({ sanitizedName: 'bota' }, dataDirOf('a'), NOW);
const bot = (): InstanceConfig => containerManager.getBot('a')!;
const user = () => bot().fleetDb!.user;
const realSave = containerManager.saveKeptOpIf;
const realSwap = containerManager.swapKeptData;
const realClose = containerManager.closeKeptOp;
const realCreate = containerManager.createKeptOpIf;

type Snap = { folder: Record<string, string>; inst: InstanceConfig };
const snap = (): Snap => ({ folder: treeOf(dataDirOf('a')), inst: bot() });

function clearCalls(): void {
  docker.calls.length = 0;
  run.psqlCalls.length = 0;
  run.execCalls.length = 0;
  owner.calls.length = 0;
}

async function press() {
  clearCalls();
  return startOnNewDatabase('a');
}

/** The NA fixture: a main whose Off ran on a cluster with no dbm_admin, and the bot role's reads answered. */
async function fixture(): Promise<Snap> {
  await seedMain('a', { off: false });
  await offOrderNoAdmin('a');
  answerDatabase();
  useOwner();
  return snap();
}

const composeOf = (): any => YAML.parse(fs.readFileSync(composePathOf('a'), 'utf-8'));
const maintenanceJson = () => JSON.stringify({ state: 'maintenance', message: OFF_MESSAGE, since: ISO }, null, 2);

/** nm31-start's end state of a clean run of the main variant. */
function expectMainDone(before: Snap, answer: unknown): void {
  const n = names();
  const oldDb = before.inst.fleetDb!;
  const password = decodeURIComponent(new URL(envManager.getEnvVars('a').DATA_BACKEND_URL).password);
  expect(answer).toEqual({
    success: true,
    text: KEPT_TEXT.nDoneMain({ old: oldDb.volume, outDir: n.outDir, newVolume: n.newVolume, certs: false, replication: false, sharers: null }),
  });
  const after = bot();
  expect(after.maintenance).toMatchObject({ state: 'running', settled: true, login: 'open' });
  expect(after.keptSets).toEqual([{ id: n.stamp, keptAt: n.startedAt, by: 'new-start', folder: n.outDir, db: oldDb }]);
  expect(after.fleetDb).toEqual({ containerName: CONTAINER, user: oldDb.user, db: oldDb.db, volume: n.newVolume, password });
  expect(after.keptOp).toBeUndefined();
  expect(treeOf(n.outDir)).toEqual(before.folder);
  expect(treeOf(dataDirOf('a'))).toEqual({ 'maintenance.json': maintenanceJson() });
  expect(fs.existsSync(n.inDir)).toBe(false);
  expect(composeOf().volumes['fleet-postgres-data']).toEqual({ name: n.newVolume });
  expect(keptRunningOp('a')).toBeNull();
  expect(containerManager.isBotBusy('a')).toBeNull();
}

const isUp = (a: string[]) => a[0] === 'sh' && a[1].includes('up -d fleet-postgres');
const namesOld = (a: string[]) => a.includes('psql') && a.includes(CONTAINER);

/** C1 to C9: in the resumed run, no psql call names the container before N8's compose up (the new database keeps the name). */
function noPsqlBeforeUp(): void {
  const up = docker.calls.findIndex(isUp);
  const end = up < 0 ? docker.calls.length : up;
  expect(docker.calls.slice(0, end).filter(namesOld)).toEqual([]);
}

/** Throws once from saveKeptOpIf for the patch that saves `step`, before anything is saved. */
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

function failRename(match: (from: string, to: string) => boolean, message: string): void {
  let done = false;
  run.beforeRename = (from, to) => {
    if (!done && match(from, to)) {
      done = true;
      throw Object.assign(new Error(message), { code: message.split(':')[0] });
    }
  };
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
  resetOwner();
  dbLogin.resetManagerRoleCache();
});
afterEach(() => {
  releaseFleetBackupBusy('a');
  vi.restoreAllMocks();
});
afterAll(() => { fs.rmSync(h.dir, { recursive: true, force: true }); });

describe('nm34 run: a crash, then a press that resumes under Invariant A', () => {
  it('C0: a crash after A19\'s save: the resume passes A7 by the record, the re-check reads S1, and NA1\'s window rule holds', async () => {
    const before = await fixture();
    let thrown = false;
    vi.spyOn(containerManager, 'createKeptOpIf').mockImplementation((id, rec) => {
      const r = realCreate(id, rec);
      if (!thrown) { thrown = true; throw new Error('the manager stopped here'); }
      return r;
    });
    expect(await press()).toMatchObject({ success: false });
    expect(stored().keptOp).toMatchObject({ op: 'new-start', step: 'recorded', noAdminOff: bot().maintenance!.orderedAt });
    const answer = await press();
    expectMainDone(before, answer);
    const stop = docker.calls.findIndex(a => a[0] === 'stop' && a[a.length - 1] === CONTAINER);
    const up = docker.calls.findIndex(isUp);
    expect(stop).toBeGreaterThan(0);
    expect(up).toBeGreaterThan(stop);
    const reads = docker.calls.slice(0, stop).filter(namesOld);
    expect(reads).toHaveLength(1);
    expect(isOwnerShape(reads[0], user())).toBe(true);
    expect(owner.calls.map(scriptOf)).toEqual(['S1']);
    expect(owner.calls[0].input.startsWith('BEGIN TRANSACTION READ ONLY;')).toBe(true);
    expect(docker.calls.slice(stop + 1, up).filter(a => a[0] !== 'inspect' && a[0] !== 'container' && a.join(' ').includes(CONTAINER))).toEqual([]);
    expect(docker.calls.slice(stop + 1, up).filter(a => a[0] === 'inspect').every(a => a[1] === '-f')).toBe(true);
  });

  it('C1: a crash between N1\'s stop and its save: the resume reads the database stopped (RC3), runs N1 again, and ends clean', async () => {
    const before = await fixture();
    crashOnStep('db-stopped');
    expect(await press()).toMatchObject({ success: false, open: true });
    expect(stored().keptOp.step).toBe('recorded');
    expect(docker.running[CONTAINER]).toBe(false);
    const answer = await press();
    expectMainDone(before, answer);
    expect(owner.calls).toEqual([]);
    noPsqlBeforeUp();
  });

  const steps: Array<[string, () => void]> = [
    ['C2: after N2', () => crashOnStep('db-out')],
    ['C3: after N3', () => {
      let swaps = 0;
      vi.spyOn(containerManager, 'swapKeptData').mockImplementation((...args) => {
        swaps++;
        const r = realSwap(...args);
        if (swaps === 1) throw new Error('the manager stopped here');
        return r;
      });
    }],
    ['C4: after N4 built the new folder', () => failRename((from) => from === dataDirOf('a'), 'the manager stopped here')],
    ['C5: after N5\'s rename', () => failRename((from) => from === names().inDir, 'the manager stopped here')],
    ['C6: after N6', () => crashOnStep('folder')],
    ['C7: after N7', () => crashOnStep('db-in')],
    ['C8: after N8', () => crashOnStep('db-up')],
    ['C9: after N9', () => crashOnStep('login')],
  ];
  it.each(steps)('%s: the resume passes A7 by the record with no session on the old database, and ends clean', async (_n, crash) => {
    const before = await fixture();
    crash();
    expect(await press()).toMatchObject({ success: false });
    expect(stored().keptOp).toBeTruthy();
    const answer = await press();
    expectMainDone(before, answer);
    expect(owner.calls).toEqual([]);
    noPsqlBeforeUp();
  });

  it('C10: a crash after N10\'s save: done, maintenance Running and settled, and a press answers T-A-OFF', async () => {
    const before = await fixture();
    vi.spyOn(containerManager, 'closeKeptOp').mockImplementation((...args) => {
      realClose(...args);
      throw new Error('the manager stopped here');
    });
    expect(await press()).toMatchObject({ success: false });
    vi.mocked(containerManager.closeKeptOp).mockRestore();
    expect(bot().keptOp).toBeUndefined();
    expect(bot().maintenance).toMatchObject({ state: 'running', settled: true });
    expect(treeOf(names().outDir)).toEqual(before.folder);
    expect(await press()).toEqual({ success: false, status: 409, error: KEPT_TEXT.aOff });
  });

  it('CX: a resume whose record\'s noAdminOff differs from the Off\'s orderedAt: T-A-UNSETTLED, the record stays open', async () => {
    await fixture();
    crashOnStep('db-out');
    expect(await press()).toMatchObject({ success: false, open: true });
    const changed = { ...stored().keptOp, noAdminOff: '2026-01-01T00:00:00.000Z' };
    patchRegistry('a', { keptOp: changed });
    const reg = fs.readFileSync(registryPath(), 'utf-8');
    const answer = await press();
    expect(answer).toEqual({ success: false, status: 409, error: KEPT_TEXT.aUnsettled(maintenance.NO_ADMIN_OFF_REASON) });
    expect(fs.readFileSync(registryPath(), 'utf-8')).toBe(reg);
    expect(docker.calls.filter(a => a[0] === 'stop')).toEqual([]);
    expect(run.execCalls).toEqual([]);
    expect(owner.calls).toEqual([]);
  });
});

describe('nm34 run: Put back of the open record, then Start again', () => {
  /** The reverse's Off meets the old cluster with no dbm_admin, through the real ensureManagerDbRole. */
  async function reverseWithoutAdmin() {
    vi.mocked(dbLogin.ensureManagerDbRole).mockRestore();
    dbLogin.resetManagerRoleCache();
    const over = noAdmin();
    try {
      clearCalls();
      return await putBack('a', names().stamp);
    } finally {
      dropOverride(over);
    }
  }

  /** P7's Off stayed unsettled for the missing dbm_admin alone, and the close answered success with its text as the warning. */
  function expectBackWithWarning(before: Snap, answer: any): void {
    expect(answer).toMatchObject({ success: true });
    expect(answer.warning).toContain(dbLogin.NO_ADMIN_ERROR);
    expect(bot().keptOp).toBeUndefined();
    expect(bot().fleetDb).toEqual(before.inst.fleetDb);
    expect(treeOf(dataDirOf('a'))).toEqual(before.folder);
    expect(composeOf().volumes['fleet-postgres-data']).toEqual({ name: before.inst.fleetDb!.volume });
    const m = bot().maintenance!;
    expect(m).toMatchObject({ state: 'off', settled: false, login: 'unconfirmed', lastError: maintenance.NO_ADMIN_OFF_REASON });
    expect(maintenance.noAdminOff(m)).toBe(true);
    expect(owner.calls).toEqual([]);
  }

  it('CU1: Put back before N3 (U-a): the old database\'s service written back, its Off unsettled for the missing dbm_admin, success with that warning', async () => {
    const before = await fixture();
    crashOnStep('db-out');
    expect(await press()).toMatchObject({ success: false, open: true });
    const answer: any = await reverseWithoutAdmin();
    expect(answer.text).toBe(KEPT_TEXT.uNothing(answer.warning));
    expectBackWithWarning(before, answer);
  });

  it('CU2: Put back after N3 (U-b): the old database and folder back, its Off unsettled for the missing dbm_admin, success with that warning', async () => {
    const before = await fixture();
    crashOnStep('folder');
    expect(await press()).toMatchObject({ success: false, open: true });
    expect(bot().keptSets).toHaveLength(1);
    const answer: any = await reverseWithoutAdmin();
    expect(answer.text).toMatch(/^Put back\. /);
    expectBackWithWarning(before, answer);
  });

  it('CU3: a Start press after the reverse is admitted by Invariant A again and ends clean', async () => {
    const before = await fixture();
    crashOnStep('db-out');
    expect(await press()).toMatchObject({ success: false, open: true });
    vi.mocked(containerManager.saveKeptOpIf).mockRestore();
    expect(await reverseWithoutAdmin()).toMatchObject({ success: true });
    answerDatabase();
    const orderedAt = bot().maintenance!.orderedAt;
    const answer: any = await press();
    expect(answer).toMatchObject({ success: true });
    expect(answer.text).toMatch(/^Started on a new database\. /);
    expect(owner.calls.map(scriptOf)).toEqual(['S1', 'S2', 'S4', 'S1']);
    expect(bot().keptLast).toMatchObject({ op: 'new-start', outcome: 'done' });
    expect(bot().keptSets).toEqual([expect.objectContaining({ by: 'new-start', db: before.inst.fleetDb })]);
    expect(bot().maintenance).toMatchObject({ state: 'running', settled: true });
    expect(orderedAt).toBeTruthy();
  });
});
