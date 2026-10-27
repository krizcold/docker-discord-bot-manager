import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vm from 'vm';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm2-routes-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir };
});

vi.mock('child_process', async (importOriginal) => (await import('./nm2-docker')).childProcessMock(await importOriginal()));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));
vi.mock('../../src/config/appCapabilities', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/config/appCapabilities')>()),
  findAppCapabilities: () => ({ companionDb: { env: { url: 'DATABASE_URL' } } }),
}));
vi.mock('../../src/env/manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/env/manager')>()),
  getEnvVars: () => ({ DATABASE_URL: 'postgresql://app:pw@bot-a-postgres:5432/app' }),
  getEnvVarsWithStatus: () => ({ vars: { DATABASE_URL: 'postgresql://app:pw@bot-a-postgres:5432/app' }, undecryptable: [], encrypted: [], corrupt: false }),
}));

import * as fs from 'fs';
import * as path from 'path';
import { createBotRoutes } from '../../src/webui/routes/bots';
import { PRIMARY, REPLICA, seedBot, clearRegistry, stored, putDump, stampText } from './nm2-harness';

const router = createBotRoutes({ clients: new Set() } as any);
const call = async (method: 'get' | 'put', routePath: string, id: string, body: unknown = {}): Promise<{ status: number; body: any }> => {
  const layer = (router as any).stack.find((l: any) => l.route?.path === routePath && l.route.methods[method]);
  const res: any = { statusCode: 200 };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  await layer.route.stack[layer.route.stack.length - 1].handle({ params: { id }, query: {}, body }, res);
  return { status: res.statusCode, body: res.body };
};
const H = 3_600_000;

beforeEach(() => {
  fs.rmSync(path.join(h.dir, 'backups'), { recursive: true, force: true });
  clearRegistry();
});
afterAll(() => fs.rmSync(h.dir, { recursive: true, force: true }));

describe('NM2 E: the backup settings', () => {
  it('E1 a valid enabled and hour with expected are saved, and the answer carries no keep', async () => {
    seedBot({ fleetDb: PRIMARY });
    const r = await call('put', '/:id/fleet-backup-config', 'a', { enabled: false, hour: 7, expected: { enabled: true, hour: 4 } });
    expect(r.status).toBe(200);
    expect(r.body.fleetBackup).toEqual({ enabled: false, hour: 7 });
    expect(stored().fleetBackup).toEqual({ enabled: false, hour: 7 });
  });

  it('E2 a body with only keep is refused and nothing is saved', async () => {
    seedBot({ fleetDb: PRIMARY });
    const r = await call('put', '/:id/fleet-backup-config', 'a', { keep: 3, expected: { keep: 7 } });
    expect(r).toEqual({ status: 400, body: { success: false, error: 'No backup setting was given. Nothing was saved.' } });
    expect(stored().fleetBackup).toBeUndefined();
  });

  it('E3 an expected value that differs from the stored one answers 409', async () => {
    seedBot({ fleetDb: PRIMARY, fleetBackup: { enabled: true, hour: 6 } });
    const r = await call('put', '/:id/fleet-backup-config', 'a', { hour: 7, expected: { hour: 4 } });
    expect(r.status).toBe(409);
    expect(r.body.fleetBackup).toEqual({ enabled: true, hour: 6 });
  });

  it('E4 an hour outside 0-23 or an enabled that is not boolean is refused with the existing texts', async () => {
    seedBot({ fleetDb: PRIMARY });
    expect((await call('put', '/:id/fleet-backup-config', 'a', { hour: 24, expected: { hour: 4 } })).body.error).toBe('hour must be a whole number from 0 to 23. Nothing was saved.');
    expect((await call('put', '/:id/fleet-backup-config', 'a', { enabled: 'yes', expected: { enabled: true } })).body.error).toBe('enabled must be true or false. Nothing was saved.');
  });
});

