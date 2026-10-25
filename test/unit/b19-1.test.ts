import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'b19-1-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  const KEY = '-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgtM9o4pDpv0Cozikt\n4uwMJM46EUEJfbQjdtA2ByXUiKmhRANCAASCO4i47sdvseuYxeVB4O0rlxjNcVMU\n+oDBbAmwCX/c8cCbXLEKcl+wkz1IYT34cczAPZABg6O0Az0dRZ6eF3hp\n-----END PRIVATE KEY-----\n';
  const CERT = '-----BEGIN CERTIFICATE-----\nMIIBmTCCAT6gAwIBAgIUDgY+bMG7vClw3xqVXtdber+h0UswCgYIKoZIzj0EAwIw\nFTETMBEGA1UEAwwKcmVsYXkudGVzdDAgFw0yNjEwMjQxOTU2NTNaGA8yMTI2MDkz\nMDE5NTY1M1owFTETMBEGA1UEAwwKcmVsYXkudGVzdDBZMBMGByqGSM49AgEGCCqG\nSM49AwEHA0IABII7iLjux2+x65jF5UHg7SuXGM1xUxT6gMFsCbAJf9zxwJtcsQpy\nX7CTPUhhPfhxzMA9kAGDo7QDPR1Fnp4XeGmjajBoMB0GA1UdDgQWBBQqYKbJkFWh\nxPOcT7Q49mMc8zDPvjAfBgNVHSMEGDAWgBQqYKbJkFWhxPOcT7Q49mMc8zDPvjAP\nBgNVHRMBAf8EBTADAQH/MBUGA1UdEQQOMAyCCnJlbGF5LnRlc3QwCgYIKoZIzj0E\nAwIDSQAwRgIhAPguVl9lDTbwuZR4c91bTG90pN57G5fKrqNVJt6cb1HKAiEA/AUV\nrXUvU3u3dD9I72F/lLjbLGmWaqohTGadeXPYkCk=\n-----END CERTIFICATE-----\n';
  return {
    dir, KEY, CERT,
    calls: [] as Array<{ args: string[]; stdin: string }>,
    certPresent: true,
    plainClients: '',
    projectContainers: '',
    containerAddrs: '',
    senders: '',
    failWhen: null as null | RegExp,
    onRun: null as null | ((text: string) => void),
    gate: null as null | Promise<void>,
  };
});

// A fake docker and openssl. openssl writes a real matching pair; `test -f`
// on the server certificate answers h.certPresent; the non-TLS client read
// answers h.plainClients and the walsender read h.senders; a run matching
// h.failWhen fails; h.gate holds the WAL-bound statement until it resolves.
vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const { EventEmitter } = await import('events');
  const { PassThrough } = await import('stream');
  const nodeFs = await import('fs');
  const answer = (text: string): { out: string; code: number } => {
    if (/^test -f \S*server\.crt$/.test(text)) return { out: '', code: h.certPresent ? 0 : 1 };
    if (text.includes('pg_stat_ssl')) return { out: `${h.plainClients}\n`, code: 0 };
    if (text.includes('FROM pg_stat_replication WHERE usename')) return { out: `${h.senders}\n`, code: 0 };
    if (text.includes('FROM pg_roles')) return { out: '0\n', code: 0 };
    return { out: '', code: 0 };
  };
  const execFile = (cmd: string, args: string[], opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    setTimeout(() => {
      if (cmd === 'openssl') {
        nodeFs.writeFileSync(args[args.indexOf('-keyout') + 1], h.KEY);
        nodeFs.writeFileSync(args[args.indexOf('-out') + 1], h.CERT);
        return done(null, '', '');
      }
      if (h.failWhen && h.failWhen.test(args.join(' '))) return done(new Error('fake failure'), '', 'fake failure\n');
      if (args[0] === 'ps') return done(null, h.projectContainers, '');
      if (args[0] === 'inspect' && args.join(' ').includes('IPAddress')) return done(null, h.containerAddrs, '');
      if (args[0] === 'inspect') return done(null, 'true\n', '');
      done(null, '', '');
    }, 1);
    return new EventEmitter();
  };
  const spawn = (_cmd: string, args: string[]) => {
    const call = { args: args.slice(1), stdin: '' };
    h.calls.push(call);
    const child: any = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.stdin.on('data', (d: Buffer) => { call.stdin += d.toString(); });
    child.kill = () => {};
    const text = args.slice(args.indexOf('-i') === 1 ? 3 : 2).join(' ');
    setTimeout(async () => {
      if (h.gate && text.includes('max_slot_wal_keep_size')) await h.gate;
      if (h.onRun) h.onRun(text);
      const fail = !!h.failWhen && h.failWhen.test(text);
      const { out, code } = fail ? { out: '', code: 1 } : text.includes('pg_read_file') ? { out: '0\n', code: 0 } : answer(text);
      child.stdout.end(out);
      child.stderr.end(fail ? 'fake failure\n' : '');
      setTimeout(() => child.emit('close', code), 1);
    }, 2);
    return child;
  };
  const fencedExecFile = (await import('./fence-fake')).withFence(execFile as any);
  return { ...real, execFile: fencedExecFile, spawn, default: { ...real, execFile: fencedExecFile, spawn } };
});

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';
import * as envManager from '../../src/env/manager';
import * as fleetBackupGuards from '../../src/instance/fleetBackupGuards';
import * as fleetReplication from '../../src/instance/fleetReplication';
import { enableFleetReplication, disableFleetReplication } from '../../src/instance/fleetReplication';

