import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'fu-l-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir };
});

// One database per container as postgres keeps it (the fu-o fake): the live read-only value, the owner file, and the
// owner each fence line names. onOwnerRead runs once the lift's owner read is answered and before its reset, which is
// where another lane can fence the database.
type Db = { readOnly: boolean; ownerFile: string | null; lines: string[] };
const pg = vi.hoisted(() => ({
  dbs: new Map<string, { readOnly: boolean; ownerFile: string | null; lines: string[] }>(),
  events: [] as string[],
  onOwnerRead: null as null | (() => void),
}));

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const HBA = '/var/lib/postgresql/data/pg_hba.conf';
  const db = (name: string) => {
    if (!pg.dbs.has(name)) pg.dbs.set(name, { readOnly: false, ownerFile: null, lines: [] });
    return pg.dbs.get(name)!;
  };
  const owners = (d: { lines: string[] }) => Array.from(new Set(d.lines.map(o => o || '-'))).join(',');
  const execFile = (_cmd: string, args: string[], optsOrCb: unknown, maybeCb?: unknown) => {
    const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as (err: Error | null, stdout: string, stderr: string) => void;
    const ok = (out = '') => setImmediate(() => cb(null, out, ''));
    const no = (err: string) => setImmediate(() => cb(new Error(err), '', err));
    const sql = args.join(' ');
    if (args[0] === 'inspect') return ok('true\n');
    if (args[0] === 'volume') return ok('[]');
    if (args[0] === 'rm') { pg.events.push('rm'); return ok(); }
    if (args[0] !== 'exec') return ok();
    if (args[1] === '-u' && args[2] === 'root') {
      const d = db(args[3]);
      const script = args[args.length - 1];
      if (script.includes('grep -qx')) {
        pg.events.push('owner-drop');
        const pattern = new RegExp(`^${/grep -qx '([^']*)'/.exec(script)![1].replace('[0-9][0-9]*', '[0-9]+')}$`);
        if (d.ownerFile !== null && pattern.test(d.ownerFile)) d.ownerFile = null;
        return ok();
      }
      if (script.includes('held-hba')) {
        pg.events.push('hba-lift');
        if (d.lines.length === 0) return ok();
        const pattern = /grep -v '# smdb-fence-owner=([^ ]*) # smdb-write-fence\$'/.exec(script)![1];
        const re = new RegExp(`^${pattern.replace('[0-9][0-9]*', '[0-9]+')}$`);
        if (d.lines.every(o => re.test(o))) { d.lines = []; return ok('stripped-hba\n'); }
        return ok(`held-hba ${d.lines.find(o => o) ?? ''}\n`);
      }
      return ok();
    }
    const d = db(args[1]);
    if (args.includes('127.0.0.1')) return no('psql: error: FATAL:  pg_hba.conf rejects connection for host "127.0.0.1"');
    if (sql.includes("current_setting('hba_file') ||")) return ok(`${HBA}|on|0|0|${d.readOnly ? 'on' : 'off'}|${d.ownerFile ?? ''}|${d.lines.length}|${owners(d)}\n`);
    if (sql.includes("pg_read_file('smdb-fence-owner', true)") && !sql.includes('regexp_split_to_table')) {
      pg.events.push('owner-read');
      const answer = `${d.readOnly ? 'on' : 'off'}|${d.ownerFile ?? ''}\n`;
      const hook = pg.onOwnerRead;
      pg.onOwnerRead = null;
      hook?.();
      return ok(answer);
    }
    if (sql.includes("pg_read_file('smdb-fence-owner', true)")) return ok(`${d.readOnly ? 'on' : 'off'}|${d.lines.length}|${d.ownerFile ?? ''}|${owners(d)}\n`);
    if (sql.includes('ALTER SYSTEM RESET default_transaction_read_only')) { pg.events.push('reset'); d.readOnly = false; return ok(); }
    return ok();
  };
  return { ...real, execFile, default: { ...real, execFile } };
});
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import * as fs from 'fs';
import * as path from 'path';

const REGISTRY = path.join(tmp.dir, 'instances.json');
const primary = { containerName: 'bot-a-postgres', user: 'app', db: 'app', volume: 'bot-a-pgdata' };
const state = (): Db => pg.dbs.get(primary.containerName)!;
const RESTORE = 'restore:1729900000000';
const onDisk = () => JSON.parse(fs.readFileSync(REGISTRY, 'utf-8')).instances.a;

function seedRegistry(extra: Record<string, unknown>): void {
  fs.writeFileSync(REGISTRY, JSON.stringify({ instances: { a: {
    id: 'a', displayName: 'a', sanitizedName: 'bot-a', status: 'running', fleetDb: primary,
    fleetBackup: { enabled: false, hour: 4, keep: 7 }, ...extra,
  } } }, null, 2));
}

async function modules() {
  vi.resetModules();
  const cm = await import('../../src/docker/containerManager');
  const guards = await import('../../src/instance/fleetBackupGuards');
  const ff = await import('../../src/instance/fleetFailback');
  const rc = await import('../../src/instance/recoveryChannel');
  return { cm, guards, ff, rc };
}

/** A restore that tries to start at the given moment: it fences the database only once it holds the backup slot, as fleetBackup's restore does. */
function restoreAt(guards: typeof import('../../src/instance/fleetBackupGuards')): { claimed: boolean | null } {
  const result = { claimed: null as boolean | null };
  pg.onOwnerRead = () => {
    result.claimed = guards.claimFleetBackupBusy('a');
    if (result.claimed) Object.assign(state(), { readOnly: true, ownerFile: RESTORE, lines: [RESTORE, RESTORE] });
  };
  return result;
}

