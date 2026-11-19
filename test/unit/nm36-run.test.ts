import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm36-run-'));
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
import { KEPT_TEXT, newStartDone, startOnNewDatabase } from '../../src/instance/keptData';
import { createBotRoutes } from '../../src/webui/routes/bots';
import { docker, resetDocker } from './nm2-docker';
import { clearRegistry, registryPath } from './nm2-harness';
import { resetRun, run } from './nm31-run';
import { CONTAINER, dataDirOf, db, pageOpenLine, resetSeed, seedMain, stored, treeOf, composePathOf } from './nm31-seed';
import { answerOrders, Before, bot, fwd, keptAfterStart, LATER, pressBack, resetBack } from './nm31-back';
import { offOrderNoAdmin, owner, resetOwner, scriptOf, useOwner } from './nm34-seed';
import { FIXTURE_CRT, FIXTURE_KEY, NOSSL, NOT_RUNNING, P, resetTls, restart, tlsFake, tlsOf } from './nm36-tls';
import type { KeptOpRecord } from '../../src/types';

const NOW = Date.parse('2026-11-17T12:00:00.000Z');
const LATER_ISO = new Date(LATER).toISOString();
const s = () => tlsOf(CONTAINER);
const timing = { ...LOCAL_TLS_TIMING };
const realSave = containerManager.saveKeptOpIf;
const TLS_EFFECTS = ['mounts', 'E1', 'probe', 'openssl', 'put:server.key', 'put:server.crt', 'mv', 'alter', 'reload', 'read'];
const tlsEffects = () => tlsFake.calls.filter(c => TLS_EFFECTS.includes(c) || c.startsWith('put:'));

/** Date.now: NOW plus `skew.ms`; clockPerRead moves the skew on 2000 ms at each TLS read. */
const skew = { ms: 0 };
function clockPerRead(): void {
  tlsFake.onRead = () => { skew.ms += 2000; };
}
function clockBack(): void {
  tlsFake.onRead = null;
  skew.ms = 0;
}

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

/** The main fixture with the kept database answering ssl on, and the login's open marked in docker.calls. */
async function fixture(ssl = 'on'): Promise<Before> {
  await seedMain();
  answerOrders();
  db.ssl = { ok: true, stdout: `${ssl}\n` };
  markOpen();
  return { inst: bot(), folder: treeOf(dataDirOf('a')), compose: fs.readFileSync(composePathOf('a'), 'utf-8') };
}

function markOpen(): void {
  const impl = vi.mocked(dbLogin.openBotLogin).getMockImplementation()!;
  vi.spyOn(dbLogin, 'openBotLogin').mockImplementation(async (t) => {
    docker.calls.push(['openBotLogin']);
    return impl(t);
  });
}

async function press() {
  tlsFake.calls.length = 0;
  tlsFake.opensslArgs.length = 0;
  return startOnNewDatabase('a');
}

const doneText = (before: Before, tls: boolean) => KEPT_TEXT.nDoneMain({
  old: before.inst.fleetDb!.volume, outDir: fwd().outDir, newVolume: fwd().newVolume, certs: false, replication: false, sharers: null, ...(tls ? { tls: true } : {}),
});

/** R1's end: the done text with the TLS clause, the record closed, TLS loaded on the new database. */
function expectDone(before: Before, answer: unknown): void {
  expect(answer).toEqual({ success: true, text: doneText(before, true) });
  expect(bot().keptOp).toBeUndefined();
  expect(bot().fleetDb!.volume).toBe(fwd().newVolume);
  expect(bot().keptLast).toMatchObject({ op: 'new-start', outcome: 'done', text: doneText(before, true) });
  expect(s()).toMatchObject({ saved: true, loaded: true });
  expect(Object.keys(s().files).sort()).toEqual(['server.crt', 'server.key']);
}

/** The open answer for `reason` at 'db-in', with the record's steps. */
function expectOpen(answer: unknown, reason: string): void {
  const rec = stored().keptOp as KeptOpRecord;
  expect(rec).toMatchObject({ step: 'db-in', lastError: reason, keptSsl: true });
  expect(answer).toEqual({ success: false, status: 409, open: true, error: KEPT_TEXT.nOpen(reason, newStartDone(rec)) });
}

