// The NM36 TLS fakes: a database container's PGDATA pair, its ssl setting and reload, and the TLS read-back as docker
// exec and psql answer them, openssl on the manager host, and docker container inspect's mounts (through execFileSync,
// so dockerClient's real containerMounts runs). Wraps nm31-run's child_process mock. No src import here: the factories
// load this file before the modules they mock.
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { docker } from './nm2-docker';

export const P = '/var/lib/postgresql/data';
const PAIR_TEST = `test -f ${P}/server.crt && test -f ${P}/server.key && test ! -e ${P}/server.crt.new && test ! -e ${P}/server.key.new`;

// Made once with the command E2 runs: openssl req -new -x509 -days 3650 -nodes -newkey rsa:2048 -subj /CN=localhost
// -addext subjectAltName=DNS:localhost. OTHER_KEY is the key of a second such run.
export const FIXTURE_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC6se/lXbgTvjAV
yqX8eVOVGhIXFq9oLgDqsaQ5c5EJ55hQCfwwvKSJKKI8FoIfLW8Mvk0JJ+ohIFds
rSKX6UXzmdjYytFn2xNSFdlsgBkJgfViG0jSKIIX0uVv/hS6lkQuIPdmHltNy4Of
+Zn3ohHbUS+//ZPH0SfZAHrUKda1fO6mHlgYcMnwrT0b/TVg0OYh3q/hHnlR2jeK
TJtJOTESZigEIfiZbEnPW9RAwZGHnNj2sLbad6jDxBlE7h9fcFhQAjSStRbpV4TW
wDuVxKQD6GriEIMrhFkODaapz/5zjO5Z6Srm3J5BkXbOGDzcsEZ/kcbNatPL14gi
OBfMWx09AgMBAAECggEAKhlIRZI32VnceXmAKvnH53ogxKyUorsm8UVcCSl+dfuP
rNLHl8zeFGDBjqersXCbF0ZNVEh4Iv6qQCMdhyBu6fLSA3beuBreVTcAl5ceLjbs
OLJ63gsM5OblXnbuwTFzz+wWpaQoRhdjh74u4jidarV4vUQm4BrRr70MNY32sOdH
xGVy6Cnw2JDbemPm8hobiD60T73yQ05/ADdN2s7KmXJIkWyzqt5XVcIPuOzOq8ya
aBLmJDNo3Al/4mmT+VGwEu/jW5lsx0jvZTIjRoyDuZ7vB8Z1ZjX8u9ht6Se3/UQ5
Yxk1GODVQz4MXoFQtpQoHkjIhC70l5rvvW4kBJVviQKBgQDeNaITtwMRj3fpl8Lh
9w2nWZp26bZXLdYHnaYRblqmkcTdqzoydgbwmBs9E1IJEYNJSEvYNScS72zfuZnX
dU3VzgUfTqvV1FZEsH9nSWCZucmWvsIdncAhbMP1dVpiDYoC1M/P7Drtyu/5F4eI
IwYEkEsvKNY4/S7JMaPUVV3aaQKBgQDXFcRJGV0/AfouZw3W6hfSPqryCy45KrqQ
gy4URCMcRPJPBnCnB5sQFgrDxnA6h1ty+W9rfJep8BF3qBF9nNIPeU5lMo+uUNIs
QZ0sTa0iFZYfn14fa29LIBeIuF2ZXgSAm2D5EcABio9BxoZlJ68joA1FPlMjIuP7
08TnA4IJtQKBgQCdOa+zaWPHcg7zfkkLH4ZOqezMRLOa3bi57McLQFztzOhRvAzS
lYZ1h/qF7Xy3I+gT2w6nLXy3Pid36Vg8BikLpdkj/MNC6hocQhHzYAz02GsVuWWa
FPtT6ySAMgfApznGpRNhWBGeHWBMjGR+Y+GnKv23oZpp+mK3QuNbowdkOQKBgA8s
EueRKXm7WvmQ/XHum3WSRB7E2SLhN73f8w0s7UkeN/WJH8M4jyCoXWQICHyodbP7
kneDl3M+Yw0MxwcUW+EJjpUm5unF+71xd3Pbmt3vpeJfLJWMz5H+FornbnrWHf0w
eLu5G9FAA/EA3xQdo4Yg0S7UQasV1/04qAgfwDmNAoGBANV8XeuDm9IGA2vKb3w4
oENsgme9tNTKON6IhGKGZjj4SxryJJuhvwGjcwcDSpYgCVtDd6MqCY0P2jIVSrb7
OHCz2rr1MIefL00dBPVUqi6/jNYOQyjoQuKjkBOFkDqPNEdSt1A+sBiNsyA7ni50
fdsTGXw7Eo/DrvY71yud3/pa
-----END PRIVATE KEY-----
`;
export const FIXTURE_CRT = `-----BEGIN CERTIFICATE-----
MIIDHzCCAgegAwIBAgIUMyiIAaWHy4lcH0y/iBn9jfLMdfcwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MTExOTAzMDI1NloXDTM2MTEx
NjAzMDI1NlowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAurHv5V24E74wFcql/HlTlRoSFxavaC4A6rGkOXORCeeY
UAn8MLykiSiiPBaCHy1vDL5NCSfqISBXbK0il+lF85nY2MrRZ9sTUhXZbIAZCYH1
YhtI0iiCF9Llb/4UupZELiD3Zh5bTcuDn/mZ96IR21Evv/2Tx9En2QB61CnWtXzu
ph5YGHDJ8K09G/01YNDmId6v4R55Udo3ikybSTkxEmYoBCH4mWxJz1vUQMGRh5zY
9rC22neow8QZRO4fX3BYUAI0krUW6VeE1sA7lcSkA+hq4hCDK4RZDg2mqc/+c4zu
Wekq5tyeQZF2zhg83LBGf5HGzWrTy9eIIjgXzFsdPQIDAQABo2kwZzAdBgNVHQ4E
FgQU6xRdW+o8Ak4gA2HhhldFEvgWY9kwHwYDVR0jBBgwFoAU6xRdW+o8Ak4gA2Hh
hldFEvgWY9kwDwYDVR0TAQH/BAUwAwEB/zAUBgNVHREEDTALgglsb2NhbGhvc3Qw
DQYJKoZIhvcNAQELBQADggEBAFV9D+RAvB9ZbtosSyGK6gLOWPcGoa1jZWIQBqjn
9Egrufqrx88KLevJmEJkHGNr32GEpbUehtVgzYKgchGpv+xEcTpYUXG/D2GabkJf
T7N0PngUbwrC0NXamnnlckqzJ9lOQMpiwtC9vOpfKcVkxgqKmFWNkv9RlSaabXEw
bmag8uoPcDK3B9XNRt/eMvJO0wglJN2R183VhoFGFvk1aDmDBjTZAG+4JHgWSDic
ZbZbUb4xGvTAEmoRTefDM4djPPj8qMU434tqufFbliq4Vydw7mU/XOLmp98Eq4Lc
+q316eGLPb+3bn4b/Fin2k9dWEsOwf3UOjUdMCJUXr5kJEc=
-----END CERTIFICATE-----
`;
export const OTHER_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCJxOKJq1NEicxg
lWpHEBC0HW30/dGcqDZxSK2XvkY5FyJaA0xLWYETNRMpIOY2Ps13Z/r6gQ2MqVol
6RxRKHkYY8DlCNxkUrhXzCsGRRrlpGX10p2keCYh9+rpNiKxKszH726Lx/oVAC9d
R8LU7KGzcSG70NMje5YivEuxXc6MSiKmR86aKaEXvY6bN7f9AFgRktA2WJTB7fTD
fi2qqK67Xr3HqD9oZa3qkPGHDmcDKyIMqkMm063xHKcXstXoHKSEhOJpBTAY5gcU
EwX9Us8H0hPW2x48zlLDnF+qky1V6vnqv35liW5QyvC5WMya2ELbt06JwgUdw0Tq
0F0x4pprAgMBAAECggEACCLXac2Fm0vzu7p5gKYmvBjraB4EZ/JiVUfuJtTrfS5Z
yhGBpnSsE/k88V9cqR2YOlaGMrN/ZWwip/1/hq/BR5r1GPq5V5Mdm3XEV9hgyFan
M7LKA4qZzDJ4m9XusCJB3nSVV8mFgiZr3ISeepp+Ew3C+ywGv4TFuCNKMoHU7vPR
HY0QpIrXfTq/6c4U9iBRjhvr8Ap0QxT/6Bogn7sAiJmZNrijVpNhYcVlOIby4rhM
2/qDK1pSARxVD6ZTycisH8WdG+r6oWUxyX78yPAGUu9YTWJYnESb8DHbWAneMSJ3
VawmyzADEjySbb6gTr8TCZvz4E3HHmjOpF21MNWDjQKBgQC80lmUarQMFsEJCJgD
jp2K+Xg7XnQgqE1gf0eZZvsRYDN9JnhMFsj1WvgcXIEbXsVgGkrVpsMbfNwYK5tC
oeNFlQbjC6YYSFfgvIuB3LW4cvBYKZZpxLXBQzbehixUi2sR7CibEtCZNp+iQKuS
Oi5Me+Qr+HfhZcLbtd/8CKQRvQKBgQC6yLnmQ/XN66rns+6psB56EJy6+RSBfehT
tn5CY0W7i0QApvYIbtB7MqWMB89+BLWcjDLWSR5sqr3og+FpkWsCJOutLdPA1aB5
RNSPS+X+kb9nKbtPf3Jwev2xqS0S6/jbW0k8yKVD3fzeDaSaLlwk9eCTzYlRERtc
dAWPiNnbRwKBgQCSt3OpkhuihQ+rIEVWBju938gfgW4EbiHpiByvQsh1IOYBKaIx
pUay9uNwziP3i3UcDnH1fyV9N1Cha0ixxq6cw4ZdZxDBL30w/+/6kO+WiaDdMDtS
pemAaOS6lVDexJIGlBSdIkp5smrpnQxzi8er4FxUGjW0Kuj05WZMJL6vlQKBgQCo
yqv0AoYmyElxiZCrl5RzCoAYFu8I9hb1T31Z0Qw7JucVD8xWYo3URziDCqvfXbIg
/jESpJDx8nobnNIe7GKfVW4E2dz57hNOg3zy4cu9+UfWmkfC15E7RGnuGsu4xbXl
xOCyJT/zzK+umvWcvzhVzjxcVOk6cRMgwVglFa6KEQJ/VniitRCwcMYRIBidAIqN
PsHW+Zn8xQ166dbyNGRs63AKieuXFohXvzd4BqkA0GTN9zvMa+oo3ByVZs/ReJy4
FvUzTF0ToToNrEbvmWD8U+USOmpIEOyXrB/oCNirjxALGfLieEKZIKTrm7w19eZa
IDJ2B7eL1p1cbaefc7Ni+A==
-----END PRIVATE KEY-----
`;

