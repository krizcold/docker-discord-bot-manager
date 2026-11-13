import { describe, expect, it, vi } from 'vitest';

const d = vi.hoisted(() => ({ calls: 0 }));
vi.mock('crypto', async (importOriginal) => {
  const real = await importOriginal<typeof import('crypto')>();
  const pbkdf2 = (...args: unknown[]) => { d.calls++; return (real.pbkdf2 as (...a: unknown[]) => void)(...args); };
  return { ...real, pbkdf2, default: { ...real, pbkdf2 } };
});
import * as crypto from 'crypto';
import { scramSha256Verifier, verifierAccepts } from '../../src/config/secretText';

const PW = 'Db-Secret-0123456789';
const SALT = Buffer.alloc(16, 7);
const SALT64 = SALT.toString('base64');
const OVER = scramSha256Verifier(PW, SALT, 4096).replace('$4096:', '$150000:');
const WHY = "the database's SCRAM-SHA-256 password for smdb uses 150000 iterations, more than the 100000 the manager checks";

// What Postgres stores for a password that SASLprep leaves as it is: the derivation over its UTF-8 bytes.
const utf8Verifier = (password: string, iterations: number): string => {
  const salted = crypto.pbkdf2Sync(Buffer.from(password, 'utf-8'), SALT, iterations, 32, 'sha256');
  const storedKey = crypto.createHash('sha256').update(crypto.createHmac('sha256', salted).update('Client Key').digest()).digest();
  const serverKey = crypto.createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${iterations}:${SALT64}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
};

const within = <T>(p: Promise<T>, ms: number): Promise<T> => Promise.race([
  p, new Promise<T>((_r, reject) => setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms)),
]);

describe('the verifier form is anchored at both ends', () => {
  it('text before or after a verifier over the bound is not a verifier', async () => {
    expect(await verifierAccepts(`x${OVER}`, PW, 'smdb')).toBe(false);
    expect(await verifierAccepts(`${OVER}!`, PW, 'smdb')).toBe(false);
  });
  it('keys with no padding are of the form', async () => {
    const k = 'A'.repeat(43);
    expect(await verifierAccepts(`SCRAM-SHA-256$150000:${SALT64}$${k}:${k}=`, PW, 'smdb')).toEqual({ why: WHY });
    expect(await verifierAccepts(`SCRAM-SHA-256$150000:${SALT64}$${k}=:${k}`, PW, 'smdb')).toEqual({ why: WHY });
  });
});

describe('the candidate', () => {
  it('an absent candidate is the empty password', async () => {
    expect(await verifierAccepts(scramSha256Verifier('', SALT, 1), undefined as unknown as string, 'smdb')).toBe(true);
  });
  it('a non-ASCII candidate answers false even against its own UTF-8 verifier', async () => {
    for (const p of ['päss', 'pässword-ascii-tail', 'ascii-head-ü']) {
      expect(await verifierAccepts(utf8Verifier(p, 1), p, 'smdb')).toBe(false);
    }
  });
});

describe('the iteration bound and the derivation', () => {
  it('a verifier made at 150000 iterations is refused with the reason and no derivation', async () => {
    const made = scramSha256Verifier(PW, SALT, 150000);
    d.calls = 0;
    expect(await verifierAccepts(made, PW, 'smdb')).toEqual({ why: WHY });
    expect(d.calls).toBe(0);
  });
  it('a derivation answers', async () => {
    expect(await within(verifierAccepts(scramSha256Verifier(PW, SALT, 1), PW, 'smdb'), 2000)).toBe(true);
    expect(await within(verifierAccepts(scramSha256Verifier(PW, SALT, 1), 'other', 'smdb'), 2000)).toBe(false);
  });
});
