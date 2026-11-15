import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm22-sites-delete-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return {
    dir, events: [] as string[],
    cert: { ok: true, pem: 'PEM' } as { ok: true; pem: string } | { ok: false; kind: 'unreachable'; reason: string; text: string },
    del: null as string | null,
  };
});

const fail = (stderr: string): Error => Object.assign(new Error(stderr), { stderr });
const answer = (args: string[]): string => {
  const line = args.join(' ');
  if (line.startsWith('image inspect')) throw fail('Error: No such image: x');
  if (line.startsWith('volume inspect')) throw fail('Error: No such volume: x');
  if (line.startsWith('volume rm')) throw fail('Error: No such volume: x');
  return '';
};

// No row reaches docker: every docker CLI call is answered here, and the calls to the main go through the fleetJoin fakes.
vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const execFileSync = (_f: string, args: string[]) => answer(args);
  const execFile = (_f: string, args: string[], opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    try { done(null, { stdout: answer(args), stderr: '' }); } catch (e) { done(e); }
  };
  const exec = (cmd: string, opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    if (cmd.startsWith('docker inspect')) done(new Error('Error: No such object'));
    else if (cmd.startsWith('docker rm')) done(new Error('Error: No such container'));
    else done(null, { stdout: '', stderr: '' });
  };
  const spawn = () => { throw new Error('no row spawns a process'); };
  const mod = { ...real, exec, execFile, execFileSync, execSync: () => '', spawn };
  return { ...mod, default: mod };
});
vi.mock('../../src/casaos/detector', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/casaos/detector')>()),
  getDeploymentMode: async () => 'docker',
}));
vi.mock('../../src/docker/dockerClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/docker/dockerClient')>()),
  listBotContainers: async () => [],
}));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));
vi.mock('../../src/instance/fleetReplica', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/fleetReplica')>()),
  instanceRemovalRefusal: async () => null,
}));
vi.mock('../../src/instance/fleetJoin', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/fleetJoin')>()),
  mainCertificate: async (code: { host: string }) => { h.events.push(`cert:${code.host}`); return h.cert; },
  deleteAddress: async (inst: { fleetLogin?: { password: string } }, code: { host: string; port: number }, pem: string) => {
    h.events.push(`delete-address:${code.host}:${code.port}:${pem}:${inst.fleetLogin?.password ?? ''}`);
    return h.del;
  },
}));

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';
import { copyLogin } from '../../src/instance/switchSql';
import { fakeJoinCode, fakeJoinRecord } from './join-fake';

const ID = '7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d';
const LOGIN = copyLogin(ID);
const REPLICA = {
  containerName: 'bot1-fleet-postgres-replica', volume: 'bot1-fleet-postgres-replica-data', slot: 'fleet_standby_7a6b5c4d3e2f4a1b8c9d0e1f2a3b4c5d',
  primaryHost: 'main.invalid', primaryPort: 15432, publicHost: 'copy.example', hostPort: 5434, certHost: 'copy.example', user: 'app', db: 'app', seededAt: 1,
};
const MAIN_DB = { containerName: 'bot1-fleet-postgres', user: 'app', db: 'app', volume: 'bot1-fleet-postgres-data' };
const DEL_LOGIN = (host: string, port: number) => `This machine's login ${LOGIN} stays on the database at ${host}:${port} until that database's operator removes it in its Database window, which also drops its slot and any row left.`;
const DEL_ROW = (reason: string) => `This machine's address could not be taken off the main's list (${reason}).`;

const seed = (extra: Record<string, unknown>): void => {
  fs.writeFileSync(path.join(h.dir, 'instances.json'), JSON.stringify({ instances: { [ID]: {
    id: ID, sanitizedName: 'bot1', displayName: 'Bot 1', titleName: 'Bot 1', status: 'stopped',
    sourceType: 'docker-image', imageRef: 'img:1', envVars: {}, lastBuiltCommit: null,
    createdAt: '2026-10-22T00:00:00.000Z', updatedAt: '2026-10-22T00:00:00.000Z', ...extra,
  } } }));
};
const run = async (): Promise<string[]> => {
  const notes: string[] = [];
  await expect(containerManager.deleteBot(ID, true, true, true, true, notes)).resolves.toBe(true);
  expect(containerManager.getBot(ID)).toBeNull();
  return notes;
};

