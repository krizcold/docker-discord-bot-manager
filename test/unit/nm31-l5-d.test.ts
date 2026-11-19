import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm31-l5-d-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  type Answer = { err?: { message: string; killed?: boolean }; stdout?: string; stderr?: string };
  return { dir, calls: [] as Array<{ cmd: string; args: string[]; opts: any }>, answers: [] as Answer[] };
});

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const execFile = (cmd: string, args: string[], opts: any, cb: (err: any, out: string, errOut: string) => void) => {
    h.calls.push({ cmd, args, opts });
    const a = h.answers.shift() ?? { err: { message: 'no answer set' }, stderr: '' };
    setTimeout(() => {
      const err = a.err ? Object.assign(new Error(a.err.message), { killed: !!a.err.killed }) : null;
      cb(err, a.stdout ?? '', a.stderr ?? '');
    }, 1);
    return {} as any;
  };
  const refuse = (...args: unknown[]) => { throw new Error('nm31-l5-d: a row reached the docker CLI: ' + JSON.stringify(args)); };
  const own = { execFile, execFileSync: refuse, execSync: refuse, spawnSync: refuse, spawn: refuse, exec: refuse };
  return { ...real, ...own, default: { ...real, ...own } };
});
vi.mock('../../src/docker/dockerClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/docker/dockerClient')>()),
  volumeState: () => 'absent',
}));
vi.mock('fs', async (importOriginal) => (await import('./nm31-run')).fsMock(await importOriginal()));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import * as fs from 'fs';
import * as path from 'path';
import * as containerManager from '../../src/docker/containerManager';
import * as envManager from '../../src/env/manager';
import { addFleetPostgresService } from '../../src/templates/pcsProcessing';
import { seedBot } from './nm2-harness';
import { resetRun, run } from './nm31-run';

const composeOf = (id: string) => path.join(h.dir, 'bots', id, 'docker-compose.yml');
const BASE = (id: string) => `services:\n  app:\n    image: bot${id}:latest\n    container_name: bot${id}-app\n`;

function seedFleetCompose(id: string): void {
  seedBot({ sourceUrl: 'https://github.com/x/fully-modular-discord-bot' }, id);
  envManager.setEnvVars(id, { DATA_BACKEND: 'postgres' });
  const spec = containerManager.ensureFleetDataBackend(containerManager.getBot(id)!);
  expect(spec).not.toBeNull();
  fs.mkdirSync(path.dirname(composeOf(id)), { recursive: true });
  fs.writeFileSync(composeOf(id), addFleetPostgresService(BASE(id), containerManager.getBot(id) as any, spec!, { mode: 'docker' }));
}

beforeEach(() => {
  h.calls.length = 0;
  h.answers.length = 0;
  resetRun();
  process.env.DEPLOYMENT_MODE = 'docker';
});

afterAll(() => {
  fs.rmSync(h.dir, { recursive: true, force: true });
});

describe('containerRunningExact', () => {
  it('runs docker inspect of the exact name with a 10 s timeout and reads true', async () => {
    h.answers.push({ stdout: 'true\n' });
    expect(await containerManager.containerRunningExact('botx-app')).toBe(true);
    expect(h.calls).toEqual([{ cmd: 'docker', args: ['inspect', '-f', '{{.State.Running}}', 'botx-app'], opts: { timeout: 10_000 } }]);
  });

  it('reads "no such object" in stderr as stopped', async () => {
    h.answers.push({ err: { message: 'Command failed' }, stderr: 'Error: No such object: botx-app\n' });
    expect(await containerManager.containerRunningExact('botx-app')).toBe(false);
  });

  it('reads "no such container" from the error message when stderr is empty as stopped', async () => {
    h.answers.push({ err: { message: 'Error: No such container: botx-app' }, stderr: '' });
    expect(await containerManager.containerRunningExact('botx-app')).toBe(false);
  });

  it('answers null on any other failure', async () => {
    h.answers.push({ err: { message: 'Command failed' }, stderr: 'Cannot connect to the Docker daemon' });
    expect(await containerManager.containerRunningExact('botx-app')).toBeNull();
  });
});

describe('stopContainerExact', () => {
  it('stops the exact name with the grace time and a grace plus 30 s timeout, then inspects', async () => {
    h.answers.push({ stdout: 'botx-app\n' }, { stdout: 'false\n' });
    expect(await containerManager.stopContainerExact('botx-app', 10)).toEqual({ ok: true });
    expect(h.calls[0]).toEqual({ cmd: 'docker', args: ['stop', '--time', '10', 'botx-app'], opts: { timeout: 40_000 } });
    expect(h.calls[1].args).toEqual(['inspect', '-f', '{{.State.Running}}', 'botx-app']);
  });

  it('says docker did not answer within grace plus 30 s when the stop is killed', async () => {
    h.answers.push({ err: { message: 'Command failed', killed: true }, stderr: '' });
    expect(await containerManager.stopContainerExact('botx-app', 10)).toEqual({ ok: false, error: 'docker did not answer within 40 s' });
    expect(h.calls).toHaveLength(1);
  });

  it('says docker did not say whether the container stopped when the inspect fails', async () => {
    h.answers.push({ stdout: 'botx-app\n' }, { err: { message: 'Command failed' }, stderr: 'Cannot connect to the Docker daemon' });
    expect(await containerManager.stopContainerExact('botx-app', 10)).toEqual({ ok: false, error: 'docker did not say whether botx-app stopped' });
  });

  it('says the container still runs when the inspect reads true', async () => {
    h.answers.push({ stdout: 'botx-app\n' }, { stdout: 'true\n' });
    expect(await containerManager.stopContainerExact('botx-app', 10)).toEqual({ ok: false, error: 'botx-app still runs' });
  });
});

describe('takeFleetDbServicesOut', () => {
  it('answers success with no deployed compose and writes none', () => {
    seedBot({}, 'n');
    expect(containerManager.takeFleetDbServicesOut('n')).toEqual({ success: true });
    expect(fs.existsSync(composeOf('n'))).toBe(false);
  });

  it('takes the database service out once and leaves a compose without it unwritten', () => {
    seedFleetCompose('f');
    const renames: string[] = [];
    run.afterRename = (_from, to) => { renames.push(to); };
    expect(fs.readFileSync(composeOf('f'), 'utf-8')).toContain('postgres');
    expect(containerManager.takeFleetDbServicesOut('f')).toEqual({ success: true });
    expect(renames).toEqual([composeOf('f')]);
    const after = fs.readFileSync(composeOf('f'), 'utf-8');
    expect(after).not.toContain('postgres');
    expect(containerManager.takeFleetDbServicesOut('f')).toEqual({ success: true });
    expect(renames).toEqual([composeOf('f')]);
    expect(fs.readFileSync(composeOf('f'), 'utf-8')).toBe(after);
  });

  it('answers the rewrite error when the compose rename fails', () => {
    seedFleetCompose('e');
    const before = fs.readFileSync(composeOf('e'), 'utf-8');
    run.beforeRename = () => { throw new Error('EIO: i/o error, rename'); };
    expect(containerManager.takeFleetDbServicesOut('e')).toEqual({ success: false, error: 'EIO: i/o error, rename' });
    expect(fs.readFileSync(composeOf('e'), 'utf-8')).toBe(before);
  });
});
