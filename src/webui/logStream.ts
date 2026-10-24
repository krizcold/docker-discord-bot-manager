import { spawn } from 'child_process';
import { parseDockerLogLine } from '../docker/dockerClient';

interface SseRes {
  readonly writable: boolean;
  write(chunk: string): unknown;
  end(): unknown;
  on(event: 'close', fn: () => void): unknown;
}

interface SseReq {
  on(event: 'close' | 'error', fn: () => void): unknown;
}

/**
 * Stream `docker logs` as SSE `log` frames carrying docker's stored time (null when a
 * line has none). When docker logs exits, an `end` frame with its exit code closes the
 * stream, so a client stops instead of reconnecting into a second tail.
 */
export function pipeContainerLogs(req: SseReq, res: SseRes, containerName: string, lines: number, follow: boolean): void {
  const send = (event: string, data: unknown) => {
    if (res.writable) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const args = ['logs', '--timestamps', '--tail', String(lines)];
  if (follow) args.splice(1, 0, '-f');
  args.push(containerName);
  const logsProcess = spawn('docker', args);

  const reader = () => {
    let partial = '';
    return {
      push(data: string) {
        const parts = (partial + data).split('\n');
        partial = parts.pop() ?? '';
        for (const l of parts) emit(l);
      },
      flush() {
        if (partial) emit(partial);
        partial = '';
      },
    };
  };
  const emit = (raw: string) => {
    const line = raw.replace(/\r$/, '');
    if (line.trim().length === 0) return;
    const { timestamp, message } = parseDockerLogLine(line);
    send('log', { log: message, timestamp });
  };
  const out = reader();
  const err = reader();
  logsProcess.stdout.setEncoding('utf8');
  logsProcess.stderr.setEncoding('utf8');
  logsProcess.stdout.on('data', out.push);
  logsProcess.stderr.on('data', err.push);

  let finished = false;
  const finish = (data: { code: number | null; error?: string }) => {
    if (finished) return;
    finished = true;
    clearInterval(keepAlive);
    out.flush();
    err.flush();
    send('end', data);
    if (res.writable) res.end();
  };
  logsProcess.on('error', (error) => finish({ code: null, error: error.message }));
  logsProcess.on('close', (code) => finish({ code }));

  const keepAlive = setInterval(() => send('ping', { timestamp: new Date().toISOString() }), 30000);

  const cleanup = () => {
    clearInterval(keepAlive);
    finished = true;
    logsProcess.kill('SIGTERM');
  };
  req.on('close', cleanup);
  req.on('error', cleanup);
  res.on('close', cleanup);
}
