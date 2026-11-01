import { beforeEach, describe, expect, it, vi } from 'vitest';

type Answer = { err?: string; stdout?: string; stderr?: string };
const dk = vi.hoisted(() => ({
  calls: [] as Array<{ cmd: string; args: string[]; opts: any }>,
  answer: { stdout: '' } as { err?: string; stdout?: string; stderr?: string },
}));
vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  execFile: (cmd: string, args: string[], opts: any, cb: (e: Error | null, out: string, err: string) => void) => {
    dk.calls.push({ cmd, args, opts });
    const a: Answer = dk.answer;
    setImmediate(() => cb(a.err !== undefined ? Object.assign(new Error(a.err), { code: 1 }) : null, a.stdout ?? '', a.stderr ?? ''));
  },
}));

import { sidecarState } from '../../src/instance/dbLogin';

beforeEach(() => {
  dk.calls = [];
  dk.answer = { stdout: '' };
});

describe('sidecarState', () => {
  it('runs docker inspect with the two-field template and the psql timeout', async () => {
    dk.answer = { stdout: 'true false\n' };
    expect(await sidecarState('pg1')).toBe('running');
    expect(dk.calls).toEqual([{ cmd: 'docker', args: ['inspect', '-f', '{{.State.Running}} {{.State.Restarting}}', 'pg1'], opts: { timeout: 30_000 } }]);
  });

  const V = '<no value>';
  it.each([
    ['false false', 'stopped'],
    ['false true', 'stopped'],
    ['true false', 'running'],
    ['true true', 'restarting'],
    [`false ${V}`, null],
    [`true ${V}`, null],
    [`${V} false`, null],
    [`${V} true`, null],
    [`${V} ${V}`, null],
  ])('docker answering "%s" is %s', async (out, want) => {
    dk.answer = { stdout: `${out}\n` };
    expect(await sidecarState('pg1')).toBe(want);
  });

  it('no such object in stderr is stopped even when the error message says something else', async () => {
    dk.answer = { err: 'Command failed: docker inspect', stderr: 'Error: No such object: pg1' };
    expect(await sidecarState('pg1')).toBe('stopped');
  });
  it('no such container in the error message with an empty stderr is stopped', async () => {
    dk.answer = { err: 'Error: No such container: pg1', stderr: '' };
    expect(await sidecarState('pg1')).toBe('stopped');
  });
  it('any other failure is null', async () => {
    dk.answer = { err: 'Command failed: docker inspect', stderr: 'permission denied while trying to connect to the docker API' };
    expect(await sidecarState('pg1')).toBeNull();
  });
});
