import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'b19-3-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir, failOn: '', sql: [] as string[] };
});

// A fake docker: the database container runs, every psql exits 0 with no
// output, and a statement containing tmp.failOn exits 1.
vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const { EventEmitter } = await import('events');
  const { PassThrough } = await import('stream');
  const execFile = (_cmd: string, args: string[], opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    if (args[0] === 'inspect') return done(null, 'true\n', '');
    done(null, '', '');
  };
  const spawn = (_cmd: string, args: string[]) => {
    const child: any = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => {};
    const sql = args[args.length - 1];
    tmp.sql.push(sql);
    const fail = tmp.failOn !== '' && sql.includes(tmp.failOn);
    setTimeout(() => {
      child.stdout.end(sql.includes('server.crt') ? 'FAKE CERT\n' : '');
      child.stderr.end(fail ? 'fake failure\n' : '');
      setTimeout(() => child.emit('close', fail ? 1 : 0), 1);
    }, 1);
    return child;
  };
  return { ...real, execFile, spawn, default: { ...real, execFile, spawn } };
});

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';
import * as envManager from '../../src/env/manager';
import { disableFleetReplication, getFleetReplicationStatus, getJoinCode } from '../../src/instance/fleetReplication';

const botDir = path.join(tmp.dir, 'bots', 'b1');
const fakeUrl = 'postgresql://smdb:fake-pass@bot1-fleet-postgres:5432/smdb?sslmode=no-verify';
const replication = { role: 'replicator', password: 'fake', hostPort: 5433, publicHost: 'h', certHost: 'h' };

const writeRegistry = (sourceUrl = 'https://example.invalid/fake/super-modular-discord-bot'): void => {
  fs.writeFileSync(path.join(tmp.dir, 'instances.json'), JSON.stringify({
    instances: {
      b1: {
        id: 'b1', sanitizedName: 'bot1', displayName: 'Bot 1', titleName: 'Bot 1', status: 'running',
        sourceType: 'git', sourceUrl,
        envVars: { DATA_BACKEND: 'postgres' },
        fleetDb: { containerName: 'bot1-fleet-postgres', user: 'smdb', db: 'smdb', volume: 'v', replication },
        createdAt: '2026-10-22T00:00:00.000Z', updatedAt: '2026-10-22T00:00:00.000Z',
      },
    },
  }));
};

beforeEach(() => {
  tmp.failOn = '';
  tmp.sql.length = 0;
  fs.rmSync(path.join(tmp.dir, 'bots'), { recursive: true, force: true });
  fs.mkdirSync(path.join(botDir, 'env'), { recursive: true });
  writeRegistry();
  envManager.setEnvVars('b1', { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: fakeUrl });
});

afterAll(() => {
  fs.rmSync(tmp.dir, { recursive: true, force: true });
});

describe('an interrupted Disable', () => {
  it('leaves a disabling mark on the record when it stops after its first change', async () => {
    tmp.failOn = 'NOLOGIN';
    const res = await disableFleetReplication(containerManager.getBot('b1')!);
    expect(res.success).toBe(false);
    expect(tmp.sql.some(s => s.includes('RESET synchronous_standby_names'))).toBe(true);
    const repl = containerManager.getBot('b1')!.fleetDb!.replication!;
    expect(repl.publicHost).toBe('h');
    expect(typeof repl.disablingSince).toBe('string');
  });

  it('is reported by the status and blocks the join code until Disable finishes', async () => {
    tmp.failOn = 'NOLOGIN';
    await disableFleetReplication(containerManager.getBot('b1')!);
    const status = await getFleetReplicationStatus(containerManager.getBot('b1')!, { probeEndpoint: false });
    expect(status.enabled).toBe(true);
    expect(typeof status.disablingSince).toBe('string');
    const block = await getJoinCode(containerManager.getBot('b1')!);
    expect(block.success).toBe(false);
    expect(block.error).toMatch(/Disable/);

    tmp.failOn = '';
    const again = await disableFleetReplication(containerManager.getBot('b1')!);
    expect(again.success).toBe(true);
    expect(containerManager.getBot('b1')!.fleetDb!.replication).toBeUndefined();
  });

  it.each(['ALTER SYSTEM RESET', 'pg_reload_conf', 'pg_drop_replication_slot'])('a failure at %s after the mark says the Disable did not finish', async (step) => {
    tmp.failOn = step;
    const res = await disableFleetReplication(containerManager.getBot('b1')!);
    expect(res.success).toBe(false);
    expect(res.error).not.toContain('nothing was disabled');
    expect(res.error).toContain('press Disable replication again');
    expect(typeof containerManager.getBot('b1')!.fleetDb!.replication!.disablingSince).toBe('string');
  });

  it('a refusal before the first change leaves no mark', async () => {
    tmp.failOn = 'FROM pg_stat_replication WHERE usename';
    const res = await disableFleetReplication(containerManager.getBot('b1')!);
    expect(res.success).toBe(false);
    expect(res.error).toContain('nothing was disabled');
    expect(containerManager.getBot('b1')!.fleetDb!.replication!.disablingSince).toBeUndefined();
    expect(tmp.sql.some(s => s.includes('ALTER SYSTEM'))).toBe(false);
  });

  it('an app with no database companion refuses before any change', async () => {
    writeRegistry('https://example.invalid/fake/other-app');
    const res = await disableFleetReplication(containerManager.getBot('b1')!);
    expect(res.success).toBe(false);
    expect(tmp.sql.some(s => s.includes('ALTER'))).toBe(false);
  });
});