export const NOSSL = 'psql: error: connection to server at "127.0.0.1", port 5432 failed: server does not support SSL, but SSL was required';
export const REFUSED = 'psql: error: connection to server at "127.0.0.1", port 5432 failed: Connection refused';
export const NOT_RUNNING = (c: string) => `Error response from daemon: container ${c} is not running`;

export interface TlsState {
  files: Record<string, string>;
  saved: boolean;
  loaded: boolean;
  e1: 'auto' | 'stderr' | 'killed' | 'enoent';
  fail: {
    put?: 'server.key' | 'server.crt'; swap?: boolean; alter?: 'error' | 'hang'; reload?: 'error' | 'hang' | 'f';
    reset?: 'error' | 'hang'; aside?: 'all' | 'second' | 'silent' | 'hang'; undoReload?: 'error' | 'hang' | 'f';
  };
  refusedReads: number;
  readFail: 'nossl' | 'refused';
  /** Reads that never answer (execFile's own timeout ends them), before any other answer. */
  readHang: number;
  loadable: boolean;
  /** Whether each pair E4 moves into place can be loaded, in order; when the queue is empty a new pair loads. */
  swapLoadable: boolean[];
}

export interface TlsFake {
  db: Record<string, TlsState>;
  openssl: 'pair' | 'mismatch' | 'missing' | 'fail' | 'silent' | 'garbage';
  opensslArgs: string[][];
  /** Every effect the fake answered, in order: mounts, E1, probe, openssl, put:<file>, mv, alter, reload, read, reset, aside. */
  calls: string[];
  mounts: Record<string, { out: string } | { stderr: string }>;
  newVolume: string;
  /** Runs at the start of every TLS read. */
  onRead: null | (() => void);
  /** A psql execFile whose -c statement holds this never answers (execFile's own timeout ends it). */
  hangSql: string | null;
}

