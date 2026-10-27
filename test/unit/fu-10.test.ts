import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vm from 'vm';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'fu-10-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  const KEY = '-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgtM9o4pDpv0Cozikt\n4uwMJM46EUEJfbQjdtA2ByXUiKmhRANCAASCO4i47sdvseuYxeVB4O0rlxjNcVMU\n+oDBbAmwCX/c8cCbXLEKcl+wkz1IYT34cczAPZABg6O0Az0dRZ6eF3hp\n-----END PRIVATE KEY-----\n';
  const CERT = '-----BEGIN CERTIFICATE-----\nMIIBmTCCAT6gAwIBAgIUDgY+bMG7vClw3xqVXtdber+h0UswCgYIKoZIzj0EAwIw\nFTETMBEGA1UEAwwKcmVsYXkudGVzdDAgFw0yNjEwMjQxOTU2NTNaGA8yMTI2MDkz\nMDE5NTY1M1owFTETMBEGA1UEAwwKcmVsYXkudGVzdDBZMBMGByqGSM49AgEGCCqG\nSM49AwEHA0IABII7iLjux2+x65jF5UHg7SuXGM1xUxT6gMFsCbAJf9zxwJtcsQpy\nX7CTPUhhPfhxzMA9kAGDo7QDPR1Fnp4XeGmjajBoMB0GA1UdDgQWBBQqYKbJkFWh\nxPOcT7Q49mMc8zDPvjAfBgNVHSMEGDAWgBQqYKbJkFWhxPOcT7Q49mMc8zDPvjAP\nBgNVHRMBAf8EBTADAQH/MBUGA1UdEQQOMAyCCnJlbGF5LnRlc3QwCgYIKoZIzj0E\nAwIDSQAwRgIhAPguVl9lDTbwuZR4c91bTG90pN57G5fKrqNVJt6cb1HKAiEA/AUV\nrXUvU3u3dD9I72F/lLjbLGmWaqohTGadeXPYkCk=\n-----END CERTIFICATE-----\n';
  return {
    dir, KEY, CERT,
    calls: [] as Array<{ args: string[]; stdin: string }>,
    plainClients: '',
    dumpStderr: '',
  };
});

// A fake docker and openssl: the non-TLS client read answers h.plainClients, pg_dump fails with h.dumpStderr,
// every other statement succeeds with no rows.
vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const { EventEmitter } = await import('events');
  const { PassThrough } = await import('stream');
  const nodeFs = await import('fs');
  const execFile = (cmd: string, args: string[], opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    setTimeout(() => {
      if (cmd === 'openssl') {
        nodeFs.writeFileSync(args[args.indexOf('-keyout') + 1], h.KEY);
        nodeFs.writeFileSync(args[args.indexOf('-out') + 1], h.CERT);
        return done(null, '', '');
      }
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
    const text = args.join(' ');
    setTimeout(() => {
      const dump = text.includes('pg_dump');
      const out = text.includes('pg_stat_ssl') ? `${h.plainClients}\n`
        : text.includes('pg_read_file') || text.includes('FROM pg_roles') ? '0\n'
        : '';
      child.stdout.end(dump ? '' : out);
      child.stderr.end(dump ? h.dumpStderr : '');
      setTimeout(() => child.emit('close', dump ? 1 : 0), 1);
    }, 2);
    return child;
  };
  const fencedExecFile = (await import('./fence-fake')).withFence(execFile as any);
  const heldSpawn = (await import('./dump-fake')).withDumpHolder(spawn as any);
  return { ...real, execFile: fencedExecFile, spawn: heldSpawn, default: { ...real, execFile: fencedExecFile, spawn: heldSpawn } };
});

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';
import * as envManager from '../../src/env/manager';
import * as fleetBackup from '../../src/instance/fleetBackup';
const backupError = (fb: typeof import('../../src/instance/fleetBackup'), id: string): string | null =>
  fb.fleetBackupStatus(JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR as string, 'instances.json'), 'utf-8')).instances[id]).main?.lastError ?? null;

import * as fleetReplication from '../../src/instance/fleetReplication';
import { publishHostPort } from '../../src/templates/pcsProcessing';

const botDir = path.join(h.dir, 'bots', 'b1');
const DB_SECRET = 'Db-Secret-0123456789';
const REPL_SECRET = 'Repl-Secret-0123456789';
const dbUrl = `postgresql://smdb:${DB_SECRET}@bot1-fleet-postgres:5432/smdb`;
const fleetDb = { containerName: 'bot1-fleet-postgres', user: 'smdb', db: 'smdb', volume: 'bot1-fleet-postgres-data' };
const replication = { role: 'replicator', password: REPL_SECRET, hostPort: 15432, publicHost: 'primary.invalid', certHost: 'primary.invalid', slotWalKeepMb: 4096 };

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
const hbaWrites = () => h.calls.filter(c => c.args.join(' ').includes('pg_hba.conf'));

