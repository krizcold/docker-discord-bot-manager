import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm36-tls-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir };
});

vi.mock('child_process', async (importOriginal) => (await import('./nm36-tls')).childProcessMock(await importOriginal(), require('fs')));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import * as crypto from 'crypto';
import * as fs from 'fs';
import { ensureLocalTls, LOCAL_TLS_TIMING } from '../../src/instance/fleetReplication';
import { resetDocker } from './nm2-docker';
import { FIXTURE_CRT, FIXTURE_KEY, NOSSL, NOT_RUNNING, OTHER_KEY, P, REFUSED, resetTls, tlsFake, tlsOf } from './nm36-tls';

const C = 'bota-fleet-postgres';
const s = () => tlsOf(C);
const FULL = ['E1', 'probe', 'openssl', 'put:server.key', 'put:server.crt', 'mv', 'alter', 'reload', 'read'];
const PAIR = () => ({ 'server.key': FIXTURE_KEY, 'server.crt': FIXTURE_CRT });
const OLD_CRT = '-----BEGIN CERTIFICATE-----\nold\n-----END CERTIFICATE-----\n';
const UNKNOWN = 'docker did not say whether the certificate pair is in place: ';
const REFUSED_10 = `the server still refused TLS 10 s after the reload: ${NOSSL}`;
const ASIDE = () => ({ 'server.key.new': FIXTURE_KEY, 'server.crt.new': FIXTURE_CRT });
const DISK_FULL = 'ERROR:  could not write to file "postgresql.auto.tmp": No space left on device';
const SHUTTING = 'psql: error: connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed: FATAL:  the database system is shutting down';
const timing = { ...LOCAL_TLS_TIMING };

/** A run whose call waits for a 30 s limit: the clock is moved on until it answers. */
async function withClock<T>(fn: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const p = fn();
    let done = false;
    p.then(() => { done = true; }, () => { done = true; });
    for (let i = 0; i < 400 && !done; i++) await vi.advanceTimersByTimeAsync(250);
    return await p;
  } finally {
    vi.useRealTimers();
  }
}

/** Date.now moved on 2000 ms at each TLS read. */
function clockPerRead(): void {
  let now = Date.parse('2026-11-19T12:00:00.000Z');
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  tlsFake.onRead = () => { now += 2000; };
}

const reads = () => tlsFake.calls.filter(c => c === 'read').length;

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  resetDocker();
  resetTls();
  Object.assign(LOCAL_TLS_TIMING, timing, { gapMs: 1 });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  Object.assign(LOCAL_TLS_TIMING, timing);
});
afterAll(() => { fs.rmSync(h.dir, { recursive: true, force: true }); });

describe('nm36 tls: ensureLocalTls brings TLS on', () => {
  it('L1: a fresh database: null; E1, the probe, openssl, both puts, the renames, ALTER, reload, the read, in order; the pair names localhost', async () => {
    expect(await ensureLocalTls(C)).toBeNull();
    expect(tlsFake.calls).toEqual(FULL);
    const argv = tlsFake.opensslArgs[0];
    expect(argv.slice(argv.indexOf('-subj'), argv.indexOf('-subj') + 2)).toEqual(['-subj', '/CN=localhost']);
    expect(argv.slice(argv.indexOf('-addext'), argv.indexOf('-addext') + 2)).toEqual(['-addext', 'subjectAltName=DNS:localhost']);
    expect(Object.keys(s().files).sort()).toEqual(['server.crt', 'server.key']);
    expect(new crypto.X509Certificate(s().files['server.crt']).subject).toBe('CN=localhost');
    expect(s()).toMatchObject({ saved: true, loaded: true });
  });

  it('L2: a complete pair in place: no openssl, no puts, no renames, and the pair bytes unchanged', async () => {
    s().files = PAIR();
    expect(await ensureLocalTls(C)).toBeNull();
    expect(tlsFake.calls).toEqual(['E1', 'alter', 'reload', 'read']);
    expect(s().files).toEqual(PAIR());
  });

  it('L3: a server.key.new left beside an older pair: a fresh pair is installed', async () => {
    s().files = { 'server.key': OTHER_KEY, 'server.crt': OLD_CRT, 'server.key.new': 'half' };
    expect(await ensureLocalTls(C)).toBeNull();
    expect(tlsFake.calls).toEqual(FULL);
    expect(s().files).toEqual(PAIR());
  });

  it('L4: the key moved and server.crt.new left: a fresh pair is installed', async () => {
    s().files = { 'server.key': OTHER_KEY, 'server.crt': OLD_CRT, 'server.crt.new': 'half' };
    expect(await ensureLocalTls(C)).toBeNull();
    expect(tlsFake.calls).toEqual(FULL);
    expect(s().files).toEqual(PAIR());
  });

  it('L5: ssl saved and not loaded: null, the reload loads it', async () => {
    Object.assign(s(), { files: PAIR(), saved: true, loaded: false });
    expect(await ensureLocalTls(C)).toBeNull();
    expect(tlsFake.calls).toEqual(['E1', 'alter', 'reload', 'read']);
    expect(s().loaded).toBe(true);
  });

  it('L6: everything done already: null, no openssl', async () => {
    Object.assign(s(), { files: PAIR(), saved: true, loaded: true });
    expect(await ensureLocalTls(C)).toBeNull();
    expect(tlsFake.opensslArgs).toEqual([]);
    expect(s().files).toEqual(PAIR());
  });
});

