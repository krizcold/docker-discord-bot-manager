import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm36-l5-a-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return {
    dir,
    /** Enable's rows answer from nm22's lane fake; every other row from the NM36 TLS fake. */
    lane: false,
    execFiles: [] as Array<{ cmd: string; args: string[]; opts: any }>,
    /** The argv of every docker exec child that was killed. */
    kills: [] as string[][],
    /** E1 never answers: only execFile's own timeout ends it. */
    e1Hang: false,
    /** The undo's renames: the docker CLI ends on a signal, so the child closes with no exit code and no stderr. */
    asideSignal: false,
    /** Answers the TLS read-back itself, one call per read. */
    readScript: null as null | (() => { code: number; stdout?: string; stderr?: string }),
  };
});

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const { EventEmitter } = await import('events');
  const { PassThrough } = await import('stream');
  const tls = await (await import('./nm36-tls')).childProcessMock(real, require('fs')) as any;
  const laneCp = (await import('./nm22-lane-fake')).laneChildProcess(real) as any;
  const DATA = '/var/lib/postgresql/data';
  const execFile = (cmd: string, args: string[], optsOrCb: any, maybeCb?: any) => {
    if (h.lane) return laneCp.execFile(cmd, args, optsOrCb, maybeCb);
    const cb = typeof optsOrCb === 'function' ? optsOrCb : maybeCb;
    const opts = typeof optsOrCb === 'function' ? undefined : optsOrCb;
    h.execFiles.push({ cmd, args: [...args], opts });
    if (h.e1Hang && args.some(a => a.startsWith(`test -f ${DATA}/server.crt && `))) {
      if (opts?.timeout) setTimeout(() => cb(Object.assign(new Error('Command failed'), { killed: true, code: null, signal: 'SIGTERM' }), '', ''), opts.timeout);
      return new EventEmitter();
    }
    if (h.readScript && args.some(a => a.includes('pg_stat_ssl s WHERE s.pid'))) {
      const a = h.readScript();
      const err = a.code ? Object.assign(new Error(`Command failed: docker ${args.join(' ')}\n${a.stderr ?? ''}`), { code: a.code, killed: false, signal: null }) : null;
      setTimeout(() => cb(err, a.stdout ?? '', a.stderr ?? ''), 1);
      return new EventEmitter();
    }
    return tls.execFile(cmd, args, optsOrCb, maybeCb);
  };
  const spawn = (cmd: string, args: string[], opts?: unknown) => {
    if (h.lane) return laneCp.spawn(cmd, args, opts);
    if (h.asideSignal && args.includes(`mv -f ${DATA}/server.key ${DATA}/server.key.new && mv -f ${DATA}/server.crt ${DATA}/server.crt.new`)) {
      const child: any = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.kill = () => true;
      child.stdout.end('');
      child.stderr.end('');
      setTimeout(() => child.emit('close', null, 'SIGKILL'), 1);
      return child;
    }
    const child = tls.spawn(cmd, args, opts);
    const kill = child.kill;
    child.kill = (...a: unknown[]) => { h.kills.push([...args]); return kill(...a); };
    return child;
  };
  const wrap = { execFile, spawn, exec: tls.exec, execFileSync: tls.execFileSync };
  return { ...real, ...wrap, default: { ...real, ...wrap } };
});
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';
import * as envManager from '../../src/env/manager';
import { enableFleetReplication, ensureLocalTls, LOCAL_TLS_READ_SQL, LOCAL_TLS_TIMING } from '../../src/instance/fleetReplication';
import { resetDocker } from './nm2-docker';
import { lane, resetLane } from './nm22-lane-fake';
import { FIXTURE_CRT, FIXTURE_KEY, NOSSL, P, resetTls, tlsFake, tlsOf } from './nm36-tls';

const C = 'bota-fleet-postgres';
const s = () => tlsOf(C);
const PAIR = () => ({ 'server.key': FIXTURE_KEY, 'server.crt': FIXTURE_CRT });
const REFUSED_10 = `the server still refused TLS 10 s after the reload: ${NOSSL}`;
const timing = { ...LOCAL_TLS_TIMING };

/** Runs fn under a faked setTimeout, moving the clock on 250 ms at a time for at most `ms`; `done` false when it has not answered by then. */
async function underClock<T>(fn: () => Promise<T>, ms: number, after: () => Promise<void> = async () => {}): Promise<{ done: boolean; value?: T }> {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const out: { done: boolean; value?: T } = { done: false };
    fn().then(v => { out.done = true; out.value = v; }, () => {});
    for (let t = 0; t < ms && !out.done; t += 250) await vi.advanceTimersByTimeAsync(250);
    await after();
    return out;
  } finally {
    vi.useRealTimers();
  }
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  resetDocker();
  resetTls();
  resetLane();
  Object.assign(h, { lane: false, execFiles: [], kills: [], e1Hang: false, asideSignal: false, readScript: null });
  Object.assign(LOCAL_TLS_TIMING, timing, { gapMs: 1 });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  Object.assign(LOCAL_TLS_TIMING, timing);
});
afterAll(() => { fs.rmSync(h.dir, { recursive: true, force: true }); });