beforeEach(() => {
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
  fs.mkdirSync(path.join(botDir, 'env'), { recursive: true });
  writeRegistry();
  envManager.setEnvVars('b1', { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: dbUrl });
  h.calls.length = 0;
  h.plainClients = '';
  h.dumpStderr = '';
});

afterAll(() => {
  fs.rmSync(h.dir, { recursive: true, force: true });
});

describe('B19-1h: a Disable keeps the non-TLS lines an Enable kept where the next start can narrow them', () => {
  it('moves keptPlain to the database record and says how many addresses stay', async () => {
    writeRegistry({ fleetDb: { ...fleetDb, replication: { ...replication, keptPlain: ['10.5.0.7'] } } });
    const res = await fleetReplication.disableFleetReplication(bot());
    expect(res.success).toBe(true);
    expect(bot().fleetDb!.replication).toBeUndefined();
    expect(bot().fleetDb!.keptPlain).toEqual(['10.5.0.7']);
    expect(res.plainClientsKept).toBe(1);
    expect(hbaWrites()).toEqual([]);
  });

  it('records nothing kept when the Enable kept no line', async () => {
    writeRegistry({ fleetDb: { ...fleetDb, replication } });
    const res = await fleetReplication.disableFleetReplication(bot());
    expect(res.success).toBe(true);
    expect(bot().fleetDb!.keptPlain).toBeUndefined();
    expect(res.plainClientsKept).toBeUndefined();
  });

  it('narrows the lines at the next start once no kept client connects without TLS', async () => {
    writeRegistry({ fleetDb: { ...fleetDb, keptPlain: ['10.5.0.7'] } });
    const warning = await fleetReplication.narrowKeptPlainHba('b1');
    expect(warning).toBeNull();
    expect(hbaWrites()[0].stdin).toBe(fleetReplication.pgHbaContent());
    expect(bot().fleetDb!.keptPlain).toBeUndefined();
    expect(bot().fleetDb!.replication).toBeUndefined();
  });

  it('keeps a line while its client still connects without TLS', async () => {
    writeRegistry({ fleetDb: { ...fleetDb, keptPlain: ['10.5.0.7', '10.5.0.8'] } });
    h.plainClients = '10.5.0.7';
    const warning = await fleetReplication.narrowKeptPlainHba('b1');
    expect(warning).toMatch(/still connect to the database without TLS/);
    expect(hbaWrites()[0].stdin).toMatch(/^host +all +all +10\.5\.0\.7\/32 +scram-sha-256$/m);
    expect(hbaWrites()[0].stdin).not.toMatch(/10\.5\.0\.8/);
    expect(bot().fleetDb!.keptPlain).toEqual(['10.5.0.7']);
  });

  it('a re-Enable carries the kept addresses into the posture and leaves none on the database record', async () => {
    writeRegistry({ fleetDb: { ...fleetDb, keptPlain: ['10.5.0.7'] } });
    const res = await fleetReplication.enableFleetReplication(bot(), 'primary.invalid', 15432, undefined);
    expect(res.success).toBe(true);
    expect(hbaWrites()[0].stdin).toMatch(/^host +all +all +10\.5\.0\.7\/32 +scram-sha-256$/m);
    expect(bot().fleetDb!.replication!.keptPlain).toEqual(['10.5.0.7']);
    expect(bot().fleetDb!.keptPlain).toBeUndefined();
  });

  it('the Disable toast says the kept addresses still connect without TLS until a start', async () => {
    const page = fs.readFileSync(path.resolve(__dirname, '../../src/webui/public/index.html'), 'utf8');
    const start = page.indexOf('async function disableFleetReplication(');
    const source = page.slice(start, page.indexOf('\n    }\n', start) + 6);
    const messages: string[][] = [];
    const ctx = vm.createContext({
      confirm: () => true, document: { getElementById: () => null },
      api: async () => ({ success: true, restartRequired: true, plainClientsKept: 1 }),
      showMessage: (t: string, m: string) => messages.push([t, m]),
      showNoAnswer: () => {}, renderFleetReplication: () => {}, loadBots: () => {},
    });
    vm.runInContext(source, ctx);
    await ctx.disableFleetReplication('b1');
    expect(messages[0][0]).toBe('success');
    expect(messages[0][1]).toMatch(/keeps admitting connections without TLS from 1 address\(es\).*until a start finds none of them/);
  });
});

