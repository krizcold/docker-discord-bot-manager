import { beforeEach, describe, expect, it, vi } from 'vitest';

const s = vi.hoisted(() => {
  const st = {
    calls: [] as Array<[string, unknown[]]>,
    broadcasts: [] as string[],
    throwIn: '' as string,
    join: { success: true, message: 'joined it' } as { success: boolean; message?: string; error?: string },
    result: { success: true } as Record<string, unknown>,
    rec: (name: string, value: () => unknown) => (...args: unknown[]) => {
      st.calls.push([name, args]);
      if (st.throwIn === name) throw new Error('boom');
      return value();
    },
  };
  return st;
});

vi.mock('../../src/docker/containerManager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/docker/containerManager')>()),
  getBot: (id: string) => (id === 'b1' ? ({ id: 'b1', name: 'b1', fleetDbReplica: { slot: 'slot_a' } } as any) : undefined),
}));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: (_w: unknown, type: string) => { s.broadcasts.push(type); } }));
vi.mock('../../src/instance/fleetReplica', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/fleetReplica')>()),
  decommissionFleetDb: s.rec('decommissionFleetDb', async () => s.result),
  getFleetReplicaStatus: s.rec('getFleetReplicaStatus', async () => ({ phase: 'idle' })),
  provisionFleetReplica: s.rec('provisionFleetReplica', () => s.result),
  reseedStalePrimary: s.rec('reseedStalePrimary', () => s.result),
  removeFleetReplica: s.rec('removeFleetReplica', async () => s.result),
  reseedStandby: s.rec('reseedStandby', async () => s.result),
}));
vi.mock('../../src/instance/fleetReplication', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/fleetReplication')>()),
  getFleetReplicationStatus: s.rec('getFleetReplicationStatus', async () => ({ posture: 'p' })),
  getJoinCode: s.rec('getJoinCode', async () => ({ success: true, joinCode: 'JC' })),
}));
vi.mock('../../src/instance/fleetJoin', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/fleetJoin')>()),
  joinFleet: s.rec('joinFleet', async () => s.join),
}));
vi.mock('../../src/instance/fleetBackup', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/fleetBackup')>()),
  fleetBackupStatus: () => ({ copy: { c: 1 } }),
}));
vi.mock('../../src/instance/fleetCopyWatch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/fleetCopyWatch')>()),
  joinView: () => ({ j: 1 }),
  rebuildView: () => ({ r: 1 }),
}));

import { createBotRoutes } from '../../src/webui/routes/bots';

const router = createBotRoutes({ clients: new Set() } as any);
const call = async (method: string, routePath: string, body: unknown = {}, id = 'b1'): Promise<{ status: number; body: any }> => {
  const layer = (router as any).stack.find((l: any) => l.route?.path === routePath && l.route.methods[method]);
  expect(layer, `${method} ${routePath}`).toBeTruthy();
  const res: any = { statusCode: 200 };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  await layer.route.stack[layer.route.stack.length - 1].handle({ params: { id }, query: {}, body }, res);
  return { status: res.statusCode, body: res.body };
};
const named = (n: string) => s.calls.filter(([c]) => c === n).map(([, a]) => a);

beforeEach(() => {
  s.calls = [];
  s.broadcasts = [];
  s.throwIn = '';
  s.join = { success: true, message: 'joined it' };
  s.result = { success: true };
});

describe('NM3 L5 j: decommission, replication and join-code routes', () => {
  it('decommission answers the module result, 404 and 500', async () => {
    s.result = { success: true, message: 'gone' };
    expect(await call('post', '/:id/fleet-db/decommission')).toEqual({ status: 200, body: { success: true, message: 'gone' } });
    expect(named('decommissionFleetDb')).toEqual([['b1']]);
    expect(await call('post', '/:id/fleet-db/decommission', {}, 'none')).toEqual({ status: 404, body: { success: false, error: 'Bot not found' } });
    s.throwIn = 'decommissionFleetDb';
    expect(await call('post', '/:id/fleet-db/decommission')).toEqual({ status: 500, body: { success: false, error: 'Error: boom' } });
  });

  it('fleet-replication answers the status, 404 and 500', async () => {
    expect(await call('get', '/:id/fleet-replication')).toEqual({ status: 200, body: { success: true, replication: { posture: 'p' } } });
    expect(await call('get', '/:id/fleet-replication', {}, 'none')).toEqual({ status: 404, body: { success: false, error: 'Bot not found' } });
    s.throwIn = 'getFleetReplicationStatus';
    expect(await call('get', '/:id/fleet-replication')).toEqual({ status: 500, body: { success: false, error: 'Error: boom' } });
  });

  it('join-code answers the module result and 500', async () => {
    expect(await call('get', '/:id/fleet-replication/join-code')).toEqual({ status: 200, body: { success: true, joinCode: 'JC' } });
    s.throwIn = 'getJoinCode';
    expect(await call('get', '/:id/fleet-replication/join-code')).toEqual({ status: 500, body: { success: false, error: 'Error: boom' } });
  });
});

