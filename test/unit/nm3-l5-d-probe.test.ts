import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm3-l5-d-'));
  process.env.DATA_DIR = dir;
  delete process.env.HOST_DATA_DIR;
  return {
    dir,
    execs: [] as Array<{ cmd: string; args: string[]; opts: any }>,
    spawns: [] as Array<{ cmd: string; args: string[] }>,
    exec: (_args: string[]): { err: boolean; out: string; stderr: string } => ({ err: false, out: '', stderr: '' }),
    run: { code: 0, out: '', err: '' },
  };
});

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const { EventEmitter } = await import('events');
  const { PassThrough } = await import('stream');
  const execFile = (cmd: string, args: string[], opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    h.execs.push({ cmd, args, opts: typeof opts === 'function' ? undefined : opts });
    const a = h.exec(args);
    setImmediate(() => done(a.err ? Object.assign(new Error('exec failed'), { code: 1 }) : null, a.out, a.stderr));
    return new EventEmitter();
  };
  const spawn = (cmd: string, args: string[]) => {
    h.spawns.push({ cmd, args });
    const child: any = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    setTimeout(() => {
      child.stdout.end(h.run.out);
      child.stderr.end(h.run.err);
      setTimeout(() => child.emit('close', h.run.code), 1);
    }, 2);
    return child;
  };
  return { ...real, execFile, spawn, default: { ...real, execFile, spawn } };
});
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import * as fs from 'fs';
import * as path from 'path';
import { ensureClientImage, ensureProbeCert, mainProbe, probeFailureText, readAddresses, unreachableText } from '../../src/instance/fleetJoin';
import { FIXTURE_FP, FIXTURE_PEM, fakeJoin } from './join-fake';

const instance = { id: 'b1', sanitizedName: 'b1' } as any;
const fp16 = FIXTURE_FP.slice(0, 16);
const certFile = path.join(h.dir, 'bots', 'b1', 'fleet-join', `${fp16}.crt`);
const mount = `${path.resolve(h.dir).replace(/\\/g, '/')}/bots/b1/fleet-join/${fp16}.crt:/primary-ca.crt:ro`;
const dsn = 'postgresql://replicator@main.invalid:15432/smdb?sslmode=verify-full&sslrootcert=/primary-ca.crt';
const pemBare = FIXTURE_PEM.trim();

beforeEach(() => {
  h.execs = []; h.spawns = [];
  h.exec = () => ({ err: false, out: '', stderr: '' });
  h.run = { code: 0, out: '', err: '' };
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
});
afterAll(() => fs.rmSync(h.dir, { recursive: true, force: true }));

describe('ensureProbeCert', () => {
  it('writes a certificate that ends in a newline as it is', () => {
    ensureProbeCert('b1', FIXTURE_FP, `${pemBare}\n`);
    expect(fs.readFileSync(certFile, 'utf-8')).toBe(`${pemBare}\n`);
  });
  it('adds the newline a certificate lacks', () => {
    ensureProbeCert('b1', FIXTURE_FP, pemBare);
    expect(fs.readFileSync(certFile, 'utf-8')).toBe(`${pemBare}\n`);
  });
});

describe('ensureClientImage', () => {
  it('inspects the image and pulls nothing when it is present', async () => {
    expect(await ensureClientImage()).toBeNull();
    expect(h.execs).toEqual([{ cmd: 'docker', args: ['image', 'inspect', 'postgres:16-alpine'], opts: { timeout: 30_000 } }]);
  });
  it('pulls a missing image with the pull timeout', async () => {
    h.exec = args => ({ err: args[0] === 'image', out: '', stderr: '' });
    expect(await ensureClientImage()).toBeNull();
    expect(h.execs[1]).toEqual({ cmd: 'docker', args: ['pull', 'postgres:16-alpine'], opts: { timeout: 600_000 } });
  });
  it('names the last line of a failed pull', async () => {
    h.exec = () => ({ err: true, out: '', stderr: 'pulling\nmanifest unknown\n' });
    expect(await ensureClientImage()).toBe('could not pull postgres:16-alpine: manifest unknown');
  });
});