describe('nm36 l5 a: the docker calls of the TLS step', () => {
  it('A1: no docker exec that closed is killed when its 30 s limit passes', async () => {
    const r = await underClock(() => ensureLocalTls(C), 5_000, async () => { await vi.advanceTimersByTimeAsync(31_000); });
    expect(r).toEqual({ done: true, value: null });
    expect(tlsFake.calls).toEqual(['E1', 'probe', 'openssl', 'put:server.key', 'put:server.crt', 'mv', 'alter', 'reload', 'read']);
    expect(h.kills).toEqual([]);
  });

  it('A2: E1 runs under a 30 s limit: a docker that never answers ends as "no answer within 30 s", nothing else called', async () => {
    h.e1Hang = true;
    const r = await underClock(() => ensureLocalTls(C), 40_000);
    expect(r).toEqual({ done: true, value: { why: 'docker did not say whether the certificate pair is in place: no answer within 30 s', off: false } });
    const e1 = h.execFiles.filter(c => c.args.includes('sh'));
    expect(e1).toHaveLength(1);
    expect(e1[0].opts).toEqual({ timeout: 30_000 });
    expect(tlsFake.calls).toEqual([]);
  });

  it('A3: the read-back is psql -X -w over TLS on the loopback, as dbm_admin, -tA with ON_ERROR_STOP', async () => {
    s().files = PAIR();
    expect(await ensureLocalTls(C)).toBeNull();
    const read = h.execFiles.filter(c => c.args.includes(LOCAL_TLS_READ_SQL));
    expect(read).toHaveLength(1);
    expect(read[0].cmd).toBe('docker');
    expect(read[0].args).toEqual([
      'exec', C, 'psql', '-X', '-w', '-d', 'host=127.0.0.1 port=5432 dbname=postgres user=dbm_admin sslmode=require connect_timeout=10',
      '-tA', '-v', 'ON_ERROR_STOP=1', '-c', LOCAL_TLS_READ_SQL,
    ]);
  });
});

describe('nm36 l5 a: a read-back that answers something other than on|true', () => {
  it('A6: reads fail on a full server until the deadline, then a session reads off|true: the why quotes the answer, off false, no undo', async () => {
    s().files = PAIR();
    let now = Date.parse('2026-11-19T12:00:00.000Z');
    const first = now;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    let reads = 0;
    h.readScript = () => {
      reads++;
      now += 2000;
      if (now - first > 10_000) return { code: 0, stdout: 'off|true\n' };
      return { code: 2, stderr: 'psql: error: connection to server at "127.0.0.1", port 5432 failed: FATAL:  sorry, too many clients already\n' };
    };
    const r = await ensureLocalTls(C);
    expect(r).toEqual({ why: "no session over TLS opened within 10 s of the reload: the session read 'off|true'", off: false });
    expect(reads).toBe(6);
    expect(h.execFiles.filter(c => c.args.some(a => a.includes('ALTER SYSTEM RESET ssl')))).toEqual([]);
    expect(tlsFake.calls).toEqual(['E1', 'alter', 'reload']);
  });
});

describe('nm36 l5 a: the undo\'s renames end with no exit code', () => {
  it('A4: the docker CLI ends on a signal, with no message: undo aside says "ended with no exit code", ssl not saved, no second reload', async () => {
    s().swapLoadable = [false];
    let now = Date.parse('2026-11-19T12:00:00.000Z');
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    tlsFake.onRead = () => { now += 2000; };
    h.asideSignal = true;
    expect(await ensureLocalTls(C)).toEqual({
      why: REFUSED_10, off: true,
      undo: { stage: 'aside', why: 'the certificate files could not be renamed (docker exec ended with no exit code with no message)' },
    });
    expect(s().saved).toBe(false);
    expect(s().files).toEqual(PAIR());
    expect(tlsFake.calls.filter(c => c === 'reload')).toHaveLength(1);
  });
});

describe('nm36 l5 a: Enable keeps its own wording when the renames stop', () => {
  const ID = '0f1e2d3c-4b5a-4968-8776-655443322110';
  const REGISTRY = path.join(h.dir, 'instances.json');
  const fleetDb = { containerName: 'm-fleet-postgres', user: 'smdb', db: 'smdb', volume: 'm-fleet-postgres-data', password: 'Db-Secret,%x' };

  it('A5: the second rename fails in Enable: "press Enable again to install a fresh pair", nothing recorded', async () => {
    h.lane = true;
    fs.mkdirSync(path.join(h.dir, 'bots', ID, 'env'), { recursive: true });
    fs.writeFileSync(REGISTRY, JSON.stringify({ instances: { [ID]: {
      id: ID, sanitizedName: 'm', displayName: 'M', titleName: 'M', status: 'running', sourceType: 'git',
      sourceUrl: 'https://example.invalid/fake/super-modular-discord-bot', envVars: { DATA_BACKEND: 'postgres' },
      createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z', fleetDb,
    } } }));
    containerManager.updateInstanceFleetLogin(ID, { password: 'Own-Machine-Secret-01' });
    envManager.setEnvVars(ID, { DATA_BACKEND_URL: 'postgresql://smdb:Db-Secret%2C%25x@m-fleet-postgres:5432/smdb?sslmode=no-verify' });
    lane.rules.push({ match: `mv -f ${P}/server.key.new ${P}/server.key && mv -f ${P}/server.crt.new ${P}/server.crt`, code: 1, err: `mv: can't rename '${P}/server.crt.new': I/O error\n` });
    const en = await enableFleetReplication(containerManager.getBot(ID)!, 'main.invalid', 15432);
    expect(en).toEqual({
      success: false,
      error: `certificate install failed while moving the new pair into place, so the key and certificate on disk may not match (the configuration was not reloaded; press Enable again to install a fresh pair): mv: can't rename '${P}/server.crt.new': I/O error`,
    });
    expect(lane.calls.filter(c => c.args.includes('mv -f '))).toHaveLength(1);
    expect(containerManager.getBot(ID)!.fleetDb!.replication).toBeUndefined();
  });
});
