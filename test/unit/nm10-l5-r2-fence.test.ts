import { afterAll, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm10-l5-r2-fence-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir, calls: [] as string[][], write: { out: '', code: 0 } };
});

vi.mock('../../src/docker/containerManager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/docker/containerManager')>()),
  appContainerAddresses: async () => ({ ok: true, addresses: ['172.18.0.4'] }),
}));
vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const { EventEmitter } = require('events') as typeof import('events');
  const answer = (args: string[]): { out: string; code: number } => {
    const sql = args.join(' ');
    if (args[0] !== 'exec') return { out: '', code: 0 };
    if (args[1] === '-u' && sql.includes('echo fenced')) return h.write;
    if (sql.includes("current_setting('hba_file')")) return { out: '/var/lib/postgresql/data/pg_hba.conf|0|0\n', code: 0 };
    if (sql.includes('pg_reload_conf()')) return { out: 't\n', code: 0 };
    return { out: '', code: 0 };
  };
  const execFile = (cmd: string, args: string[], opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    if (cmd === 'docker') h.calls.push(args);
    const r = cmd === 'docker' ? answer(args) : { out: '', code: 0 };
    setTimeout(() => (r.code === 0 ? done(null, r.out, '') : done(Object.assign(new Error('Command failed'), { code: r.code }), r.out, '')), 1);
    return new EventEmitter();
  };
  return { ...real, execFile, default: { ...real, execFile } };
});
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';
import { fenceMigrateSource } from '../../src/instance/fleetBackup';

afterAll(() => fs.rmSync(h.dir, { recursive: true, force: true }));

describe('fenceMigrateSource when the write exec fails after its script printed "fenced"', () => {
  it('names the failed rewrite and sends no reload', async () => {
    const fleetDb = { containerName: 'bot-a-postgres', user: 'smdb', db: 'app', volume: 'bot-a-postgres-data' };
    const inst = {
      id: 'a', sanitizedName: 'bot-a', displayName: 'Bot A', titleName: 'Bot A', status: 'running', sourceType: 'git', sourceUrl: 'https://example.invalid/fake/app',
      envVars: {}, createdAt: '2026-10-24T00:00:00.000Z', updatedAt: '2026-10-24T00:00:00.000Z', fleetDb,
    };
    fs.writeFileSync(path.join(h.dir, 'instances.json'), JSON.stringify({ instances: { a: inst } }));
    h.write = { out: 'fenced\n', code: 137 };
    expect(await fenceMigrateSource(containerManager.getBot('a')!, 'migrate:1')).toBe('pg_hba.conf could not be rewritten (unknown reason)');
    expect(h.calls.filter(c => c.join(' ').includes('pg_reload_conf()'))).toHaveLength(0);
  });
});
