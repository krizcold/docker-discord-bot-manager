import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm34-l5-a-'));
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
import * as containerManager from '../../src/docker/containerManager';
import * as dbLogin from '../../src/instance/dbLogin';
import { releaseFleetBackupBusy } from '../../src/instance/fleetBackupGuards';
import { KEPT_TEXT, OWNER_CLUSTER_READ, startOnNewDatabase } from '../../src/instance/keptData';
import { resetDocker } from './nm2-docker';
import { clearRegistry } from './nm2-harness';
import { resetRun } from './nm31-run';
import { OFF_MESSAGE, resetSeed, seedMain } from './nm31-seed';
import { resetOwner } from './nm34-seed';

const NOW = Date.parse('2026-11-17T12:00:00.000Z');
const NA = "The bot's Off is not confirmed because its database has no dbm_admin role, so the bot's login could not be blocked";

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

describe('nm34 l5 a: the bot role read argv', () => {
  it('ownerReadArgs sends the PG16.0-safe options, then -i, -q, -tA and ON_ERROR_STOP', () => {
    const opts = dbLogin.MANAGER_SESSION_OPTIONS.replace(' -c restrict_nonsystem_relation_kind=', '');
    expect(opts).not.toContain('restrict_nonsystem_relation_kind');
    expect(dbLogin.OWNER_SESSION_OPTIONS).toBe(opts);
    expect(dbLogin.ownerReadArgs('pgc', 'smdb', 'botdb')).toEqual([
      'exec', '-e', `PGOPTIONS=${opts} -c statement_timeout=20s -c lock_timeout=10s -c idle_session_timeout=10s -c idle_in_transaction_session_timeout=10s -c default_transaction_read_only=on -c role=none`,
      '-i', 'pgc', 'psql', '-X', '-w', '-q', '-U', 'smdb', '-d', 'botdb', '-tA', '-v', 'ON_ERROR_STOP=1',
    ]);
  });
});

describe('nm34 l5 a: operator texts', () => {
  it('T-A-NA-DOWN and the live copy notes read exactly', () => {
    expect(KEPT_TEXT.aNaDown).toBe(`${NA}, and the database is not running, so the manager cannot check it as the bot's role; choose Off again, which starts it alone; nothing was changed`);
    expect(KEPT_TEXT.aNaStandby).toBe(`${NA}, and the database runs in recovery as a live copy, so the manager does not stop it as this bot's main; nothing was changed`);
    expect(KEPT_TEXT.cNotSuper('smdb')).toBe("the live copy's role smdb is not a superuser there, so the manager did not read it as that role");
    expect(KEPT_TEXT.cRead('smdb', 'boom')).toBe("the read as the live copy's role smdb failed too (boom)");
    expect(KEPT_TEXT.cName('smdb')).toBe("the live copy's role name smdb is not one the manager reads as, so it did not read the copy as that role");
  });

  it('S1 counts the role\'s other client sessions twice', () => {
    const count = "SELECT 'sessions|' || count(*) FROM pg_catalog.pg_stat_activity WHERE usename = current_user AND backend_type = 'client backend' AND pid <> pg_catalog.pg_backend_pid();";
    expect(OWNER_CLUSTER_READ).toContain(count);
    expect(OWNER_CLUSTER_READ).toContain(count.replace("'sessions|'", "'sessions2|'"));
  });
});

describe('nm34 l5 a: an Off order that never finished', () => {
  it('Start on a new database refuses with "the order has not finished" when the record has no lastError', async () => {
    await seedMain('a', { off: false });
    containerManager.updateInstanceMaintenance('a', {
      state: 'off', message: OFF_MESSAGE, orderedAt: new Date(NOW).toISOString(), settled: false,
      hook: 'none', login: 'unconfirmed', savedByBot: null,
    } as any);
    const answer = await startOnNewDatabase('a');
    expect(answer).toEqual({
      success: false, status: 409,
      error: "The bot's change to Off is not confirmed yet (the order has not finished), so its database may still be in use; nothing was changed",
    });
  });
});
