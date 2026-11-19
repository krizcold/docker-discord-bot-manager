import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm36-l5-b-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir };
});

vi.mock('child_process', async (importOriginal) => (await import('./nm36-tls')).childProcessMock(await importOriginal(), require('fs')));
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
import * as containerManager from '../../src/docker/containerManager';
import * as dbLogin from '../../src/instance/dbLogin';
import { releaseFleetBackupBusy } from '../../src/instance/fleetBackupGuards';
import { LOCAL_TLS_TIMING } from '../../src/instance/fleetReplication';
import { startOnNewDatabase } from '../../src/instance/keptData';
import { resetDocker } from './nm2-docker';
import { clearRegistry } from './nm2-harness';
import { resetRun } from './nm31-run';
import { CONTAINER, db, resetSeed, seedMain, stored } from './nm31-seed';
import { answerOrders, fwd, resetBack } from './nm31-back';
import { resetOwner } from './nm34-seed';
import { NOSSL, resetTls, tlsFake, tlsOf } from './nm36-tls';
import type { KeptOpRecord } from '../../src/types';

const NOW = Date.parse('2026-11-17T12:00:00.000Z');
const s = () => tlsOf(CONTAINER);
const timing = { ...LOCAL_TLS_TIMING };
const skew = { ms: 0 };
const REFUSED_10 = `the server still refused TLS 10 s after the reload: ${NOSSL}`;
const SHUTTING_DOWN = 'psql: error: connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed: FATAL:  the database system is shutting down';
const KEPT_HAD_IT = 'the kept database had it on, and a Database URL that asks for TLS does not connect without it';

/** The main fixture; the kept database answers SHOW ssl with on. */
async function fixture(): Promise<void> {
  await seedMain();
  answerOrders();
  db.ssl = { ok: true, stdout: 'on\n' };
}

/** The new database's first pair never loads, and each TLS read moves the clock on 2 s, so E7 ends on the server's no-SSL answer. */
function refusing(): void {
  s().swapLoadable = [false];
  tlsFake.onRead = () => { skew.ms += 2000; };
}

/** The press's answer and the reason the open record stores. */
async function pressOpen(): Promise<{ answer: { success: boolean; open?: boolean; error?: string }; reason: string | undefined }> {
  const answer = await startOnNewDatabase('a') as { success: boolean; open?: boolean; error?: string };
  const rec = stored().keptOp as KeptOpRecord | undefined;
  return { answer, reason: rec?.lastError };
}

function expectOpenWith(r: Awaited<ReturnType<typeof pressOpen>>, reason: string): void {
  expect(r.reason).toBe(reason);
  expect(r.answer).toMatchObject({ success: false, status: 409, open: true });
  expect(r.answer.error).toContain(`: ${reason}. `);
  expect((stored().keptOp as KeptOpRecord).step).toBe('db-in');
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  skew.ms = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => NOW + skew.ms);
  resetDocker();
  resetRun();
  resetTls();
  clearRegistry();
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
  resetSeed();
  resetBack();
  resetOwner();
  dbLogin.resetManagerRoleCache();
  tlsFake.newVolume = fwd().newVolume;
  Object.assign(LOCAL_TLS_TIMING, timing, { gapMs: 1 });
});
afterEach(() => {
  releaseFleetBackupBusy('a');
  vi.restoreAllMocks();
  Object.assign(LOCAL_TLS_TIMING, timing);
});
afterAll(() => { fs.rmSync(h.dir, { recursive: true, force: true }); });

