import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'b20-3-'));
  process.env.DATA_DIR = dir;
  return { dir };
});

const pg = vi.hoisted(() => ({
  fenced: new Map<string, boolean>(),
  saved: 'error' as '0' | '1' | 'error',
  inRecovery: 't' as 't' | 'f' | 'error',
}));

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const execFile = vi.fn((_cmd: string, args: string[], optsOrCb: unknown, maybeCb?: unknown) => {
    const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as (err: Error | null, stdout: string, stderr: string) => void;
    const sql = args.join(' ');
    if (args[0] === 'inspect') return cb(null, 'true\n', '');
    if (args[0] === 'exec' && sql.includes('SHOW default_transaction_read_only')) return cb(null, pg.fenced.get(args[1]) ? 'on\n' : 'off\n', '');
    if (args[0] === 'exec' && sql.includes('pg_file_settings')) {
      return pg.saved === 'error' ? cb(new Error('denied'), '', 'ERROR: permission denied') : cb(null, `${pg.saved}\n`, '');
    }
    if (args[0] === 'exec' && sql.includes('pg_is_in_recovery')) {
      return pg.inRecovery === 'error' ? cb(new Error('down'), '', 'psql: error') : cb(null, `${pg.inRecovery}\n`, '');
    }
    return cb(null, '', '');
  });
  const fencedExecFile = (await import('./fence-fake')).withFence(execFile as any);
  return { ...real, execFile: fencedExecFile, default: { ...real, execFile: fencedExecFile } };
});

import * as fs from 'fs';
import * as path from 'path';
import { fenceOwners } from './fence-fake';

const REGISTRY = path.join(tmp.dir, 'instances.json');
const primary = { containerName: 'bot-a-postgres', user: 'app', db: 'app', volume: 'bot-a-pgdata' };
const copy = { containerName: 'bot-a-postgres-replica', user: 'app', db: 'app', volume: 'bot-a-pgreplica' };

function seedRegistry(extra: Record<string, unknown> = {}): void {
  fs.writeFileSync(REGISTRY, JSON.stringify({ instances: { a: { id: 'a', displayName: 'a', fleetDb: primary, fleetBackup: { enabled: false, hour: 4, keep: 7 }, ...extra } } }, null, 2));
}

async function seededWarning(): Promise<string> {
  vi.resetModules();
  const fb = await import('../../src/instance/fleetBackup');
  const spy = vi.spyOn(globalThis, 'setInterval').mockImplementation((() => 0) as unknown as typeof setInterval);
  fb.startFleetBackupScheduler();
  spy.mockRestore();
  fb.stopFleetBackupScheduler();
  let text: string | null = null;
  await vi.waitFor(() => { text = fb.getFleetFenceStuck('a'); expect(text).not.toBeNull(); });
  return text as unknown as string;
}

beforeEach(() => {
  pg.fenced = new Map([[primary.containerName, true]]);
  pg.saved = 'error';
  pg.inRecovery = 't';
  fenceOwners.clear();
  seedRegistry();
});
afterAll(() => { fs.rmSync(tmp.dir, { recursive: true, force: true }); });

describe('the stuck-fence warning seeded at start names a remedy that works', () => {
  it('a fence saved in the configuration is not promised to clear on a restart', async () => {
    pg.saved = '1';
    const text = await seededWarning();
    expect(text).not.toMatch(/restart the instance to clear it/);
    expect(text).toMatch(/a restart keeps it on/);
    expect(text).toMatch(/running a restore again retries the lift/);
  });

  it('a fence held only by the running server says a restart clears it', async () => {
    pg.saved = '0';
    expect(await seededWarning()).toMatch(/restarting the instance clears it/);
  });

  it('an unreadable configuration says the restart outcome cannot be confirmed', async () => {
    const text = await seededWarning();
    expect(text).toMatch(/could not be confirmed/);
    expect(text).not.toMatch(/restart the instance to clear it/);
  });

  it('an armed recovery channel names its disarm as the remedy', async () => {
    pg.saved = '1';
    seedRegistry({ recoveryChannel: { mode: 'source' } });
    fenceOwners.set(primary.containerName, 'swap:1729900000000');
    expect(await seededWarning()).toMatch(/disarming the recovery channel/);
  });

  it('a recovery channel receiver is not sent to a disarm that leaves the fence', async () => {
    pg.saved = '1';
    seedRegistry({ recoveryChannel: { mode: 'receiver' } });
    const text = await seededWarning();
    expect(text).not.toMatch(/disarming the recovery channel on its Database modal lifts it/);
    expect(text).toMatch(/disarm the recovery channel \(receiver\), then run a restore again to retry the lift/);
  });

  it('a promoted copy is not sent to a re-seed the modal refuses', async () => {
    pg.fenced = new Map([[copy.containerName, true]]);
    pg.inRecovery = 'f';
    seedRegistry({ fleetDb: undefined, fleetDbReplica: copy });
    const text = await seededWarning();
    expect(text).not.toMatch(/re-seeding this copy on its Database modal clears it/);
    expect(text).toMatch(/promoted/);
  });

  it('a copy still in recovery keeps the re-seed remedy', async () => {
    pg.fenced = new Map([[copy.containerName, true]]);
    seedRegistry({ fleetDb: undefined, fleetDbReplica: copy });
    expect(await seededWarning()).toMatch(/re-seeding this copy on its Database modal clears it/);
  });
});
