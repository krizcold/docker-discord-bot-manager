import { describe, expect, it } from 'vitest';
import {
  addressList, certFingerprint, decodeJoinCode, encodeJoinCode, formatBackendUrlList, isBackendUrlList, isJoinCode,
  JOIN_CODE_PREFIX, lsnText, lsnToBigInt, splitBackendUrls, sqlLiteral,
} from '../../src/config/joinCode';
import { COPY_FP, COPY_PEM, FIXTURE_FP, FIXTURE_PEM, fakeJoin, fakeJoinCode } from './join-fake';

// A small LCG, so the property rows are the same on every run.
function lcg(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 4294967296;
  };
}
const TAME = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._~-';
const ANY = `${TAME},%@:/?#&= '"\\`;
const pick = (r: () => number, chars: string, min: number, max: number) =>
  Array.from({ length: min + Math.floor(r() * (max - min + 1)) }, () => chars[Math.floor(r() * chars.length)]).join('');

const b64 = (o: unknown) => `${JOIN_CODE_PREFIX}${Buffer.from(JSON.stringify(o)).toString('base64url')}`;

describe('join code: encode and decode', () => {
  it('round-trips 500 seeded codes', () => {
    const r = lcg(42);
    for (let i = 0; i < 500; i++) {
      const code = fakeJoin({
        host: `h${pick(r, 'abc123', 1, 8)}.example`,
        port: 1 + Math.floor(r() * 65535),
        db: pick(r, TAME, 1, 20),
        machine: pick(r, 'abc XYZ-1', 1, 30).trim() || 'm',
        repl: { user: pick(r, TAME, 1, 12), password: pick(r, TAME, 1, 40) },
        app: { user: pick(r, TAME, 1, 12), password: pick(r, ANY, 1, 40) },
      });
      const d = decodeJoinCode(encodeJoinCode(code));
      expect(d).toEqual({ ok: true, code });
    }
  });

  it('ignores whitespace and line breaks a chat window adds', () => {
    const code = fakeJoinCode();
    const wrapped = `  ${code.slice(0, 20)}\n${code.slice(20, 50)}\r\n ${code.slice(50)}  `;
    expect(decodeJoinCode(wrapped)).toEqual({ ok: true, code: fakeJoin() });
  });

  const good = { v: 1, host: 'main.invalid', port: 15432, db: 'smdb', fp: FIXTURE_FP, machine: 'm', repl: { user: 'replicator', password: 'p' }, app: { user: 'smdb', password: 'q' } };
  it.each([
    ['no prefix', 'postgresql://a@b/c', 'it does not start with smdbjoin1.'],
    ['not base64url', `${JOIN_CODE_PREFIX}abc+def`, 'it is damaged (it does not decode)'],
    ['not JSON', `${JOIN_CODE_PREFIX}${Buffer.from('nope').toString('base64url')}`, 'it is damaged (it does not decode)'],
    ['an array', b64([1]), 'it is damaged (it does not decode)'],
    ['v 2', b64({ ...good, v: 2 }), 'it names no valid version'],
    ['host with a comma', b64({ ...good, host: 'a,b' }), 'it names no valid host'],
    ['host starting with a dot', b64({ ...good, host: '.a' }), 'it names no valid host'],
    ['port 0', b64({ ...good, port: 0 }), 'it names no valid port'],
    ['port 65536', b64({ ...good, port: 65536 }), 'it names no valid port'],
    ['port as text', b64({ ...good, port: '15432' }), 'it names no valid port'],
    ['db with a slash', b64({ ...good, db: 'a/b' }), 'it names no valid database'],
    ['fp short', b64({ ...good, fp: 'abc' }), 'it names no valid fingerprint'],
    ['fp upper case', b64({ ...good, fp: FIXTURE_FP.toUpperCase() }), 'it names no valid fingerprint'],
    ['machine empty', b64({ ...good, machine: '' }), 'it names no valid machine'],
    ['machine 65 characters', b64({ ...good, machine: 'x'.repeat(65) }), 'it names no valid machine'],
    ['no replication login', b64({ ...good, repl: null }), 'it names no valid replication'],
    ['replication password with a space', b64({ ...good, repl: { user: 'r', password: 'a b' } }), 'it names no valid replication password'],
    ['replication user with a quote', b64({ ...good, repl: { user: "r'", password: 'p' } }), 'it names no valid replication user'],
    ['no database password', b64({ ...good, app: { user: 'smdb', password: '' } }), 'it names no valid database password'],
    ['over 4096 characters', `${JOIN_CODE_PREFIX}${'a'.repeat(4100)}`, 'it is longer than 4096 characters'],
  ])('refuses %s', (_name, text, why) => {
    expect(decodeJoinCode(text)).toEqual({ ok: false, why });
  });

  it('isJoinCode tells a code from a URL', () => {
    expect(isJoinCode(fakeJoinCode())).toBe(true);
    expect(isJoinCode(`  ${fakeJoinCode()}`)).toBe(true);
    expect(isJoinCode('postgresql://a:b@c:5432/d')).toBe(false);
    expect(isJoinCode('')).toBe(false);
    expect(isJoinCode(undefined)).toBe(false);
  });
});