describe('B06-1b: a dump error shown on the card carries no secret', () => {
  const scheduledDump = async (): Promise<void> => {
    let tick: () => void = () => {};
    const spy = vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void) => { tick = fn; return 0; }) as unknown as typeof setInterval);
    fleetBackup.startFleetBackupScheduler();
    spy.mockRestore();
    fleetBackup.stopFleetBackupScheduler();
    tick();
    await vi.waitFor(() => expect(backupError(fleetBackup, 'b1')).not.toBeNull());
  };

  it('hides the database and replication passwords that pg_dump quoted', async () => {
    writeRegistry({
      fleetDb: { ...fleetDb, replication },
      fleetBackup: { enabled: true, hour: new Date().getHours(), keep: 3 },
    });
    h.dumpStderr = `pg_dump: error: connection to "${dbUrl}" failed; password ${REPL_SECRET} rejected\n`;
    await scheduledDump();
    const text = backupError(fleetBackup, 'b1')!;
    expect(text).toContain('pg_dump exited with code 1');
    expect(text).not.toContain(DB_SECRET);
    expect(text).not.toContain(REPL_SECRET);
    expect(text).toContain('***');
  });
});

describe('B26-3d: an off-loopback bind beside a domain base says Authelia does not cover the port', () => {
  const env = { bind: process.env.BOT_PORT_BIND, base: process.env.BOT_DOMAIN_BASE };
  afterEach(() => {
    if (env.bind === undefined) delete process.env.BOT_PORT_BIND; else process.env.BOT_PORT_BIND = env.bind;
    if (env.base === undefined) delete process.env.BOT_DOMAIN_BASE; else process.env.BOT_DOMAIN_BASE = env.base;
    vi.restoreAllMocks();
  });
  const compose = 'services:\n  app:\n    image: example/app\n';

  it('publishes the port and the warning names the uncovered port', () => {
    process.env.BOT_PORT_BIND = '0.0.0.0';
    process.env.BOT_DOMAIN_BASE = 'dbot.example.invalid';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = publishHostPort(compose, 18080, 3000);
    expect(out).toContain('18080:3000');
    expect(warn.mock.calls.map(c => String(c[0])).join('\n')).toMatch(/Authelia login .* does not cover this port/);
  });

  it('says nothing of Authelia without a domain base', () => {
    process.env.BOT_PORT_BIND = '0.0.0.0';
    delete process.env.BOT_DOMAIN_BASE;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    publishHostPort(compose, 18080, 3000);
    const text = warn.mock.calls.map(c => String(c[0])).join('\n');
    expect(text).toContain('reachable from other hosts');
    expect(text).not.toContain('Authelia');
  });

  const page = fs.readFileSync(path.resolve(__dirname, '../../src/webui/public/index.html'), 'utf8');
  const fnStart = page.indexOf('function openButtonTitle(');
  const fnSource = fnStart < 0 ? '' : page.slice(fnStart, page.indexOf('\n    }\n', fnStart) + 6);
  const title = (portBind: unknown, hostPort: number | null, viaPublicUrl: boolean): string =>
    vm.runInNewContext(`${fnSource}\nopenButtonTitle(bot, viaPublicUrl)`, { portBind, bot: { hostPort }, viaPublicUrl });

  it('the Open title over the HTTPS address names the port Authelia does not cover', () => {
    const text = title({ bind: '0.0.0.0', loopback: false }, 18080, true);
    expect(text).toContain('18080');
    expect(text).toContain('0.0.0.0');
    expect(text).toMatch(/Authelia login does not cover it/);
  });

  it('the disabled Open title never claims a 127.0.0.1 bind on an off-loopback bind', () => {
    const text = title({ bind: '0.0.0.0', loopback: false }, 18080, false);
    expect(text).not.toContain('127.0.0.1');
    expect(text).not.toMatch(/only reachable from the server itself/);
    expect(title({ bind: '127.0.0.1', loopback: true }, 18080, false)).toMatch(/BOT_PORT_BIND is 127\.0\.0\.1 publish their web UI port only on the server itself/);
    expect(title({ bind: '127.0.0.1', loopback: true }, 18080, true)).toBe("Open the bot's web UI");
  });

  it('the Open titles state the bind per deploy, never as this bot\'s bind', () => {
    const loop = title({ bind: '127.0.0.1', loopback: true }, 18080, false);
    expect(loop).not.toMatch(/web UI port is bound to/);
    expect(loop).toMatch(/deployed while BOT_PORT_BIND is 127\.0\.0\.1/);
    expect(loop).toMatch(/deployed under another bind keeps it until it is rebuilt/);
    for (const viaPublicUrl of [true, false]) {
      const off = title({ bind: '0.0.0.0', loopback: false }, 18080, viaPublicUrl);
      expect(off).not.toMatch(/this one: 18080\) on that address/);
      expect(off).toMatch(/deployed under another bind keeps it until it is rebuilt/);
    }
  });

  it('both Open buttons take their title from it', () => {
    expect(page.match(/title="\$\{escapeHtml\(openButtonTitle\(bot, (true|false)\)\)\}">Open</g)?.length).toBe(2);
  });
});