describe('NM2 the health object, the list and copyBackup', () => {
  it('main only, copy only and both carry the families they hold', async () => {
    const fb = await import('../../src/instance/fleetBackup');
    const cm = await import('../../src/docker/containerManager');
    seedBot({ fleetDb: PRIMARY });
    const main = fb.fleetBackupStatus(cm.getBot('a')!);
    expect(main).toMatchObject({ enabled: true, hour: 4, scoped: true, restoreError: null, copy: null });
    expect(main.main).toMatchObject({ family: 'main', role: 'main database', enabled: true, hour: 4, paused: false, lastFile: null, lastAt: null, lastError: null, failingSince: null, skip: null, test: null, alerts: { dumps: null, test: null } });
    seedBot({ fleetDbReplica: REPLICA });
    const copy = fb.fleetBackupStatus(cm.getBot('a')!);
    expect(copy.main).toBeNull();
    expect(copy.copy).toMatchObject({ family: 'copy', role: 'live copy' });
    seedBot({ fleetDb: PRIMARY, fleetDbReplica: REPLICA });
    const both = fb.fleetBackupStatus(cm.getBot('a')!);
    expect(both.main?.family).toBe('main');
    expect(both.copy?.family).toBe('copy');
    seedBot({});
    const coll = (await import('../../src/webui/routes/bots')).collectHealthChanges(new Map());
    expect(coll.find(c => c.id === 'a')?.fleetBackup).toBeNull();
  });

  it('the newest dump of each family is named, with the copy\'s dataAt from its counts file', async () => {
    const at = Date.now() - H;
    putDump(`hourly-${stampText(at)}.dump`, { takenAt: at });
    putDump(`copy-hourly-${stampText(at)}.dump`, { takenAt: at, meta: { dataAt: at - 5000 } });
    putDump('pre-restore-x.dump');
    seedBot({ fleetDb: PRIMARY, fleetDbReplica: REPLICA });
    const fb = await import('../../src/instance/fleetBackup');
    const cm = await import('../../src/docker/containerManager');
    const st = fb.fleetBackupStatus(cm.getBot('a')!);
    expect(st.main).toMatchObject({ lastFile: `hourly-${stampText(at)}.dump`, lastAt: at });
    expect(st.copy).toMatchObject({ lastFile: `copy-hourly-${stampText(at)}.dump`, lastAt: at, dataAt: at - 5000 });
  });

  it('list entries carry kind, family, takenAt, tables, rows, dataAt and the test verdict', async () => {
    const at = Date.now() - H;
    const file = `daily-${stampText(at)}.dump`;
    putDump(file, { takenAt: at, counts: { '"public"."a"': 4, '"public"."b"': 1 } });
    putDump('pre-restore-x.dump', { meta: null });
    seedBot({ fleetDb: PRIMARY, fleetBackupTests: { main: { last: { file, startedAt: at, finishedAt: at, result: 'passed', tables: 2, rows: 5 }, lastGood: file } } });
    const r = await call('get', '/:id/fleet-backups', 'a');
    const entry = (name: string) => r.body.backups.find((b: any) => b.file === name);
    expect(entry(file)).toMatchObject({ file, kind: 'daily', family: 'main', takenAt: at, tables: 2, rows: 5, dataAt: null, test: 'passed' });
    expect(entry('pre-restore-x.dump')).toMatchObject({ file: 'pre-restore-x.dump', kind: 'safety', family: 'main', tables: null, rows: null, test: null });
  });

  it('copyBackup on the replica route is the copy family\'s status', async () => {
    seedBot({ fleetDbReplica: REPLICA });
    const fb = await import('../../src/instance/fleetBackup');
    const cm = await import('../../src/docker/containerManager');
    expect(fb.fleetBackupStatus(cm.getBot('a')!).copy).toMatchObject({ family: 'copy', enabled: true, hour: 4 });
  });
});

