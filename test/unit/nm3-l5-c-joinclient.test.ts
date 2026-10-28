import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm3-l5-c-'));
  process.env.DATA_DIR = dir;
  return {
    dir,
    execCalls: [] as Array<{ cmd: string; args: string[]; opts: unknown }>,
    execAnswer: (_cmd: string, _args: string[]) => ({ err: null as Error | null, stdout: '', stderr: '' }),
    spawnCalls: [] as Array<{ cmd: string; args: string[]; opts: any }>,
    children: [] as any[],
    autoClose: true as boolean,
    connect: null as null | ((opts: any) => any),
    tlsConnect: null as null | ((opts: any) => any),
  };
});

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const { EventEmitter } = await import('events');
  const { PassThrough } = await import('stream');
  const execFile = (cmd: string, args: string[], optsOrCb: unknown, maybeCb?: unknown) => {
    const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as ((err: Error | null, stdout: string, stderr: string) => void) | undefined;
    h.execCalls.push({ cmd, args, opts: typeof optsOrCb === 'function' ? undefined : optsOrCb });
    const a = h.execAnswer(cmd, args);
    setTimeout(() => cb?.(a.err, a.stdout, a.stderr), 1);
    return new EventEmitter();
  };
  const spawn = (cmd: string, args: string[], opts: any) => {
    h.spawnCalls.push({ cmd, args, opts });
    const c: any = new EventEmitter();
    c.stdout = new PassThrough();
    c.stderr = new PassThrough();
    c.kill = vi.fn(() => true);
    h.children.push(c);
    if (h.autoClose) setTimeout(() => c.emit('close', 1), 2);
    return c;
  };
  return { ...real, execFile, spawn, default: { ...real, execFile, spawn } };
});

vi.mock('net', async (importOriginal) => {
  const real = await importOriginal<typeof import('net')>();
  const connect = (...a: any[]) => (h.connect ? h.connect(a[0]) : (real.connect as any)(...a));
  return { ...real, connect, default: { ...real, connect } };
});

vi.mock('tls', async (importOriginal) => {
  const real = await importOriginal<typeof import('tls')>();
  const connect = (...a: any[]) => (h.tlsConnect ? h.tlsConnect(a[0]) : (real.connect as any)(...a));
  return { ...real, connect, default: { ...real, connect } };
});

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { hostBotDirFor } from '../../src/docker/containerManager';
import {
  ensureClientImage, ensureProbeCert, fetchMainCertificate, mainCertificate, mainProbe, runPrimaryClient, sameManagerMain, seedDsnFor,
} from '../../src/instance/fleetJoin';
import { fakeJoin, FIXTURE_FP, FIXTURE_PEM } from './join-fake';

const PW = 'supersecretpw1';

function pending<T>(p: Promise<T>, ms = 60): Promise<T | 'pending'> {
  return Promise.race([p, new Promise<'pending'>(r => setTimeout(() => r('pending'), ms))]);
}
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

fs.writeFileSync(path.join(h.dir, 'instances.json'), JSON.stringify({ instances: {
  c: { id: 'c', displayName: 'c', sanitizedName: 'c', status: 'running', fleetDb: { containerName: 'c-pg', user: 'smdb', db: 'smdb', volume: 'v', replication: { role: 'r', password: '', hostPort: 15432, certHost: 'x' } } },
  a: { id: 'a', displayName: 'a', sanitizedName: 'a', status: 'running', fleetDb: { containerName: 'a-pg', user: 'smdb', db: 'smdb', volume: 'v', replication: { role: 'r', password: '', hostPort: 15432, publicHost: 'other.invalid', certHost: 'x' } } },
  b: { id: 'b', displayName: 'b', sanitizedName: 'b', status: 'running', fleetDb: { containerName: 'b-pg', user: 'smdb', db: 'smdb', volume: 'v', replication: { role: 'r', password: '', hostPort: 9999, publicHost: 'main.invalid', certHost: 'x' } } },
  l: { id: 'l', displayName: 'l', sanitizedName: 'l', status: 'running', fleetDb: { containerName: 'l-pg', user: 'smdb', db: 'smdb', volume: 'v', replication: { role: 'r', password: '', hostPort: 15432, publicHost: 'local.invalid', certHost: 'x' } } },
} }));

