import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/docker/containerManager', async () => (await import('./migrate-fake')).cmMock());
vi.mock('../../src/env/manager', async (o) => (await import('./migrate-fake')).envMock(await o()));
vi.mock('../../src/instance/dbLogin', async (o) => (await import('./migrate-fake')).dbLoginMock(await o()));
vi.mock('../../src/instance/appHookClient', async (o) => (await import('./migrate-fake')).hookMock(await o()));
vi.mock('../../src/instance/maintenance', async (o) => (await import('./migrate-fake')).maintenanceMock(await o()));
vi.mock('../../src/instance/fleetBackup', async (o) => (await import('./migrate-fake')).fleetBackupMock(await o()));
vi.mock('../../src/instance/fleetReplica', async (o) => (await import('./migrate-fake')).fleetReplicaMock(await o()));
vi.mock('../../src/instance/fleetSwitch', async () => (await import('./migrate-fake')).fleetSwitchMock());

import { identityOf, laneDone, runMigration, MIGRATE_TIMING } from '../../src/instance/migrate';
import { fastTiming, m, resetMigrate, seedBot, COMPANION_URL, EXTERNAL_URL } from './migrate-fake';

beforeEach(() => { resetMigrate(); fastTiming(MIGRATE_TIMING); });

const rec = () => m.bots.b1.migrate;
const last = () => m.bots.b1.migrateLast;
const COMPANION = { host: 'b1-fleet-postgres', port: 5432, database: 'smdb' };
const MG_DEST_URL = (jobId: string, url: string) => `Migration ${jobId} is done, and the bot names b1-fleet-postgres:5432/smdb as the database the copy went to, but the Database URL names ${url}. The bot stays in Maintenance and its Data Backend is unchanged. Set the Database URL to b1-fleet-postgres:5432/smdb, then press Migrate.`;

async function press() {
  expect(await runMigration('b1', 'postgres', 'press')).toEqual({ accepted: true });
  await laneDone('b1');
}

/** A G3 park (awaiting 'destination') on a move to the companion, then the operator sets the stored URL to `url`. */
async function parkedThenUrl(url: string) {
  seedBot();
  m.bot.destination = { host: 'elsewhere.example', port: 5432, database: 'smdb' };
  await press();
  expect(rec()).toMatchObject({ phase: 'waiting', awaiting: 'destination', destination: 'b1-fleet-postgres:5432/smdb' });
  m.env.b1.DATA_BACKEND_URL = url;
  m.bot.destination = COMPANION;
  m.bot.journal = [];
  m.bot.script = [{ state: 'done', stage: 'switching' }];
}

async function g3a(url: string, shown: string) {
  await parkedThenUrl(url);
  const events = m.events.length;
  await press();
  const after = m.events.slice(events);
  const jobId = m.bot.posts[m.bot.posts.length - 1].jobId;
  expect(rec()).toMatchObject({ phase: 'waiting', resumeAt: 'following', awaiting: 'destination' });
  expect(rec().text).toBe(MG_DEST_URL(jobId, shown));
  expect(after.some(e => e.startsWith('env-inop'))).toBe(false);
  expect(after.some(e => e.startsWith('stop:'))).toBe(false);
  expect(after.some(e => e.startsWith('start'))).toBe(false);
  expect(m.env.b1.DATA_BACKEND).toBe('file');
  m.env.b1.DATA_BACKEND_URL = COMPANION_URL;
  await press();
  expect(m.events).toContain('record:finishing:confirmed');
  expect(last().outcome).toBe('done');
  expect(rec()).toBeUndefined();
}

describe('G3a: the job names the record\'s destination and the stored URL does not', () => {
  it('a blanked URL parks with MG-DEST-URL naming no database; setting the URL and pressing reaches confirmed', async () => {
    await g3a('', 'no database');
  });
  it('a URL naming another database parks with MG-DEST-URL naming it; setting the URL and pressing reaches confirmed', async () => {
    await g3a(EXTERNAL_URL, 'db.example.test:5432/app');
  });
  it('G1 on a move to the companion: the stored URL is the companion\'s and the move closes done', async () => {
    seedBot();
    await press();
    expect(m.env.b1.DATA_BACKEND_URL).toBe(COMPANION_URL);
    expect(m.events).toContain('record:finishing:confirmed');
    expect(last().outcome).toBe('done');
  });
});

