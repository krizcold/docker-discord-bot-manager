import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/docker/containerManager', async () => (await import('./migrate-fake')).cmMock());
vi.mock('../../src/instance/fleetSwitch', async () => (await import('./migrate-fake')).fleetSwitchMock());

import {
  backendOf, destinationPlan, getVerdict, hookAnswer, interruptVerdict, keepDelay, mintJobId, postVerdict, refusalVerdict, sameDatabase, stageSide, MIGRATE_TIMING,
} from '../../src/instance/migrate';

const STAGES_BEFORE = ['checking', 'draining', 'reading', 'copying', 'verifying', 'rereading', 'committing', 'placing'];
const STAGES_PAST = ['retire-source', 'switching', 'env'];

describe('stageSide', () => {
  it.each(STAGES_BEFORE)('%s is before the switch', s => expect(stageSide(s)).toBe('before'));
  it.each(STAGES_PAST)('%s is past the switch', s => expect(stageSide(s)).toBe('past'));
  it('an unknown stage is neither, and reads as past where it counts', () => {
    expect(stageSide('defragmenting')).toBe('unknown');
    expect(stageSide(undefined)).toBe('unknown');
  });
});

describe('sameDatabase', () => {
  it.each([
    ['postgresql://a:b@DB.Example:5432/app', { host: 'db.example', port: 5432, database: 'app' }, true],
    ['postgresql://a:b@db.example/app', 'db.example:5432/app', true],
    ['postgresql://a:b@db.example:5432/app/', 'db.example:5432/app', true],
    ['postgresql://a:b@[::1]:5433/app', { host: '::1', port: 5433, database: 'app' }, true],
    ['postgresql://a:b@db.example:5432/app', 'db.example:5432/other', false],
    ['postgresql://a:b@db.example:5433/app', 'db.example:5432/app', false],
    [null, 'db.example:5432/app', false],
  ])('%s vs %j: %s', (a, b, want) => expect(sameDatabase(a as any, b as any)).toBe(want));
});

describe('mintJobId', () => {
  it('1000 ids fit contract 9 and differ', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const id = mintJobId();
      expect(id).toMatch(/^[A-Za-z0-9-]{8,40}$/);
      seen.add(id);
    }
    expect(seen.size).toBe(1000);
  });
});

describe('backendOf', () => {
  it.each([[{ DATA_BACKEND: 'postgres' }, 'postgres'], [{ DATA_BACKEND: ' Postgres ' }, 'postgres'], [{ DATA_BACKEND: 'file' }, 'file'], [{}, 'file'], [{ DATA_BACKEND: 'pg' }, 'file']])('%j is %s', (env, want) => {
    expect(backendOf(env as any)).toBe(want);
  });
});

describe('destinationPlan', () => {
  const inst = { sanitizedName: 'b1', fleetDb: undefined as any };
  const withDb = { sanitizedName: 'b1', fleetDb: { containerName: 'b1-fleet-postgres', user: 'smdb', db: 'smdb', volume: 'v', replication: { publicHost: 'pub.example', hostPort: 5433 } as any } };
  it('blank goes onto the companion', () => expect(destinationPlan(inst, '', 'postgres')).toEqual({ ok: true, companion: true, destination: 'b1-fleet-postgres:5432/smdb', url: '' }));
  it('the companion URL and its public host are the companion', () => {
    expect(destinationPlan(withDb, 'postgresql://smdb:p@b1-fleet-postgres:5432/smdb', 'postgres')).toMatchObject({ ok: true, companion: true });
    expect(destinationPlan(withDb, 'postgresql://smdb:p@pub.example:5433/smdb', 'postgres')).toMatchObject({ ok: true, companion: true });
  });
  it('an external URL is that database', () => expect(destinationPlan(inst, 'postgresql://u:p@db.example:5432/app', 'postgres')).toMatchObject({ ok: true, companion: false, destination: 'db.example:5432/app' }));
  it('a list, a join code and a bad scheme are refused', () => {
    expect(destinationPlan(inst, 'postgresql://u:p@a:5432/x,postgresql://u:p@b:5432/x', 'postgres')).toEqual({ ok: false, refusal: 'list' });
    expect(destinationPlan(inst, 'mysql://u:p@a/x', 'postgres')).toEqual({ ok: false, refusal: 'badurl' });
    expect(destinationPlan(inst, 'not a url', 'postgres')).toEqual({ ok: false, refusal: 'badurl' });
  });
  it('A13 (round 5) the companion spelled in upper case is the companion', () => {
    expect(destinationPlan(withDb, 'postgresql://smdb:p@B1-FLEET-POSTGRES:5432/smdb', 'postgres')).toMatchObject({ ok: true, companion: true });
  });
  it('A13 (round 5) the public host at another port than its hostPort is not the companion', () => {
    expect(destinationPlan(withDb, 'postgresql://smdb:p@pub.example:5432/smdb', 'postgres')).toMatchObject({ ok: true, companion: false });
  });
});