describe('nm36 tls: E2 to E4 fail (TLS known not to be on)', () => {
  it('L7: openssl fails: its stderr, off true, nothing written', async () => {
    tlsFake.openssl = 'fail';
    expect(await ensureLocalTls(C)).toEqual({ why: 'certificate generation failed: req: Unable to load config info', off: true });
    expect(s()).toMatchObject({ files: {}, saved: false, loaded: false });
    expect(tlsFake.calls).toEqual(['E1', 'probe', 'openssl']);
  });

  it('L8: openssl is missing: "certificate generation failed: Error: spawn openssl ENOENT", off true', async () => {
    tlsFake.openssl = 'missing';
    expect(await ensureLocalTls(C)).toEqual({ why: 'certificate generation failed: Error: spawn openssl ENOENT', off: true });
    expect(s()).toMatchObject({ files: {}, saved: false });
  });

  it('L9: the key does not match the certificate: nothing installed, off true', async () => {
    tlsFake.openssl = 'mismatch';
    expect(await ensureLocalTls(C)).toEqual({ why: 'the generated key does not match the generated certificate (nothing was installed)', off: true });
    expect(s()).toMatchObject({ files: {}, saved: false });
  });

  it('L10: the key\'s put fails: off true, nothing in PGDATA, no ALTER', async () => {
    s().fail.put = 'server.key';
    expect(await ensureLocalTls(C)).toEqual({
      why: `certificate install failed (server.key; the installed pair was not changed): sh: can't create ${P}/server.key.new: Permission denied`, off: true,
    });
    expect(s()).toMatchObject({ files: {}, saved: false });
    expect(tlsFake.calls).not.toContain('alter');
  });

  it('L11: the certificate\'s put fails: off true, the key\'s .new stays, no ALTER', async () => {
    s().fail.put = 'server.crt';
    expect(await ensureLocalTls(C)).toEqual({
      why: `certificate install failed (server.crt; the installed pair was not changed): sh: can't create ${P}/server.crt.new: Permission denied`, off: true,
    });
    expect(s().files).toEqual({ 'server.key.new': FIXTURE_KEY });
    expect(s().saved).toBe(false);
  });

  it('L12: the renames stop between the two: the why says run it again, not press Enable; off true, ssl not saved', async () => {
    s().fail.swap = true;
    const r = await ensureLocalTls(C);
    expect(r).toEqual({
      why: `certificate install failed while moving the new pair into place, so the key and certificate on disk may not match (the configuration was not reloaded; run it again to install a fresh pair): mv: can't rename '${P}/server.crt.new': I/O error`,
      off: true,
    });
    expect(r!.why).not.toContain('press Enable');
    expect(s().files).toEqual({ 'server.key': FIXTURE_KEY, 'server.crt.new': FIXTURE_CRT });
    expect(s().saved).toBe(false);
    expect(tlsFake.calls).not.toContain('alter');
  });

  it('L21: openssl exits 0 and writes nothing: the read\'s ENOENT message (the catch), off true', async () => {
    tlsFake.openssl = 'silent';
    const r = await ensureLocalTls(C);
    expect(r).toEqual({ why: expect.stringMatching(/^ENOENT: no such file or directory, open '.*server\.key'$/), off: true });
    expect(s()).toMatchObject({ files: {}, saved: false });
  });

  it('L22: openssl writes a key that is not PEM: "the generated certificate pair could not be read (nothing was installed): ...", off true', async () => {
    tlsFake.openssl = 'garbage';
    const r = await ensureLocalTls(C);
    expect(r!.why.startsWith('the generated certificate pair could not be read (nothing was installed): ')).toBe(true);
    expect(r!.why.length).toBeGreaterThan('the generated certificate pair could not be read (nothing was installed): '.length);
    expect(r!.off).toBe(true);
    expect(s()).toMatchObject({ files: {}, saved: false });
  });
});

