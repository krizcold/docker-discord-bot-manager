import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm22-l5-g-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { thrown: null as null | Error };
});

vi.mock('child_process', async (importOriginal) => (await import('./nm22-lane-fake')).laneChildProcess(await importOriginal<typeof import('child_process')>()));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));
vi.mock('../../src/docker/containerManager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/docker/containerManager')>()),
  migrateRefusal: () => null,
  migrationHoldRefusal: () => null,
  getBot: (id: string) => (id === 'b1' ? { id: 'b1', name: 'b1' } : undefined),
}));
vi.mock('../../src/instance/fleetReplication', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/fleetReplication')>()),
  renewJoinCode: async () => { if (h.thrown) throw h.thrown; return { success: true }; },
  removeCopyLogin: async () => { if (h.thrown) throw h.thrown; return { success: true }; },
}));

import http from 'http';
import { AddressInfo } from 'net';
import { createBotRoutes } from '../../src/webui/routes/bots';
import { Client } from '../../src/cli/client';
import { dispatch } from '../../src/cli/commands';

const router = createBotRoutes({ clients: new Set() } as any);
const route = async (method: 'post' | 'delete', routePath: string, params: Record<string, string>, body: unknown = {}) => {
  const layer = (router as any).stack.find((l: any) => l.route?.path === routePath && l.route.methods[method]);
  const res: any = { statusCode: 200 };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  await layer.route.stack[layer.route.stack.length - 1].handle({ params, query: {}, body }, res);
  return { status: res.statusCode, body: res.body };
};

afterEach(() => { h.thrown = null; });

describe('NM22 L5 g: the join code renewal and Remove routes answer 500 with the error when the call throws', () => {
  it('renew: a throw answers 500 { success: false, error }', async () => {
    h.thrown = new Error('boom renew');
    expect(await route('post', '/:id/fleet-replication/join-code/renew', { id: 'b1' })).toEqual({ status: 500, body: { success: false, error: 'Error: boom renew' } });
  });

  it('Remove: a throw answers 500 { success: false, error }', async () => {
    h.thrown = new Error('boom remove');
    expect(await route('delete', '/:id/fleet-replication/logins/:login', { id: 'b1', login: 'smdb_copy_x' }, { confirm: true }))
      .toEqual({ status: 500, body: { success: false, error: 'Error: boom remove' } });
  });
});

const deleteRun = async (flags: Record<string, string | boolean>, answer: Record<string, unknown> = { success: true, vaulted: false, envDeleted: true }) => {
  const seen: Array<[string, string]> = [];
  const server = http.createServer((req, res) => {
    seen.push([req.method ?? '', req.url ?? '']);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(answer));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  const out: string[] = [];
  const exit = vi.spyOn(process, 'exit').mockImplementation(((c?: number) => { throw Object.assign(new Error('exit'), { exitCode: c ?? 0 }); }) as never);
  const o = vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => { out.push(String(s)); return true; }) as never);
  const e = vi.spyOn(process.stderr, 'write').mockImplementation((() => true) as never);
  const tty = process.stdout.isTTY;
  process.stdout.isTTY = true;
  try {
    await dispatch(new Client({ host: '127.0.0.1', port: (server.address() as AddressInfo).port }), ['bots', 'delete', 'b1'], flags);
  } catch (x) {
    if ((x as { exitCode?: number }).exitCode === undefined) throw x;
  } finally {
    process.stdout.isTTY = tty;
    exit.mockRestore();
    o.mockRestore();
    e.mockRestore();
    server.closeAllConnections();
    await new Promise<void>(r => server.close(() => r()));
  }
  return { seen, out: out.join('') };
};

describe('NM22 L5 g: `dbm bots delete` sends DELETE with its flags as the query', () => {
  const sent = async (flags: Record<string, string | boolean>) => (await deleteRun(flags)).seen;

  it('every flag joined by & after ?', async () => {
    expect(await sent({ 'delete-data': true, 'confirm-fleet-data': true, 'confirm-promoted': true, 'no-keep-env': true }))
      .toEqual([['DELETE', '/api/bots/b1?keepData=false&confirmFleetData=true&confirmPromoted=true&keepEnv=false']]);
    expect(await sent({})).toEqual([['DELETE', '/api/bots/b1?keepData=true']]);
  });
});

describe('NM22 L5 g: `dbm bots delete` prints only the body fields of the types it reads (a manager of another build)', () => {
  const printed = async (fields: Record<string, unknown>) => (await deleteRun({}, { success: true, ...fields })).out;

  it('an empty or numeric keptDataDir prints "data preserved"', async () => {
    expect(await printed({ keptDataDir: '' })).toBe('Bot removed (data preserved)\n');
    expect(await printed({ keptDataDir: 7 })).toBe('Bot removed (data preserved)\n');
  });

  it('an empty or numeric keptReplicaVolume adds no replica clause', async () => {
    expect(await printed({ keptReplicaVolume: '' })).toBe('Bot removed (data preserved)\n');
    expect(await printed({ keptReplicaVolume: 7 })).toBe('Bot removed (data preserved)\n');
  });

  it('a dump count given as text adds no dumps clause', async () => {
    expect(await printed({ dbDumpsKept: { count: '2', folder: 'f' } })).toBe('Bot removed (data preserved)\n');
  });

  it('an empty or numeric warning adds nothing', async () => {
    expect(await printed({ warning: '' })).toBe('Bot removed (data preserved)\n');
    expect(await printed({ warning: 7 })).toBe('Bot removed (data preserved)\n');
  });
});
