import { execFile } from 'child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnCapture } from '../../src/webui/terminal';
import { feedStdin } from '../../src/docker/childStdin';

const BIG = Buffer.alloc(8 * 1024 * 1024, 120);
const EXIT3 = ['-e', 'process.exit(3)'];

let uncaught: Error[] = [];
const onUncaught = (e: Error) => { uncaught.push(e); };
beforeEach(() => { uncaught = []; process.on('uncaughtException', onUncaught); });
afterEach(() => { process.off('uncaughtException', onUncaught); });

describe('T-EPIPE: a child that exits before reading its stdin', () => {
  it('spawnCapture resolves with the child failure and raises no uncaught exception', async () => {
    const r = await spawnCapture(process.execPath, EXIT3, { input: BIG });
    await new Promise(r2 => setTimeout(r2, 50));
    expect(r.code).toBe(3);
    expect(uncaught).toEqual([]);
  });

  it('feedStdin on an execFile child leaves the outcome to the child and raises no uncaught exception', async () => {
    const r = await new Promise<{ ok: boolean }>(resolve => {
      const child = execFile(process.execPath, EXIT3, err => resolve({ ok: !err }));
      feedStdin(child.stdin, BIG.toString('latin1'));
    });
    await new Promise(r2 => setTimeout(r2, 50));
    expect(r.ok).toBe(false);
    expect(uncaught).toEqual([]);
  });
});