describe('the reader through destinationPlan (D88)', () => {
  const inst = { sanitizedName: 'b1', fleetDb: undefined as any };
  const plan = (url: string, env: Record<string, string> = {}) => (destinationPlan as any)(inst, url, 'postgres', 'smdb', env);
  it.each([
    ['postgresql://smdb:pw@b1-fleet-postgres:5432/smdb', {}, 'b1-fleet-postgres:5432/smdb'],
    ['POSTGRESQL://u:p@Db.Example.Test:5432/app#frag', {}, 'db.example.test:5432/app'],
    ['postgresql://u:p w@db.example.test:5432/app', {}, 'db.example.test:5432/app'],
    ['postgresql://u:p%zz@db.example.test:5432/app', {}, 'db.example.test:5432/app'],
    ['postgresql://u:p@db.example.test/app', {}, 'db.example.test:5432/app'],
    ['postgresql://u:p@[::1]:5433/db', {}, '::1:5433/db'],
    ['postgresql://u:p@db.example.test:5432/app', { PGPORT: '5433' }, 'db.example.test:5432/app'],
  ])('readable: %s with %j is %s', (url, env, destination) => {
    expect(plan(url, env)).toEqual({ ok: true, companion: false, destination, url });
  });
  it.each([
    ['postgresql://u:p@db.example.test:5432/app?host=s1-fleet-postgres', {}, 'param'],
    ['postgresql://u:p@db.example.test:5432/app?hostaddr=10.0.0.1', {}, 'param'],
    ['postgresql://u:p@pub.example:5432/x?port=5433', {}, 'param'],
    ['postgresql://a:b@h1:5432/smdb?sslmode=x,postgresql://a:b@h2:5432/smdb&host=s1', {}, 'param'],
    ['postgresql://u:p@s1%2Dfleet%2Dpostgres:5432/app', {}, 'encodedHost'],
    ['postgresql://u:p@h1,h2:5432/db', {}, 'hosts'],
    ['postgresql:///smdb', {}, 'noHost'],
    ['postgresql://u:p@db.example.test:5432', {}, 'noDatabase'],
    ['postgresql://u:p@db.example.test:5432/', {}, 'noDatabase'],
    ['postgresql://u:p@db.example.test:5432/smdb/', {}, 'databaseName'],
    ['postgresql://u:p@db.example.test:5432/a%2Cb', {}, 'databaseName'],
    ['postgresql://u:p@db.example.test/app', { PGPORT: '5433' }, 'pgport'],
  ])('a form: %s with %j is %s', (url, env, form) => {
    expect(plan(url, env)).toEqual({ ok: false, refusal: 'form', form });
  });
  it.each([
    'postgresql://u:p@/smdb?host=s1-fleet-postgres',
    'mysql://u:p@s1-fleet-postgres:5432/smdb',
    '//s1-fleet-postgres:5432/smdb',
    's1-fleet-postgres:5432/smdb',
  ])('(pin) %s is a bad URL', url => {
    expect(plan(url)).toEqual({ ok: false, refusal: 'badurl' });
  });
});

