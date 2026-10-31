import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm6-lag-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir, slots: [] as unknown[], sql: [] as string[] };
});

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const { EventEmitter } = await import('events');
  const execFile = (_cmd: string, args: string[], opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    setImmediate(() => done(null, args[0] === 'inspect' ? 'true\n' : '', ''));
    return {} as any;
  };
  const spawn = (_cmd: string, args: string[]) => {
    const child: any = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { write: () => true, end: () => undefined, on: () => undefined };
    child.kill = () => undefined;
    const sql = args[args.length - 1];
    h.sql.push(sql);
    const out = sql.includes("current_setting('ssl')") ? `on||${JSON.stringify(h.slots)}|4096MB\n` : '[]\n';
    setImmediate(() => { child.stdout.emit('data', out); child.emit('close', 0); });
    return child;
  };
  const mod = { ...real, execFile, spawn };
  return { ...mod, default: mod };
});
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import * as fs from 'fs';
import * as path from 'path';
import { getFleetReplicationStatus } from '../../src/instance/fleetReplication';

const slot = (behindBytes: unknown, replayLagSeconds: unknown = null) => ({
  slot: 'smdb_fleet_c', walStatus: 'reserved', active: true, retainedBytes: 0, clientAddr: '10.0.0.5', state: 'streaming', replayLagSeconds, behindBytes,
});
const inst = { id: 'a', sanitizedName: 'a', fleetDb: { containerName: 'a-pg', user: 'app', db: 'app', volume: 'v', replication: { publicHost: 'main.example', hostPort: 5433 } } } as any;

beforeEach(() => {
  h.sql = [];
  fs.writeFileSync(path.join(h.dir, 'instances.json'), JSON.stringify({ instances: { a: inst } }));
});
afterAll(() => fs.rmSync(h.dir, { recursive: true, force: true }));

describe('LG1: getFleetReplicationStatus reads each slot\'s byte lag', () => {
  it('the slot query asks for the replay position', async () => {
    h.slots = [slot(0)];
    await getFleetReplicationStatus(inst, { probeEndpoint: false });
    expect(h.sql.find(s => s.includes("current_setting('ssl')"))).toContain('r.replay_lsn');
  });
  it('0, above 0 and null', async () => {
    for (const [given, want] of [[0, 0], [5242880, 5242880], [null, null]] as const) {
      h.slots = [slot(given)];
      const st = await getFleetReplicationStatus(inst, { probeEndpoint: false });
      expect(st.live?.slots[0].behindBytes).toBe(want);
    }
  });
});

describe('LG2 (fixer 1): no replay position is no byte figure', () => {
  it('the slot query gives null, not 0, when the slot has no replay position', async () => {
    h.slots = [slot(0)];
    await getFleetReplicationStatus(inst, { probeEndpoint: false });
    expect(h.sql.find(s => s.includes("current_setting('ssl')"))).toContain('CASE WHEN r.replay_lsn IS NULL THEN NULL ELSE GREATEST(pg_wal_lsn_diff(pg_current_wal_lsn(), r.replay_lsn), 0) END');
  });
});
