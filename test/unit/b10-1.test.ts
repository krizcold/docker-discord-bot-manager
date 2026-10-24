import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ calls: [] as string[][], script: '' }));

// A fake docker CLI: `logs` runs h.script through sh, so a test sets what docker
// prints and the code it exits with.
vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const spawn = (cmd: string, args: string[]) => {
    h.calls.push(args);
    if (cmd !== 'docker' || args[0] !== 'logs') throw new Error(`unexpected spawn ${cmd} ${args[0]}`);
    return real.spawn('sh', ['-c', h.script]);
  };
  return { ...real, spawn };
});

import { pipeContainerLogs } from '../../src/webui/logStream';
import { parseDockerLogLine } from '../../src/docker/dockerClient';
import { dispatch } from '../../src/cli/commands';

class FakeRes extends EventEmitter {
  writable = true;
  out = '';
  ended = false;
  write(chunk: string) { this.out += chunk; return true; }
  end() { this.ended = true; this.writable = false; this.emit('close'); }
  frames() {
    return this.out.split('\n\n').filter(Boolean).map((b) => {
      const ev = /^event: (.*)$/m.exec(b)![1];
      return { event: ev, data: JSON.parse(/^data: (.*)$/m.exec(b)![1]) };
    });
  }
}

const run = (script: string, follow = true) => new Promise<FakeRes>((resolve) => {
  h.script = script;
  const req = new EventEmitter();
  const res = new FakeRes();
  res.on('close', () => resolve(res));
  pipeContainerLogs(req, res, 'c1', 50, follow);
});

afterEach(() => { h.calls.length = 0; });

describe('B10-1 container log stream', () => {
  it('sends an end frame with the exit code and closes the response when docker logs exits', async () => {
    const res = await run("printf '2026-01-02T03:04:05.123456789Z hello\\n'; exit 3");
    const frames = res.frames();
    expect(frames.at(-1)).toEqual({ event: 'end', data: { code: 3 } });
    expect(res.ended).toBe(true);
  });

  it('log frames carry docker stored time, and null when a line has no time', async () => {
    const res = await run("printf '2020-05-06T07:08:09.5Z old line\\nno stamp here\\n'");
    const logs = res.frames().filter((f) => f.event === 'log').map((f) => f.data);
    expect(logs).toEqual([
      { log: 'old line', timestamp: '2020-05-06T07:08:09.5Z' },
      { log: 'no stamp here', timestamp: null },
    ]);
  });

  it('asks docker for timestamps, and follows only when told to', async () => {
    await run('true', true);
    await run('true', false);
    expect(h.calls[0]).toEqual(['logs', '-f', '--timestamps', '--tail', '50', 'c1']);
    expect(h.calls[1]).toEqual(['logs', '--timestamps', '--tail', '50', 'c1']);
  });

  it('a line split across two reads arrives as one line, and a last line without newline is kept', async () => {
    const res = await run("printf '2020-01-01T00:00:00Z par'; sleep 0.2; printf 'tial\\ntail'");
    const logs = res.frames().filter((f) => f.event === 'log').map((f) => f.data.log);
    expect(logs).toEqual(['partial', 'tail']);
  });

  it('a multi-byte character split across two reads arrives whole', async () => {
    const res = await run("printf '2020-01-01T00:00:00Z a\\360\\237'; sleep 0.2; printf '\\230\\200b\\n'");
    const logs = res.frames().filter((f) => f.event === 'log').map((f) => f.data.log);
    expect(logs).toEqual(['a\u{1F600}b']);
  });

  it('parses a docker timestamp and leaves other lines without one', () => {
    expect(parseDockerLogLine('2026-10-24T01:02:03.000000001Z  spaced')).toEqual({ timestamp: '2026-10-24T01:02:03.000000001Z', message: ' spaced' });
    expect(parseDockerLogLine('plain')).toEqual({ timestamp: null, message: 'plain' });
  });
});

describe('B10-1 dbm container-logs', () => {
  const exits: number[] = [];
  const fakeClient = (frames: { event: string; data: unknown }[], paths: string[]) => ({
    sse: async (path: string, onFrame: (f: { event: string; data: unknown }) => void) => {
      paths.push(path);
      for (const f of frames) onFrame(f);
      return 'end' as const;
    },
  });
  const go = async (frames: { event: string; data: unknown }[], flags: Record<string, string | boolean>) => {
    const paths: string[] = [];
    vi.spyOn(process, 'exit').mockImplementation(((c: number) => { exits.push(c); throw new Error(`exit ${c}`); }) as never);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await dispatch(fakeClient(frames, paths) as never, ['bots', 'container-logs', 'b1', 'c1'], flags).catch(() => {});
    vi.restoreAllMocks();
    return paths;
  };

  it('without --follow asks for a one-shot read and exits 0 on a clean end frame', async () => {
    exits.length = 0;
    const paths = await go([{ event: 'log', data: { log: 'x', timestamp: null } }, { event: 'end', data: { code: 0 } }], {});
    expect(paths[0]).toContain('follow=0');
    expect(exits[0]).toBe(0);
  });

  it('with --follow keeps following and fails on an end frame with a nonzero code', async () => {
    exits.length = 0;
    const paths = await go([{ event: 'end', data: { code: 1 } }], { follow: true });
    expect(paths[0]).not.toContain('follow=0');
    expect(exits[0]).toBe(1);
  });
});