describe('keepDelay', () => {
  it('30, 60, 120, 240, 480 seconds', () => {
    expect([0, 1, 2, 3, 4, 9].map(keepDelay)).toEqual(MIGRATE_TIMING.keepDelaysMs.length === 5 ? [30_000, 60_000, 120_000, 240_000, 480_000, 480_000] : []);
  });
});

// The full product of state x same/other jobId x same/other `to` x started x kept.
const STATES = ['running', 'done', 'failed', 'interrupted'];
const ans = (job: any) => hookAnswer({ ok: true, status: 200, body: { success: true, job } }, 'GET');
const postAns = (body: any) => hookAnswer({ ok: true, status: 200, body: { success: true, ...body } }, 'POST');
const rows: Array<{ state: string; ours: boolean; same: boolean; started: number; kept: number; stage: string }> = [];
for (const state of STATES) for (const ours of [true, false]) for (const same of [true, false]) for (let started = 0; started <= 3; started++) for (let kept = 0; kept <= 5; kept++) for (const stage of ['copying', 'switching', 'mystery']) rows.push({ state, ours, same, started, kept, stage });

describe('the verdicts over every input', () => {
  it(`${rows.length} rows: only a done job of this \`to\` reaches the env store, and no job of this record past the switch closes`, () => {
    for (const r of rows) {
      const rec = { to: 'postgres' as const, jobId: 'mgr-ours', jobIds: ['mgr-ours'], started: r.started, kept: r.kept, posted: true };
      const job = { jobId: r.ours ? 'mgr-ours' : 'mgr-earlier', to: r.same ? 'postgres' : 'file', state: r.state, stage: r.stage };
      const past = r.ours && r.same && (r.state === 'running' || r.state === 'interrupted') && r.stage !== 'copying';
      const gv = getVerdict(ans(job), rec);
      const rv = refusalVerdict(ans(job), rec);
      const done = r.same && r.state === 'done';
      expect(gv.act === 'done', JSON.stringify(r)).toBe(done);
      expect(rv.act === 'done', JSON.stringify(r)).toBe(done);
      if (past) {
        expect(rv.act, JSON.stringify(r)).not.toBe('close');
        expect(gv.act, JSON.stringify(r)).not.toBe('failed');
      }
      if (r.ours && r.same && r.state === 'interrupted' && r.stage === 'copying') expect(gv.act).toBe(r.started < 3 ? 'again' : 'spent');
      const pv = postVerdict(postAns({ ...job, state: r.state === 'running' ? 'started' : r.state }), rec);
      if (!r.same) expect(pv.act).toBe('park');
      if (r.same && r.state === 'failed') expect(pv.act).toBe('failed');
    }
  });
  it('a finished job never counts as past the switch, whatever its last stage', () => {
    const rec = { to: 'file' as const, jobId: 'mgr-a', jobIds: ['mgr-a'], started: 0, kept: 0, posted: true };
    expect(refusalVerdict(ans({ jobId: 'mgr-a', to: 'file', state: 'failed', stage: 'switching' }), rec).act).toBe('close');
    expect(refusalVerdict(ans({ jobId: 'mgr-old', to: 'file', state: 'interrupted', stage: 'switching' }), rec).act).toBe('close');
    expect(refusalVerdict(ans({ jobId: 'mgr-a', to: 'file', state: 'interrupted', stage: 'switching' }), rec).act).toBe('keep');
  });
  it('interruptVerdict: before the switch POSTs again under the cap, past it keeps', () => {
    const rec = { to: 'file' as const, jobId: 'a', jobIds: ['a'], started: 2, kept: 0, posted: true };
    expect(interruptVerdict({ jobId: 'a', to: 'file', state: 'interrupted', stage: 'copying' }, rec).act).toBe('again');
    expect(interruptVerdict({ jobId: 'a', to: 'file', state: 'interrupted', stage: 'copying' }, { ...rec, started: 3 }).act).toBe('spent');
    expect(interruptVerdict({ jobId: 'a', to: 'file', state: 'interrupted', stage: 'env' }, rec).act).toBe('keep');
  });
});
