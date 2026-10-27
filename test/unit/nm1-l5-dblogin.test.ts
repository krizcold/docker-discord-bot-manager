import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Answer = { err?: string; killed?: boolean; stdout?: string; stderr?: string };
const dk = vi.hoisted(() => ({
  calls: [] as Array<{ args: string[]; opts: any }>,
  answer: (_args: string[]): { err?: string; killed?: boolean; stdout?: string; stderr?: string } => ({ stdout: '' }),
}));
vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  execFile: (cmd: string, args: string[], opts: any, cb: (e: Error | null, out: string, err: string) => void) => {
    dk.calls.push({ args: [cmd, ...args], opts });
    const a: Answer = dk.answer(args);
    setImmediate(() => cb(a.err !== undefined ? Object.assign(new Error(a.err), { code: 1, killed: !!a.killed }) : null, a.stdout ?? '', a.stderr ?? ''));
  },
}));

import {
  asManager, ensureManagerDbRole, readBotLogin, blockBotLogin, endBotSessions, resetManagerRoleCache, forgetManagerRole,
  psqlFailureClass, parseBotLogin, isMissingManagerRole, withRole, sidecarRunning,
} from '../../src/instance/dbLogin';

const t = { container: 'b1-fleet-postgres', user: 'smdb' };
const MISSING = 'FATAL:  role "dbm_admin" does not exist';
const READ_ONLY = 'ERROR:  cannot execute CREATE ROLE in a read-only transaction';
const roleOf = (c: { args: string[] }) => c.args[c.args.indexOf('-U') + 1];
const isCheck = (args: string[]) => args[args.length - 1].startsWith('SELECT rolsuper');

beforeEach(() => {
  dk.calls = [];
  resetManagerRoleCache();
});
afterEach(() => vi.restoreAllMocks());

describe('parsing and classes', () => {
  it('parseBotLogin reads a session count of two digits', () => {
    expect(parseBotLogin('false|true|12\n')).toEqual({ inRecovery: false, canLogin: true, sessions: 12 });
  });
  it('parseBotLogin drops only a final newline, never one inside', () => {
    expect(parseBotLogin('false\n|true|1')).toBeNull();
  });
  it('a missing role other than dbm_admin is not the missing-role class', () => {
    expect(psqlFailureClass('FATAL:  role "smdb" does not exist')).toBe('other');
    expect(psqlFailureClass('ERROR: "dbm_admin" is busy')).toBe('other');
    expect(isMissingManagerRole('ERROR: something else')).toBe(false);
    expect(isMissingManagerRole(MISSING)).toBe(true);
  });
  it('withRole swaps the manager role only', () => {
    expect(withRole(['-U', 'dbm_admin', 'x'], 'smdb')).toEqual(['-U', 'smdb', 'x']);
  });
});

describe('psql error texts', () => {
  const failRead = async (a: Answer) => {
    dk.answer = () => a;
    return readBotLogin(t);
  };
  it('the last non-blank line, trimmed', async () => {
    expect(await failRead({ err: 'x', stderr: 'first\n  ERROR:  last  \n\n' })).toEqual({ ok: false, cls: 'other', error: 'ERROR:  last' });
  });
  it('a blank stderr says psql failed with no message', async () => {
    expect(await failRead({ err: 'x', stderr: '\n' })).toEqual({ ok: false, cls: 'other', error: 'psql failed with no message' });
  });
  it('no stderr carries the error message', async () => {
    expect(await failRead({ err: 'spawn failed', stderr: '' })).toEqual({ ok: false, cls: 'other', error: 'spawn failed' });
  });
  it('a killed docker says it did not answer within 30 s', async () => {
    expect(await failRead({ err: 'killed', killed: true, stderr: '' })).toEqual({ ok: false, cls: 'other', error: 'docker did not answer within 30 s' });
  });
  it('an unexpected read answer is quoted', async () => {
    expect(await failRead({ stdout: 'garbage\n' })).toEqual({ ok: false, cls: 'other', error: 'the login read answered something unexpected (garbage)' });
  });
  it('a block in recovery says so', async () => {
    dk.answer = () => ({ stdout: 'true|true|0\n' });
    expect(await blockBotLogin(t)).toEqual({ ok: false, cls: 'recovery', error: 'the database is in recovery' });
  });
});