describe('NM3 L5 j: fleet-join', () => {
  it('404 for an unknown bot and 400 for a blank code', async () => {
    expect(await call('post', '/:id/fleet-join', { joinCode: 'x' }, 'none')).toEqual({ status: 404, body: { success: false, error: 'Bot not found' } });
    expect(await call('post', '/:id/fleet-join', { joinCode: '   ' })).toEqual({ status: 400, body: { success: false, error: 'joinCode is required' } });
    expect(named('joinFleet')).toEqual([]);
  });

  it('broadcasts bot:updated only after a successful join', async () => {
    expect((await call('post', '/:id/fleet-join', { joinCode: 'C' })).body).toEqual(s.join);
    expect(s.broadcasts).toEqual(['bot:updated']);
    s.broadcasts = [];
    s.join = { success: false, error: 'no' };
    expect((await call('post', '/:id/fleet-join', { joinCode: 'C' })).body).toEqual({ success: false, error: 'no' });
    expect(s.broadcasts).toEqual([]);
  });
});

describe('NM3 L5 j: fleet-replica GET and POST', () => {
  it('GET answers success true with the views', async () => {
    expect((await call('get', '/:id/fleet-replica')).body).toEqual({ success: true, replica: { phase: 'idle' }, copyBackup: { c: 1 }, join: { j: 1 }, rebuild: { r: 1 } });
  });

  it('a blank joinCode does not join', async () => {
    await call('post', '/:id/fleet-replica', { joinCode: '  ' });
    expect(named('joinFleet')).toEqual([]);
    expect(named('provisionFleetReplica')).toHaveLength(1);
  });

  it('a failed join answers the join and does not provision', async () => {
    s.join = { success: false, error: 'bad code' };
    expect((await call('post', '/:id/fleet-replica', { joinCode: 'C' })).body).toEqual({ success: false, error: 'bad code' });
    expect(named('provisionFleetReplica')).toEqual([]);
  });

  it('passes string fields and confirm true, and adds the join message', async () => {
    s.result = { success: true, r: 1 };
    const r = await call('post', '/:id/fleet-replica', { joinCode: 'C', publicHost: 'h.example', hostPort: 5433, confirm: true, confirmVolume: 'vol' });
    expect(r.body).toEqual({ success: true, r: 1, joinMessage: 'joined it' });
    const [args] = named('provisionFleetReplica');
    expect(args.slice(1)).toEqual(['h.example', 5433, true, { confirmVolume: 'vol' }]);
  });

  it('drops non-string fields and a non-true confirm', async () => {
    await call('post', '/:id/fleet-replica', { publicHost: 7, confirm: 'yes', confirmVolume: 9 });
    const [args] = named('provisionFleetReplica');
    expect(args.slice(1)).toEqual([undefined, undefined, false, { confirmVolume: undefined }]);
  });
});

describe('NM3 L5 j: fleet-reseed', () => {
  it('400 for a blank code', async () => {
    expect(await call('post', '/:id/fleet-reseed', { joinCode: '  ' })).toEqual({ status: 400, body: { success: false, error: 'joinCode is required' } });
    expect(named('reseedStalePrimary')).toEqual([]);
  });

  it('passes string fields and confirm true', async () => {
    await call('post', '/:id/fleet-reseed', { joinCode: 'C', publicHost: 'h', hostPort: 1, confirm: true, confirmVolume: 'v' });
    expect(named('reseedStalePrimary')[0].slice(1)).toEqual(['C', 'h', 1, true, { confirmVolume: 'v' }]);
  });

  it('drops non-string fields and a non-true confirm', async () => {
    await call('post', '/:id/fleet-reseed', { joinCode: 'C', publicHost: 3, confirm: 'yes', confirmVolume: 4 });
    expect(named('reseedStalePrimary')[0].slice(1)).toEqual(['C', undefined, undefined, false, { confirmVolume: undefined }]);
  });
});

describe('NM3 L5 j: fleet-replica DELETE and reseed', () => {
  it('a removal with no warning ends the slot text at the sentence', async () => {
    expect((await call('delete', '/:id/fleet-replica')).body).toEqual({ success: true, warning: 'The primary keeps replication slot slot_a, which retains WAL until it is dropped there: its Database modal lists the slot with a Drop action once nothing streams on it' });
  });

  it('a blank joinCode does not join before reseeding', async () => {
    await call('post', '/:id/fleet-replica/reseed', { joinCode: '  ' });
    expect(named('joinFleet')).toEqual([]);
    expect(named('reseedStandby')).toHaveLength(1);
  });

  it('a failed join answers the join and does not reseed', async () => {
    s.join = { success: false, error: 'bad code' };
    expect((await call('post', '/:id/fleet-replica/reseed', { joinCode: 'C' })).body).toEqual({ success: false, error: 'bad code' });
    expect(named('reseedStandby')).toEqual([]);
  });

  it('a successful join reseeds with confirm true', async () => {
    s.result = { success: true, z: 1 };
    expect((await call('post', '/:id/fleet-replica/reseed', { joinCode: 'C', confirm: true })).body).toEqual({ success: true, z: 1 });
    expect(named('joinFleet')).toHaveLength(1);
    expect(named('reseedStandby')[0][1]).toEqual({ confirm: true });
  });

  it('a non-true confirm reseeds with confirm false', async () => {
    await call('post', '/:id/fleet-replica/reseed', { confirm: 'yes' });
    expect(named('reseedStandby')[0][1]).toEqual({ confirm: false });
  });
});