const botDir = path.join(h.dir, 'bots', 'b1');
const dbUrl = 'postgresql://smdb:Db-Secret-0123456789@bot1-fleet-postgres:5432/smdb';
const fleetDb = { containerName: 'bot1-fleet-postgres', user: 'smdb', db: 'smdb', volume: 'bot1-fleet-postgres-data' };
const replication = { role: 'replicator', password: 'Repl-Secret-0123456789', hostPort: 15432, publicHost: 'primary.invalid', certHost: 'primary.invalid', slotWalKeepMb: 4096 };

const writeRegistry = (extra: Record<string, unknown> = {}): void => {
  fs.writeFileSync(path.join(h.dir, 'instances.json'), JSON.stringify({
    instances: {
      b1: {
        id: 'b1', sanitizedName: 'bot1', displayName: 'Bot 1', titleName: 'Bot 1', status: 'running',
        sourceType: 'git', sourceUrl: 'https://example.invalid/fake/super-modular-discord-bot',
        envVars: { DATA_BACKEND: 'postgres' },
        fleetDb,
        createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z',
        ...extra,
      },
    },
  }));
};

const bot = () => containerManager.getBot('b1')!;
const enable = (opts?: { rotateCert?: boolean }) => enableFleetReplication(bot(), 'primary.invalid', 15432, undefined, opts);
const ran = (re: RegExp) => h.calls.filter(c => re.test(`${c.args.join(' ')}\n${c.stdin}`));
const hbaWrites = () => h.calls.filter(c => c.args.join(' ').includes('pg_hba.conf'));

beforeEach(() => {
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
  fs.mkdirSync(path.join(botDir, 'env'), { recursive: true });
  writeRegistry();
  envManager.setEnvVars('b1', { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: dbUrl });
  h.calls.length = 0;
  h.certPresent = true;
  h.plainClients = '';
  h.projectContainers = '';
  h.containerAddrs = '';
  h.senders = '';
  h.failWhen = null;
  h.onRun = null;
  h.gate = null;
});

afterAll(() => {
  fs.rmSync(h.dir, { recursive: true, force: true });
});

describe('the replication lane is serialized per instance', () => {
  it('refuses a second Enable while the first runs, and the first still finishes', async () => {
    let open!: () => void;
    h.gate = new Promise<void>(r => { open = r; });
    const first = enable();
    await new Promise(r => setTimeout(r, 30));
    const second = await enable();
    open();
    const firstRes = await first;
    expect(second.success).toBe(false);
    expect(second.error).toMatch(/Enable is refused until it finishes \(nothing was changed\)/);
    expect(firstRes.success).toBe(true);
    expect(ran(/ROLE replicator/).length).toBe(1);
  });

  it('refuses Enable while another lane holds the instance (a seed, a start)', async () => {
    let release!: () => void;
    const held = containerManager.withExternalBotOp('b1', 'replica-seed', () => new Promise<void>(r => { release = r; }));
    const res = await enable();
    release();
    await held;
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/replica-seed/);
    expect(h.calls).toEqual([]);
  });

  it('refuses Enable and Disable while a backup or restore holds the busy slot', async () => {
    expect(fleetBackupGuards.claimFleetBackupBusy('b1')).toBe(true);
    try {
      const res = await enable();
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/backup, restore/);
      writeRegistry({ fleetDb: { ...fleetDb, replication } });
      const off = await disableFleetReplication(bot());
      expect(off.success).toBe(false);
      expect(h.calls).toEqual([]);
    } finally {
      fleetBackupGuards.releaseFleetBackupBusy('b1');
    }
  });
});

