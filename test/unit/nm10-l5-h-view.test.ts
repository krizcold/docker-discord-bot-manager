import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/docker/containerManager', async () => (await import('./migrate-fake')).cmMock());
vi.mock('../../src/env/manager', async (o) => (await import('./migrate-fake')).envMock(await o()));
vi.mock('../../src/instance/dbLogin', async (o) => (await import('./migrate-fake')).dbLoginMock(await o()));
vi.mock('../../src/instance/appHookClient', async (o) => (await import('./migrate-fake')).hookMock(await o()));
vi.mock('../../src/instance/maintenance', async (o) => (await import('./migrate-fake')).maintenanceMock(await o()));
vi.mock('../../src/instance/fleetBackup', async (o) => (await import('./migrate-fake')).fleetBackupMock(await o()));
vi.mock('../../src/instance/fleetReplica', async (o) => (await import('./migrate-fake')).fleetReplicaMock(await o()));
vi.mock('../../src/instance/fleetSwitch', async () => (await import('./migrate-fake')).fleetSwitchMock());

import { destinationPlan, migrateView, MIGRATE_TIMING } from '../../src/instance/migrate';
import { fastTiming, m, resetMigrate, seedBot, seedSharer, COMPANION_URL, EXTERNAL_URL, FLEET_DB, SETTLED } from './migrate-fake';

beforeEach(() => { resetMigrate(); fastTiming(MIGRATE_TIMING); });

const view = () => migrateView(m.bots.b1);
const R8 = "The env store for this instance cannot be read, so the manager can't tell which database the bot uses; nothing was changed";
const RUNNING = 'Migrate runs with the bot in Maintenance; choose Maintenance in State first; nothing was changed';
const OFF = 'The bot is Off, and Migrate needs it running in Maintenance; choose Maintenance in State first; nothing was changed';
const companionDest = () => {
  const p = destinationPlan(m.bots.b1, '', 'postgres');
  return p.ok ? p.destination : 'no plan';
};

describe('migrateView: the State window control (L5 h)', () => {
  it('VH1 an app without the companion setting: hidden, with no destination, companion or fence', () => {
    seedBot({ inst: { sourceUrl: 'https://github.com/x/some-other-app' } });
    expect(view()).toEqual({ hidden: true, to: null, refusal: null, record: null, last: null, destination: null, companion: false, sharers: [], fenced: false });
  });
  it('VH2 an unreadable env store: shown with the env refusal', () => {
    seedBot();
    m.envStatus.corrupt = true;
    expect(view()).toEqual({ hidden: false, to: null, refusal: R8, record: null, last: null, destination: null, companion: false, sharers: [], fenced: false });
  });
  it('VH3 a JSON bot in settled Maintenance with no Database URL: no refusal, the companion destination, no sharers', () => {
    seedBot();
    seedSharer('s2');
    expect(view()).toEqual({ hidden: false, to: 'postgres', refusal: null, record: null, last: null, destination: companionDest(), companion: true, sharers: [], fenced: false });
    expect(companionDest()).not.toBeNull();
  });
  it('VH4 a JSON bot whose Database URL names an outside database: no sharers named, not fenced, not the companion', () => {
    seedBot({ url: EXTERNAL_URL });
    seedSharer('s2');
    const v = view();
    expect(v.sharers).toEqual([]);
    expect(v.companion).toBe(false);
    expect(v.fenced).toBe(false);
  });
  it('VH5 a bot Running: the Running refusal', () => {
    seedBot({ inst: { maintenance: { ...SETTLED, state: 'running', savedByBot: null } } });
    expect(view().refusal).toBe(RUNNING);
  });
  it('VH6 a bot Off: the Off refusal', () => {
    seedBot({ inst: { maintenance: { ...SETTLED, state: 'off', savedByBot: null } } });
    expect(view().refusal).toBe(OFF);
  });
  it('VH7 an unconfirmed Maintenance with no stored error: the refusal says the order has not finished', () => {
    seedBot({ inst: { maintenance: { ...SETTLED, settled: false } } });
    expect(view().refusal).toBe("The bot's change to Maintenance is not confirmed yet (the order has not finished), and Migrate waits for a confirmed Maintenance; nothing was changed");
  });
  it('VH8 a Postgres bot on its companion: the other bots on its database by name, not itself, and the fence', () => {
    seedBot({ postgres: true });
    seedSharer('s2');
    expect(view()).toEqual({ hidden: false, to: 'file', refusal: null, record: null, last: null, destination: null, companion: false, sharers: ['S2'], fenced: true });
  });
  it('VH9 a Postgres bot whose Database URL is blank spaces: the companion by default, and no sharers named', () => {
    seedBot({ postgres: true, url: '   ' });
    seedSharer('s2');
    expect(view().sharers).toEqual([]);
  });
  it('VH10 a Postgres bot on an outside database: not fenced', () => {
    seedBot({ external: true });
    expect(view().fenced).toBe(false);
  });
  it('VH11 a migration to Postgres past its switch, the stored backend already postgres: the record direction, not fenced', () => {
    seedBot({ postgres: true });
    m.bots.b1.migrate = { to: 'postgres', from: 'file', destination: 'b1-fleet-postgres:5432/smdb', companion: true, jobId: 'mgr-a', jobIds: ['mgr-a'], posted: true, started: 1, kept: 0, phase: 'finishing', loginOpened: true, sharers: [], sharersStopped: [], openedAt: '2026-10-31T00:00:00.000Z', text: 'x' };
    expect(m.bots.b1.fleetDb).toEqual(FLEET_DB);
    expect(m.env.b1.DATA_BACKEND_URL).toBe(COMPANION_URL);
    const v = view();
    expect(v.to).toBe('postgres');
    expect(v.fenced).toBe(false);
  });
});
