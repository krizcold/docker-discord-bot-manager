import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// peerProbe's argv and its reading of each answer, and runPrimaryClient's answer when docker cannot start.
const sp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm5-l5-i-probe-'));
  process.env.DATA_DIR = dir;
  return { dir, throwSpawn: false, stdout: '', stderr: '', code: 0, args: [] as string[], rms: [] as string[][] };
});

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const { EventEmitter } = require('events') as typeof import('events');
  const { PassThrough } = require('stream') as typeof import('stream');
  const spawn = (_cmd: string, args: string[]) => {
    if (sp.throwSpawn) throw Object.assign(new Error('spawn ENOMEM'), { code: 'ENOMEM' });
    sp.args = args;
    const child: any = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => true;
    setTimeout(() => { child.stdout.end(sp.stdout); child.stderr.end(sp.stderr); setTimeout(() => child.emit('close', sp.code), 1); }, 1);
    return child;
  };
  const execFile = (_c: string, a: string[], o: unknown, c?: unknown) => {
    sp.rms.push(a);
    const cb = (typeof o === 'function' ? o : c) as ((e: Error | null) => void) | undefined;
    setTimeout(() => cb?.(null), 0);
    return { on: () => undefined };
  };
  return { ...real, spawn, execFile, default: { ...real, spawn, execFile } };
});

import * as fs from 'fs';
import { peerProbe, runPrimaryClient } from '../../src/instance/fleetJoin';
import { GEN_READ_SQL } from '../../src/instance/switchSql';
import { FIXTURE_PEM, fakeJoin } from './join-fake';

const inst = { id: 'a', sanitizedName: 'a', displayName: 'A' } as any;
const GEN = '4|copy.example|2026-10-30T09:00:00Z';
const SCRIPT = 'psql "$1&replication=true" -Atc IDENTIFY_SYSTEM || exit 2; psql "$1" -v ON_ERROR_STOP=1 -Atc "SELECT pg_is_in_recovery()::text" || exit 3; '
  + 'psql "$1" -v ON_ERROR_STOP=1 -Atc "$2" 2>/tmp/gen.err || { if grep -q "does not exist" /tmp/gen.err; then echo "0||"; else cat /tmp/gen.err >&2; exit 4; fi; }; '
  + 'psql "$3" -v ON_ERROR_STOP=1 -Atc "$4" 2>/tmp/mark.err || { if grep -q smdb_manager /tmp/mark.err; then echo 0; else echo unread; fi; }';
const UNREAD = { kind: 'unreachable', reason: 'the database gave an answer the manager does not read' };
const HBA = 'psql: error: FATAL:  pg_hba.conf rejects connection for host "10.0.0.2", user "replicator"';
const PWFAIL = 'psql: error: FATAL:  password authentication failed for user "replicator"';
const answer = (stdout: string, code = 0, stderr = '') => { sp.stdout = stdout; sp.code = code; sp.stderr = stderr; };
const probe = (over: Parameters<typeof fakeJoin>[0] = {}) => peerProbe(inst, fakeJoin(over), FIXTURE_PEM);

beforeEach(() => { sp.throwSpawn = false; sp.args = []; sp.rms = []; answer(''); });
afterAll(() => fs.rmSync(sp.dir, { recursive: true, force: true }));

describe('runPrimaryClient when docker cannot start', () => {
  it('answers ok false with an empty stdout and the reason', async () => {
    sp.throwSpawn = true;
    expect(await runPrimaryClient('smdb-x', { password: 'pw' }, [], 'psql', [], 5000))
      .toEqual({ ok: false, stdout: '', stderr: 'docker run could not start (spawn ENOMEM)' });
  });
});

describe('peerProbe argv', () => {
  it('the default name, the certificate mount, the sh entrypoint and the script', async () => {
    answer(`7001|2|0/5\nfalse\n${GEN}\n1\n`);
    await probe();
    const a = sp.args;
    expect(a.slice(0, 7)).toEqual(['run', '--rm', '--name', 'a-fleet-peer-probe', '-e', 'PGPASSWORD', '-v']);
    expect(a[7]).toMatch(/:\/primary-ca\.crt:ro$/);
    expect(fs.readFileSync(a[7].slice(0, -':/primary-ca.crt:ro'.length), 'utf8')).toContain('BEGIN CERTIFICATE');
    expect(a.slice(8, 12)).toEqual(['--entrypoint', 'sh', 'postgres:16-alpine', '-c']);
    expect(a[12]).toBe(SCRIPT);
    expect(a[13]).toBe('sh');
    expect(a[15]).toBe(GEN_READ_SQL);
    expect(sp.rms).toContainEqual(['rm', '-f', 'a-fleet-peer-probe']);
  });
});