describe('the recovery lanes keep their replication login', () => {
  it('refuses an Enable that would mint a credential while a recovery channel is armed', async () => {
    writeRegistry({ recoveryChannel: { mode: 'source', containerName: 'bot1-recovery', token: 't', createdAt: 1 } });
    const res = await enable();
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/recovery channel is armed/);
    expect(ran(/ROLE replicator/)).toEqual([]);
  });

  it('refuses Disable while a rescue record exists', async () => {
    writeRegistry({ fleetDb: { ...fleetDb, replication }, recoveryRescue: { phase: 'catchup', startedAt: 1 } });
    const res = await disableFleetReplication(bot());
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/recovery rescue is recorded/);
    expect(ran(/NOLOGIN/)).toEqual([]);
    expect(bot().fleetDb!.replication).toBeDefined();
  });
});

describe('Disable counts every walsender of the replication role', () => {
  it('refuses while a replication connection holds no active slot', async () => {
    writeRegistry({ fleetDb: { ...fleetDb, replication } });
    h.senders = '10.0.0.9';
    const res = await disableFleetReplication(bot());
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/10\.0\.0\.9/);
    expect(res.error).toMatch(/nothing was disabled/);
    expect(ran(/NOLOGIN/)).toEqual([]);
    expect(bot().fleetDb!.replication!.disablingSince).toBeUndefined();
  });
});

describe('the server certificate pair', () => {
  it('writes both files under .new names and renames them only once both are written', async () => {
    const res = await enable({ rotateCert: true });
    expect(res.success).toBe(true);
    const writes = ran(/cat > \S*server\.(key|crt)/);
    expect(writes.map(c => /cat > (\S+)/.exec(c.args.join(' '))![1])).toEqual([
      '/var/lib/postgresql/data/server.key.new', '/var/lib/postgresql/data/server.crt.new',
    ]);
    expect(ran(/mv -f \S*server\.key\.new \S*server\.key && mv -f \S*server\.crt\.new/).length).toBe(1);
  });

  it('leaves the installed pair alone and runs no reload when the certificate write fails', async () => {
    h.failWhen = /server\.crt\.new/;
    const res = await enable({ rotateCert: true });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/installed pair was not changed/);
    expect(ran(/mv -f/)).toEqual([]);
    expect(ran(/pg_reload_conf/)).toEqual([]);
    expect(ran(/cat > \S*server\.key( |$)/)).toEqual([]);
  });

  it('regenerates when an earlier install stopped between the renames', async () => {
    writeRegistry({ fleetDb: { ...fleetDb, replication } });
    h.failWhen = /test ! -e/;
    const res = await enable();
    expect(res.success).toBe(true);
    expect(res.certRotated).toBe(true);
    expect(ran(/cat > \S*server\.crt\.new/).length).toBe(1);
  });
});

describe('certRotated says whether a pair was installed over an existing one', () => {
  it('is true on a re-enable after a Disable, where the old cert stays on disk', async () => {
    const res = await enable();
    expect(res.success).toBe(true);
    expect(res.certRotated).toBe(true);
  });

  it('is true on rotateCert with an unchanged host', async () => {
    writeRegistry({ fleetDb: { ...fleetDb, replication } });
    const res = await enable({ rotateCert: true });
    expect(res.certRotated).toBe(true);
  });

  it('is false on a first enable with no certificate on disk', async () => {
    h.certPresent = false;
    const res = await enable();
    expect(res.success).toBe(true);
    expect(res.certRotated).toBe(false);
  });

  it('is false on a re-enable that keeps the pair', async () => {
    writeRegistry({ fleetDb: { ...fleetDb, replication } });
    const res = await enable();
    expect(res.success).toBe(true);
    expect(res.certRotated).toBe(false);
    expect(ran(/cat > \S*server\./)).toEqual([]);
  });

  it('is reported on a failure after the new pair was installed', async () => {
    h.failWhen = /ALTER SYSTEM SET ssl/;
    const res = await enable();
    expect(res.success).toBe(false);
    expect(res.certRotated).toBe(true);
    expect(res.error).toMatch(/new server certificate is already installed/);
  });
});

