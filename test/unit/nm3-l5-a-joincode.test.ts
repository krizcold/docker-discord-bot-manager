import { describe, expect, it } from 'vitest';
import {
  CERT_PEM_RE, JOIN_CODE_PREFIX, addressList, decodeJoinCode, lsnText, lsnToBigInt, machineText,
} from '../../src/config/joinCode';
import { findAppCapabilities } from '../../src/config/appCapabilities';
import { dmOutcomeText } from '../../src/instance/backupFiles';

const FP = 'a'.repeat(64);
const base = () => ({
  v: 1, host: 'db.example', port: 5432, db: 'smdb', fp: FP, machine: 'home',
  repl: { user: 'repl', password: 'rp' }, app: { user: 'smdb', password: 'pw' },
});
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf-8').toString('base64url');
const raw = (value: unknown) => `${JOIN_CODE_PREFIX}${b64(value)}`;
const why = (text: string) => {
  const d = decodeJoinCode(text);
  return d.ok ? 'ok' : d.why;
};

describe('decodeJoinCode bounds and shapes', () => {
  it('refuses a fingerprint with a character before or after its 64 hex digits', () => {
    expect(why(raw({ ...base(), fp: `x${FP}` }))).toBe('it names no valid fingerprint');
    expect(why(raw({ ...base(), fp: `${FP}x` }))).toBe('it names no valid fingerprint');
    expect(why(raw(base()))).toBe('ok');
  });

  it('names the login itself when a login is not an object', () => {
    expect(why(raw({ ...base(), repl: 'text' }))).toBe('it names no valid replication');
  });

  it('takes a database password of 256 characters and refuses 257', () => {
    expect(why(raw({ ...base(), app: { user: 'smdb', password: 'p'.repeat(256) } }))).toBe('ok');
    expect(why(raw({ ...base(), app: { user: 'smdb', password: 'p'.repeat(257) } }))).toBe('it names no valid database password');
  });

  it('checks a code of exactly 4096 characters and refuses 4097 by length', () => {
    expect(why(`${JOIN_CODE_PREFIX}${'A'.repeat(4096 - JOIN_CODE_PREFIX.length)}`)).toBe('it is damaged (it does not decode)');
    expect(why(`${JOIN_CODE_PREFIX}${'A'.repeat(4097 - JOIN_CODE_PREFIX.length)}`)).toBe('it is longer than 4096 characters');
  });

  it('refuses a body with a character outside base64url before or after it', () => {
    const body = b64(base());
    expect(why(`${JOIN_CODE_PREFIX}!${body}`)).toBe('it is damaged (it does not decode)');
    expect(why(`${JOIN_CODE_PREFIX}${body}!`)).toBe('it is damaged (it does not decode)');
  });

  it('refuses a body that decodes to null or a number as damaged', () => {
    expect(why(`${JOIN_CODE_PREFIX}${b64(null)}`)).toBe('it is damaged (it does not decode)');
    expect(why(`${JOIN_CODE_PREFIX}${b64(5)}`)).toBe('it is damaged (it does not decode)');
  });

  it('takes a host of 253 characters and refuses 254', () => {
    expect(why(raw({ ...base(), host: 'h'.repeat(253) }))).toBe('ok');
    expect(why(raw({ ...base(), host: 'h'.repeat(254) }))).toBe('it names no valid host');
  });

  it('takes ports 1 and 65535', () => {
    expect(why(raw({ ...base(), port: 1 }))).toBe('ok');
    expect(why(raw({ ...base(), port: 65535 }))).toBe('ok');
    expect(why(raw({ ...base(), port: 0 }))).toBe('it names no valid port');
    expect(why(raw({ ...base(), port: 65536 }))).toBe('it names no valid port');
  });
});

describe('machineText', () => {
  it('keeps a valid name as it is, spaces included', () => {
    expect(machineText(' home pc ')).toBe(' home pc ');
  });

  it('drops non-printable characters, trims and keeps 64 characters', () => {
    expect(machineText('é pc ')).toBe('pc');
    expect(machineText(`é${'m'.repeat(70)}`)).toBe('m'.repeat(64));
  });

  it('names an all-unprintable name unnamed', () => {
    expect(machineText('éè')).toBe('unnamed');
  });
});