describe('the cached role', () => {
  it('a failure of another class keeps the cache', async () => {
    dk.answer = () => ({ stdout: 'true\n' });
    await ensureManagerDbRole(t);
    dk.answer = () => ({ err: 'x', stderr: 'ERROR: other' });
    await readBotLogin(t);
    dk.calls = [];
    expect(await ensureManagerDbRole(t)).toEqual({ ok: true });
    expect(dk.calls).toEqual([]);
  });
  it('a missing role on the retry drops the cache again', async () => {
    dk.answer = args => (isCheck(args) ? { stdout: 'true\n' } : { err: 'x', stderr: MISSING });
    await readBotLogin(t);
    dk.calls = [];
    dk.answer = () => ({ stdout: 'true\n' });
    await ensureManagerDbRole(t);
    expect(dk.calls.length).toBe(1);
  });
  it('asManager drops the cache when its own run reports the role missing', async () => {
    dk.answer = () => ({ stdout: 'true\n' });
    await ensureManagerDbRole(t);
    dk.calls = [];
    const runs: string[] = [];
    let n = 0;
    const r = await asManager(t, async role => { runs.push(role); return n++ === 0 ? 'gone' : 'fine'; }, x => x === 'gone');
    expect(r).toBe('fine');
    expect(dk.calls.length).toBe(1);
    expect(runs).toEqual(['dbm_admin', 'dbm_admin']);
  });
  it('asManager returns the first answer when the role cannot be made for a reason other than recovery', async () => {
    dk.answer = () => ({ stdout: 'false\n' });
    const runs: string[] = [];
    const r = await asManager(t, async role => { runs.push(role); return 'gone'; }, x => x === 'gone');
    expect(r).toBe('gone');
    expect(runs).toEqual(['dbm_admin']);
  });
  it('a successful read runs once, with no role check', async () => {
    dk.answer = () => ({ stdout: 'false|false|0\n' });
    await readBotLogin(t);
    expect(dk.calls.length).toBe(1);
  });
  it('a failed check of another class creates nothing', async () => {
    dk.answer = () => ({ err: 'x', stderr: 'ERROR: other' });
    expect(await ensureManagerDbRole(t)).toEqual({ ok: false, cls: 'other', error: 'ERROR: other' });
    expect(dk.calls.length).toBe(1);
  });
  it('a role that is not a superuser is never cached', async () => {
    dk.answer = () => ({ stdout: 'false\n' });
    await ensureManagerDbRole(t);
    await ensureManagerDbRole(t);
    expect(dk.calls.length).toBe(2);
  });
});

describe('the live copy warning', () => {
  const copy = () => {
    dk.answer = args => (roleOf({ args }) === 'dbm_admin' ? { err: 'x', stderr: MISSING } : args[args.length - 1].startsWith('CREATE') ? { err: 'x', stderr: READ_ONLY } : { stdout: 'true|true|0\n' });
    return readBotLogin(t);
  };
  const warns = () => vi.spyOn(console, 'warn').mockImplementation(() => {});
  it('is logged again after resetManagerRoleCache', async () => {
    const w = warns();
    await copy();
    resetManagerRoleCache();
    await copy();
    expect(w).toHaveBeenCalledTimes(2);
  });
  it('is logged again after forgetManagerRole', async () => {
    const w = warns();
    await copy();
    forgetManagerRole(t.container);
    await copy();
    expect(w).toHaveBeenCalledTimes(2);
  });
  it('is logged again after a login as the manager role worked', async () => {
    const w = warns();
    await copy();
    dk.answer = () => ({ stdout: 'false|true|0\n' });
    await readBotLogin(t);
    await copy();
    expect(w).toHaveBeenCalledTimes(2);
  });
});

describe('endBotSessions', () => {
  it('a terminate that fails ends with its error at once', async () => {
    dk.answer = args => (args[args.length - 1].includes('pg_terminate_backend') ? { err: 'x', stderr: 'ERROR: term' } : { stdout: 'false|true|0\n' });
    expect(await endBotSessions(t, 0)).toEqual({ ok: false, cls: 'other', error: 'ERROR: term' });
    expect(dk.calls.length).toBe(1);
  });
  it('the error names the sessions left', async () => {
    dk.answer = args => (args[args.length - 1].includes('pg_terminate_backend') ? { stdout: '1\n' } : { stdout: 'false|true|2\n' });
    expect(await endBotSessions(t, 0)).toEqual({ ok: false, cls: 'other', left: 2, error: '2 session(s) left after three rounds' });
  });
  it('pauses for pauseMs after each terminate, and not at all for 0', async () => {
    dk.answer = args => (args[args.length - 1].includes('pg_terminate_backend') ? { stdout: '1\n' } : { stdout: 'false|true|0\n' });
    const st = vi.spyOn(globalThis, 'setTimeout');
    await endBotSessions(t, 0);
    expect(st.mock.calls.filter(c => c[1] === 0).length).toBe(0);
    await endBotSessions(t, 5);
    expect(st.mock.calls.filter(c => c[1] === 5).length).toBe(1);
  });
  it('pauseMs of 0 never sets a timer', async () => {
    dk.answer = args => (args[args.length - 1].includes('pg_terminate_backend') ? { stdout: '1\n' } : { stdout: 'false|true|0\n' });
    const st = vi.spyOn(globalThis, 'setTimeout');
    await endBotSessions(t, 0);
    expect(st).not.toHaveBeenCalled();
  });
});

describe('sidecarRunning', () => {
  it('the exact argv and timeout', async () => {
    dk.answer = () => ({ stdout: 'true\n' });
    expect(await sidecarRunning('pg1')).toBe(true);
    expect(dk.calls.map(c => c.args)).toEqual([['docker', 'inspect', '-f', '{{.State.Running}}', 'pg1']]);
    expect(dk.calls[0].opts).toEqual({ timeout: 30_000 });
  });
  it('a stopped container', async () => {
    dk.answer = () => ({ stdout: 'false\n' });
    expect(await sidecarRunning('pg1')).toBe(false);
  });
  it('no such object in stderr is false', async () => {
    dk.answer = () => ({ err: 'exit 1', stderr: 'Error: No such object: pg1' });
    expect(await sidecarRunning('pg1')).toBe(false);
  });
  it('no such container in the error message is false', async () => {
    dk.answer = () => ({ err: 'Error: No such container: pg1', stderr: '' });
    expect(await sidecarRunning('pg1')).toBe(false);
  });
  it('any other failure is null', async () => {
    dk.answer = () => ({ err: 'exit 1', stderr: 'permission denied' });
    expect(await sidecarRunning('pg1')).toBeNull();
  });
});

