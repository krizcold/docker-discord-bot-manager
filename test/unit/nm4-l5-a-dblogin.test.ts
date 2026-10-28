import { beforeEach, describe, expect, it, vi } from 'vitest';

const dk = vi.hoisted(() => ({
  answer: (_args: string[]): { stdout: string } => ({ stdout: '' }),
}));
vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  execFile: (_cmd: string, args: string[], _opts: any, cb: (e: Error | null, out: string, err: string) => void) => {
    const a = dk.answer(args);
    setImmediate(() => cb(null, a.stdout, ''));
  },
}));

import { readWriteFence, resetManagerRoleCache } from '../../src/instance/dbLogin';

const t = { container: 'b1-fleet-postgres', user: 'smdb' };
const FENCE_SQL = "SELECT current_setting('default_transaction_read_only')";
const fenceWith = (owner: string) => { dk.answer = (args) => ({ stdout: args[args.length - 1] === FENCE_SQL ? 'on\n' : owner }); };

beforeEach(() => resetManagerRoleCache());

describe('NM4 L5 survivors in dbLogin.ts (writer a)', () => {
  it('an unknown read-only value names what it read back', async () => {
    dk.answer = () => ({ stdout: 'notice\nmaybe\n' });
    expect(await readWriteFence(t)).toEqual({ ok: false, cls: 'other', error: 'the read-only setting read back as maybe' });
  });

  it('an owner answer with a leading extra line is unreadable', async () => {
    fenceWith('stray\nreseed:1793181600000|1\n');
    expect(await readWriteFence(t)).toEqual({ ok: true, on: true, owner: null, persisted: null });
  });

  it('an owner answer with a trailing extra line is unreadable', async () => {
    fenceWith('reseed:1793181600000|1\nstray\n');
    expect(await readWriteFence(t)).toEqual({ ok: true, on: true, owner: null, persisted: null });
  });

  it('a count of two digits reads as saved', async () => {
    fenceWith('|10\n');
    expect(await readWriteFence(t)).toEqual({ ok: true, on: true, owner: null, persisted: true });
  });
});