describe('peerProbe reads an answer that ran to the end', () => {
  it('a blank line between the answers is skipped', async () => {
    answer(`7001|2|0/5\n\nfalse\n${GEN}\n1\n`);
    expect(await probe()).toMatchObject({ kind: 'writable', systemId: '7001', timeline: 2, receiveMark: true });
  });
  it('CRLF line ends are read', async () => {
    answer(`7001|2|0/5\r\nfalse\r\n${GEN}\r\n1\r\n`);
    expect(await probe()).toMatchObject({ kind: 'writable', systemId: '7001', timeline: 2, gen: { generation: 4 } });
  });
  it('in recovery', async () => {
    answer(`7001|2|0/5\ntrue\n${GEN}\n0\n`);
    expect(await probe()).toMatchObject({ kind: 'in-recovery', systemId: '7001', receiveMark: false });
  });
  it('a two-digit timeline', async () => {
    answer(`7001|12|0/5\nfalse\n${GEN}\n1\n`);
    expect(await probe()).toMatchObject({ kind: 'writable', timeline: 12 });
  });
  it.each(['abc|2|0/5', '7001|x|0/5', 'a7001|2|0/5', '7001a|2|0/5', '7001|a2|0/5', '7001|2a|0/5'])('a first line %j is not read', async first => {
    answer(`${first}\nfalse\n${GEN}\n1\n`);
    expect(await probe()).toEqual(UNREAD);
  });
  it('a recovery answer other than true or false is not read', async () => {
    answer(`7001|2|0/5\nmaybe\n${GEN}\n1\n`);
    expect(await probe()).toEqual(UNREAD);
  });
  it.each([['1a', null], ['a1', null], ['12', true]] as const)('the mark line %j -> receiveMark %s', async (line, want) => {
    answer(`7001|2|0/5\nfalse\n${GEN}\n${line}\n`);
    expect(await probe()).toMatchObject({ kind: 'writable', receiveMark: want });
  });
});

describe('peerProbe reads a failed answer', () => {
  it('identified, one line, refused by pg_hba: fenced', async () => {
    answer('7001|2|0/5\n', 3, HBA);
    expect(await probe()).toEqual({ kind: 'fenced', systemId: '7001', reason: 'FATAL:  pg_hba.conf rejects connection for host "10.0.0.2", user "replicator"' });
  });
  it('identified, one line, a password failure: unreachable', async () => {
    answer('7001|2|0/5\n', 3, PWFAIL);
    expect(await probe()).toEqual({ kind: 'unreachable', reason: 'FATAL:  password authentication failed for user "replicator"' });
  });
  it('identified, two lines, refused by pg_hba: unreachable', async () => {
    answer('7001|2|0/5\nfalse\n', 4, HBA);
    expect(await probe()).toEqual({ kind: 'unreachable', reason: 'FATAL:  pg_hba.conf rejects connection for host "10.0.0.2", user "replicator"' });
  });
  it.each(['', 'garbage\n'])('not identified (stdout %j), refused by pg_hba: unreachable', async out => {
    answer(out, 2, HBA);
    expect(await probe()).toEqual({ kind: 'unreachable', reason: 'FATAL:  pg_hba.conf rejects connection for host "10.0.0.2", user "replicator"' });
  });
  it('not identified, a password failure: login refused', async () => {
    answer('', 2, PWFAIL);
    expect(await probe()).toEqual({ kind: 'login-refused', reason: 'FATAL:  password authentication failed for user "replicator"' });
  });
  it('a password too short for the redaction is still starred in the reason', async () => {
    answer('', 2, 'psql: error: FATAL:  password authentication failed (pq3)');
    expect(await probe({ repl: { user: 'replicator', password: 'pq3' } })).toEqual({ kind: 'login-refused', reason: 'FATAL:  password authentication failed (***)' });
  });
});
