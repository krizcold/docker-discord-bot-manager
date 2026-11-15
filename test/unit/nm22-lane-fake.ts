// NM22 part 4: a fake docker for the main's replication lane (Enable, Disable, the join code, New join code, Remove,
// the status read). Every psql call is recorded with its argv and stdin; reads answer as real psql -tA prints them
// (out/NM22/p1-fix.txt, pg-claims*.txt): command tags on stdout, NOTICE and ERROR lines on stderr.
import { EventEmitter } from 'events';
import * as nodeFs from 'fs';
import { PassThrough } from 'stream';
import { FIXTURE_KEY, FIXTURE_PEM } from './join-fake';
import { rolesReadAnswer } from './roles-fake';

/** `hang`: the call never answers, so the caller's own time limit ends it (the kill closes the child). */
export interface Rule { match: string | RegExp; code?: number; out?: string; err?: string; once?: boolean; hang?: boolean }
export interface Call { args: string; stdin: string }

export const lane = {
  calls: [] as Call[],
  rules: [] as Rule[],
  running: 'true',
  cert: FIXTURE_PEM,
  joinExists: true,
  ownExists: true,
  /** The admission read of Remove: role exists | slot state | client. */
  roleExists: 'true',
  slotActive: 'absent',
  client: '',
  /** Answers of the slot state read, in order; 'absent' once they run out. */
  slotStates: [] as string[],
  copyRoles: 'copyroles|ok',
  holders: '',
  logins: '[]',
  addresses: '[]',
  slots: '',
  dockerCalls: 0,
};

export function resetLane(): void {
  lane.calls = [];
  lane.rules = [];
  lane.running = 'true';
  lane.cert = FIXTURE_PEM;
  lane.joinExists = true;
  lane.ownExists = true;
  lane.roleExists = 'true';
  lane.slotActive = 'absent';
  lane.client = '';
  lane.slotStates = [];
  lane.copyRoles = 'copyroles|ok';
  lane.holders = '';
  lane.logins = '[]';
  lane.addresses = '[]';
  lane.slots = '';
  lane.dockerCalls = 0;
}

/** The stdin or -c text of every psql call so far, in order. */
export function sqlTexts(): string[] {
  return lane.calls.filter(c => c.args.includes(' psql ')).map(c => c.stdin || c.args);
}

const RENEW_OUT = 'SET\nSET\nSET\nBEGIN\nALTER ROLE\nALTER ROLE\nDO\nALTER ROLE\nDO\nALTER ROLE\ncommitting\nCOMMIT\nrenewed\nended|0\nunlinked|0\nDO\n';
const BLOCK_OUT = 'BEGIN\nDO\nALTER ROLE\nDO\nALTER ROLE\ncommitting\nCOMMIT\nblocked|true|true|true\n';

function answer(text: string): { code: number; out: string; err: string; hang?: boolean } {
  for (let i = 0; i < lane.rules.length; i++) {
    const r = lane.rules[i];
    const hit = typeof r.match === 'string' ? text.includes(r.match) : r.match.test(text);
    if (!hit) continue;
    if (r.once) lane.rules.splice(i, 1);
    return { code: r.code ?? 0, out: r.out ?? '', err: r.err ?? '', hang: r.hang };
  }
  if (text.includes("'copyroles|'")) return { code: 0, out: `${lane.copyRoles}\n`, err: '' };
  const roles = rolesReadAnswer(text);
  if (roles !== null) return { code: 0, out: roles, err: '' };
  if (text.includes('cat /var/lib/postgresql/data/server.crt')) return lane.cert ? { code: 0, out: lane.cert, err: '' } : { code: 1, out: '', err: 'cat: no such file' };
  if (text.includes("WHERE line LIKE '%")) return { code: 0, out: '0\n', err: '' };
  if (text.includes("SELECT 'login|'")) return { code: 0, out: `login|${lane.roleExists}|${lane.slotActive}|${lane.client}\n`, err: '' };
  if (text.includes("SELECT 'blocked|'")) return { code: 0, out: BLOCK_OUT, err: '' };
  if (text.includes("SELECT 'renewed'")) return { code: 0, out: RENEW_OUT, err: '' };
  if (text.includes("rolname = 'smdb_join';")) return { code: 0, out: lane.joinExists ? '1\n' : '0\n', err: '' };
  if (/FROM pg_roles WHERE rolname = 'smdb_copy_[0-9a-f]{32}';/.test(text)) return { code: 0, out: lane.ownExists ? '1\n' : '0\n', err: '' };
  if (text.includes('SELECT coalesce((SELECT active::text')) return { code: 0, out: `${lane.slotStates.shift() ?? 'absent'}\n`, err: '' };
  if (text.includes('pg_catalog.count(*) FROM pg_catalog.pg_stat_activity')) return { code: 0, out: '0\n', err: '' };
  if (text.includes('pg_catalog.count(pg_catalog.pg_terminate_backend')) return { code: 0, out: '0\n', err: '' };
  if (text.includes("'member', EXISTS")) return { code: 0, out: `${lane.logins}\n`, err: '' };
  if (text.includes('string_agg(DISTINCT pg_catalog.pg_get_userbyid(s.setrole)')) return { code: 0, out: `${lane.holders}\n`, err: '' };
  if (text.includes("current_setting('ssl')")) return { code: 0, out: `on||${lane.slots}|4096MB\n`, err: '' };
  if (text.includes("to_regclass('smdb_manager.addresses') IS NULL")) return { code: 0, out: `${lane.addresses}\n`, err: '' };
  if (text.includes('FROM pg_roles WHERE rolname')) return { code: 0, out: '1\n', err: '' };
  if (text.includes('DROP ROLE IF EXISTS')) return { code: 0, out: 'DROP ROLE\n', err: '' };
  return { code: 0, out: '', err: '' };
}

/** The child_process module with this fake's execFile and spawn. */
export function laneChildProcess(real: typeof import('child_process')): typeof import('child_process') {
  const execFile = (cmd: string, args: string[], opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    lane.dockerCalls++;
    if (cmd === 'openssl') {
      nodeFs.writeFileSync(args[args.indexOf('-keyout') + 1], FIXTURE_KEY);
      nodeFs.writeFileSync(args[args.indexOf('-out') + 1], FIXTURE_PEM);
      setImmediate(() => done(null, '', ''));
    } else if (args[0] === 'inspect') {
      setImmediate(() => done(null, `${lane.running}\n`, ''));
    } else {
      const text = args.join(' ');
      lane.calls.push({ args: text, stdin: '' });
      const a = answer(text);
      setImmediate(() => done(a.code ? Object.assign(new Error(a.err), { code: a.code }) : null, a.out, a.err));
    }
    return new EventEmitter();
  };
  const spawn = (_cmd: string, args: string[]) => {
    lane.dockerCalls++;
    const child: any = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => true;
    let stdin = '';
    child.stdin.on('data', (d: Buffer) => { stdin += d; });
    setTimeout(() => {
      const text = args.join(' ');
      lane.calls.push({ args: text, stdin });
      const a = answer(`${text} ${stdin}`);
      if (a.hang) {
        child.kill = () => { setTimeout(() => child.emit('close', null), 1); return true; };
        return;
      }
      child.stdout.end(a.out);
      child.stderr.end(a.err);
      setTimeout(() => child.emit('close', a.code), 1);
    }, 5);
    return child;
  };
  return { ...real, execFile, spawn, default: { ...real, execFile, spawn } } as any;
}
