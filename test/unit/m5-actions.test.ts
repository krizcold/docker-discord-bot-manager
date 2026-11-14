import { describe, expect, it, vi } from 'vitest';
import {
  actionRows, boundOutcome, boundReadFailure, disableOutcome, dropOutcome, EnableForm, enableOutcome, seedCancelOutcome,
} from '../../src/cli/tui/actions';
import { Dialog } from '../../src/cli/tui/dialog';
import { seedParked, seedRunning } from './m5-fake';

type Reads = Parameters<typeof actionRows>[1];
const replication = (rep: Record<string, unknown>) => ({ ok: true as const, value: { replication: rep } });
const on = (live: Record<string, unknown> | undefined = { slotWalKeep: '4096MB', slots: [] }) => replication({ enabled: true, publicHost: 'db.example.net', hostPort: 15432, live });
const replica = (r: Record<string, unknown> | null) => ({ ok: true as const, value: { replica: r } });
const labels = (reads: Reads, layout: 'main' | 'copy' | 'none' = 'main') => actionRows(layout, reads).map((r) => r.label);

describe('m5 the Actions rows', () => {
  it('replication off offers Enable; on offers Disable; unbounded retention offers the bound', () => {
    expect(labels({ replication: replication({ enabled: false }) })).toEqual(['Enable replication']);
    expect(labels({ replication: ({ ok: true, value: {} }) })).toEqual(['Enable replication']);
    expect(labels({ replication: on() })).toEqual(['Disable replication']);
    expect(labels({ replication: on({ slotWalKeep: '-1', slots: [] }) })).toEqual(['Apply the 4096 MB WAL bound', 'Disable replication']);
    expect(labels({ replication: on(undefined) })).toEqual(['Disable replication']);
  });

  it('a drop row for each fleet slot that is not active, with the slot its press sends', () => {
    const rows = actionRows('main', { replication: on({ slotWalKeep: '4096MB', slots: [
      { slot: 'smdb_copy_a', fleet: true, active: true, machine: 'yundera' },
      { slot: 'smdb_copy_b', fleet: true, active: false, machine: 'hetzner' },
      { slot: 'smdb_copy_c', fleet: true, active: false, machine: null },
      { slot: 'other_slot', fleet: false, active: false },
    ] }) });
    expect(rows.map((r) => r.label)).toEqual(['Drop slot smdb_copy_b (the copy on hetzner)', 'Drop slot smdb_copy_c', 'Disable replication']);
    expect(rows.filter((r) => r.kind === 'drop').map((r) => (r as { slot: string }).slot)).toEqual(['smdb_copy_b', 'smdb_copy_c']);
  });

  it('the seed banner: Cancel while cancelable, none once cancel was requested or past cancelling, Dismiss for a stopped seed', () => {
    const rows = actionRows('main', { replica: replica(seedRunning()) });
    expect(rows).toEqual([{ kind: 'seed', label: 'Cancel the seed', startedAt: 1_700_000_000_000, parked: false }]);
    expect(labels({ replica: replica(seedRunning({ cancelRequested: true })) })).toEqual([]);
    expect(labels({ replica: replica(seedRunning({ cancelable: false })) })).toEqual([]);
    expect(actionRows('main', { replica: replica(seedParked()) })).toEqual([{ kind: 'seed', label: 'Dismiss the stopped seed', startedAt: 1_700_000_100_000, parked: true }]);
    expect(labels({ replica: replica({ ...seedRunning(), ...seedParked() }) })).toEqual(['Cancel the seed']);
    expect(labels({ replica: replica(null) })).toEqual([]);
  });

  it('a failed, unanswered or missing read offers nothing built from it', () => {
    for (const bad of [{ ok: false as const, text: 'Bot not found' }, { ok: null, text: 'the manager did not answer within 15 s' }]) {
      expect(labels({ replication: bad as never, replica: bad as never })).toEqual([]);
      expect(labels({ replication: bad as never, replica: replica(seedRunning()) })).toEqual(['Cancel the seed']);
      expect(labels({ replication: on(), replica: bad as never })).toEqual(['Disable replication']);
    }
    expect(labels({})).toEqual([]);
  });

  it('the copy layout offers none of the main\'s replication rows; the no-database layout offers nothing', () => {
    const all = { replication: on({ slotWalKeep: '-1', slots: [] }), replica: replica(seedRunning()) };
    expect(labels(all, 'copy')).toEqual(['Cancel the seed']);
    expect(labels({ replication: on({ slotWalKeep: '-1', slots: [] }) }, 'copy')).toEqual([]);
    expect(labels(all, 'none')).toEqual([]);
  });
});

