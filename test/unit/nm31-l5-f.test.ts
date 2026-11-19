import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: string[] }[],
  answers: [] as { code: number; stdout: string; stderr: string }[],
}));

vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  spawn: () => { throw new Error('no real process in this file'); },
  execFile: () => { throw new Error('no real process in this file'); },
}));
vi.mock('../../src/docker/processStart', async (importOriginal) => {
  const { EventEmitter } = await import('events');
  const { PassThrough } = await import('stream');
  return {
    ...(await importOriginal<typeof import('../../src/docker/processStart')>()),
    startProcess: (cmd: string, args: readonly string[]) => {
      h.calls.push({ cmd, args: [...args] });
      const a = h.answers.shift() ?? { code: 0, stdout: '', stderr: '' };
      const child: any = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.kill = () => true;
      setImmediate(() => {
        if (a.stdout) child.stdout.emit('data', a.stdout);
        if (a.stderr) child.stderr.emit('data', a.stderr);
        child.emit('close', a.code);
      });
      return { child };
    },
  };
});

import * as dbLogin from '../../src/instance/dbLogin';
import { readGenerationAsAdmin } from '../../src/instance/fleetSwitch';

const T = { container: 'smdb-pg-x', user: 'bota' };
const ok = (stdout: string) => ({ code: 0, stdout, stderr: '' });
const fail = (stderr: string) => ({ code: 2, stdout: '', stderr });
const superAnswer = ok('true\n');

beforeEach(() => { h.calls.length = 0; h.answers.length = 0; });

describe('nm31 l5 f: adminReadArgs', () => {
  it('builds the read-only superuser psql argv', () => {
    expect(dbLogin.adminReadArgs('c1', 'botdb')).toEqual([
      'exec', '-e', `PGOPTIONS=${dbLogin.MANAGER_SESSION_OPTIONS} -c default_transaction_read_only=on`, '-i', 'c1', 'psql', '-X',
      '-U', 'dbm_admin', '-d', 'botdb', '-tA', '-v', 'ON_ERROR_STOP=1',
    ]);
  });
});

describe('nm31 l5 f: readGenerationAsAdmin', () => {
  it('a failed superuser read answers its error and runs nothing more', async () => {
    h.answers.push(fail('psql: error: FATAL:  the database system is starting up\n'));
    expect(await readGenerationAsAdmin(T, 'botdb')).toEqual({ ok: false, error: 'FATAL:  the database system is starting up' });
    expect(h.calls).toHaveLength(1);
  });

  it('a missing role answers the exact refusal', async () => {
    h.answers.push(ok('missing\n'));
    expect(await readGenerationAsAdmin(T, 'botdb')).toEqual({ ok: false, error: "the bot's role bota does not exist in the database's cluster" });
    expect(h.calls).toHaveLength(1);
  });

  it('sends the admin read argv with -q', async () => {
    h.answers.push(superAnswer, ok('-\n'));
    expect(await readGenerationAsAdmin(T, 'botdb')).toEqual({ ok: true, row: null });
    expect(h.calls[1]).toEqual({ cmd: 'docker', args: [...dbLogin.adminReadArgs('smdb-pg-x', 'botdb'), '-q'] });
  });

  it('a failed admin read answers its error', async () => {
    h.answers.push(superAnswer, fail('psql: error: FATAL:  database "botdb" does not exist\n'));
    expect(await readGenerationAsAdmin(T, 'botdb')).toEqual({ ok: false, error: 'FATAL:  database "botdb" does not exist' });
  });

  it('a view is not read', async () => {
    h.answers.push(superAnswer, ok('v\n'));
    expect(await readGenerationAsAdmin(T, 'botdb')).toEqual({ ok: false, error: 'smdb_manager.generation is not a plain table (relkind v), so the manager did not read it' });
  });

  it('a plain table with a bad row line quotes the line', async () => {
    h.answers.push(superAnswer, ok('r\nx|y\n'));
    expect(await readGenerationAsAdmin(T, 'botdb')).toEqual({ ok: false, error: "the generation read answered 'x|y'" });
  });

  it('a plain table with no row line quotes nothing', async () => {
    h.answers.push(superAnswer, ok('r\n'));
    expect(await readGenerationAsAdmin(T, 'botdb')).toEqual({ ok: false, error: "the generation read answered ''" });
  });

  it('a plain table row is read', async () => {
    h.answers.push(superAnswer, ok('r\n7|m1|2026-11-01 00:00:00+00\n'));
    expect(await readGenerationAsAdmin(T, 'botdb')).toEqual({ ok: true, row: { generation: 7, machine: 'm1', since: '2026-11-01 00:00:00+00' } });
  });
});
