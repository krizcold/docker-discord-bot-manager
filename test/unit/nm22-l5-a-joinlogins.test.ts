import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm22-l5-a-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir };
});

vi.mock('child_process', async (importOriginal) => (await import('./nm22-lane-fake')).laneChildProcess(await importOriginal<typeof import('child_process')>()));
vi.mock('../../src/instance/fleetJoin', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/fleetJoin')>()),
  sendAddresses: async () => ({ state: 'applied' }),
}));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';
import * as envManager from '../../src/env/manager';
import * as fleetBackupGuards from '../../src/instance/fleetBackupGuards';
import { getFleetReplicationStatus, getJoinCode, renewJoinCode } from '../../src/instance/fleetReplication';
import { lane, resetLane } from './nm22-lane-fake';

const ID = '0f1e2d3c-4b5a-4968-8776-655443322110';
const OTHER = 'smdb_copy_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const OTHER_SLOT = 'fleet_standby_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const REGISTRY = path.join(h.dir, 'instances.json');
const dbUrl = 'postgresql://smdb:Db-Secret%2C%25x@m-fleet-postgres:5432/smdb?sslmode=no-verify';
const fleetDb = { containerName: 'm-fleet-postgres', user: 'smdb', db: 'smdb', volume: 'm-fleet-postgres-data', password: 'Db-Secret,%x' };
const replication = { role: 'smdb_join', password: 'Join-Secret-0123456789', hostPort: 15432, publicHost: 'main.invalid', certHost: 'main.invalid', slotWalKeepMb: 4096 };

const writeRegistry = (): void => {
  fs.writeFileSync(REGISTRY, JSON.stringify({ instances: { [ID]: {
    id: ID, sanitizedName: 'm', displayName: 'M', titleName: 'M', status: 'running', sourceType: 'git',
    sourceUrl: 'https://example.invalid/fake/super-modular-discord-bot', envVars: { DATA_BACKEND: 'postgres' },
    createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z', fleetDb: { ...fleetDb, replication },
  } } }));
  (containerManager as any).updateInstanceFleetLogin(ID, { password: 'Own-Machine-Secret-01' });
};
const bot = () => containerManager.getBot(ID)!;
const status = () => getFleetReplicationStatus(bot(), { probeEndpoint: false });
const valid = { login: OTHER, member: true, canLogin: true, slot: null, active: null, walStatus: null, client: null };
const copyRolesFails = (err: string) => lane.rules.push({ match: "'copyroles|'", code: 2, err, once: true });
const checkFailed = (reason: string) => `The logins that machines get with the join code could not be checked (${reason}), so no join code was made`;

beforeEach(() => {
  resetLane();
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
  fs.mkdirSync(path.join(h.dir, 'bots', ID, 'env'), { recursive: true });
  writeRegistry();
  envManager.setEnvVars(ID, { DATA_BACKEND_URL: dbUrl });
});
afterAll(() => fs.rmSync(h.dir, { recursive: true, force: true }));

describe('NM22 L5 a: the join code refusals', () => {
  it('a failed copy-roles read is a refusal, success false', async () => {
    copyRolesFails('psql: error: connection to server on socket failed\n');
    expect(await getJoinCode(bot())).toEqual({ success: false, error: checkFailed('connection to server on socket failed') });
  });

  it('an answer of another shape is quoted up to 200 characters', async () => {
    lane.copyRoles = 'x'.repeat(300);
    expect((await getJoinCode(bot())).error).toBe(`The logins that machines get with the join code are not set up as the manager needs (${'x'.repeat(200)}), so no join code was made; press Enable replication to set them up again`);
  });

  it('role-settings with an empty holders read: the note without names', async () => {
    lane.copyRoles = 'copyroles|role-settings';
    lane.holders = '';
    const r = await getJoinCode(bot());
    expect(r.success).toBe(true);
    expect(r.note).toBe("Some logins carry session settings of their own, which the manager's sessions override; Enable replication clears them.");
  });
});