describe('addressList', () => {
  const app = { user: 'smdb', password: 'pw' };
  const input = (extra: Record<string, unknown>) => ({ app, db: 'smdb', certDir: '/data/db-certs', main: { host: 'main.example', port: 5432, fp: FP }, others: [], ...extra });
  const hosts = (urls: string[]) => urls.map(u => new URL(u).host);

  it('tells hosts apart that only an uppercase fold would merge', () => {
    const urls = addressList(input({ main: { host: 'SS', port: 5432, fp: FP }, others: [{ host: 'ß', port: 5432, fp: FP }] }));
    expect(urls).toHaveLength(2);
  });

  it('skips the main when it is the local container', () => {
    const urls = addressList(input({ local: { container: 'bot-pg' }, main: { host: 'bot-pg', port: 5432, fp: FP } }));
    expect(hosts(urls)).toEqual(['bot-pg:5432']);
  });

  it('skips an address that is the main container', () => {
    const urls = addressList(input({ main: { host: 'main.example', port: 5432, fp: FP, container: 'main-pg' }, others: [{ host: 'main-pg', port: 5432, fp: FP }] }));
    expect(hosts(urls)).toEqual(['main-pg:5432']);
  });

  it('orders the rest by host, then port, and lists each once', () => {
    const urls = addressList(input({
      others: [
        { host: 'c.example', port: 1, fp: FP }, { host: 'a.example', port: 1, fp: FP }, { host: 'b.example', port: 2, fp: FP },
        { host: 'd.example', port: 5432, fp: FP }, { host: 'd.example', port: 5433, fp: FP }, { host: 'd.example', port: 5432, fp: FP },
      ],
    }));
    expect(hosts(urls)).toEqual(['main.example:5432', 'a.example:1', 'b.example:2', 'c.example:1', 'd.example:5432', 'd.example:5433']);
  });

  it('orders a later host with a lower port after an earlier host', () => {
    for (const others of [[{ host: 'b.example', port: 1, fp: FP }, { host: 'a.example', port: 2, fp: FP }], [{ host: 'a.example', port: 2, fp: FP }, { host: 'b.example', port: 1, fp: FP }]]) {
      expect(hosts(addressList(input({ others })))).toEqual(['main.example:5432', 'a.example:2', 'b.example:1']);
    }
  });

  it('orders one host by port whichever comes first', () => {
    for (const ports of [[5432, 5433], [5433, 5432]]) {
      const urls = addressList(input({ others: ports.map(port => ({ host: 'd.example', port, fp: FP })) }));
      expect(hosts(urls)).toEqual(['main.example:5432', 'd.example:5432', 'd.example:5433']);
    }
  });
});

describe('LSN text', () => {
  it('reads only a whole LSN, spaces around it trimmed', () => {
    expect(lsnToBigInt(' 16/B3 ')).toBe((0x16n << 32n) + 0xb3n);
    expect(lsnToBigInt('x16/B3')).toBeNull();
    expect(lsnToBigInt('16/B3x')).toBeNull();
  });

  it('writes an LSN in uppercase hex', () => {
    expect(lsnText((0xabn << 32n) + 0xcdn)).toBe('AB/CD');
  });
});

describe('CERT_PEM_RE', () => {
  const pem = '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----';
  it('matches only a whole certificate block', () => {
    expect(CERT_PEM_RE.test(pem)).toBe(true);
    expect(CERT_PEM_RE.test(`x${pem}`)).toBe(false);
    expect(CERT_PEM_RE.test(`${pem}x`)).toBe(false);
  });
});

describe('the bot manifest', () => {
  const manifest = findAppCapabilities('https://github.com/krizcold/fully-modular-discord-bot')!;
  it('lists its wizard fields', () => {
    expect(manifest.wizardFields?.map(f => f.key)).toEqual(['FLEET_SHARD_COUNT', 'FLEET_SHARD_CAPACITY', 'PIN_TEST_GUILD_SHARD', 'NODE_NAME', 'DATA_BACKEND', 'DATA_BACKEND_URL']);
  });
  it('describes the database URL field', () => {
    expect(manifest.wizardFields?.find(f => f.key === 'DATA_BACKEND_URL')?.description).toBe(
      "Blank makes a managed Postgres on this server, which becomes the main database. To use another machine's database, paste the join code from that machine's manager. A postgresql:// URL uses an external database.");
  });
  it('names /data as the folder the bot sees its data in', () => {
    expect(manifest.companionDb?.appDataPath).toBe('/data');
  });
});

describe('dmOutcomeText', () => {
  it('says the app has no hook when the DM is unsupported', () => {
    expect(dmOutcomeText({ dm: 'unsupported' })).toBe('The owner could not be messaged: this app has no notify-owner hook.');
  });
  it('names a failure that carries no error', () => {
    expect(dmOutcomeText({ dm: 'failed' })).toBe('The owner could not be messaged: notify-owner failed.');
  });
});