describe('nm36 l5 b: the operator texts of A21, G0 and the TLS step, word for word', () => {
  it('A21: SHOW ssl fails: the refusal says the manager can\'t confirm whether the database runs with TLS', async () => {
    await fixture();
    db.ssl = { ok: false, stderr: `Error response from daemon: container ${CONTAINER} is not running\n` };
    const answer = await startOnNewDatabase('a');
    expect(answer).toEqual({ success: false, status: 409,
      error: `The manager can't confirm whether the bot's database runs with TLS (Error response from daemon: container ${CONTAINER} is not running); the new database gets TLS only when this one has it; nothing was changed` });
    expect(containerManager.getBot('a')!.keptOp).toBeUndefined();
  });

  it('G0-3: docker says no such container: the stored reason names the gone container', async () => {
    await fixture();
    tlsFake.mounts[CONTAINER] = { stderr: `Error: No such container: ${CONTAINER}` };
    expectOpenWith(await pressOpen(), 'the database container is gone (docker says no such container), so the manager did not turn TLS on');
    expect(tlsFake.calls).toEqual(['mounts']);
  });

  it('G0-4: the daemon does not answer: the stored reason carries docker\'s error', async () => {
    await fixture();
    const err = 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?';
    tlsFake.mounts[CONTAINER] = { stderr: err };
    expectOpenWith(await pressOpen(), `docker did not say which volume the database container runs on (${err}), so the manager did not turn TLS on`);
    expect(tlsFake.calls).toEqual(['mounts']);
  });

  it('G0-2: a bind whose source path holds a line break prints two lines: the reason joins them with a comma and a space', async () => {
    await fixture();
    tlsFake.mounts[CONTAINER] = { out: 'bind /srv/pg\ndata\n' };
    expectOpenWith(await pressOpen(), `docker shows bind /srv/pg, data at the database's data folder, not the new volume ${fwd().newVolume}, so the manager did not turn TLS on`);
    expect(tlsFake.calls).toEqual(['mounts']);
  });

  it('G0-2: the two lines carry spaces around the line break: each line is trimmed before the reason joins them', async () => {
    await fixture();
    tlsFake.mounts[CONTAINER] = { out: 'bind /srv/pg \n data\n' };
    expectOpenWith(await pressOpen(), `docker shows bind /srv/pg, data at the database's data folder, not the new volume ${fwd().newVolume}, so the manager did not turn TLS on`);
    expect(tlsFake.calls).toEqual(['mounts']);
  });

  it('G0-2: the new volume\'s line followed by a second line: the run stops before E1 and the reason names both lines', async () => {
    await fixture();
    const v = fwd().newVolume;
    tlsFake.mounts[CONTAINER] = { out: `volume ${v}\nx\n` };
    const r = await pressOpen();
    expect((stored().keptOp as KeptOpRecord).keptSsl).toBe(true);
    expectOpenWith(r, `docker shows volume ${v}, x at the database's data folder, not the new volume ${v}, so the manager did not turn TLS on`);
    expect(tlsFake.calls).toEqual(['mounts']);
  });

  it('T-N-TLS-UNKNOWN: the reload fails after ssl was saved: the stored reason says the manager can\'t confirm TLS is on', async () => {
    await fixture();
    s().fail.reload = 'error';
    expectOpenWith(await pressOpen(), `the manager can't confirm that TLS is on for the new database (the configuration could not be reloaded: ${SHUTTING_DOWN}); ${KEPT_HAD_IT}`);
    expect(s().saved).toBe(true);
  });

  it('T-N-TLS-OFF (T10): the undo runs whole: the reason has no reload clause between "aside" and "; the new database runs without TLS"', async () => {
    await fixture();
    refusing();
    expectOpenWith(await pressOpen(), `TLS could not be turned on for the new database (${REFUSED_10}), so the manager turned it off again and set its certificate aside; the new database runs without TLS while the Database URL asks for TLS, and Run it again makes a fresh certificate`);
    expect(tlsFake.calls.slice(-3)).toEqual(['reset', 'aside', 'reload']);
  });

  it('T-N-TLS-OFF (T33): the undo\'s reload answers an error: the clause says the configuration was not reloaded and ssl still shows on', async () => {
    await fixture();
    refusing();
    s().fail.undoReload = 'error';
    expectOpenWith(await pressOpen(), `TLS could not be turned on for the new database (${REFUSED_10}), so the manager turned it off again and set its certificate aside; the configuration was not reloaded after that (${SHUTTING_DOWN}), so the running database still shows ssl on until its next reload or restart; the new database runs without TLS while the Database URL asks for TLS, and Run it again makes a fresh certificate`);
    expect(s().saved).toBe(false);
  });

  it('T-N-TLS-STUCK (T28): ALTER SYSTEM RESET ssl fails: the reason warns that a restart may fail and names Put back', async () => {
    await fixture();
    refusing();
    s().fail.reset = 'error';
    expectOpenWith(await pressOpen(), `TLS could not be turned on for the new database (${REFUSED_10}), and turning it off again failed (ALTER SYSTEM RESET ssl failed: ERROR:  could not write to file "postgresql.auto.tmp": No space left on device), so ssl may still be saved beside a certificate the database cannot load: a restart of the new database may fail, and Put back returns the kept database`);
    expect(s().saved).toBe(true);
  });
});