describe('certificate fingerprint', () => {
  it('is the lowercase hex SHA-256 of the DER', () => {
    expect(certFingerprint(FIXTURE_PEM)).toBe(FIXTURE_FP);
    expect(certFingerprint(COPY_PEM)).toBe(COPY_FP);
  });
});

describe('the address list', () => {
  const app = { user: 'smdb', password: 'p,w%d' };
  const certDir = '/data/db-certs';

  it('puts the local copy first, the main second and the rest by host then port', () => {
    const list = addressList({
      app, db: 'smdb', certDir,
      local: { container: 'b-fleet-postgres-replica', host: 'copy.invalid', port: 15433 },
      main: { host: 'main.invalid', port: 15432, fp: FIXTURE_FP },
      others: [
        { host: 'z.invalid', port: 1, fp: COPY_FP },
        { host: 'a.invalid', port: 9, fp: COPY_FP },
        { host: 'a.invalid', port: 2, fp: COPY_FP },
        { host: 'main.invalid', port: 15432, fp: FIXTURE_FP },
        { host: 'copy.invalid', port: 15433, fp: COPY_FP },
      ],
    });
    expect(list).toEqual([
      'postgresql://smdb:p%2Cw%25d@b-fleet-postgres-replica:5432/smdb?sslmode=no-verify',
      `postgresql://smdb:p%2Cw%25d@main.invalid:15432/smdb?sslmode=verify-full&sslrootcert=/data/db-certs/${FIXTURE_FP.slice(0, 16)}.crt`,
      `postgresql://smdb:p%2Cw%25d@a.invalid:2/smdb?sslmode=verify-full&sslrootcert=/data/db-certs/${COPY_FP.slice(0, 16)}.crt`,
      `postgresql://smdb:p%2Cw%25d@a.invalid:9/smdb?sslmode=verify-full&sslrootcert=/data/db-certs/${COPY_FP.slice(0, 16)}.crt`,
      `postgresql://smdb:p%2Cw%25d@z.invalid:1/smdb?sslmode=verify-full&sslrootcert=/data/db-certs/${COPY_FP.slice(0, 16)}.crt`,
    ]);
  });

  it('names a main on this same manager by its container', () => {
    const list = addressList({ app, db: 'smdb', certDir, main: { host: 'main.invalid', port: 15432, fp: FIXTURE_FP, container: 'm-fleet-postgres' }, others: [] });
    expect(list).toEqual(['postgresql://smdb:p%2Cw%25d@m-fleet-postgres:5432/smdb?sslmode=no-verify']);
  });

  it('never holds a comma inside an entry, whatever the password (seeded)', () => {
    const r = lcg(7);
    for (let i = 0; i < 300; i++) {
      const pw = pick(r, ANY, 1, 30);
      const list = addressList({ app: { user: 'smdb', password: pw }, db: 'smdb', certDir, main: { host: 'main.invalid', port: 15432, fp: FIXTURE_FP }, others: [{ host: 'o.invalid', port: 2, fp: COPY_FP }] });
      expect(splitBackendUrls(formatBackendUrlList(list))).toEqual(list);
      for (const url of list) expect(decodeURIComponent(new URL(url).password)).toBe(pw);
    }
  });

  it('splits and tells a list apart', () => {
    expect(splitBackendUrls(' a , b ,, c ')).toEqual(['a', 'b', 'c']);
    expect(splitBackendUrls(undefined)).toEqual([]);
    expect(isBackendUrlList('a,b')).toBe(true);
    expect(isBackendUrlList('postgresql://a:b@c/d')).toBe(false);
  });
});

describe('LSN and SQL literals', () => {
  it('lsnToBigInt orders like the LSN (seeded) and reads back through lsnText', () => {
    const r = lcg(3);
    for (let i = 0; i < 300; i++) {
      const a = [Math.floor(r() * 0xffff), Math.floor(r() * 0xffffffff)];
      const b = [Math.floor(r() * 0xffff), Math.floor(r() * 0xffffffff)];
      const la = lsnToBigInt(`${a[0].toString(16)}/${a[1].toString(16)}`)!;
      const lb = lsnToBigInt(`${b[0].toString(16)}/${b[1].toString(16)}`)!;
      const cmp = a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1];
      expect(Math.sign(Number(la - lb))).toBe(Math.sign(cmp));
      expect(lsnToBigInt(lsnText(la))).toBe(la);
    }
    expect(lsnToBigInt('nonsense')).toBeNull();
    expect(lsnToBigInt('')).toBeNull();
  });

  it('sqlLiteral doubles quotes and refuses a NUL', () => {
    expect(sqlLiteral("it's")).toBe("'it''s'");
    expect(() => sqlLiteral('a\0b')).toThrow(/NUL/);
  });
});