beforeEach(() => {
  h.execCalls.length = 0;
  h.spawnCalls.length = 0;
  h.children.length = 0;
  h.autoClose = true;
  h.execAnswer = () => ({ err: null, stdout: '', stderr: '' });
  h.connect = null;
  h.tlsConnect = null;
});
afterEach(() => vi.useRealTimers());
afterAll(() => fs.rmSync(h.dir, { recursive: true, force: true }));

describe('client argv and image pull', () => {
  it('seedDsnFor names the user, host, port, db and the verify-full CA', () => {
    expect(seedDsnFor({ user: 'u s', password: PW, host: 'h.invalid', port: 5433, db: 'd' }))
      .toBe('postgresql://u%20s@h.invalid:5433/d?sslmode=verify-full&sslrootcert=/primary-ca.crt');
  });

  it('a missing image is pulled with a ten minute limit', async () => {
    h.execAnswer = (_c, args) => ({ err: args[0] === 'image' ? new Error('no') : null, stdout: '', stderr: '' });
    expect(await ensureClientImage()).toBeNull();
    const pull = h.execCalls.find(c => c.args[0] === 'pull')!;
    expect(pull.opts).toEqual({ timeout: 600000 });
  });

  it('mainProbe removes the old probe container by name before it runs the client', async () => {
    await mainProbe({ id: 'p', sanitizedName: 'pp' } as any, fakeJoin(), FIXTURE_PEM);
    expect(h.execCalls[0]).toEqual({ cmd: 'docker', args: ['rm', '-f', 'pp-fleet-join-probe'], opts: { timeout: 30000 } });
  });

  it('runPrimaryClient passes the password only through the environment', async () => {
    const r = await runPrimaryClient('n1', { password: PW }, ['a:/b', 'c:/d'], 'psql', ['x', 'y'], 5000);
    expect(r.ok).toBe(false);
    expect(h.spawnCalls[0].cmd).toBe('docker');
    expect(h.spawnCalls[0].args).toEqual(['run', '--rm', '--name', 'n1', '-e', 'PGPASSWORD', '-v', 'a:/b', '-v', 'c:/d', '--entrypoint', 'psql', 'postgres:16-alpine', 'x', 'y']);
    expect(h.spawnCalls[0].opts.env.PGPASSWORD).toBe(PW);
  });

  it('on timeout the container is removed by name, then the CLI is killed', async () => {
    h.autoClose = false;
    void runPrimaryClient('n2', { password: PW }, [], 'psql', [], 20);
    await wait(80);
    expect(h.execCalls).toEqual([{ cmd: 'docker', args: ['rm', '-f', 'n2'], opts: undefined }]);
    expect(h.children[0].kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('a spawn error resolves with the fixed text and stops the timer', async () => {
    h.autoClose = false;
    const p = runPrimaryClient('n3', { password: PW }, [], 'psql', [], 30);
    h.children[0].emit('error', new Error('spawn EMFILE'));
    expect(await pending(p)).toEqual({ ok: false, stdout: '', stderr: 'docker run failed' });
    await wait(70);
    expect(h.execCalls).toEqual([]);
  });

  it('a spawn error keeps the stderr already read', async () => {
    h.autoClose = false;
    const p = runPrimaryClient('n4', { password: PW }, [], 'psql', [], 5000);
    h.children[0].stderr.write('boom');
    await wait(10);
    h.children[0].emit('error', new Error('x'));
    expect(await p).toEqual({ ok: false, stdout: '', stderr: 'boom' });
  });

  it('close redacts the password from stderr and stops the timer', async () => {
    h.autoClose = false;
    const p = runPrimaryClient('n5', { password: PW }, [], 'psql', [], 30);
    h.children[0].stderr.write(`FATAL: bad ${PW}`);
    await wait(10);
    h.children[0].emit('close', 2);
    expect(await p).toEqual({ ok: false, stdout: '', stderr: 'FATAL: bad ***' });
    await wait(70);
    expect(h.execCalls).toEqual([]);
  });
});

type FakeSock = EventEmitter & { write: any; destroy: any };
function fakeSocket(): FakeSock {
  const s = new EventEmitter() as FakeSock;
  s.write = vi.fn();
  s.destroy = vi.fn();
  return s;
}
function fakeSecure(cert: any): FakeSock & { getPeerCertificate: any } {
  const s = fakeSocket() as any;
  s.getPeerCertificate = vi.fn(() => cert);
  return s;
}

describe('fetchMainCertificate over fake sockets', () => {
  let sock: FakeSock;
  let secure: ReturnType<typeof fakeSecure>;
  let tlsOpts: any;
  beforeEach(() => {
    sock = fakeSocket();
    h.connect = () => sock;
    h.tlsConnect = (opts) => { tlsOpts = opts; return secure; };
  });

  it('a socket error gives its message, once, and leaves no timer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const p = fetchMainCertificate('main.invalid', 1);
    sock.emit('error', new Error('connect ECONNREFUSED'));
    sock.emit('close');
    expect(await p).toEqual({ ok: false, reason: 'connect ECONNREFUSED' });
    expect(sock.destroy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a close before the answer byte', async () => {
    const p = fetchMainCertificate('main.invalid', 1);
    sock.emit('close');
    expect(await p).toEqual({ ok: false, reason: 'the connection closed before TLS started' });
  });

  it('an answer byte other than S or N', async () => {
    const p = fetchMainCertificate('main.invalid', 1);
    sock.emit('data', Buffer.from('X'));
    expect(await p).toEqual({ ok: false, reason: 'the server did not answer as Postgres' });
  });

  it('after S, raw socket errors and closes are ignored and the PEM is exact', async () => {
    const raw = Buffer.alloc(96, 7);
    secure = fakeSecure({ raw });
    const p = fetchMainCertificate('main.invalid', 1);
    sock.emit('data', Buffer.from('S'));
    sock.emit('error', new Error('late'));
    sock.emit('close');
    expect(tlsOpts).toEqual({ socket: sock, rejectUnauthorized: false, servername: 'main.invalid' });
    secure.emit('secureConnect');
    const b64 = raw.toString('base64');
    const r = await p;
    expect(r).toMatchObject({ ok: true, pem: `-----BEGIN CERTIFICATE-----\n${b64.slice(0, 64)}\n${b64.slice(64)}\n-----END CERTIFICATE-----\n` });
    expect(secure.getPeerCertificate).toHaveBeenCalledWith(true);
  });

  it('a certificate shorter than one line keeps its single line', async () => {
    const raw = Buffer.alloc(30, 1);
    secure = fakeSecure({ raw });
    const p = fetchMainCertificate('main.invalid', 1);
    sock.emit('data', Buffer.from('S'));
    secure.emit('secureConnect');
    expect(await p).toMatchObject({ ok: true, pem: `-----BEGIN CERTIFICATE-----\n${raw.toString('base64')}\n-----END CERTIFICATE-----\n` });
  });

  it('a TLS error gives its message', async () => {
    secure = fakeSecure({});
    const p = fetchMainCertificate('main.invalid', 1);
    sock.emit('data', Buffer.from('S'));
    secure.emit('error', new Error('handshake bad'));
    expect(await p).toEqual({ ok: false, reason: 'handshake bad' });
  });

  it('a close during the handshake', async () => {
    secure = fakeSecure({});
    const p = fetchMainCertificate('main.invalid', 1);
    sock.emit('data', Buffer.from('S'));
    secure.emit('close');
    expect(await p).toEqual({ ok: false, reason: 'the connection closed during the TLS handshake' });
  });

  it('a handshake with no certificate', async () => {
    secure = fakeSecure({});
    const p = fetchMainCertificate('main.invalid', 1);
    sock.emit('data', Buffer.from('S'));
    secure.emit('secureConnect');
    expect(await p).toEqual({ ok: false, reason: 'the server showed no certificate' });
  });
});

describe('sameManagerMain and the local certificate read', () => {
  it('matches only host and port together, and skips a main with no public host', () => {
    expect(sameManagerMain({ host: 'MAIN.invalid', port: 15432 })).toBeNull();
    expect(sameManagerMain({ host: 'LOCAL.invalid', port: 15432 })?.id).toBe('l');
  });

  it('reads server.crt by docker exec with the read limit', async () => {
    h.execAnswer = () => ({ err: null, stdout: FIXTURE_PEM, stderr: '' });
    expect(await mainCertificate(fakeJoin({ host: 'local.invalid' }))).toEqual({ ok: true, pem: FIXTURE_PEM });
    expect(h.execCalls[0]).toEqual({ cmd: 'docker', args: ['exec', 'l-pg', 'cat', '/var/lib/postgresql/data/server.crt'], opts: { timeout: 30000 } });
  });

  it('a failed exec gives the last trimmed stderr line', async () => {
    h.execAnswer = () => ({ err: new Error('m'), stdout: '', stderr: 'first\nlast\n' });
    expect(await mainCertificate(fakeJoin({ host: 'local.invalid' }))).toMatchObject({ ok: false, kind: 'unreachable', reason: 'last' });
  });

  it('a failed exec with no text says docker exec failed', async () => {
    h.execAnswer = () => ({ err: new Error(''), stdout: '', stderr: '' });
    expect(await mainCertificate(fakeJoin({ host: 'local.invalid' }))).toMatchObject({ ok: false, reason: 'docker exec failed' });
  });

  it('a file with no certificate in it', async () => {
    h.execAnswer = () => ({ err: null, stdout: 'garbage', stderr: '' });
    expect(await pending(mainCertificate(fakeJoin({ host: 'local.invalid' })))).toMatchObject({ ok: false, reason: 'the certificate file holds no certificate' });
  });

  it('a fingerprint mismatch names the fingerprint seen', async () => {
    h.execAnswer = () => ({ err: null, stdout: FIXTURE_PEM, stderr: '' });
    expect(await mainCertificate(fakeJoin({ host: 'local.invalid', fp: 'f'.repeat(64) }))).toMatchObject({ ok: false, kind: 'fingerprint', reason: `fingerprint ${FIXTURE_FP.slice(0, 16)}...` });
  });
});

describe('ensureProbeCert', () => {
  it('writes under the bot folder by fingerprint and returns the host path', () => {
    const out = ensureProbeCert('e1', FIXTURE_FP, FIXTURE_PEM);
    expect(out).toBe(`${hostBotDirFor('e1')}/fleet-join/${FIXTURE_FP.slice(0, 16)}.crt`);
    expect(fs.readFileSync(path.join(h.dir, 'bots', 'e1', 'fleet-join', `${FIXTURE_FP.slice(0, 16)}.crt`), 'utf-8')).toBe(FIXTURE_PEM);
  });

  it('leaves a file that already holds the same text alone', () => {
    const file = path.join(h.dir, 'bots', 'e2', 'fleet-join', `${FIXTURE_FP.slice(0, 16)}.crt`);
    fs.mkdirSync(`${file}.tmp`, { recursive: true });
    fs.writeFileSync(file, FIXTURE_PEM);
    expect(() => ensureProbeCert('e2', FIXTURE_FP, FIXTURE_PEM)).not.toThrow();
  });
});