describe('NM22 L5 a: the reason taken from psql stderr', () => {
  it('a WARNING line after the psql error is never the reason', async () => {
    copyRolesFails('psql: error: connection to server failed\nWARNING:  there is no transaction in progress\n');
    expect((await getJoinCode(bot())).error).toBe(checkFailed('connection to server failed'));
  });

  it('the last line is taken without its indent', async () => {
    copyRolesFails('psql: error: connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed: No such file or directory\n\tIs the server running locally and accepting connections on that socket?\n');
    expect((await getJoinCode(bot())).error).toBe(checkFailed('Is the server running locally and accepting connections on that socket?'));
  });

  it('a stderr of warnings only says psql failed', async () => {
    copyRolesFails('WARNING:  there is no transaction in progress\n');
    expect((await getJoinCode(bot())).error).toBe(checkFailed('psql failed'));
  });

  it('psql prefixes are removed only at the start of the line', async () => {
    copyRolesFails('ERROR:  role "psql:a: b" does not exist\n');
    expect((await getJoinCode(bot())).error).toBe(checkFailed('role "psql:a: b" does not exist'));
    copyRolesFails('ERROR:  role "psql: error: b" does not exist\n');
    expect((await getJoinCode(bot())).error).toBe(checkFailed('role "psql: error: b" does not exist'));
  });
});

describe('NM22 L5 a: New join code', () => {
  it('a bot gone from the registry: refused, nothing changed', async () => {
    expect(await renewJoinCode({ ...bot(), id: 'ffffffff-0000-4000-8000-000000000000' })).toEqual({ success: false, error: 'Bot not found (nothing was changed)' });
  });

  it('a busy backup lane names New join code', async () => {
    expect(fleetBackupGuards.claimFleetBackupBusy(ID)).toBe(true);
    try {
      expect(await renewJoinCode(bot())).toEqual({ success: false, error: 'A backup, restore or standby re-seed is running on this instance; New join code is refused until it finishes (nothing was changed)' });
    } finally {
      fleetBackupGuards.releaseFleetBackupBusy(ID);
    }
  });
});

describe('NM22 L5 a: the status read of the machine logins', () => {
  it('an address list that is not an array leaves the slots without machine names', async () => {
    lane.slots = JSON.stringify([{ slot: OTHER_SLOT, walStatus: 'reserved', active: false }]);
    lane.addresses = '{}';
    const s = await status();
    expect(s.live!.slots.map(x => [x.slot, x.machine, x.address])).toEqual([[OTHER_SLOT, null, null]]);
  });

  it('a logins answer that is not an array leaves the list out', async () => {
    lane.logins = '{}';
    expect((await status()).live!.logins).toBeUndefined();
  });

  const bad: Array<[string, Record<string, unknown>]> = [
    ['a login that is not a string', { login: [OTHER] }],
    ['a login off the pattern', { login: 'replicator' }],
    ['a member that is not a boolean', { member: 'true' }],
    ['a canLogin that is not a boolean', { canLogin: null }],
  ];
  it.each(bad)('%s leaves the list out', async (_name, change) => {
    lane.logins = JSON.stringify([{ ...valid, ...change }]);
    expect((await status()).live!.logins).toBeUndefined();
  });

  it('a slot that is not a string is no slot; an empty machine name stays empty', async () => {
    const { slot: _s, ...noSlot } = valid;
    lane.logins = JSON.stringify([noSlot]);
    lane.addresses = JSON.stringify([{ slot: OTHER_SLOT, machine: null, host: 'b.invalid', port: 15433 }]);
    expect((await status()).live!.logins).toEqual([
      { login: OTHER, own: false, member: true, canLogin: true, slot: null, slotState: 'absent', machine: '', address: 'b.invalid:15433', client: null },
    ]);
  });

  it('an empty or missing client is no client', async () => {
    const { client: _c, ...noClient } = valid;
    for (const entry of [{ ...valid, client: '' }, noClient]) {
      lane.logins = JSON.stringify([entry]);
      expect((await status()).live!.logins![0].client).toBeNull();
    }
  });
});
