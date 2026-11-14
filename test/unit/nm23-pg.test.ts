import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import { CHECKSUM_SQL, COUNTS_SQL, parseChecksumLines, parseCountLines } from '../../src/instance/backupFiles';

const dockerRuns = process.platform !== 'win32' && (() => {
  try {
    return spawnSync('docker', ['version'], { stdio: 'ignore', timeout: 10000 }).status === 0;
  } catch {
    return false;
  }
})();

// The one container this file starts, removed by exact name.
const NAME = `nm23-pg-${process.pid}`;
const USER = 'app';

const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const run = (args: string[], input?: string) => {
  const r = spawnSync('docker', args, { encoding: 'utf-8', timeout: 300000, input });
  return { status: r.status, out: r.stdout || '', err: (r.stderr || '').trim() };
};
const viaArg = (sql: string) => run(['exec', NAME, 'psql', '-X', '-U', USER, '-d', USER, '-tA', '-v', 'ON_ERROR_STOP=1', '-c', sql]);
const viaStdin = (sql: string) => run(['exec', '-i', NAME, 'psql', '-X', '-q', '-tA', '-v', 'ON_ERROR_STOP=1', '-U', USER, '-d', USER], `${sql};\n`);
const viaShell = (sql: string) => run(['exec', NAME, 'sh', '-c', 'psql "$1" -v ON_ERROR_STOP=1 -Atc "$2"', 'sh', `postgres://${USER}:pw@127.0.0.1:5432/${USER}`, sql]);
const ok = (r: { status: number | null; out: string; err: string }) => {
  expect(r.status, r.err).toBe(0);
  return r.out;
};
const waitTcp = () => {
  for (let i = 0; i < 180; i++) {
    if (run(['exec', NAME, 'pg_isready', '-h', '127.0.0.1', '-q']).status === 0) return;
    pause(500);
  }
  throw new Error(`${NAME} did not become ready`);
};

const SCH = '"odd\\sch"';
const LF = '"lf\ntab"';
const CR = '"cr\rtab"';
const ALL = '"all\n\r\\n\\"';
const SCHEMA = [
  `CREATE SCHEMA ${SCH} AUTHORIZATION ${USER}`,
  `CREATE TABLE ${SCH}.plain (x int)`,
  `CREATE TABLE ${SCH}.${LF} (x int)`,
  `CREATE TABLE ${SCH}.${CR} (x int)`,
  `CREATE TABLE public.${ALL} (x int)`,
  `INSERT INTO ${SCH}.plain VALUES (1)`,
  `INSERT INTO ${SCH}.${LF} VALUES (1), (2)`,
  `INSERT INTO ${SCH}.${CR} VALUES (1), (2), (3)`,
  `INSERT INTO public.${ALL} VALUES (1), (2), (3), (4)`,
].join(';\n');

const KEYS: Record<string, number> = { [`${SCH}.plain`]: 1, [`${SCH}.${LF}`]: 2, [`${SCH}.${CR}`]: 3, [`public.${ALL}`]: 4 };

describe.skipIf(!dockerRuns)('NM23 names with line breaks and backslashes against a real Postgres 16 (Linux with docker)', () => {
  beforeAll(() => {
    const started = run(['run', '-d', '--name', NAME, '-e', `POSTGRES_USER=${USER}`, '-e', 'POSTGRES_PASSWORD=pw', '-e', `POSTGRES_DB=${USER}`, 'postgres:16-alpine']);
    expect(started.status, started.err).toBe(0);
    waitTcp();
    ok(viaStdin(SCHEMA));
  }, 300000);

  afterAll(() => {
    run(['rm', '-f', '-v', NAME]);
  }, 120000);

  it('PG1 the keys are the exact format(%I.%I) text', () => {
    const real = ok(viaArg("SELECT string_agg(format('%I.%I', n.nspname, c.relname), '|' ORDER BY n.nspname, c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind = 'r' AND n.nspname IN ('odd\\sch', 'public')"));
    expect(real.replace(/\n$/, '').split('|').sort()).toEqual(Object.keys(KEYS).sort());
  });

  it.each([['-c', viaArg], ['stdin', viaStdin], ['the receiver shell', viaShell]])('PG2 COUNTS_SQL through %s gives every key and its count', (_how, through) => {
    expect(parseCountLines(ok(through(COUNTS_SQL)))).toEqual({ ok: true, counts: KEYS });
  });

  it.each([['-c', viaArg], ['stdin', viaStdin], ['the receiver shell', viaShell]])('PG3 CHECKSUM_SQL through %s gives every key', (_how, through) => {
    const parsed = parseChecksumLines(ok(through(CHECKSUM_SQL)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(Object.keys(parsed.sums).sort()).toEqual(Object.keys(KEYS).sort());
    for (const h of Object.values(parsed.sums)) expect(h).toMatch(/^[0-9a-f]{32}$/);
  });
});