let warns: string[] = [];
beforeEach(() => {
  h.events = [];
  h.cert = { ok: true, pem: 'PEM' };
  h.del = null;
  fs.mkdirSync(path.join(h.dir, 'bots', 'bot1'), { recursive: true });
  warns = [];
  vi.spyOn(console, 'warn').mockImplementation((m: unknown) => { warns.push(String(m)); });
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => fs.rmSync(h.dir, { recursive: true, force: true }));

describe('O9 deleteBot on a machine that joined (R10, R24, R37, R46, R48)', () => {
  it('D1: a copy with an address, code and login: its row is taken off as its login; the notes hold DEL-LOGIN', async () => {
    seed({ fleetDbReplica: REPLICA, fleetJoin: fakeJoinRecord(), fleetLogin: { password: 'own-pw' } });
    expect(await run()).toEqual([DEL_LOGIN('main.invalid', 15432)]);
    expect(h.events).toEqual(['cert:main.invalid', 'delete-address:main.invalid:15432:PEM:own-pw']);
    expect(warns.find(w => w.includes('hosted a database standby'))).toContain(` Its login ${LOGIN} stays on the main until the main's operator removes it there.`);
  });

  it.each([
    ['the main does not answer', () => { h.del = 'the main at main.invalid:15432 did not answer within 60 seconds'; }, 'the main at main.invalid:15432 did not answer within 60 seconds', 2],
    ['its certificate cannot be fetched', () => { h.cert = { ok: false, kind: 'unreachable', reason: 'connect ECONNREFUSED', text: 'x' }; }, 'connect ECONNREFUSED', 1],
  ])('D2: %s: DEL-ROW with the reason, then DEL-LOGIN; the delete completes', async (_n, set, reason, calls) => {
    seed({ fleetDbReplica: REPLICA, fleetJoin: fakeJoinRecord(), fleetLogin: { password: 'own-pw' } });
    set();
    expect(await run()).toEqual([DEL_ROW(reason), DEL_LOGIN('main.invalid', 15432)]);
    expect(h.events).toHaveLength(calls);
  });

  it.each([
    ['the code no longer decodes', { fleetJoin: fakeJoinRecord({ code: 'not-a-code' }), fleetLogin: { password: 'own-pw' } }, 'the stored join code no longer decodes'],
    ['no code is stored', { fleetLogin: { password: 'own-pw' } }, 'the stored join code no longer decodes'],
    ['no login is stored', { fleetJoin: fakeJoinRecord() }, 'no login to the main was stored for it'],
    ['the login is lost', { fleetJoin: fakeJoinRecord(), fleetLogin: { password: '' } }, 'no login to the main was stored for it'],
  ])('D3: %s: no call to the main; DEL-ROW with that reason and DEL-LOGIN', async (_n, extra, reason) => {
    seed({ fleetDbReplica: REPLICA, ...extra });
    expect(await run()).toEqual([DEL_ROW(reason), DEL_LOGIN('main.invalid', 15432)]);
    expect(h.events).toEqual([]);
  });

  it.each([
    ['a joined instance with no copy', { fleetJoin: fakeJoinRecord({}, { host: 'joined.example', port: 15440 }), fleetLogin: { password: 'own-pw' } }, DEL_LOGIN('joined.example', 15440)],
    ['a copy without an address', { fleetDbReplica: { ...REPLICA, publicHost: undefined }, fleetJoin: fakeJoinRecord(), fleetLogin: { password: 'own-pw' } }, DEL_LOGIN('main.invalid', 15432)],
  ])('D4: %s: DEL-LOGIN only, no call', async (_n, extra, text) => {
    seed(extra);
    expect(await run()).toEqual([text]);
    expect(h.events).toEqual([]);
  });

  it('D5: an instance that never joined: no note', async () => {
    seed({ fleetDb: MAIN_DB, fleetLogin: { password: 'own-pw' } });
    expect(await run()).toEqual([]);
    expect(h.events).toEqual([]);
  });

  const at = '2026-11-01T00:00:00.000Z';
  it.each([
    ['formerMain', { formerMain: { code: fakeJoinCode({ host: 'old.example', port: 5500 }), slot: 's', machine: 'old.example', host: 'old.example', port: 5500, generation: 2, at } }, 'old.example', 5500],
    ['replacedBy', { replacedBy: { machine: 'new.example', host: 'new.example', port: 5501, generation: 4, own: 3, since: null, at } }, 'new.example', 5501],
    ['mainConflict', { mainConflict: { machine: 'tie.example', host: 'tie.example', port: 5502, generation: 3, at } }, 'tie.example', 5502],
    ['handover with mode stream', { handover: { mode: 'stream', phase: 'stopped', machine: 'to.example', host: 'to.example', port: 5503, generation: 4, at } }, 'to.example', 5503],
  ])('D6: a main whose record holds %s: one DEL-LOGIN for that database', async (_n, rec, host, port) => {
    seed({ fleetDb: { ...MAIN_DB, ...rec } });
    expect(await run()).toEqual([DEL_LOGIN(host, port)]);
  });

  it('D6: a push handover names no database; duplicates are merged; the joined main comes first', async () => {
    seed({
      fleetDb: { ...MAIN_DB, formerMain: { code: fakeJoinCode(), slot: 's', machine: 'main.invalid', host: 'main.invalid', port: 15432, generation: 2, at },
        replacedBy: { machine: 'new.example', host: 'new.example', port: 5501, generation: 4, own: 3, since: null, at },
        mainConflict: { machine: 'new.example', host: 'new.example', port: 5501, generation: 3, at },
        handover: { mode: 'push', phase: 'pushing', machine: 'push.example', host: 'push.example', port: 5509, generation: 4, at } },
      fleetJoin: fakeJoinRecord(),
    });
    expect(await run()).toEqual([DEL_LOGIN('main.invalid', 15432), DEL_LOGIN('new.example', 5501)]);
  });
});