export const freshTls = (): TlsState => ({
  files: {}, saved: false, loaded: false, e1: 'auto', fail: {}, refusedReads: 0, readFail: 'nossl', readHang: 0, loadable: true, swapLoadable: [],
});

function fresh(): TlsFake {
  return { db: {}, openssl: 'pair', opensslArgs: [], calls: [], mounts: {}, newVolume: '', onRead: null, hangSql: null };
}

export const tlsFake: TlsFake = ((globalThis as { __nm36Tls?: TlsFake }).__nm36Tls ??= fresh());

export function resetTls(): void {
  Object.assign(tlsFake, fresh());
}

/** The state of one container, made on first use. */
export function tlsOf(c: string): TlsState {
  return (tlsFake.db[c] ??= freshTls());
}

export const complete = (s: TlsState): boolean =>
  'server.crt' in s.files && 'server.key' in s.files && !('server.crt.new' in s.files) && !('server.key.new' in s.files);

/** A container start: it loads ssl when saved beside a complete pair it can load. */
export function restart(c: string): void {
  const s = tlsOf(c);
  s.loaded = s.saved && s.loadable && complete(s);
}

type Cb = (err: Error | null, stdout: string, stderr: string) => void;

const failure = (args: string[], code: number | string | null, stderr: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(`Command failed: ${args.join(' ')}\n${stderr}`), { code, killed: false, signal: null, ...extra });

