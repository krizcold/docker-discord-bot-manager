// The write fence's own docker calls (B14-2Lb), answered the way a database that takes the fence answers them, for
// fake docker CLIs written before the fence had a pg_hba layer. The fake's own answers keep deciding the read-only
// layer: the fence-state read is passed to it as the SHOW it used to send, and the pg_hba layer reads as absent.
type Cb = (err: Error | null, stdout: string, stderr: string) => void;
type ExecFileFake = (cmd: string, args: string[], optsOrCb: unknown, maybeCb?: unknown) => unknown;

export const FENCE_SETTINGS = '/var/lib/postgresql/data/pg_hba.conf|on|0|0';

export function withFence<F extends ExecFileFake>(fake: F): F {
  return ((cmd: string, args: string[], optsOrCb: unknown, maybeCb?: unknown) => {
    const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as Cb;
    const sql = args.join(' ');
    if (cmd === 'docker' && args[0] === 'exec') {
      if (sql.includes("current_setting('hba_file') ||")) return cb(null, `${FENCE_SETTINGS}\n`, '');
      if (args.includes('127.0.0.1') && args.includes('-w')) return cb(new Error('rejected'), '', 'psql: error: FATAL:  pg_hba.conf rejects connection for host "127.0.0.1"');
      if (args[1] === '-u' && args[2] === 'root' && sql.includes('smdb-write-fence')) return cb(null, '', '');
      if (sql.includes('pg_terminate_backend(pid, 5000)')) return cb(null, '', '');
      if (sql.includes('pg_read_file') && sql.includes("current_setting('default_transaction_read_only')")) {
        const show = [...args.slice(0, -1), 'SHOW default_transaction_read_only'];
        return fake(cmd, show, typeof optsOrCb === 'function' ? {} : optsOrCb, (err: Error | null, stdout: string, stderr: string) =>
          err ? cb(err, stdout, stderr) : cb(null, /^(on|off)$/.test(String(stdout).trim()) ? `${String(stdout).trim()}|0\n` : String(stdout), stderr));
      }
    }
    return fake(cmd, args, optsOrCb, maybeCb);
  }) as F;
}

export const FENCED_HBA = 'host replication all all reject # smdb-write-fence\nhost all all all reject # smdb-write-fence\n';
export const MANAGED_HBA = 'local   all             all                                     trust\nhost    all             all             127.0.0.1/32            trust\n';

/**
 * Runs a script a lane sends to a data directory through this machine's sh, on a temp directory that stands in for
 * <dir> and holds <files>. chown only logs its arguments (no postgres user here). Answers the files after the run.
 */
export async function runOnDataDir(script: string, dir: string, files: Record<string, string>, stdin?: string): Promise<{ out: string; files: Record<string, string>; chowns: string[] }> {
  const { vi } = await import('vitest');
  const { execFileSync } = await vi.importActual<typeof import('child_process')>('child_process');
  const fs = await vi.importActual<typeof import('fs')>('fs');
  const os = await vi.importActual<typeof import('os')>('os');
  const path = await vi.importActual<typeof import('path')>('path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fence-dir-'));
  try {
    const bin = path.join(root, 'bin');
    const data = path.join(root, 'data');
    fs.mkdirSync(bin);
    fs.mkdirSync(data);
    const log = path.join(root, 'chown.log');
    fs.writeFileSync(path.join(bin, 'chown'), '#!/bin/sh\necho "$@" >> "$CHOWN_LOG"\n', { mode: 0o755 });
    for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(data, name), content);
    const shData = process.platform === 'win32' ? `/${data[0].toLowerCase()}${data.slice(2).replace(/\\/g, '/')}` : data;
    const out = execFileSync('sh', ['-c', script.split(dir).join(shData)], {
      input: stdin ?? '',
      env: { ...process.env, CHOWN_LOG: log, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
    }).toString();
    const after: Record<string, string> = {};
    for (const name of fs.readdirSync(data)) after[name] = fs.readFileSync(path.join(data, name), 'utf8');
    const chowns = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(l => l.split(shData).join(dir)) : [];
    return { out, files: after, chowns };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

