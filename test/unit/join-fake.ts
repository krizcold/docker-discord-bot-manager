/**
 * Fixtures for the join code tests: a fixed self-signed certificate for main.invalid (and one for a copy), codes and
 * registry records built from it, and a fake docker for child_process whose answers a test sets in `docker`.
 */
import { EventEmitter } from 'events';
import * as fs from 'fs';
import { PassThrough } from 'stream';
import { encodeJoinCode, JoinCode } from '../../src/config/joinCode';

export const FIXTURE_PEM = `-----BEGIN CERTIFICATE-----
MIIBnjCCAUSgAwIBAgIUCdC6jqTA0KJPSvixvqeQ7rZT39QwCgYIKoZIzj0EAwIw
FzEVMBMGA1UEAwwMbWFpbi5pbnZhbGlkMCAXDTI2MTAyODAxMjY0MFoYDzIxMjYx
MDA0MDEyNjQwWjAXMRUwEwYDVQQDDAxtYWluLmludmFsaWQwWTATBgcqhkjOPQIB
BggqhkjOPQMBBwNCAASRPbp3SsddkY9w48HQKxdKQm+KcdCJlurZZ7lMkAgxMu6O
oIMsl9m1l5cF4xWW6wTFcoaxLuPmM+Bru2l5IQKAo2wwajAdBgNVHQ4EFgQU9iRY
ynGzhKuwX6ipxP7MRRWhY1swHwYDVR0jBBgwFoAU9iRYynGzhKuwX6ipxP7MRRWh
Y1swDwYDVR0TAQH/BAUwAwEB/zAXBgNVHREEEDAOggxtYWluLmludmFsaWQwCgYI
KoZIzj0EAwIDSAAwRQIgCrtXiXXcBEWI6/0Pgmm/N7TKG5o4Ge7DfodRmtlYUcIC
IQCXClqYgouUKNSxR1ZTEAiDoJtJI8Spkz097udf4vHrKw==
-----END CERTIFICATE-----
`;

