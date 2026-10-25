import { beforeEach, describe, expect, it, vi } from 'vitest';

const st = vi.hoisted(() => ({ calls: [] as Array<{ args: string[]; opts: any }>, killed: false }));

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const execFile = (cmd: string, args: string[], opts: any, maybeCb?: (err: any, stdout: string, stderr: string) => void) => {
    const cb = typeof opts === 'function' ? opts : maybeCb!;
    if (cmd !== 'docker') throw new Error(`unexpected execFile ${cmd}`);
    st.calls.push({ args, opts: typeof opts === 'function' ? undefined : opts });
    const err = st.killed ? Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM' }) : null;
    setImmediate(() => cb(err, st.killed ? '' : '7301234567890123456\n', ''));
    return { stdin: null };
  };
  return { ...real, execFile };
});

import { readSystemId } from '../../src/instance/recoveryControl';

const fleetDb = { containerName: 'src1-db', user: 'u', db: 'd' };

beforeEach(() => {
  st.calls.length = 0;
  st.killed = false;
});

describe('FU-8c the quiesce reads its system id with a bounded docker call', () => {
  it('passes a timeout to the system id read', async () => {
    expect(await readSystemId(fleetDb)).toBe('7301234567890123456');
    expect(st.calls.length).toBe(1);
    expect(st.calls[0].opts?.timeout).toBeGreaterThan(0);
  });

  it('reads a timed-out system id as unknown', async () => {
    st.killed = true;
    expect(await readSystemId(fleetDb)).toBeNull();
  });
});