function later(cb: Cb, err: Error | null, stdout = '', stderr = ''): void {
  setTimeout(() => cb(err, stdout, stderr), 1);
}

/** No answer: execFile's own timeout kills the child and answers killed, as Node does. */
function hang(cb: Cb, opts: unknown): void {
  const ms = (opts as { timeout?: number } | undefined)?.timeout;
  if (ms) setTimeout(() => cb(Object.assign(new Error('Command failed'), { killed: true, code: null, signal: 'SIGTERM' }), '', ''), ms);
}

const valueAfter = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

/** execFile: openssl, E1, and the psql calls of E5, E6 and E7; anything else to the wrapped mock. */
function execFileTls(base: (...a: unknown[]) => unknown, fsReal: typeof import('fs')) {
  return (cmd: string, args: string[], optsOrCb: unknown, maybeCb?: unknown): unknown => {
    const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as Cb;
    const opts = typeof optsOrCb === 'function' ? undefined : optsOrCb;
    if (cmd === 'openssl') {
      tlsFake.calls.push('openssl');
      tlsFake.opensslArgs.push([...args]);
      const keyOut = valueAfter(args, '-keyout');
      const crtOut = valueAfter(args, '-out');
      const mode = tlsFake.openssl;
      if (mode === 'missing') { later(cb, Object.assign(new Error('spawn openssl ENOENT'), { code: 'ENOENT', errno: -2, syscall: 'spawn openssl', path: 'openssl' })); return new EventEmitter(); }
      if (mode === 'fail') { later(cb, failure(['openssl', ...args], 1, 'req: Unable to load config info\n'), '', 'req: Unable to load config info\n'); return new EventEmitter(); }
      if (mode !== 'silent') {
        fsReal.writeFileSync(keyOut, mode === 'mismatch' ? OTHER_KEY : mode === 'garbage' ? 'not a key\n' : FIXTURE_KEY);
        fsReal.writeFileSync(crtOut, FIXTURE_CRT);
      }
      later(cb, null);
      return new EventEmitter();
    }
    if (cmd !== 'docker' || args[0] !== 'exec') return base(cmd, args, optsOrCb, maybeCb);
    const sh = args.indexOf('sh');
    if (sh > 0 && args[sh + 1] === '-c' && args[sh + 2] === PAIR_TEST) {
      const c = args[sh - 1];
      const s = tlsOf(c);
      docker.calls.push(args);
      tlsFake.calls.push('E1');
      if (s.e1 === 'stderr') later(cb, failure(args, 1, `${NOT_RUNNING(c)}\n`), '', `${NOT_RUNNING(c)}\n`);
      else if (s.e1 === 'killed') later(cb, Object.assign(new Error('Command failed'), { killed: true, code: null, signal: 'SIGTERM' }));
      else if (s.e1 === 'enoent') later(cb, Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT', errno: -2, syscall: 'spawn docker', path: 'docker' }));
      else if (complete(s)) later(cb, null);
      else later(cb, failure(args, 1, ''));
      return new EventEmitter();
    }
    const p = args.indexOf('psql');
    const sql = args.includes('-c') ? valueAfter(args, '-c') : '';
    if (p > 0 && tlsFake.hangSql && sql.includes(tlsFake.hangSql)) {
      docker.calls.push(args);
      hang(cb, opts);
      return new EventEmitter();
    }
    const which = sql.includes('ALTER SYSTEM SET ssl = on') ? 'alter' : sql.includes('ALTER SYSTEM RESET ssl') ? 'reset'
      : sql.includes('pg_reload_conf()') ? 'reload' : sql.includes('pg_stat_ssl s WHERE s.pid') ? 'read' : null;
    if (p < 0 || !which) return base(cmd, args, optsOrCb, maybeCb);
    const s = tlsOf(args[p - 1]);
    docker.calls.push(args);
    const afterAside = tlsFake.calls[tlsFake.calls.length - 1] === 'aside';
    tlsFake.calls.push(which);
    if (which === 'reset') {
      if (s.fail.reset === 'hang') hang(cb, opts);
      else if (s.fail.reset === 'error') later(cb, failure(args, 1, 'ERROR:  could not write to file "postgresql.auto.tmp": No space left on device\n'), '', 'ERROR:  could not write to file "postgresql.auto.tmp": No space left on device\n');
      else { s.saved = false; later(cb, null, 'ALTER SYSTEM\n'); }
      return new EventEmitter();
    }
    if (which === 'reload' && afterAside) {
      if (s.fail.undoReload === 'hang') hang(cb, opts);
      else if (s.fail.undoReload === 'error') later(cb, failure(args, 2, 'psql: error: connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed: FATAL:  the database system is shutting down\n'), '', 'psql: error: connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed: FATAL:  the database system is shutting down\n');
      else if (s.fail.undoReload === 'f') later(cb, null, 'f\n');
      else { s.loaded = s.saved && s.loadable && complete(s); later(cb, null, 't\n'); }
      return new EventEmitter();
    }
    if (which === 'alter') {
      if (s.fail.alter === 'hang') hang(cb, opts);
      else if (s.fail.alter === 'error') later(cb, failure(args, 1, 'ERROR:  could not write to file "postgresql.auto.tmp": No space left on device\n'), '', 'ERROR:  could not write to file "postgresql.auto.tmp": No space left on device\n');
      else { s.saved = true; later(cb, null, 'ALTER SYSTEM\n'); }
      return new EventEmitter();
    }
    if (which === 'reload') {
      if (s.fail.reload === 'hang') hang(cb, opts);
      else if (s.fail.reload === 'error') later(cb, failure(args, 2, 'psql: error: connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed: FATAL:  the database system is shutting down\n'), '', 'psql: error: connection to server on socket "/var/run/postgresql/.s.PGSQL.5432" failed: FATAL:  the database system is shutting down\n');
      else if (s.fail.reload === 'f') later(cb, null, 'f\n');
      else { s.loaded = s.saved && s.loadable && complete(s); later(cb, null, 't\n'); }
      return new EventEmitter();
    }
    tlsFake.onRead?.();
    if (s.readHang > 0) { s.readHang--; hang(cb, opts); return new EventEmitter(); }
    if (s.loaded && s.refusedReads === 0) { later(cb, null, 'on|true\n'); return new EventEmitter(); }
    if (s.refusedReads > 0) s.refusedReads--;
    const stderr = `${s.readFail === 'nossl' ? NOSSL : REFUSED}\n`;
    later(cb, failure(args, 2, stderr), '', stderr);
    return new EventEmitter();
  };
}

function child(): any {
  const c: any = new EventEmitter();
  c.stdout = new PassThrough();
  c.stderr = new PassThrough();
  c.stdin = new PassThrough();
  c.kill = () => true;
  return c;
}

function close(c: any, code: number | null, stderr = ''): void {
  c.stdout.end('');
  c.stderr.end(stderr);
  setTimeout(() => c.emit('close', code), 1);
}

/** spawn: E2's probe, E3's puts and E4's renames (dbExec); anything else to the wrapped mock. */
function spawnTls(base: (...a: unknown[]) => unknown) {
  return (cmd: string, args: string[], opts?: unknown): unknown => {
    if (cmd !== 'docker' || args[0] !== 'exec') return base(cmd, args, opts);
    const rest = args.slice(args[1] === '-i' ? 2 : 1);
    const c = rest[0];
    const what = rest.slice(1);
    const put = what[0] === 'sh' && what[1] === '-c' ? /^cat > (\S+)\.new && chown postgres:postgres \S+ && chmod 600 \S+$/.exec(what[2]) : null;
    const mv = what[0] === 'sh' && what[1] === '-c' && what[2] === `mv -f ${P}/server.key.new ${P}/server.key && mv -f ${P}/server.crt.new ${P}/server.crt`;
    const probe = what.length === 3 && what[0] === 'test' && what[1] === '-f' && what[2] === `${P}/server.crt`;
    const aside = what[0] === 'sh' && what[1] === '-c' && what[2] === `mv -f ${P}/server.key ${P}/server.key.new && mv -f ${P}/server.crt ${P}/server.crt.new`;
    if (!put && !mv && !probe && !aside) return base(cmd, args, opts);
    docker.calls.push(args);
    const s = tlsOf(c);
    const ch = child();
    if (aside) {
      tlsFake.calls.push('aside');
      const away = (name: string) => {
        if (!(name in s.files)) return false;
        s.files[`${name}.new`] = s.files[name];
        delete s.files[name];
        return true;
      };
      if (s.fail.aside === 'silent') { close(ch, 1); return ch; }
      if (s.fail.aside === 'hang') {
        // The renames finish, but docker never answers: dbExec's timer kills the CLI, which closes with code null and no stderr.
        away('server.key');
        away('server.crt');
        ch.kill = () => { close(ch, null); return true; };
        return ch;
      }
      if (s.fail.aside === 'all' || !away('server.key')) { close(ch, 1, `mv: can't rename '${P}/server.key': Permission denied\n`); return ch; }
      if (s.fail.aside === 'second' || !away('server.crt')) { close(ch, 1, `mv: can't rename '${P}/server.crt': Permission denied\n`); return ch; }
      close(ch, 0);
      return ch;
    }
    if (put) {
      const name = put[1].slice(P.length + 1) as 'server.key' | 'server.crt';
      tlsFake.calls.push(`put:${name}`);
      let input = '';
      ch.stdin.on('data', (d: Buffer) => { input += String(d); });
      ch.stdin.on('finish', () => {
        if (s.fail.put === name) return close(ch, 1, `sh: can't create ${put[1]}.new: Permission denied\n`);
        s.files[`${name}.new`] = input;
        close(ch, 0);
      });
      return ch;
    }
    if (mv) {
      tlsFake.calls.push('mv');
      const move = (name: string) => {
        if (!(`${name}.new` in s.files)) return false;
        s.files[name] = s.files[`${name}.new`];
        delete s.files[`${name}.new`];
        return true;
      };
      if (!move('server.key')) { close(ch, 1, `mv: can't rename '${P}/server.key.new': No such file or directory\n`); return ch; }
      if (s.fail.swap || !move('server.crt')) { close(ch, 1, `mv: can't rename '${P}/server.crt.new': I/O error\n`); return ch; }
      if (s.swapLoadable.length) s.loadable = s.swapLoadable.shift()!;
      else s.loadable = true;
      close(ch, 0);
      return ch;
    }
    tlsFake.calls.push('probe');
    close(ch, 'server.crt' in s.files ? 0 : 1);
    return ch;
  };
}

/**
 * execFileSync: docker container inspect right after a compose up is the start's own mount read, answered by nm31-run;
 * any other is G0's and answers from `mounts` (default: the new volume). Anything else goes to nm31-run's mock, where
 * another docker command throws.
 */
function execFileSyncTls(base: (cmd: string, args: string[], opts?: unknown) => unknown, nm31: typeof import('./nm31-run')) {
  return (cmd: string, args: string[], opts?: unknown): unknown => {
    if (cmd !== 'docker' || args[0] !== 'container' || args[1] !== 'inspect') return base(cmd, args, opts);
    if (nm31.run.upRead) return nm31.mountRead(args);
    docker.calls.push(args);
    tlsFake.calls.push('mounts');
    const c = args[args.length - 1];
    const a = tlsFake.mounts[c] ?? { out: `volume ${tlsFake.newVolume}\n` };
    if ('stderr' in a) throw Object.assign(new Error(`Command failed: docker ${args.join(' ')}\n${a.stderr}`), { status: 1, stderr: Buffer.from(`${a.stderr}\n`), stdout: Buffer.from('') });
    return a.out;
  };
}

export async function childProcessMock(real: typeof import('child_process'), fsReal: typeof import('fs')): Promise<Record<string, unknown>> {
  const nm31 = await import('./nm31-run');
  const base = await nm31.childProcessMock(real, fsReal) as { execFile: (...a: unknown[]) => unknown; spawn: (...a: unknown[]) => unknown; exec: unknown; execFileSync: (cmd: string, args: string[], opts?: unknown) => unknown };
  const execFile = execFileTls(base.execFile, fsReal);
  const spawn = spawnTls(base.spawn);
  const execFileSync = execFileSyncTls(base.execFileSync, nm31);
  const wrap = { execFile, spawn, exec: base.exec, execFileSync };
  return { ...real, ...wrap, default: { ...real, ...wrap } };
}