describe('a running bot on its old URL keeps reaching its database', () => {
  it('keeps a non-TLS line for a client outside 172.16/12 and records it', async () => {
    h.plainClients = '10.5.0.7 172.18.0.3 127.0.0.1';
    const res = await enable();
    expect(res.success).toBe(true);
    expect(res.plainClientsKept).toBe(1);
    const hba = hbaWrites()[0].stdin;
    expect(hba).toMatch(/^host +all +all +10\.5\.0\.7\/32 +scram-sha-256$/m);
    expect(hba).not.toMatch(/172\.18\.0\.3/);
    expect(hba.indexOf('10.5.0.7')).toBeLessThan(hba.indexOf('hostssl'));
    expect(bot().fleetDb!.replication!.keptPlain).toEqual(['10.5.0.7']);
  });

  it('keeps a recorded line on a re-Enable while the bot holds no connection', async () => {
    writeRegistry({ fleetDb: { ...fleetDb, replication: { ...replication, keptPlain: ['10.5.0.7'] } } });
    const res = await enable();
    expect(res.success).toBe(true);
    expect(res.plainClientsKept).toBe(1);
    expect(hbaWrites()[0].stdin).toMatch(/^host +all +all +10\.5\.0\.7\/32 +scram-sha-256$/m);
    expect(bot().fleetDb!.replication!.keptPlain).toEqual(['10.5.0.7']);
  });

  it('keeps a line for the instance\'s own container on a first Enable while the bot holds no connection', async () => {
    h.projectContainers = 'c1\nc2\n';
    h.containerAddrs = '/bot1 10.5.0.8  \n/bot1-fleet-postgres 10.5.0.2  \n';
    const res = await enable();
    expect(res.success).toBe(true);
    expect(res.plainClientsKept).toBe(1);
    const hba = hbaWrites()[0].stdin;
    expect(hba).toMatch(/^host +all +all +10\.5\.0\.8\/32 +scram-sha-256$/m);
    expect(hba).not.toMatch(/10\.5\.0\.2/);
    expect(bot().fleetDb!.replication!.keptPlain).toEqual(['10.5.0.8']);
  });

  it('refuses a first Enable, changing nothing, when docker cannot say the containers\' addresses', async () => {
    h.projectContainers = 'c1\n';
    h.failWhen = /IPAddress/;
    const res = await enable();
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/nothing was changed/);
    expect(hbaWrites()).toEqual([]);
    expect(ran(/ROLE replicator/)).toEqual([]);
  });

  it('writes the narrowed pg_hba when no client is outside the pool', async () => {
    h.plainClients = '172.20.0.5';
    const res = await enable();
    expect(res.plainClientsKept).toBeUndefined();
    expect(hbaWrites()[0].stdin).toBe(fleetReplication.pgHbaContent());
    expect(bot().fleetDb!.replication!.keptPlain).toBeUndefined();
  });

  it('narrows at the next start once the kept client no longer connects without TLS', async () => {
    writeRegistry({ fleetDb: { ...fleetDb, replication: { ...replication, keptPlain: ['10.5.0.7'] } } });
    const warning = await fleetReplication.narrowKeptPlainHba('b1');
    expect(warning).toBeNull();
    expect(hbaWrites()[0].stdin).toBe(fleetReplication.pgHbaContent());
    expect(ran(/pg_reload_conf/).length).toBe(1);
    expect(bot().fleetDb!.replication!.keptPlain).toBeUndefined();
    expect(bot().fleetDb!.replication!.password).toBe(replication.password);
  });

  it('keeps the line and says so while the client still connects without TLS', async () => {
    writeRegistry({ fleetDb: { ...fleetDb, replication: { ...replication, keptPlain: ['10.5.0.7'] } } });
    h.plainClients = '10.5.0.7';
    const warning = await fleetReplication.narrowKeptPlainHba('b1');
    expect(warning).toMatch(/still connect to the database without TLS/);
    expect(hbaWrites()[0].stdin).toMatch(/10\.5\.0\.7\/32/);
    expect(bot().fleetDb!.replication!.keptPlain).toEqual(['10.5.0.7']);
  });

  it('never adds a non-TLS line for an address Enable did not keep', async () => {
    writeRegistry({ fleetDb: { ...fleetDb, replication: { ...replication, keptPlain: ['10.5.0.7'] } } });
    h.plainClients = '10.9.9.9';
    const warning = await fleetReplication.narrowKeptPlainHba('b1');
    expect(warning).toBeNull();
    expect(hbaWrites()[0].stdin).toBe(fleetReplication.pgHbaContent());
  });
});

describe('Enable re-reads the record before writing it', () => {
  it('refuses to write when another request changed the record while it ran', async () => {
    h.onRun = (text) => {
      if (text.includes('ALTER SYSTEM SET ssl')) containerManager.updateInstanceFleetDbReplication('b1', { ...replication, publicHost: 'other.invalid' });
    };
    const res = await enable();
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/record changed while this Enable ran/);
    expect(bot().fleetDb!.replication!.publicHost).toBe('other.invalid');
    expect(envManager.getEnvVars('b1').DATA_BACKEND_URL).toBe(dbUrl);
  });
});