const parkedRun = (extra: Record<string, unknown>) => ({
  mode: 'failback', startedAt: 1, updatedAt: 1, standInNodeId: null, episode: null, lineage: null, dump: null,
  fence: { ok: true, error: null, at: 1, owned: true }, consentAt: null, block: null, serve: null,
  stoppedByRun: false, parked: true, lastError: 'x', ...extra,
});
const channel = { mode: 'source', containerName: 'bot-a-recovery-relay', token: 't', createdAt: 1, endpointHost: 'h', endpointPort: 15433, pinCert: 'c' };

beforeEach(() => {
  pg.dbs = new Map([[primary.containerName, { readOnly: true, ownerFile: 'failback:1', lines: ['failback:1', 'failback:1'] }]]);
  pg.events = [];
  pg.onOwnerRead = null;
});
afterAll(() => { fs.rmSync(tmp.dir, { recursive: true, force: true }); });

describe('FU-L row 1: the park\'s lift holds the backup slot from its owner read to its reset', () => {
  it('a restore that tries to fence between the Dismiss lift\'s owner read and its reset is refused, and no restore layer is reset', async () => {
    seedRegistry({ fleetFailback: parkedRun({ phase: 'catching-up' }) });
    const { cm, guards, ff } = await modules();
    const restore = restoreAt(guards);
    const r = await ff.dismissFailback(cm.getBot('a')!);
    if (restore.claimed) guards.releaseFleetBackupBusy('a');
    if (state().ownerFile === RESTORE) expect(state().readOnly).toBe(true);
    expect(restore.claimed).toBe(false);
    expect(r).toEqual({ success: true });
    expect(state()).toEqual({ readOnly: false, ownerFile: null, lines: [] });
    expect(guards.isFleetBackupBusy('a')).toBe(false);
  });

  it('a restore that tries to fence between the Cancel lift\'s owner read and its reset is refused, and no restore layer is reset', async () => {
    seedRegistry({ fleetFailback: parkedRun({ phase: 'wipe-consent' }) });
    const { cm, guards, ff } = await modules();
    const restore = restoreAt(guards);
    const r = await ff.cancelFailback(cm.getBot('a')!);
    if (restore.claimed) guards.releaseFleetBackupBusy('a');
    if (state().ownerFile === RESTORE) expect(state().readOnly).toBe(true);
    expect(restore.claimed).toBe(false);
    expect(r).toEqual({ success: true });
    expect(state()).toEqual({ readOnly: false, ownerFile: null, lines: [] });
    expect(guards.isFleetBackupBusy('a')).toBe(false);
  });

  it('Dismiss and Cancel refuse while another lane holds the slot, and send nothing and keep the run', async () => {
    for (const [phase, close, word] of [['catching-up', 'dismissFailback', 'Dismiss'], ['wipe-consent', 'cancelFailback', 'Cancel']] as const) {
      seedRegistry({ fleetFailback: parkedRun({ phase }) });
      const { cm, guards, ff } = await modules();
      expect(guards.claimFleetBackupBusy('a')).toBe(true);
      const r = await ff[close](cm.getBot('a')!);
      guards.releaseFleetBackupBusy('a');
      expect(r.success).toBe(false);
      expect(r.error).toBe(`${word} was refused because another database operation holds the backup slot of this instance; nothing was changed. ${word} again once it ends`);
      expect(pg.events).toEqual([]);
      expect(state()).toEqual({ readOnly: true, ownerFile: 'failback:1', lines: ['failback:1', 'failback:1'] });
      expect(onDisk().fleetFailback).toMatchObject({ phase, parked: true, lastError: 'x', fence: { owned: true } });
    }
  });
});

describe('FU-L row 2: the disarm\'s lift holds the backup slot from its owner read to its reset', () => {
  beforeEach(() => {
    pg.dbs.set(primary.containerName, { readOnly: true, ownerFile: 'swap:3', lines: ['swap:3', 'swap:3'] });
  });

  it('a restore that tries to fence between the disarm lift\'s owner read and its reset is refused, and no restore layer is reset', async () => {
    seedRegistry({ recoveryChannel: channel });
    const { cm, guards, rc } = await modules();
    const restore = restoreAt(guards);
    const r = await rc.disarmRecoveryChannel(cm.getBot('a')!);
    if (restore.claimed) guards.releaseFleetBackupBusy('a');
    if (state().ownerFile === RESTORE) expect(state().readOnly).toBe(true);
    expect(restore.claimed).toBe(false);
    expect(r).toEqual({ success: true });
    expect(state()).toEqual({ readOnly: false, ownerFile: null, lines: [] });
    expect(guards.isFleetBackupBusy('a')).toBe(false);
  });

  it('a disarm while another lane holds the slot removes the relay, sends nothing to the fence and keeps the channel on record', async () => {
    seedRegistry({ recoveryChannel: channel });
    const { cm, guards, rc } = await modules();
    expect(guards.claimFleetBackupBusy('a')).toBe(true);
    const r = await rc.disarmRecoveryChannel(cm.getBot('a')!);
    guards.releaseFleetBackupBusy('a');
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/^The disarm did not finish: the relay was removed, but the write fence on bot-a-postgres was not lifted, because another database operation holds the backup slot of this instance, so a swap's fence on it, if one is there, stays on\. The channel stays on record, and Disarm retries these steps$/);
    expect(pg.events).not.toContain('hba-lift');
    expect(pg.events).not.toContain('owner-read');
    expect(pg.events).not.toContain('reset');
    expect(state()).toEqual({ readOnly: true, ownerFile: 'swap:3', lines: ['swap:3', 'swap:3'] });
    expect(onDisk().recoveryChannel).toMatchObject({ containerName: channel.containerName });
  });
});