describe('nm36 tls: E5 and E6', () => {
  it('L13: ALTER answers an error after E1 answered absent: off true, no reload', async () => {
    s().fail.alter = 'error';
    expect(await ensureLocalTls(C)).toEqual({ why: 'ssl = on could not be saved: ERROR:  could not write to file "postgresql.auto.tmp": No space left on device', off: true });
    expect(tlsFake.calls).not.toContain('reload');
    expect(s().saved).toBe(false);
  });

  it('L28: ALTER answers an error after E1 answered complete: off false (an earlier run may have saved and loaded ssl)', async () => {
    s().files = PAIR();
    s().fail.alter = 'error';
    expect(await ensureLocalTls(C)).toEqual({ why: 'ssl = on could not be saved: ERROR:  could not write to file "postgresql.auto.tmp": No space left on device', off: false });
    expect(tlsFake.calls).toEqual(['E1', 'alter']);
  });

  it('L14: ALTER gets no answer in 30 s: off false, no reload', async () => {
    s().fail.alter = 'hang';
    expect(await withClock(() => ensureLocalTls(C))).toEqual({ why: 'the database did not answer ALTER SYSTEM SET ssl = on within 30 s', off: false });
    expect(tlsFake.calls).not.toContain('reload');
  });

  it('L15: the reload fails: off false, ssl saved', async () => {
    s().fail.reload = 'error';
    expect(await ensureLocalTls(C)).toEqual({
      why: 'the configuration could not be reloaded: psql: error: connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed: FATAL:  the database system is shutting down',
      off: false,
    });
    expect(s()).toMatchObject({ saved: true, loaded: false });
    expect(tlsFake.calls).not.toContain('read');
  });

  it('L16: the reload gets no answer in 30 s: off false', async () => {
    s().fail.reload = 'hang';
    expect(await withClock(() => ensureLocalTls(C))).toEqual({ why: 'the database did not answer pg_reload_conf() within 30 s', off: false });
    expect(s().saved).toBe(true);
  });

  it('L17: the reload answers f: off false', async () => {
    s().fail.reload = 'f';
    expect(await ensureLocalTls(C)).toEqual({ why: "pg_reload_conf answered 'f'", off: false });
    expect(tlsFake.calls).not.toContain('read');
  });
});

describe('nm36 tls: E7, the read-back over TLS', () => {
  it('L18: two refused reads, then on: null after three reads', async () => {
    s().refusedReads = 2;
    expect(await ensureLocalTls(C)).toBeNull();
    expect(reads()).toBe(3);
  });

  it('L19: never loaded, the server answers no SSL: "the server still refused TLS 10 s after the reload: ...", off true, six reads; the undo saves ssl off and sets the pair aside under its .new names', async () => {
    s().swapLoadable = [false];
    clockPerRead();
    expect(await ensureLocalTls(C)).toEqual({ why: REFUSED_10, off: true, undo: { stage: 'done' } });
    expect(reads()).toBe(6);
    expect(s()).toMatchObject({ saved: false, loaded: false });
    expect(s().files).toEqual(ASIDE());
    expect(tlsFake.calls.slice(-3)).toEqual(['reset', 'aside', 'reload']);
  });

  it('L27: never loaded, connections refused: "no session over TLS opened within 10 s of the reload: ...", off false', async () => {
    s().swapLoadable = [false];
    s().readFail = 'refused';
    clockPerRead();
    expect(await ensureLocalTls(C)).toEqual({ why: `no session over TLS opened within 10 s of the reload: ${REFUSED}`, off: false });
    expect(reads()).toBe(6);
  });

  it('L20: a read that times out counts as a try, and the next one reads on', async () => {
    LOCAL_TLS_TIMING.tryMs = 50;
    s().readHang = 1;
    expect(await ensureLocalTls(C)).toBeNull();
    expect(reads()).toBe(2);
  });
});