describe('G3a with an env store the manager cannot read at done()', () => {
  const MG_DEST_URL_READ = (jobId: string) => `Migration ${jobId} is done, and the bot names b1-fleet-postgres:5432/smdb as the database the copy went to, but the env store for this bot cannot be read, so the manager can't tell which database the Database URL names. The bot stays in Maintenance and its Data Backend is unchanged. Set the Database URL to b1-fleet-postgres:5432/smdb, then press Migrate.`;
  async function unreadable(kind: 'corrupt' | 'url') {
    await parkedThenUrl(COMPANION_URL);
    const events = m.events.length;
    const posts = m.bot.posts.length;
    const bad = () => m.bot.posts.length > posts;
    m.envStatus = kind === 'corrupt'
      ? { undecryptable: [], get corrupt() { return bad(); } } as any
      : { corrupt: false, get undecryptable() { return bad() ? ['DATA_BACKEND_URL'] : []; } } as any;
    await press();
    const after = m.events.slice(events);
    const jobId = m.bot.posts[m.bot.posts.length - 1].jobId;
    expect(rec()).toMatchObject({ phase: 'waiting', resumeAt: 'following', awaiting: 'destination' });
    expect(rec().text).toBe(MG_DEST_URL_READ(jobId));
    expect(after.some(e => e.startsWith('env:') || e.startsWith('env-inop'))).toBe(false);
    expect(after.some(e => e.startsWith('stop:'))).toBe(false);
    expect(after.some(e => e.startsWith('start'))).toBe(false);
    expect(m.migrateWrites.some(w => w.rec?.phase === 'finishing')).toBe(false);
  }
  it('a corrupt store parks with MG-DEST-URL-READ', async () => { await unreadable('corrupt'); });
  it('an undecryptable url key parks with MG-DEST-URL-READ', async () => { await unreadable('url'); });
});

describe('D142: the companion step at M-prepare', () => {
  it('an env read that fails after the attach keeps the admitted destination', async () => {
    seedBot();
    let reads = 0;
    const status = m.envStatus;
    m.envStatus = { undecryptable: status.undecryptable, get corrupt() { return m.events.includes('db-start:b1') && reads++ === 0; } } as any;
    await press();
    expect(m.migrateWrites.some(w => w.rec && 'destination' in w.rec && w.rec.destination === null)).toBe(false);
    expect(m.migrateWrites.some(w => w.rec?.phase === 'finishing' && w.rec.destination === 'b1-fleet-postgres:5432/smdb')).toBe(true);
    expect(identityOf(m.bot.posts[0].url ?? COMPANION_URL)).toBe('b1-fleet-postgres:5432/smdb');
  });
});

describe('the confirm text shows the destination as the manager prints it', () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../../src/webui/public/index.html'), 'utf8');
  const fn = (name: string) => {
    const start = html.indexOf(`function ${name}(`);
    let i = html.indexOf('{', html.indexOf(')', start));
    for (let depth = 0; ; i++) {
      if (html[i] === '{') depth++;
      else if (html[i] === '}' && --depth === 0) return html.slice(start, i + 1);
    }
  };
  const ctx = vm.createContext({ String });
  vm.runInContext(fn('migrateConfirmText'), ctx);
  const view = (destination: string) => ({ to: 'postgres', companion: false, destination, sharers: [] });
  it('brackets an IPv6 host and leaves a named host as it is', () => {
    expect(ctx.migrateConfirmText({ displayName: 'B' }, view('fd00::1:5432/app'))).toMatch(/^Migrate B's data to Postgres at \[fd00::1\]:5432\/app\? /);
    expect(ctx.migrateConfirmText({ displayName: 'B' }, view('db.example:5432/app'))).toMatch(/^Migrate B's data to Postgres at db\.example:5432\/app\? /);
  });
});