/** Throws once from the save of `step`; every other save runs. */
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

function dropKeptSsl(): void {
  const reg = JSON.parse(fs.readFileSync(registryPath(), 'utf-8'));
  delete reg.instances.a.keptOp.keptSsl;
  fs.writeFileSync(registryPath(), JSON.stringify(reg, null, 2));
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

describe('nm36 run: the db-up step with the kept database on TLS', () => {
  it('R1: a clean run turns TLS on: the checksum read, then the mount read, then E1; ALTER before the login opens; done with the TLS clause', async () => {
    const before = await fixture();
    const answer = await press();
    expectDone(before, answer);
    const at = (pred: (a: string[]) => boolean) => docker.calls.findIndex(pred);
    const sums = at(a => a.join(' ').includes('SHOW data_checksums'));
    const mounts = docker.calls.map(a => a[0] === 'container' && a[1] === 'inspect').lastIndexOf(true);
    const e1 = at(a => a[0] === 'exec' && a.includes('sh') && a[a.length - 1].startsWith(`test -f ${P}/server.crt && test -f ${P}/server.key`));
    const alter = at(a => a.includes('ALTER SYSTEM SET ssl = on;'));
    const opened = at(a => a[0] === 'openBotLogin');
    expect(sums).toBeGreaterThanOrEqual(0);
    expect(mounts).toBeGreaterThan(sums);
    expect(e1).toBeGreaterThan(mounts);
    expect(alter).toBeGreaterThan(e1);
    expect(opened).toBeGreaterThan(alter);
    expect(docker.calls[mounts]).toEqual(['container', 'inspect', '-f',
      '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Type}} {{if .Name}}{{.Name}}{{else}}{{.Source}}{{end}}{{println}}{{end}}{{end}}', CONTAINER]);
    expect(tlsEffects()).toEqual(['mounts', 'E1', 'probe', 'openssl', 'put:server.key', 'put:server.crt', 'mv', 'alter', 'reload', 'read']);
  });

  it('R2: the kept database ran with ssl off: no openssl, no ALTER SYSTEM SET ssl, no TLS read; NM31\'s done text', async () => {
    const before = await fixture('off');
    const answer = await press();
    expect(answer).toEqual({ success: true, text: KEPT_TEXT.nDoneMain({ old: before.inst.fleetDb!.volume, outDir: fwd().outDir, newVolume: fwd().newVolume, certs: false, replication: false, sharers: null }) });
    expect(tlsFake.calls).toEqual([]);
    expect(tlsFake.opensslArgs).toEqual([]);
    expect(docker.calls.filter(a => a.join(' ').includes('ALTER SYSTEM SET ssl'))).toEqual([]);
    const reads = docker.calls.map((a, i) => (a[0] === 'container' ? i : -1)).filter(i => i >= 0);
    expect(reads).toHaveLength(2);
    const made = docker.calls.findIndex(a => a[0] === 'sh' && a[1].endsWith('up --no-start fleet-postgres'));
    const up = docker.calls.findIndex((a, i) => i > made && a[0] === 'sh' && a[1].endsWith('up -d fleet-postgres'));
    const ready = docker.calls.findIndex((a, i) => i > made && a[0] === 'sh' && a[1].includes(' pg_isready '));
    expect(made).toBeGreaterThanOrEqual(0);
    expect(reads[0]).toBeGreaterThan(made);
    expect(reads[0]).toBeLessThan(up);
    expect(reads[1]).toBeGreaterThan(up);
    expect(reads[1]).toBeLessThan(ready);
  });

  it('R3: an open record at db-in without keptSsl, as an older manager left it: Run again makes no TLS call, text without the clause', async () => {
    const before = await fixture();
    tlsFake.openssl = 'fail';
    await press();
    expect(stored().keptOp).toMatchObject({ step: 'db-in', keptSsl: true });
    dropKeptSsl();
    tlsFake.openssl = 'pair';
    const answer = await press();
    expect(answer).toEqual({ success: true, text: doneText(before, false) });
    expect(tlsEffects()).toEqual([]);
  });

  it('R4: through the route POST /:id/fleet-db/new-start: 200 with R1\'s text', async () => {
    const before = await fixture();
    expect(await call('/:id/fleet-db/new-start', { id: 'a' })).toEqual({ status: 200, body: { success: true, text: doneText(before, true) } });
  });
});

type Fault = {
  name: string; arrange: () => void; clear: () => void; lead: (why: string) => string; why: string;
  /** Checked after the first press, and after the Run again. */
  stopped?: () => void; again?: () => void;
};
const OPENSSL_FAIL = 'certificate generation failed: req: Unable to load config info';
const REFUSED_10 = `the server still refused TLS 10 s after the reload: ${NOSSL}`;
const ASIDE = () => ({ 'server.key.new': FIXTURE_KEY, 'server.crt.new': FIXTURE_CRT });
const faults: Fault[] = [
  { name: 'openssl fails', arrange: () => { tlsFake.openssl = 'fail'; }, clear: () => { tlsFake.openssl = 'pair'; }, lead: KEPT_TEXT.nTls, why: OPENSSL_FAIL },
  { name: 'the pair does not match', arrange: () => { tlsFake.openssl = 'mismatch'; }, clear: () => { tlsFake.openssl = 'pair'; }, lead: KEPT_TEXT.nTls,
    why: 'the generated key does not match the generated certificate (nothing was installed)' },
  { name: 'the key\'s put fails', arrange: () => { s().fail.put = 'server.key'; }, clear: () => { s().fail.put = undefined; }, lead: KEPT_TEXT.nTls,
    why: `certificate install failed (server.key; the installed pair was not changed): sh: can't create ${P}/server.key.new: Permission denied` },
  { name: 'the renames stop between the two', arrange: () => { s().fail.swap = true; }, clear: () => { s().fail.swap = false; }, lead: KEPT_TEXT.nTls,
    why: `certificate install failed while moving the new pair into place, so the key and certificate on disk may not match (the configuration was not reloaded; run it again to install a fresh pair): mv: can't rename '${P}/server.crt.new': I/O error` },
  { name: 'ALTER answers an error', arrange: () => { s().fail.alter = 'error'; }, clear: () => { s().fail.alter = undefined; }, lead: KEPT_TEXT.nTls,
    why: 'ssl = on could not be saved: ERROR:  could not write to file "postgresql.auto.tmp": No space left on device' },
  { name: 'never loaded, the server answers no SSL (the first pair stays unloadable)', arrange: () => { s().swapLoadable = [false]; clockPerRead(); }, clear: clockBack,
    lead: (why: string) => KEPT_TEXT.nTlsOff(why), why: REFUSED_10,
    stopped: () => {
      expect(s()).toMatchObject({ saved: false, loaded: false });
      expect(s().files).toEqual(ASIDE());
      expect(tlsFake.calls.slice(-3)).toEqual(['reset', 'aside', 'reload']);
    },
    again: () => expect(tlsFake.opensslArgs.length).toBe(1) },
  { name: 'the reload fails', arrange: () => { s().fail.reload = 'error'; }, clear: () => { s().fail.reload = undefined; }, lead: KEPT_TEXT.nTlsUnknown,
    why: 'the configuration could not be reloaded: psql: error: connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed: FATAL:  the database system is shutting down' },
];

describe('nm36 run: the TLS step stops, then Run again', () => {
  it.each(faults.map(f => [f.name, f] as const))('R5: %s: the record stays open at db-in with the reason; cleared, Run again ends as R1', async (_n, f) => {
    const before = await fixture();
    f.arrange();
    const answer = await press();
    expectOpen(answer, f.lead(f.why));
    f.stopped?.();
    f.clear();
    expectDone(before, await press());
    f.again?.();
  });

  const states: Array<[string, () => void, () => void, boolean]> = [
    ['T11: a .new file left by the renames', () => { s().fail.swap = true; }, () => { s().fail.swap = false; }, true],
    ['T12: the pair complete, ssl not saved', () => { s().fail.alter = 'error'; }, () => { s().fail.alter = undefined; }, false],
    ['T13: ssl saved, not loaded', () => { s().fail.reload = 'error'; }, () => { s().fail.reload = undefined; }, false],
    ['T14: everything done but the save of db-up', () => crashOnStep('db-up'), () => vi.mocked(containerManager.saveKeptOpIf).mockImplementation(realSave), false],
    ['T15: the container restarted after ssl was saved', () => { s().fail.reload = 'error'; }, () => { s().fail.reload = undefined; restart(CONTAINER); }, false],
  ];
  it.each(states)('R6: %s: Run again ends as R1', async (_n, arrange, clear, openssl) => {
    const before = await fixture();
    arrange();
    expect(await press()).toMatchObject({ success: false, open: true });
    expect(stored().keptOp).toMatchObject({ step: 'db-in' });
    clear();
    const answer = await press();
    expectDone(before, answer);
    expect(tlsFake.opensslArgs.length).toBe(openssl ? 1 : 0);
  });

  it('R7 (T17): the login fails after db-up was saved: the done list ends with TLS is on; Run again makes no TLS call', async () => {
    const before = await fixture();
    db.open = { ok: false, cls: 'other', error: 'the server closed the connection' };
    const answer = await press();
    const rec = stored().keptOp as KeptOpRecord;
    expect(rec.step).toBe('db-up');
    const done = newStartDone(rec);
    expect(done.slice(-2)).toEqual(['the new database started', 'TLS is on']);
    const reason = "the bot's login on the new database could not be opened (the server closed the connection)";
    expect(answer).toEqual({ success: false, status: 409, open: true, error: KEPT_TEXT.nOpen(reason, done) });
    db.open = { ok: true };
    const again = await press();
    expect(tlsEffects()).toEqual([]);
    expect(again).toEqual({ success: true, text: doneText(before, true) });
  });

  it('R8 (T18): Put back after R5\'s stop: the reverse\'s done answer, the -new set holds the new volume, no TLS call', async () => {
    const before = await fixture();
    run.volumes[before.inst.fleetDb!.volume] = 'exists';
    tlsFake.openssl = 'fail';
    expect(await press()).toMatchObject({ success: false, open: true });
    run.volumes[fwd().newVolume] = 'exists';
    tlsFake.openssl = 'pair';
    skew.ms = LATER - NOW;
    tlsFake.calls.length = 0;
    const answer = await pressBack(fwd().stamp, { reverse: true });
    expect(answer).toMatchObject({ success: true });
    expect((answer as { text: string }).text.startsWith('Put back.')).toBe(true);
    expect(bot().fleetDb).toEqual(before.inst.fleetDb);
    expect(bot().keptOp).toBeUndefined();
    expect(bot().keptSets).toEqual([{
      id: `${fwd().stamp}-new`, keptAt: LATER_ISO, by: 'put-back', folder: fwd().inDir,
      db: { containerName: CONTAINER, user: before.inst.fleetDb!.user, db: before.inst.fleetDb!.db, volume: fwd().newVolume, password: before.inst.fleetDb!.password },
    }]);
    expect(tlsEffects()).toEqual([]);
  });

  it('R9 (T19): Put back of the kept set after R1: Put back\'s done answer, the kept volume in use again, no TLS call', async () => {
    db.ssl = { ok: true, stdout: 'on\n' };
    const before = await keptAfterStart('main');
    expect(stored().keptLast.text).toContain('TLS on as the kept database had it');
    tlsFake.calls.length = 0;
    const answer = await pressBack();
    expect(answer).toMatchObject({ success: true });
    expect((answer as { text: string }).text.startsWith('Put back.')).toBe(true);
    expect(bot().fleetDb!.volume).toBe(before.inst.fleetDb!.volume);
    expect(tlsEffects()).toEqual([]);
  });

  it('R10: the no-dbm_admin path with the kept database on TLS: done with the TLS clause; scripts S1, S2, S4, S1', async () => {
    await seedMain('a', { off: false });
    await offOrderNoAdmin('a');
    answerOrders();
    useOwner();
    owner.ssl = 'on';
    const before: Before = { inst: bot(), folder: {}, compose: '' };
    const answer = await press();
    expect(answer).toEqual({ success: true, text: doneText(before, true) });
    expect(owner.calls.map(scriptOf)).toEqual(['S1', 'S2', 'S4', 'S1']);
    expect(s()).toMatchObject({ saved: true, loaded: true });
  });

  it('R11: R5\'s open record: the page\'s open line equals the answer\'s error', async () => {
    await fixture();
    tlsFake.openssl = 'fail';
    const answer = await press() as { error: string };
    expect(pageOpenLine(bot().keptOp)).toBe(answer.error);
    expect(answer.error).toContain(KEPT_TEXT.nTls(OPENSSL_FAIL));
  });
});

describe('nm36 run: G0, the mount read', () => {
  const cases: Array<[string, (kept: string) => { out: string } | { stderr: string }, (kept: string) => string]> = [
    ['G0-2: the kept volume', kept => ({ out: `volume ${kept}\n` }), kept => KEPT_TEXT.nMount([`volume ${kept}`], fwd().newVolume)],
    ['G0-2: a bind mount', () => ({ out: 'bind /srv/pgdata\n' }), () => KEPT_TEXT.nMount(['bind /srv/pgdata'], fwd().newVolume)],
    ['G0-2: no mount', () => ({ out: '' }), () => KEPT_TEXT.nMount([], fwd().newVolume)],
    ['G0-3: no such container', () => ({ stderr: `Error: No such container: ${CONTAINER}` }), () => KEPT_TEXT.nMountGone],
    ['G0-4: the daemon does not answer', () => ({ stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?' }),
      () => KEPT_TEXT.nMountUnknown('Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?')],
  ];
  it.each(cases)('R12: %s: open at db-in with G0\'s reason, no E1, no openssl; the mounts cleared, Run again ends as R1', async (name, answerOf, reasonOf) => {
    const before = await fixture();
    const kept = before.inst.fleetDb!.volume;
    tlsFake.mounts[CONTAINER] = answerOf(kept);
    const answer = await press();
    const reason = reasonOf(kept);
    expectOpen(answer, reason);
    if (name.includes('bind')) expect(reason).toContain('bind /srv/pgdata');
    if (name.includes('no mount')) expect(reason).toContain('docker shows no mount at');
    expect(tlsFake.calls).toEqual(['mounts']);
    expect(tlsFake.opensslArgs).toEqual([]);
    delete tlsFake.mounts[CONTAINER];
    expectDone(before, await press());
  });
});

describe('nm36 run: E1 unanswered on a Run again (T26, T27)', () => {
  it('R13: a run stopped after E5 by a reload error, then E1 answers docker\'s error: can\'t confirm, no openssl, pair and ssl unchanged; then Run again ends as R1', async () => {
    const before = await fixture();
    s().fail.reload = 'error';
    expect(await press()).toMatchObject({ success: false, open: true });
    s().fail.reload = undefined;
    s().e1 = 'stderr';
    const pair = { ...s().files };
    const answer = await press();
    expectOpen(answer, KEPT_TEXT.nTlsUnknown(`docker did not say whether the certificate pair is in place: ${NOT_RUNNING(CONTAINER)}`));
    expect(tlsFake.opensslArgs).toEqual([]);
    expect(s().files).toEqual(pair);
    expect(s().saved).toBe(true);
    s().e1 = 'auto';
    expectDone(before, await press());
  });
});

describe('nm36 run: the undo\'s crash cells, driven as "the next effect fails, then Run again"', () => {
  const DISK_FULL = 'ERROR:  could not write to file "postgresql.auto.tmp": No space left on device';
  const renameFail = (f: string) => `the certificate files could not be renamed: mv: can't rename '${P}/${f}': Permission denied`;
  const refusing = async () => {
    const before = await fixture();
    s().swapLoadable = [false];
    clockPerRead();
    return before;
  };

  it('R14 (T28): the reset fails (STUCK); Run again with the container running ends at T10 with the same pair; a third press ends as R1', async () => {
    const before = await refusing();
    s().fail.reset = 'error';
    expectOpen(await press(), KEPT_TEXT.nTlsStuck(REFUSED_10, `ALTER SYSTEM RESET ssl failed: ${DISK_FULL}`));
    expect(s()).toMatchObject({ saved: true });
    s().fail.reset = undefined;
    expectOpen(await press(), KEPT_TEXT.nTlsOff(REFUSED_10));
    expect(tlsFake.opensslArgs).toEqual([]);
    expect(s().files).toEqual(ASIDE());
    clockBack();
    expectDone(before, await press());
    expect(tlsFake.opensslArgs.length).toBe(1);
  });

  it('R14 (T29): both renames fail (ASIDE); Run again reuses the pair, the undo runs whole and ends at T10', async () => {
    await refusing();
    s().fail.aside = 'all';
    expectOpen(await press(), KEPT_TEXT.nTlsAside(REFUSED_10, renameFail('server.key')));
    expect(s()).toMatchObject({ saved: false });
    s().fail.aside = undefined;
    expectOpen(await press(), KEPT_TEXT.nTlsOff(REFUSED_10));
    expect(tlsFake.opensslArgs).toEqual([]);
    expect(s().files).toEqual(ASIDE());
    expect(s().saved).toBe(false);
  });

  it('R14 (T30): the second rename fails (ASIDE); Run again makes a fresh pair and ends as R1', async () => {
    const before = await refusing();
    s().fail.aside = 'second';
    expectOpen(await press(), KEPT_TEXT.nTlsAside(REFUSED_10, renameFail('server.crt')));
    s().fail.aside = undefined;
    clockBack();
    expectDone(before, await press());
    expect(tlsFake.opensslArgs.length).toBe(1);
  });

  it('R14 (T33): the undo\'s reload fails (OFF with the reload clause); Run again makes a fresh pair and ends as R1', async () => {
    const before = await refusing();
    s().fail.undoReload = 'error';
    expectOpen(await press(), KEPT_TEXT.nTlsOff(REFUSED_10,
      'psql: error: connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed: FATAL:  the database system is shutting down'));
    expect(s()).toMatchObject({ saved: false });
    expect(s().files).toEqual(ASIDE());
    s().fail.undoReload = undefined;
    clockBack();
    expectDone(before, await press());
    expect(tlsFake.opensslArgs.length).toBe(1);
  });
});

describe('nm36 run: the undo\'s unknown and silent outcomes (code review 2)', () => {
  const LEAD = `TLS could not be turned on for the new database (${REFUSED_10})`;
  const refusing = async () => {
    await fixture();
    s().swapLoadable = [false];
    clockPerRead();
  };
  /** A press whose call waits for its 30 s limit: the clock is moved on until the press answers. */
  async function pressWithClock() {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const p = press();
      let done = false;
      p.then(() => { done = true; }, () => { done = true; });
      for (let i = 0; i < 400 && !done; i++) await vi.advanceTimersByTimeAsync(250);
      return await p;
    } finally {
      vi.useRealTimers();
    }
  }

  it('R15 (A3): the undo\'s reload gets no answer in 30 s: the clause says the manager can\'t confirm the reload', async () => {
    await refusing();
    s().fail.undoReload = 'hang';
    expectOpen(await pressWithClock(), `${LEAD}, so the manager turned it off again and set its certificate aside; the manager can't confirm the configuration was reloaded after that (the database did not answer pg_reload_conf() within 30 s), so the running database may still show ssl on until its next reload or restart; the new database runs without TLS while the Database URL asks for TLS, and Run it again makes a fresh certificate`);
  });

  it('R16 (A4): the renames get no answer in 30 s and dbExec kills docker: the text says the manager can\'t confirm the certificate was set aside', async () => {
    await refusing();
    s().fail.aside = 'hang';
    expectOpen(await pressWithClock(), `${LEAD}, so the manager turned it off again, but the manager can't confirm its certificate was set aside (docker did not answer within 30 s, so the manager can't confirm the certificate files were renamed); the new database runs without TLS while the Database URL asks for TLS`);
  });

  it('R17 (A4): the renames fail with no message: the why names docker exec\'s exit code', async () => {
    await refusing();
    s().fail.aside = 'silent';
    expectOpen(await press(), `${LEAD}, so the manager turned it off again, but its certificate could not be set aside (the certificate files could not be renamed (docker exec exited 1 with no message)); the new database runs without TLS while the Database URL asks for TLS`);
  });
});