describe('nm36 tls: E1 does not answer (nothing changed)', () => {
  it('L23: docker answers with its own error: the daemon\'s line, off false, no other call', async () => {
    s().e1 = 'stderr';
    expect(await ensureLocalTls(C)).toEqual({ why: `${UNKNOWN}${NOT_RUNNING(C)}`, off: false });
    expect(tlsFake.calls).toEqual(['E1']);
    expect(s()).toMatchObject({ files: {}, saved: false });
  });

  it('L24: E1 killed at its 30 s limit: "... in place: no answer within 30 s", off false', async () => {
    s().e1 = 'killed';
    expect(await ensureLocalTls(C)).toEqual({ why: `${UNKNOWN}no answer within 30 s`, off: false });
    expect(tlsFake.calls).toEqual(['E1']);
  });

  it('L25: the docker CLI is missing: off false, no other call', async () => {
    s().e1 = 'enoent';
    expect(await ensureLocalTls(C)).toEqual({ why: `${UNKNOWN}spawn docker ENOENT`, off: false });
    expect(tlsFake.calls).toEqual(['E1']);
  });

  it('L26 (T27): after an earlier run passed E5, E1 answers docker\'s error: off false, no openssl, no .new, no rename; pair and ssl unchanged', async () => {
    Object.assign(s(), { files: PAIR(), saved: true, loaded: true, e1: 'stderr' });
    expect(await ensureLocalTls(C)).toEqual({ why: `${UNKNOWN}${NOT_RUNNING(C)}`, off: false });
    expect(tlsFake.calls).toEqual(['E1']);
    expect(tlsFake.opensslArgs).toEqual([]);
    expect(s().files).toEqual(PAIR());
    expect(s()).toMatchObject({ saved: true, loaded: true });
  });
});

describe('nm36 tls: the undo after the server refused TLS fails', () => {
  const refusing = () => {
    s().swapLoadable = [false];
    clockPerRead();
  };
  const reloads = () => tlsFake.calls.filter(c => c === 'reload').length;

  it.each([
    ['an error', 'error' as const, `ALTER SYSTEM RESET ssl failed: ${DISK_FULL}`],
    ['no answer in 30 s', 'hang' as const, 'the database did not answer ALTER SYSTEM RESET ssl within 30 s'],
  ])('L29 (T31): ALTER SYSTEM RESET ssl answers %s: undo reset with its why; ssl still saved beside the live pair, nothing renamed', async (_n, mode, why) => {
    refusing();
    s().fail.reset = mode;
    const r = mode === 'hang' ? await withClock(() => ensureLocalTls(C)) : await ensureLocalTls(C);
    expect(r).toEqual({ why: REFUSED_10, off: true, undo: { stage: 'reset', why } });
    expect(s().saved).toBe(true);
    expect(s().files).toEqual(PAIR());
    expect(tlsFake.calls).not.toContain('aside');
    expect(reloads()).toBe(1);
  });

  it.each([
    ['both renames', 'all' as const, `the certificate files could not be renamed: mv: can't rename '${P}/server.key': Permission denied`, PAIR],
    ['the second rename', 'second' as const, `the certificate files could not be renamed: mv: can't rename '${P}/server.crt': Permission denied`,
      () => ({ 'server.key.new': FIXTURE_KEY, 'server.crt': FIXTURE_CRT })],
  ])('L30 (T32): %s fail: undo aside with its why; ssl not saved, no second reload', async (_n, mode, why, files) => {
    refusing();
    s().fail.aside = mode;
    expect(await ensureLocalTls(C)).toEqual({ why: REFUSED_10, off: true, undo: { stage: 'aside', why } });
    expect(s().saved).toBe(false);
    expect(s().files).toEqual(files());
    expect(reloads()).toBe(1);
  });

  it.each([
    ['an error', 'error' as const, SHUTTING],
    ['no answer in 30 s', 'hang' as const, 'the database did not answer pg_reload_conf() within 30 s'],
    ['f', 'f' as const, "pg_reload_conf answered 'f'"],
  ])('L31 (T33): the undo\'s reload answers %s: undo reload with its why; ssl not saved, the pair under its .new names', async (_n, mode, why) => {
    refusing();
    s().fail.undoReload = mode;
    const r = mode === 'hang' ? await withClock(() => ensureLocalTls(C)) : await ensureLocalTls(C);
    expect(r).toEqual({ why: REFUSED_10, off: true, undo: { stage: 'reload', why, ...(mode === 'hang' ? { timedOut: true } : {}) } });
    expect(s().saved).toBe(false);
    expect(s().files).toEqual(ASIDE());
    expect(tlsFake.calls.slice(-3)).toEqual(['reset', 'aside', 'reload']);
  });
});
