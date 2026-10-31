import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm5-l5-e-view-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
});

vi.mock('child_process', async (o) => (await import('./switch-harness')).childProcessMock(await o()));
vi.mock('../../src/instance/dbLogin', async (o) => (await import('./switch-harness')).dbLoginMock(await o()));
vi.mock('../../src/docker/containerManager', async (o) => (await import('./switch-harness')).containerManagerMock(await o()));

import { switchView } from '../../src/instance/fleetSwitch';
import { utcText } from '../../src/instance/backupFiles';

const AT = '2026-10-30T09:00:00.000Z';
const WHEN = '2026-10-30 09:00 UTC';
const base = (fleetDb: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}) => ({ id: 'a', displayName: 'A', fleetDb: fleetDb && { containerName: 'a-pg', user: 'app', db: 'app', ...fleetDb }, ...extra }) as any;
const REPLACED = { machine: 'copy.example', host: 'copy.example', port: 5434, generation: 5, own: 4, since: '2026-10-29T08:00:00.000Z', at: AT, cert: 'x' };
const REPLACED_LINE = "copy.example replaced this database as the main on 2026-10-29 08:00 UTC (generation 5, this one 4). The manager blocked the bot's database login here so nothing writes to it. Rejoin this machine as a copy.";
const CONFLICT = { machine: 'b.example', host: 'b.example', port: 5440, generation: 3, at: AT, cert: 'x' };
const CONFLICT_LINE = "Two databases of A are mains with the same generation 3: this one and b.example (b.example:5440). The manager blocked the bot's database login here, so no bot writes to this database until you choose; b.example's manager does the same when it finds this one (it checks every 5 minutes while it can reach it). Keep this machine as the main raises this one's generation and opens the login here; or rejoin this machine as a copy of b.example, which replaces this database after a dump of it.";

describe('L5 e: the switch view texts', () => {
  it('a stream hand-over waiting: the not-finished line and badge only', () => {
    const v = switchView(base({ handover: { mode: 'stream', phase: 'waiting', machine: 'copy.example', host: 'copy.example', port: 5434, generation: 4, at: AT } }));
    expect(v.lines).toEqual(['The hand-over did not finish. Press Hand over again, or Cancel the hand-over.']);
    expect(v.badges).toEqual([{ text: 'Hand-over not finished', title: 'Press Hand over again, or Cancel the hand-over', danger: true }]);
  });
  it('a stopped stream hand-over with no machine name reads another machine', () => {
    const v = switchView(base({ handover: { mode: 'stream', phase: 'stopped', host: 'copy.example', port: 5434, generation: 4, at: AT } }));
    const title = `Handed over to another machine on ${WHEN}. This machine rejoins as its copy once another machine is the main; last check: not checked yet.`;
    expect(v.lines).toEqual([title]);
    expect(v.badges).toEqual([{ text: 'Handed over', title, danger: false }]);
  });
  it('a push move done: the recorded line, its error, and the handed-over badge', () => {
    const v = switchView(base({ handover: { mode: 'push', phase: 'done', machine: 'copy.example', generation: 4, at: AT, lastError: 'the push broke' } }));
    expect(v.lines).toEqual(['A move is recorded: a push to copy.example.', 'the push broke']);
    expect(v.badges).toEqual([{ text: 'Handed over', title: 'a push to copy.example', danger: false }]);
  });
  it('a push move waiting: not finished, and a danger badge', () => {
    const v = switchView(base({ handover: { mode: 'push', phase: 'waiting', machine: 'copy.example', generation: 4, at: AT } }));
    expect(v.lines).toEqual(['A move is recorded: a push to copy.example, not finished.']);
    expect(v.badges).toEqual([{ text: 'Hand-over not finished', title: 'a push to copy.example', danger: true }]);
  });
  it('a receive: the waiting line and the Receiving badge', () => {
    const v = switchView(base({ receive: { startedAt: AT, expiresAt: AT, safetyDump: 'pre.dump' } }));
    expect(v.lines).toEqual([`Waiting for a push until ${WHEN}.`]);
    expect(v.badges).toEqual([{ text: 'Receiving', title: `Waiting for a push until ${WHEN}`, danger: false }]);
  });
  it('replaced, with since and no clauses: the line names since, and the badge title is the line', () => {
    const v = switchView(base({ replacedBy: REPLACED }));
    expect(v.lines).toEqual([REPLACED_LINE]);
    expect(v.badges).toEqual([{ text: 'Replaced by copy.example', title: REPLACED_LINE, danger: true }]);
  });
  it('replaced with a block error and an Off error with no reason', () => {
    const v = switchView(base({ replacedBy: { ...REPLACED, blockError: 'denied', off: { state: 'error' } } }));
    expect(v.lines).toEqual([`${REPLACED_LINE} The login could not be blocked (denied); the manager tries again every 5 minutes. The manager could not put the bot in Off yet (no reason given); it tries again every minute, and the bot's database login stays blocked.`]);
  });
  const triedAt = Date.parse(AT);
  it.each([
    ['posted in DMs', { state: 'posted', place: 'dm', triedAt }, ` The owner was told on ${utcText(triedAt)} (in the owner's DMs).`],
    ['posted in the channel with a note', { state: 'posted', place: 'channel', note: 'pinned', triedAt }, ` The owner was told on ${utcText(triedAt)} (in the owner messages channel). pinned`],
    ['a repeat with no note', { state: 'repeat', triedAt }, ' The bot had already posted this message: no reason given'],
    ['failed with no error', { state: 'failed', triedAt }, ' The message to the owner was not posted (no reason given); the manager tries again every hour.'],
    ['unknown with no error', { state: 'unknown', triedAt }, " Whether the message to the owner was posted can't be confirmed (no reason given); the manager sends it again within an hour, and the bot drops a repeat."],
  ])('the owner message clause: %s', (_n, dm, clause) => {
    expect(switchView(base({ replacedBy: { ...REPLACED, dm } })).lines).toEqual([`${REPLACED_LINE}${clause}`]);
  });
  it('two mains: the line, and the badge titled with it', () => {
    const v = switchView(base({ mainConflict: CONFLICT }));
    expect(v.lines).toEqual([CONFLICT_LINE]);
    expect(v.badges).toEqual([{ text: 'Two mains', title: CONFLICT_LINE, danger: true }]);
  });
  it('a list offer pending or refused with no error reads no reason given', () => {
    expect(switchView(base({}, { addressesPush: { state: 'pending' } })).lines).toEqual(["The manager can't confirm that the running bot took its new database list (no reason given); it sends the list again every minute until the bot answers."]);
    expect(switchView(base({}, { addressesPush: { state: 'refused' } })).lines).toEqual(['The bot refused its new database list (no reason given); it uses the list from its next start (Apply on the card, or Restart).']);
  });
  it('a take-over not finished: the line and badge', () => {
    const v = switchView(base(undefined, { fleetDbReplica: { takeover: { planned: true, generation: 4 } } }));
    expect(v.lines).toEqual(['A take-over did not finish. Press Take over again.']);
    expect(v.badges).toEqual([{ text: 'Take-over not finished', title: 'Press Take over again', danger: true }]);
    expect(v.takeover).toEqual({ planned: true, generation: 4 });
  });
  it('a main with nothing recorded shows no line', () => {
    expect(switchView(base({}))).toMatchObject({ lines: [], badges: [] });
  });
});