describe('mainProbe', () => {
  const okOut = '7012345|1|0/16B3748\nfalse|kept';
  const probe = (slot?: string, code = fakeJoin()) => mainProbe(instance, code, FIXTURE_PEM, slot);
  const slotSql = (s: string) => `COALESCE((SELECT CASE WHEN active THEN 'active' WHEN wal_status = 'lost' THEN 'lost' ELSE 'kept' END FROM pg_replication_slots WHERE slot_name = '${s}'), 'absent')`;

  it('runs psql in a named container with the certificate mounted and the slot read', async () => {
    h.run.out = okOut;
    expect(await probe('fleet_slot_1')).toEqual({ ok: true, facts: { systemId: '7012345', timeline: 1, lsn: 0x16B3748n, inRecovery: false, slot: 'kept' } });
    expect(h.execs[0].args).toEqual(['rm', '-f', 'b1-fleet-join-probe']);
    expect(h.spawns[0].args).toEqual(['run', '--rm', '--name', 'b1-fleet-join-probe', '-e', 'PGPASSWORD', '-v', mount,
      '--entrypoint', 'sh', 'postgres:16-alpine', '-c',
      'psql "$1&replication=true" -Atc IDENTIFY_SYSTEM && psql "$1" -v ON_ERROR_STOP=1 -Atc "$2"', 'sh', dsn,
      `SELECT pg_is_in_recovery()::text || '|' || ${slotSql('fleet_slot_1')}`]);
  });

  it('reads a slot name that is not a slot name as absent', async () => {
    h.run.out = okOut;
    await probe('x-y');
    expect(h.spawns[0].args.at(-1)).toBe(`SELECT pg_is_in_recovery()::text || '|' || 'absent'`);
  });

  it.each([['lost'], ['active']])('reads the slot state %s', async s => {
    h.run.out = `7|1|0/1\ntrue|${s}`;
    expect(await probe('s')).toMatchObject({ ok: true, facts: { slot: s, inRecovery: true } });
  });

  it('reads an answer with a blank first line and spaces around a line', async () => {
    h.run.out = '\n7|1|0/1\n  false|absent  ';
    expect(await probe()).toMatchObject({ ok: true, facts: { systemId: '7', slot: 'absent' } });
  });

  it.each([
    ['a system id with letters', 'abc|1|0/1\nfalse|absent'],
    ['a system id with a letter first', 'x1|1|0/1\nfalse|absent'],
    ['a system id with a letter last', '1x|1|0/1\nfalse|absent'],
    ['a timeline with a letter first', '1|x1|0/1\nfalse|absent'],
    ['a timeline with a letter last', '1|1x|0/1\nfalse|absent'],
    ['a recovery flag that is not a boolean', '1|1|0/1\nmaybe|absent'],
  ])('refuses %s', async (_n, out) => {
    h.run.out = out;
    expect(await probe()).toEqual({ ok: false, kind: 'garbled', reason: 'the main gave an answer the manager does not read' });
  });

  it('reads a timeline of two digits', async () => {
    h.run.out = '1|12|0/1\nfalse|absent';
    expect(await probe()).toMatchObject({ ok: true, facts: { timeline: 12 } });
  });

  it.each([
    ['the FATAL line, trimmed', 'first\n   FATAL: boom   \nlast', 'FATAL: boom', 'unreachable'],
    ['psql failed when stderr is empty', '', 'psql failed', 'unreachable'],
    ['a psql prefix only at the start', 'x psql: error: y', 'x psql: error: y', 'unreachable'],
    ['the prefix cut at the start', 'psql: error: y', 'y', 'unreachable'],
    ['a missing role as a login refusal', 'FATAL:  role "ab" does not exist', 'FATAL:  role "ab" does not exist', 'login'],
  ])('a failed probe names %s', async (_n, err, reason, kind) => {
    h.run = { code: 2, out: '', err };
    expect(await probe()).toEqual({ ok: false, kind, reason });
  });

  it('hides a short password the redaction leaves', async () => {
    h.run = { code: 2, out: '', err: 'FATAL: bad pw7 here' };
    expect(await probe(undefined, fakeJoin({ repl: { user: 'replicator', password: 'pw7' } }))).toEqual({ ok: false, kind: 'unreachable', reason: 'FATAL: bad *** here' });
  });
});

describe('probeFailureText', () => {
  it('words a failure that is not a login refusal as unreachable', () => {
    const code = fakeJoin();
    expect(probeFailureText(code, { ok: false, kind: 'unreachable', reason: 'r' })).toBe(unreachableText('main.invalid', 15432, 'r'));
  });
});

describe('readAddresses', () => {
  const row = (over: Record<string, unknown> = {}) => ({ host: 'h.invalid', port: 5432, slot: 'fleet_a', cert: FIXTURE_PEM, machine: 'm1', ...over });
  const read = async (rows: unknown[]) => {
    h.run.out = JSON.stringify(rows);
    return readAddresses(instance, fakeJoin(), FIXTURE_PEM);
  };

  it('runs psql in a named container with the certificate mounted', async () => {
    await read([]);
    expect(h.execs[0].args).toEqual(['rm', '-f', 'b1-fleet-join-list']);
    const a = h.spawns[0].args;
    expect(a.slice(0, a.length - 1)).toEqual(['run', '--rm', '--name', 'b1-fleet-join-list', '-e', 'PGPASSWORD', '-v', mount,
      '--entrypoint', 'psql', 'postgres:16-alpine', dsn, '-v', 'ON_ERROR_STOP=1', '-Atc']);
    expect(a.at(-1)).toContain('FROM smdb_manager.addresses a');
  });

  it('keeps a valid row with its slot, the trimmed certificate and a default machine name', async () => {
    const r = await read([row({ cert: `${pemBare}\n`, machine: undefined })]);
    expect(r).toEqual({ ok: true, addresses: [{ host: 'h.invalid', port: 5432, slot: 'fleet_a', cert: pemBare, machine: 'unnamed' }] });
  });

  it('keeps the main row with a null slot and the edge ports', async () => {
    const r = await read([row({ slot: null, port: 1 }), row({ port: 65535 })]);
    expect(r.ok && r.addresses.map(a => [a.port, a.slot])).toEqual([[1, null], [65535, 'fleet_a']]);
  });

  it('leaves out a null row, bad ports, a bad slot and a certificate that does not parse', async () => {
    const badCert = '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----';
    const r = await read([null, row({ port: 0 }), row({ port: 65536 }), row({ slot: 'Bad-slot' }), row({ cert: badCert }), row({ host: 'kept.invalid' })]);
    expect(r).toEqual({ ok: true, addresses: [{ host: 'kept.invalid', port: 5432, slot: 'fleet_a', cert: pemBare, machine: 'm1' }] });
  });
});
