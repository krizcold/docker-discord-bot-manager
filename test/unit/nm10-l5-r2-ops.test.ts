import { afterAll, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm10-l5-r2-ops-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir };
});

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const { EventEmitter } = await import('events');
  const execFile = (_cmd: string, _args: string[], opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    setTimeout(() => done(new Error('fail'), '', 'Cannot connect to the Docker daemon'), 1);
    return new EventEmitter();
  };
  const exec = (_cmd: string, opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    done(new Error('Cannot connect to the Docker daemon'));
  };
  return { ...real, execFile, exec, default: { ...real, execFile, exec } };
});
vi.mock('../../src/docker/dockerClient', async (o) => ({
  ...(await o<typeof import('../../src/docker/dockerClient')>()),
  listComposeContainers: async () => [],
  listBotContainers: async () => [],
  listContainersByBotId: async () => [],
}));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';
import { laneDone, resumeMigrations } from '../../src/instance/migrate';

const SMDB = 'https://github.com/x/fully-modular-discord-bot';

afterAll(() => fs.rmSync(h.dir, { recursive: true, force: true }));

describe('resumeMigrations over a parked record', () => {
  it("keeps the note of a Build a restart cut on that bot", async () => {
    const cut = { op: 'build', startedAt: '2026-11-01T00:00:00.000Z' };
    fs.writeFileSync(path.join(h.dir, 'active-ops.json'), JSON.stringify({ b1: cut }, null, 2));
    const rec = {
      to: 'postgres', from: 'file', destination: 'b1-fleet-postgres:5432/smdb', companion: true, jobId: 'mgr-a', jobIds: ['mgr-a'],
      posted: false, started: 0, kept: 0, phase: 'waiting', resumeAt: 'posting', loginOpened: false, sharers: [], sharersStopped: [],
      openedAt: '2026-11-01T00:00:00.000Z', text: 't',
    };
    const inst = {
      id: 'b1', displayName: 'B1', sanitizedName: 'b1', titleName: 'B1', sourceUrl: SMDB, sourceId: null, status: 'stopped', containerIds: [],
      envVars: {}, lastBuiltCommit: null, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', migrate: rec,
    };
    fs.writeFileSync(path.join(h.dir, 'instances.json'), JSON.stringify({ instances: { b1: inst } }, null, 2));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    containerManager.loadOpRecords();
    resumeMigrations();
    await new Promise(r => setTimeout(r, 0));
    await laneDone('b1');
    expect(containerManager.cutOpOf('b1')).toEqual(cut);
    expect(JSON.parse(fs.readFileSync(path.join(h.dir, 'active-ops.json'), 'utf-8'))).toEqual({ b1: cut });
  });
});