export const FIXTURE_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgjsELtyplC41c3iDV
vZgbga7O42FWIaJw3Hh6vFDWqx2hRANCAASRPbp3SsddkY9w48HQKxdKQm+KcdCJ
lurZZ7lMkAgxMu6OoIMsl9m1l5cF4xWW6wTFcoaxLuPmM+Bru2l5IQKA
-----END PRIVATE KEY-----
`;

export const FIXTURE_FP = '53c295c7036f3837c5e3e4fb657827a7c737cfa2d4c66beae02bbfd36c40c746';

export const COPY_PEM = `-----BEGIN CERTIFICATE-----
MIIBhjCCASugAwIBAgIUaW2ucoCMt8N3i+tlMqFSXnbzcD0wCgYIKoZIzj0EAwIw
FzEVMBMGA1UEAwwMY29weS5pbnZhbGlkMCAXDTI2MTAyODAxMjY0NVoYDzIxMjYx
MDA0MDEyNjQ1WjAXMRUwEwYDVQQDDAxjb3B5LmludmFsaWQwWTATBgcqhkjOPQIB
BggqhkjOPQMBBwNCAATbnvpfgCIX5wlSfrJ+u3jsSqkNiMnk6syXRrl/93hNrET4
CFcZe0iG28QEb48yTGFpCy+KL3qNke8RoOuEK5p/o1MwUTAdBgNVHQ4EFgQUz81K
Pom3cDyTPHhB1dU+7+MyjSUwHwYDVR0jBBgwFoAUz81KPom3cDyTPHhB1dU+7+My
jSUwDwYDVR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNJADBGAiEA6h2yBJiwXW9w
dF/Fn1dgNxClrOEdzxP4pxu5GMev+QACIQDTyCfIbRaDFGTvTM2skk9m++HjOoaq
iFORJQp+zks/LQ==
-----END CERTIFICATE-----
`;

export const COPY_FP = 'bb4b800f36f202bda5dce3afd633fb152f82b1dc90d46b9ae46daaf25f3f7528';

export function fakeJoin(over: Partial<JoinCode> = {}): JoinCode {
  return {
    v: 1, host: 'main.invalid', port: 15432, db: 'smdb', fp: FIXTURE_FP, machine: 'main.invalid',
    repl: { user: 'replicator', password: 'replpass' }, app: { user: 'smdb', password: 'app,pa%ss' }, ...over,
  };
}

export function fakeJoinCode(over: Partial<JoinCode> = {}): string {
  return encodeJoinCode(fakeJoin(over));
}

export function fakeJoinRecord(over: Record<string, unknown> = {}, code: Partial<JoinCode> = {}): Record<string, unknown> {
  const j = fakeJoin(code);
  return {
    code: encodeJoinCode(j), host: j.host, port: j.port, db: j.db, fp: j.fp, machine: j.machine,
    joinedAt: '2026-10-20T00:00:00.000Z', systemId: '7001', addresses: [], addressesReadAt: Date.now(), ...over,
  };
}

/** What the fake docker answers; a test changes fields in beforeEach or in a row. */
export const docker = {
  events: [] as string[],
  main: { systemId: '7001', timeline: 1, lsn: '0/5000000', inRecovery: false, slot: 'absent', fail: '' },
  addresses: [] as unknown[],
  addressFail: '',
  registerFail: '',
  unregisterFail: '',
  copy: 'true|streaming|7001|1|0/4000000' as string | null,
  copyCert: COPY_PEM as string | null,
  mainCertExec: FIXTURE_PEM as string | null,
  imagePresent: true,
  pullFail: '',
  running: 'true' as 'true' | 'false' | 'unknown',
  volumeExists: false,
  slotFail: '',
  seedProbe: 'f',
  basebackupFail: '',
  wipeFail: '',
  statusProbe: 't|streaming|t|0.5' as string | null,
};

export function resetDocker(): void {
  Object.assign(docker, {
    events: [],
    main: { systemId: '7001', timeline: 1, lsn: '0/5000000', inRecovery: false, slot: 'absent', fail: '' },
    addresses: [], addressFail: '', registerFail: '', unregisterFail: '',
    copy: 'true|streaming|7001|1|0/4000000', copyCert: COPY_PEM, mainCertExec: FIXTURE_PEM,
    imagePresent: true, pullFail: '', running: 'true', volumeExists: false,
    slotFail: '', seedProbe: 'f', basebackupFail: '', wipeFail: '', statusProbe: 't|streaming|t|0.5',
  });
}

type Answer = { code: number; stdout: string; stderr: string };
const ok = (stdout = ''): Answer => ({ code: 0, stdout, stderr: '' });
const fail = (stderr: string): Answer => ({ code: 1, stdout: '', stderr });

function execAnswer(cmd: string, args: string[]): Answer {
  if (cmd === 'openssl') {
    const keyOut = args[args.indexOf('-keyout') + 1];
    const out = args[args.indexOf('-out') + 1];
    fs.writeFileSync(keyOut, FIXTURE_KEY);
    fs.writeFileSync(out, FIXTURE_PEM);
    return ok();
  }
  const text = args.join(' ');
  if (args[0] === 'rm') return ok();
  if (args[0] === 'image' && args[1] === 'inspect') { docker.events.push('image'); return docker.imagePresent ? ok('[]') : fail('Error: No such image'); }
  if (args[0] === 'pull') { docker.events.push('pull'); return docker.pullFail ? fail(docker.pullFail) : ok(); }
  if (args[0] === 'volume' && args[1] === 'inspect') return docker.volumeExists ? ok('[]') : fail('Error: No such volume');
  if (args[0] === 'inspect') {
    if (docker.running === 'unknown') return fail('Cannot connect to the Docker daemon');
    return ok(`${docker.running}\n`);
  }
  if (args[0] === 'exec' && text.includes('cat /var/lib/postgresql/data/server.crt')) {
    const pem = args[1].includes('replica') ? docker.copyCert : docker.mainCertExec;
    docker.events.push(args[1].includes('replica') ? 'copy-cert' : 'cert-exec');
    return pem ? ok(pem) : fail('cat: no such file');
  }
  if (args[0] === 'exec' && text.includes('pg_control_system()') && text.includes('pg_stat_wal_receiver')) {
    docker.events.push('copy-facts');
    return docker.copy ? ok(`${docker.copy}\n`) : fail('psql: error: connection refused');
  }
  if (args[0] === 'exec' && text.includes('pg_last_xact_replay_timestamp')) {
    return docker.statusProbe ? ok(`${docker.statusProbe}\n`) : fail('psql: error: connection refused');
  }
  if (args[0] === 'exec' && text.includes('SELECT pg_is_in_recovery();')) {
    return ok(`${(docker.statusProbe || 't').split('|')[0]}\n`);
  }
  return ok();
}

function spawnAnswer(args: string[]): Answer {
  const text = args.join(' ');
  if (args[0] === 'run' && text.includes('IDENTIFY_SYSTEM') && args.includes('sh')) {
    docker.events.push('main-probe');
    const m = docker.main;
    if (m.fail) return fail(m.fail);
    return ok(`${m.systemId}|${m.timeline}|${m.lsn}|\n${m.inRecovery}|${m.slot}\n`);
  }
  if (args[0] === 'run' && text.includes('FROM smdb_manager.addresses a')) {
    docker.events.push('address-read');
    return docker.addressFail ? fail(docker.addressFail) : ok(`${JSON.stringify(docker.addresses)}\n`);
  }
  if (args[0] === 'run' && text.includes('INSERT INTO smdb_manager.addresses')) {
    docker.events.push('register');
    return docker.registerFail ? fail(docker.registerFail) : ok();
  }
  if (args[0] === 'run' && text.includes('DELETE FROM smdb_manager.addresses')) {
    docker.events.push('unregister');
    return docker.unregisterFail ? fail(docker.unregisterFail) : ok();
  }
  if (args[0] === 'run' && text.includes('pg_create_physical_replication_slot')) {
    docker.events.push('slot');
    return docker.slotFail ? fail(docker.slotFail) : ok();
  }
  if (args[0] === 'run' && text.includes('pg_drop_replication_slot(slot_name)')) { docker.events.push('drop-slot'); return ok(); }
  if (args[0] === 'run' && args.includes('pg_basebackup')) {
    docker.events.push('basebackup');
    return docker.basebackupFail ? fail(docker.basebackupFail) : ok();
  }
  if (args[0] === 'run' && text.includes('SELECT pg_is_in_recovery()')) { docker.events.push('seed-probe'); return ok(`${docker.seedProbe}\n`); }
  if (args[0] === 'run' && text.includes('-mindepth 1 -maxdepth 1 -exec rm -rf')) {
    docker.events.push('wipe');
    return docker.wipeFail ? fail(docker.wipeFail) : ok();
  }
  return ok();
}

function child(answer: Answer): any {
  const c: any = new EventEmitter();
  c.stdout = new PassThrough();
  c.stderr = new PassThrough();
  c.stdin = new PassThrough();
  c.stdin.resume();
  c.kill = () => true;
  setTimeout(() => {
    c.stdout.end(answer.stdout);
    c.stderr.end(answer.stderr);
    setTimeout(() => c.emit('close', answer.code), 2);
  }, 2);
  return c;
}

/** A child_process module whose docker and openssl calls answer from `docker`. */
export function childProcessMock(real: typeof import('child_process')): Record<string, unknown> {
  const execFile = (cmd: string, args: string[], optsOrCb: unknown, maybeCb?: unknown) => {
    const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as ((err: Error | null, stdout: string, stderr: string) => void) | undefined;
    const a = execAnswer(cmd, args);
    setTimeout(() => cb?.(a.code === 0 ? null : Object.assign(new Error(a.stderr), { code: a.code }), a.stdout, a.stderr), 1);
    return new EventEmitter();
  };
  const spawn = (_cmd: string, args: string[]) => child(spawnAnswer(args));
  const exec = (_cmd: string, opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    done?.(null, { stdout: '', stderr: '' });
  };
  return { ...real, execFile, spawn, exec, default: { ...real, execFile, spawn, exec } };
}

/** The join code that names the main an older test's replication DSN named. */
export function codeFor(dsn: string, over: Partial<JoinCode> = {}): string {
  return encodeJoinCode(joinFor(dsn, over));
}

function joinFor(dsn: string, over: Partial<JoinCode> = {}): JoinCode {
  const u = new URL(dsn);
  return fakeJoin({
    host: u.hostname, port: Number(u.port) || 5432, db: u.pathname.replace(/^\//, ''), machine: u.hostname,
    repl: { user: decodeURIComponent(u.username), password: decodeURIComponent(u.password) }, ...over,
  });
}

/** The registry's join record for that code. */
export function joinRecordFor(dsn: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  const j = joinFor(dsn);
  return fakeJoinRecord(over, j);
}

/** What certSource.fetch answers for the fixture main. */
export const fixtureCert = async (): Promise<{ ok: true; pem: string; fp: string }> => ({ ok: true, pem: FIXTURE_PEM, fp: FIXTURE_FP });