describe('NM2 the Database window texts (section 10)', () => {
  const pageHtml = fs.readFileSync(path.resolve(__dirname, '../../src/webui/public/index.html'), 'utf8');
  const fn = (name: string): string => {
    const start = pageHtml.indexOf(`function ${name}(`);
    expect(start, name).toBeGreaterThan(-1);
    return pageHtml.slice(start, pageHtml.indexOf('\n    }\n', start) + 6);
  };
  const src = ['backupTime', 'backupTestHtml', 'backupAlertHtml', 'backupStatusHtml', 'fleetBackupBadges', 'copyDumpHtml'].map(fn).join('\n');
  const run = (expr: string, ctx: Record<string, unknown>) => vm.runInNewContext(`${src}\n${expr}`, { escapeHtml: (s: string) => s, ...ctx });
  const T0 = Date.UTC(2026, 9, 27, 4, 10);
  const when = (ms: number) => new Date(ms).toLocaleString();
  const fam = (over: Record<string, unknown> = {}) => ({ family: 'main', role: 'main database', enabled: true, hour: 4, paused: false, lastFile: null, lastAt: null, dataAt: null, lastError: null, failingSince: null, listError: null, skip: null, test: null, alerts: { dumps: null, test: null }, ...over });
  const line = (f: unknown) => run('backupStatusHtml(f)', { f }) as string;

  it.each([
    ['T-OFF', fam({ enabled: false }), 'Backups are off for this bot: no backup is taken and none is deleted.'],
    ['T-NEVER', fam(), 'No backup yet; the first one starts within a minute.'],
    ['T-OK', fam({ lastFile: 'daily-x.dump', lastAt: T0 }), `Last backup: daily-x.dump at ${when(T0)}. Hourly backups are kept for 48 hours and daily ones for 30 days; the daily backup and its test restore run at 04:00.`],
    ['T-COPYOK', fam({ family: 'copy', role: 'live copy', lastFile: 'copy-daily-x.dump', lastAt: T0, dataAt: T0 - 1000 }), `Last backup of this copy: copy-daily-x.dump at ${when(T0)}, holding changes up to ${when(T0 - 1000)}.`],
    ['T-COPYOK no replay', fam({ family: 'copy', role: 'live copy', lastFile: 'copy-daily-x.dump', lastAt: T0 }), `Last backup of this copy: copy-daily-x.dump at ${when(T0)}, holding no replayed change yet.`],
    ['T-ERR', fam({ lastError: 'pg_dump exited with code 1: x' }), 'The last backup attempt failed: pg_dump exited with code 1: x. The next attempt starts at the next hour.'],
    ['T-FAILING', fam({ lastError: 'boom', failingSince: T0, alerts: { dumps: { kind: 'dumps', text: 'dm', since: T0, dm: 'pending' }, test: null } }), `No backup has succeeded since ${when(T0)}. Last error: boom.`],
    ['T-FAILING no error', fam({ failingSince: T0, alerts: { dumps: { kind: 'dumps', text: 'dm', since: T0, dm: 'pending' }, test: null } }), `No backup has succeeded since ${when(T0)}.`],
    ['T-PAUSED', fam({ paused: true, lastFile: 'hourly-x.dump', lastAt: T0 }), 'The database container is not running, so no backup is taken; nothing can change in it while it is stopped. Newest backup: hourly-x.dump.'],
    ['T-PAUSED none', fam({ paused: true }), 'The database container is not running, so no backup is taken; nothing can change in it while it is stopped. Newest backup: none.'],
    ['T-NONE', fam(), 'No test restore yet; the first runs after the daily backup at 04:00.'],
    ['T-RUN', fam({ test: { file: 'daily-x.dump', startedAt: T0, result: 'running' } }), `Test restore of daily-x.dump running since ${when(T0)}.`],
    ['T-PASS', fam({ test: { file: 'daily-x.dump', startedAt: T0, finishedAt: T0, result: 'passed', tables: 4, rows: 120 } }), `Test restore of daily-x.dump passed at ${when(T0)}: 4 tables and 120 rows matched the counts recorded when it was taken.`],
    ['T-FAIL', fam({ test: { file: 'daily-x.dump', startedAt: T0, finishedAt: T0, result: 'failed', text: 'pg_restore did not finish within 10 minutes' } }), `Test restore of daily-x.dump failed at ${when(T0)}: pg_restore did not finish within 10 minutes.`],
    ['T-CUT', fam({ test: { file: 'daily-x.dump', startedAt: T0, result: 'interrupted', cutShort: 1 } }), 'Test restore of daily-x.dump was cut short by a manager restart; it runs again within a minute.'],
    ['N-SENT', fam({ alerts: { dumps: null, test: { kind: 'test', text: 'x', since: T0, dm: 'sent', dmAt: T0 } } }), `The owner was sent a DM at ${when(T0)}.`],
    ['N-PENDING', fam({ alerts: { dumps: null, test: { kind: 'test', text: 'x', since: T0, dm: 'pending' } } }), 'The DM to the owner is being sent.'],
    ['N-FAILED', fam({ alerts: { dumps: null, test: { kind: 'test', text: 'x', since: T0, dm: 'failed', dmAt: T0, dmError: 'notify-owner returned 404' } } }), 'The DM to the owner could not be sent: notify-owner returned 404. The manager tries again every hour.'],
    ['N-UNKNOWN', fam({ alerts: { dumps: null, test: { kind: 'test', text: 'x', since: T0, dm: 'unknown', dmAt: T0 } } }), "The bot did not answer within 30 s, so the manager can't confirm the owner got the DM."],
    ['N-NONE', fam({ alerts: { dumps: null, test: { kind: 'test', text: 'x', since: T0, dm: 'unsupported', dmAt: T0 } } }), 'This app has no notify-owner hook, so this failure shows only here.'],
  ])('%s', (_id, f, text) => {
    expect(line(f)).toContain(text);
  });

  const failedTest = { test: { file: 'd.dump', startedAt: T0, result: 'failed', finishedAt: T0, text: 'x' }, alerts: { dumps: null, test: { kind: 'test', text: 'x', since: T0, dm: 'sent', dmAt: T0 } } };

  it('T-OFF with no test alert: no last backup line and no test line', () => {
    const out = line(fam({ enabled: false, lastFile: 'x.dump', lastAt: T0, test: { file: 'x.dump', startedAt: T0, finishedAt: T0, result: 'passed', tables: 1, rows: 1 } }));
    expect(out).toContain('Backups are off for this bot');
    expect(out).not.toContain('Last backup');
    expect(out).not.toMatch(/test restore/i);
  });

  it('T-OFF with a test alert standing: the test line and its DM line follow, in the window and on the replica window', () => {
    const out = line(fam({ enabled: false, ...failedTest }));
    expect(out).toContain('Backups are off for this bot');
    expect(out).toContain(`Test restore of d.dump failed at ${when(T0)}: x.`);
    expect(out).toContain(`The owner was sent a DM at ${when(T0)}.`);
    expect(out).not.toContain('Last backup');
    const copy = run('copyDumpHtml(f)', { f: fam({ family: 'copy', role: 'live copy', enabled: false, ...failedTest }) }) as string;
    expect(copy).toContain('Test restore of d.dump failed');
    expect(copy).toContain('The owner was sent a DM');
  });

  it('T-SCOPE: a family out of scope shows no status line, and no promise of a dump or a test', () => {
    expect(line(fam({ skip: 'scope' }))).toBe('');
    expect(line(fam({ skip: 'scope', lastFile: 'daily-x.dump', lastAt: T0 }))).toBe('');
  });

  it('T-SEED: a copy whose seed runs shows one line, that its backups start after the seed', () => {
    const out = line(fam({ family: 'copy', role: 'live copy', skip: 'seed' }));
    expect(out).toBe('<div class="env-tip">Backups of this copy start after its seed finishes.</div>');
  });

  it('a skipped family shows the test line and its DM line while a test alert stands', () => {
    for (const skip of ['scope', 'seed']) {
      const out = line(fam({ skip, ...failedTest }));
      expect(out).toContain(`Test restore of d.dump failed at ${when(T0)}: x.`);
      expect(out).toContain(`The owner was sent a DM at ${when(T0)}.`);
      expect(out).not.toMatch(/within a minute|first runs after/);
    }
  });

  it('the badges replace the old failed and stale badges', () => {
    const fbh = { main: fam({ alerts: { dumps: { kind: 'dumps', text: 'No backup of A', since: T0, dm: 'sent' }, test: null } }), copy: fam({ family: 'copy', alerts: { dumps: null, test: { kind: 'test', text: 'The daily test', since: T0, dm: 'sent' } } }) };
    const out = run('fleetBackupBadges(f)', { f: fbh }) as string;
    expect(out).toContain('title="No backup of A">DB backup failed</span>');
    expect(out).toContain('title="The daily test">DB test restore failed</span>');
    expect(run('fleetBackupBadges(f)', { f: { main: fam(), copy: null } })).toBe('');
    expect(pageHtml).not.toContain('DB backup stale');
    expect(pageHtml).not.toContain('No database backup in over 36 hours');
  });

  it('copyDumpHtml shows the copy family\'s lines and nothing for no copy', () => {
    expect(run('copyDumpHtml(f)', { f: null })).toBe('');
    expect(run('copyDumpHtml(f)', { f: fam({ family: 'copy', role: 'live copy', enabled: false }) })).toContain('Backups are off for this bot');
    expect(pageHtml).toContain('${copyDumpHtml(res.copyBackup)}');
  });

  it('the settings row has no Keep, and names the switch and the hour as ruled', () => {
    expect(pageHtml).not.toContain('fleet-backup-keep');
    expect(pageHtml).toContain('<span>Backups</span>');
    expect(pageHtml).toContain('Daily backup and test restore at');
    expect(pageHtml).toContain('Backups kept on this machine: dumps of the live copy (copy-) and dumps taken while this machine held the main database. Restoring one needs a machine that holds the main database.');
  });
});
