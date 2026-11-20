import nodeFs from 'fs';
import http from 'http';
import net from 'net';

export type SocketOwner = { uid: number; gid: number };

type SocketFs = Pick<typeof nodeFs, 'lstatSync' | 'unlinkSync' | 'chmodSync' | 'chownSync'>;
type ProbeSocket = Pick<net.Socket, 'once' | 'destroy'>;
export type LocalDeps = {
  fs?: SocketFs;
  log?: (line: string) => void;
  connect?: (socketPath: string) => ProbeSocket;
  /** How long a connect to a socket found at the path may stay unanswered. */
  probeMs?: number;
  umask?: (mask: number) => number;
  /** Runs once the server listens, before the mode and the owner are set. */
  afterListen?: () => void;
};

const PROBE_MS = 2000;

export function socketOwner(raw: string | undefined): SocketOwner | null {
  const m = /^(\d{1,10}):(\d{1,10})$/.exec(raw || '');
  return m ? { uid: Number(m[1]), gid: Number(m[2]) } : null;
}

const reason = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function close(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

type Probe = { state: 'listening' } | { state: 'stale' } | { state: 'unknown'; why: string };

function probe(socketPath: string, ms: number, connect: (socketPath: string) => ProbeSocket): Promise<Probe> {
  return new Promise((resolve) => {
    let sock: ProbeSocket | null = null;
    let done = false;
    const finish = (result: Probe) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock?.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ state: 'unknown', why: `a connect neither opened nor failed within ${ms / 1000} s` }), ms);
    try {
      sock = connect(socketPath);
    } catch (err) {
      finish({ state: 'unknown', why: reason(err) });
      return;
    }
    sock.once('connect', () => finish({ state: 'listening' }));
    sock.once('error', (err: Error) => {
      const code = (err as NodeJS.ErrnoException)?.code;
      finish(code === 'ECONNREFUSED' || code === 'ENOENT' ? { state: 'stale' } : { state: 'unknown', why: reason(err) });
    });
  });
}

export async function listenLocal(
  server: http.Server,
  socketPath: string,
  owner: SocketOwner | null,
  deps: LocalDeps = {},
): Promise<boolean> {
  const fs = deps.fs || nodeFs;
  const log = deps.log || ((line: string) => console.log(line));
  const umask = deps.umask || ((mask: number) => process.umask(mask));
  const notOpened = (why: string): false => {
    log(`[Server] The local socket was not opened: ${why}`);
    return false;
  };

  let found: nodeFs.Stats | null = null;
  try {
    found = fs.lstatSync(socketPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') return notOpened(`${socketPath} could not be read (${reason(err)})`);
  }
  if (found) {
    if (!found.isSocket()) return notOpened(`${socketPath} exists and is not a socket, so it was left as it is`);
    const inUse = await probe(socketPath, deps.probeMs ?? PROBE_MS, deps.connect || ((p) => net.connect(p)));
    if (inUse.state === 'listening') return notOpened(`another process listens at ${socketPath}`);
    if (inUse.state === 'unknown') {
      return notOpened(`the manager could not tell whether ${socketPath} is in use (can't confirm: ${inUse.why})`);
    }
    try {
      fs.unlinkSync(socketPath);
    } catch (err) {
      return notOpened(`the socket a stopped manager left at ${socketPath} could not be removed (${reason(err)})`);
    }
  }

  const failed = await new Promise<Error | null>((resolve) => {
    const onError = (err: Error) => resolve(err);
    server.once('error', onError);
    // listen binds the path before it returns, so the file never has a mode wider than 0600.
    const before = umask(0o177);
    try {
      server.listen(socketPath, () => {
        server.off('error', onError);
        resolve(null);
      });
    } catch (err) {
      server.off('error', onError);
      resolve(err instanceof Error ? err : new Error(String(err)));
    } finally {
      umask(before);
    }
  });
  if (failed) return notOpened(`listening at ${socketPath} failed (${reason(failed)})`);
  deps.afterListen?.();

  try {
    fs.chmodSync(socketPath, 0o600);
  } catch (err) {
    await close(server);
    log(`[Server] The local socket ${socketPath} was closed again: its mode could not be set to 0600 (${reason(err)})`);
    return false;
  }
  if (owner) {
    try {
      fs.chownSync(socketPath, owner.uid, owner.gid);
    } catch (err) {
      await close(server);
      log(`[Server] The local socket ${socketPath} was closed again: it could not be given to uid ${owner.uid}, gid ${owner.gid} (${reason(err)})`);
      return false;
    }
  }
  log(`[Server] The local socket ${socketPath} is open for ${owner ? `uid ${owner.uid}, gid ${owner.gid}` : "this process's own user"}`);
  return true;
}
