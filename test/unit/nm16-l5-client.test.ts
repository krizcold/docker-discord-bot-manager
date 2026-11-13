import { afterEach, describe, expect, it, vi } from 'vitest';

const d = vi.hoisted(() => ({ argv: [] as string[][], out: '', fail: null as string | null }));

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const answer = (args: string[]): string => {
    d.argv.push(args);
    if (d.fail) throw Object.assign(new Error(d.fail), { stderr: d.fail });
    return d.out;
  };
  const execFileSync = (_f: string, args: string[]) => answer(args);
  const execFile = (_f: string, args: string[], opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    try { done(null, { stdout: answer(args), stderr: '' }); } catch (e) { done(e); }
  };
  const mod = { ...real, execFile, execFileSync };
  return { ...mod, default: mod };
});

import { listBotContainers, listBotContainersAsync } from '../../src/docker/dockerClient';

const FORMAT = '{{.ID}}|{{.Names}}|{{.State}}|{{.Status}}|{{.Label "com.docker.compose.project"}}|{{.Label "bot-id"}}|{{.Label "com.docker.compose.service"}}';
const ARGV = ['ps', '-a', '--filter', 'label=managed-by=discord-bot-manager', '--format', FORMAT];
const OUT = 'abc123|b1-app|running|Up 2 minutes|b1|b1|app\ndef456|b1-fleet-postgres|exited|Exited (0) 1 hour ago|b1||fleet-postgres\n';
const PARSED = [
  { id: 'abc123', name: 'b1-app', state: 'running', status: 'Up 2 minutes', ports: [], project: 'b1', botId: 'b1', service: 'app' },
  { id: 'def456', name: 'b1-fleet-postgres', state: 'exited', status: 'Exited (0) 1 hour ago', ports: [], project: 'b1', service: 'fleet-postgres' },
];

afterEach(() => { d.argv = []; d.out = ''; d.fail = null; vi.restoreAllMocks(); });

describe.each([
  ['listBotContainers', listBotContainers],
  ['listBotContainersAsync', listBotContainersAsync],
])('NM16 L5: %s', (_name, list) => {
  it('L1 runs docker ps over every managed container and parses each field', async () => {
    d.out = OUT;
    expect(await list()).toEqual(PARSED);
    expect(d.argv).toEqual([ARGV]);
  });
  it('L2 a container with no compose labels has no project or bot id', async () => {
    d.out = 'abc123|lone|running|Up 1 second|||';
    expect(await list()).toEqual([{ id: 'abc123', name: 'lone', state: 'running', status: 'Up 1 second', ports: [] }]);
  });
  it('L3 an unanswered listing is null and logged', async () => {
    d.fail = 'Cannot connect to the Docker daemon';
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await list()).toBeNull();
    expect(err.mock.calls[0][0]).toBe('[Docker] Failed to list containers:');
  });
});