describe('m5 the texts', () => {
  it('Enable: success with and without the URL kept, every note, refusal, page fallback and no answer', () => {
    expect(enableOutcome({ ok: true, value: { success: true } }).text).toBe('Replication enabled. Restart the instance to publish the port and apply the new database URL.');
    expect(enableOutcome({ ok: true, value: { success: true, certRotated: true, plainClientsKept: 2, urlKept: 'Kept.', addressesText: ' Took it.' } }).text)
      .toBe('Replication enabled. Restart the instance to publish the port. A new server certificate was installed: every other machine needs the new join code. The database keeps admitting connections without TLS from 2 address(es) outside 172.16.0.0/12 that the bot may still use on its old URL, until a start finds none of them connected that way. Kept. Took it.');
    expect(enableOutcome({ ok: true, value: { success: false, error: 'Invalid port' } })).toEqual({ ok: false, text: 'Invalid port' });
    expect(enableOutcome({ ok: true, value: { success: false } }).text).toBe('Failed to enable replication');
    expect(enableOutcome({ ok: null, text: 'socket hang up' }).text).toBe('No answer from the manager (socket hang up); the replication change may still be running. Check its state before trying again.');
  });

  it('the bound, the drop, the disable and the seed cancel', () => {
    expect(boundOutcome({ ok: true, value: { success: true } }).text).toBe('WAL retention bound applied (4096 MB). It takes effect immediately; wal_log_hints applies on the next restart.');
    expect(boundOutcome({ ok: true, value: {} }).text).toBe('Failed to apply the bound');
    expect(boundOutcome({ ok: null, text: 'x' }).text).toContain('the WAL bound change may still be running');
    expect(boundReadFailure({ ok: false, text: 'Bot not found' }).text).toBe('Could not read the replication settings (Bot not found), so the bound was not applied; nothing was sent.');
    expect(dropOutcome('s1', { ok: true, value: { success: true } }).text).toBe('Slot s1 dropped');
    expect(dropOutcome('s1', { ok: true, value: {} }).text).toBe('Failed to drop the slot');
    expect(dropOutcome('s1', { ok: null, text: 'x' }).text).toContain('the slot drop may still be running');
    expect(disableOutcome({ ok: true, value: { success: true, urlKept: 'U.', plainClientsKept: 1, addressesText: ' A.' } }).text)
      .toBe('Replication disabled. Restart the instance to apply. U. The database keeps admitting connections without TLS from 1 address(es) outside 172.16.0.0/12 that the bot may still use on its old URL, until a start finds none of them connected that way. A.');
    expect(disableOutcome({ ok: true, value: { success: false } }).text).toBe('Failed to disable replication');
    expect(seedCancelOutcome({ ok: true, value: { success: true } }).text).toBe('Cancel requested');
    expect(seedCancelOutcome({ ok: true, value: { success: true, dismissed: true } }).text).toBe('Dismissed');
    expect(seedCancelOutcome({ ok: true, value: { success: false } }).text).toBe('Failed to cancel the seed');
    expect(seedCancelOutcome({ ok: null, text: 'x' }).text).toContain('the seed cancel may still be running');
  });

  it('the Enable form checks numbers, then the host, and sends only the fields filled', () => {
    const f = new EnableForm();
    const type = (t: string) => f.key(t, {});
    expect(f.body()).toEqual({ refusal: 'Enter the public host or IP other machines will dial' });
    f.key('', { tab: true });
    type('15a');
    f.key('', { downArrow: true });
    type('x');
    expect(f.body()).toEqual({ refusal: 'Not a number: port, WAL bound. Fix it, then try again. Nothing was sent.' });
    f.key('', { backspace: true });
    type('2048');
    f.key('', { upArrow: true });
    f.key('', { backspace: true });
    f.key('', { backspace: true });
    type('5432');
    f.key('', { upArrow: true });
    type(' db.example.net ');
    expect(f.body()).toEqual({ enabled: true, publicHost: 'db.example.net', hostPort: 15432, slotWalKeepMb: 2048 });
    const g = new EnableForm();
    g.key('h', {});
    expect(g.body()).toEqual({ enabled: true, publicHost: 'h' });
    expect(g.key('', { return: true })).toBe('send');
    expect(g.key('', { escape: true })).toBe('leave');
  });
});

describe('m5 the scrolling dialog', () => {
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
  const make = (run = vi.fn()) => ({ d: new Dialog(['Head', ''], () => lines, 'Y Go', run), run });

  it('says Down More and ignores Y until the last line has been on screen, then Y confirms', () => {
    const { d } = make();
    let v = d.view(80, 12);
    expect(v.body).toEqual(['Head', '', ...lines.slice(0, 10)]);
    expect(v.keys).toBe('Down More  any other key Cancel');
    expect(d.key('y', {})).toBeNull();
    expect(d.key('', { pageDown: true })).toBeNull();
    v = d.view(80, 12);
    expect(v.body.slice(2)).toEqual(lines.slice(9, 19));
    expect(d.key('', { pageDown: true })).toBeNull();
    expect(d.key('', { pageDown: true })).toBeNull();
    v = d.view(80, 12);
    expect(v.body.at(-1)).toBe('line 30');
    expect(v.keys).toBe('Y Go  Up/Down Scroll  any other key Cancel');
    expect(d.key('', { upArrow: true })).toBeNull();
    v = d.view(80, 12);
    expect(v.keys).toBe('Y Go  Up/Down Scroll  any other key Cancel');
    expect(d.key('Y', {})).toBe('yes');
  });

  it('Down one line at a time reaches the end; PgUp and Up stop at the top', () => {
    const { d } = make();
    d.view(80, 12);
    for (let i = 0; i < 25; i++) d.key('', { downArrow: true });
    expect(d.view(80, 12).body.at(-1)).toBe('line 30');
    for (let i = 0; i < 5; i++) d.key('', { pageUp: true });
    expect(d.view(80, 12).body[2]).toBe('line 1');
  });

  it('takes Y only from an input that is exactly y or Y; any other key cancels, before or after the end', () => {
    const short = new Dialog([], () => ['Drop it?'], 'Y Drop', () => undefined);
    expect(short.view(80, 10).keys).toBe('Y Drop  any other key Cancel');
    expect(short.key('yy', {})).toBe('cancel');
    expect(short.key('n', {})).toBe('cancel');
    expect(short.key('', {})).toBe('cancel');
    expect(short.key('y', {})).toBe('yes');
    const { d } = make();
    d.view(80, 12);
    expect(d.key('q', {})).toBe('cancel');
  });

  it('only the newest view counts: a first draw with more room does not unlock Y', () => {
    const { d } = make();
    d.view(80, 40);
    d.view(80, 12);
    expect(d.key('y', {})).toBeNull();
  });
});
