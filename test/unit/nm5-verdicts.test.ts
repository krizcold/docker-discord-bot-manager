import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm5-verdicts-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
});

import { composeJoinCode, dmDue, formerVerdict, heldVerdict, noticeDue, noticeState, OldMain, peerCode, peerVerdict, rejoinDue, replacedPlan, takeoverMode, ModeInput } from '../../src/instance/fleetSwitch';
import { addressesState } from '../../src/instance/fleetJoin';
import {
  ensureGenerationSql, GENERATION_SCHEMA_SQL, generationAfterRestore, generationBefore, GenRow, parseGenRow, parseRestoreState, pushBrokenOf, raiseSql,
  markIdOf, parseReceiveMark, receiveMarkClearSql, receiveMarkSql, receiveMarkVerdict, replicationRoleEnsureSql, restoreStateUpsertSql,
} from '../../src/instance/switchSql';
import { decodeJoinCode, decodeMoveCode, encodeJoinCode, encodeMoveCode, isMoveCode } from '../../src/config/joinCode';
import { compareChecksums, parseChecksumLines } from '../../src/instance/backupFiles';
import { COPY_FP, COPY_PEM, FIXTURE_FP, FIXTURE_PEM, fakeJoin } from './join-fake';

const held = (state: string, extra: Record<string, number> = {}) => ({ state, ...extra } as any);

describe('heldVerdict over every answer and confirm', () => {
  const cases: Array<[string, boolean, string]> = [];
  for (const s of ['yes', 'not-running', 'stopped', 'no', 'unknown', 'absent']) for (const c of [false, true]) cases.push([s, c, '']);
  it.each(cases)('%s with confirm %s', (state, confirm) => {
    const v = heldVerdict(state === 'absent' ? undefined : state === 'no' ? held('no', { guilds: 2, files: 1 }) : held(state), confirm, 'hand-over', 'no answer within 30 seconds');
    if (state === 'yes' || state === 'not-running' || (state === 'stopped' && confirm)) expect(v).toEqual({ go: true });
    else if (state === 'stopped') expect(v).toEqual({ ask: 'The bot was stopped without confirming that it saved what it held. Whatever it had not saved was lost at that stop, not by this hand-over, which loses nothing more. Hand over anyway?' });
    else if (state === 'no') expect(v).toEqual({ refuse: "The bot reports changes it could not save (2 guild(s), 1 file(s)), so the hand-over was refused and nothing was changed: a hand-over now would leave them behind. Choose Maintenance again so the bot tries the save again; the bot's log names what it could not save." });
    else if (state === 'unknown') expect(v).toEqual({ refuse: 'The bot could not confirm that it saved every change it holds, so the hand-over was refused and nothing was changed. Choose Maintenance again; the bot answers whether its changes are saved.' });
    else expect(v).toEqual({ refuse: "The bot did not answer the maintenance order (no answer within 30 seconds), so the manager can't confirm it saved the changes it holds; the hand-over was refused and nothing was changed. Choose Maintenance again while the bot runs, or choose Off." });
  });
  it('push and move name themselves', () => {
    expect(heldVerdict(held('unknown'), false, 'push')).toEqual({ refuse: expect.stringContaining('so the push was refused') });
    expect(heldVerdict(held('stopped'), false, 'move')).toEqual({ ask: expect.stringMatching(/not by this move, which loses nothing more\. Make the backup anyway\?$/) });
  });
});

describe('takeoverMode against an oracle, exhaustively', () => {
  const oldMains: OldMain[] = ['writable', 'in-recovery', 'fenced', 'unreachable', 'login-refused', 'other-system', 'no-code'];
  const intents = [null, { generation: 9, planned: true }, { generation: 9, planned: false, inherit: { file: 'f.dump', at: '2026-10-28T00:00:00Z' } }];
  const handovers = [null, { slot: 's', generation: 4, machine: 'b' }, { slot: 's', generation: 7, machine: 'b' }, { slot: 'other', generation: 4, machine: 'x' }];
  const restores = [null, { pending: true, file: 'r.dump', at: '2026-10-28T01:00:00Z' }, { pending: false, file: 'r.dump', at: '2026-10-28T01:00:00Z' }];
  const rows: ModeInput[] = [];
  for (const inRecovery of [true, false]) for (const intent of intents) for (const handover of handovers) for (const oldMain of oldMains) for (const restore of restores) for (const confirm of [false, true]) {
    rows.push({ inRecovery, intent, handover, oldMain, restore, confirm, gen: 3, slot: 's' });
  }
  const oracle = (p: ModeInput) => {
    const inherit = p.restore?.pending ? { file: p.restore.file, at: p.restore.at } : undefined;
    if (!p.inRecovery && p.intent) return { mode: 'resume', target: 9, ...(p.intent.inherit ? { inherit: p.intent.inherit } : {}) };
    if (!p.inRecovery && p.oldMain === 'writable') return { refusal: 'TK-MAINUP-P' };
    if (!p.inRecovery && p.oldMain === 'fenced') return { refusal: 'TK-MAINFENCED-P' };
    if (!p.inRecovery && p.oldMain === 'in-recovery') return { refusal: 'TK-MAINCOPY' };
    if (!p.inRecovery) return { mode: 'promoted', target: 4, ...(inherit ? { inherit } : {}), ...(p.confirm ? {} : { ask: 'W-PROMOTED' }) };
    if (p.oldMain === 'writable') return { refusal: 'TK-MAINUP' };
    if (p.oldMain === 'fenced') return { refusal: 'TK-MAINFENCED' };
    if (p.oldMain === 'in-recovery') return { refusal: 'TK-MAINCOPY' };
    if (p.handover?.slot === 's' && p.handover.generation === 4) return { mode: 'planned', target: 4 };
    if (p.handover && p.handover.slot !== 's') return { refusal: 'TK-OTHER' };
    return { mode: 'unplanned', target: 4, ...(inherit ? { inherit } : {}), ...(p.confirm ? {} : { ask: 'W-UNPLANNED' }) };
  };
  it(`agrees on all ${rows.length} combinations`, () => {
    for (const p of rows) expect(takeoverMode(p), JSON.stringify(p)).toEqual(oracle(p));
  });
  it('a planned row never inherits the restore record (T34)', () => {
    expect(takeoverMode({ inRecovery: true, intent: null, handover: { slot: 's', generation: 4, machine: 'b' }, oldMain: 'unreachable', restore: { pending: true, file: 'x', at: 'y' }, confirm: false, gen: 3, slot: 's' }))
      .toEqual({ mode: 'planned', target: 4 });
  });
  it.each(oldMains.flatMap(oldMain => [false, true].map(confirm => [oldMain, confirm] as const)))('T22, T49 to T51: promoted, no intent, the old main %s, confirm %s', (oldMain, confirm) => {
    const p: ModeInput = { inRecovery: false, intent: null, handover: null, oldMain, restore: null, confirm, gen: 3, slot: 's' };
    expect(takeoverMode(p)).toEqual(oracle(p));
  });
  it('gen absent counts as 0', () => {
    expect(takeoverMode({ inRecovery: true, intent: null, handover: { slot: 's', generation: 1, machine: 'b' }, oldMain: 'no-code', restore: null, confirm: false, gen: null, slot: 's' }))
      .toEqual({ mode: 'planned', target: 1 });
  });
});

describe('peerVerdict', () => {
  const peer = (kind: string, gen: number | null, sys = '7001') => (kind === 'writable' || kind === 'in-recovery'
    ? { kind, systemId: sys, timeline: 2, gen: gen === null ? null : { generation: gen, machine: 'b', since: null } }
    : { kind, reason: 'x', systemId: sys }) as any;
  it.each([
    [peer('in-recovery', 9), 'none'], [peer('writable', 9, '8000'), 'none'], [peer('writable', 6), 'replaced'], [peer('writable', 5), 'tie'],
    [peer('writable', 4), 'none'], [peer('writable', null), 'none'], [peer('unreachable', null), 'unknown'], [peer('login-refused', null), 'unknown'],
    [peer('fenced', null), 'unknown'], [null, 'unknown'],
  ])('%j -> %s', (p, want) => {
    expect(peerVerdict(5, p, '7001')).toBe(want);
  });
});

describe('generationBefore', () => {
  const g = (n: number | null): GenRow | null => (n === null ? null : { generation: n, machine: `m${n}`, since: null });
  const values = [null, 0, 2, 3, 4];
  it.each(values.flatMap(l => values.map(f => [l, f] as const)))('live %s floor %s', (l, f) => {
    const live = g(l);
    const floor = g(f);
    const lv = l ?? 0;
    const fv = f ?? 0;
    const want = lv === 0 && fv === 0 ? null : fv > lv ? floor : live && lv > 0 ? live : floor;
    expect(generationBefore(live, floor)).toEqual(want);
  });
});

describe('generationAfterRestore', () => {
  const b = { generation: 5, machine: 'a', since: '2026-10-28T10:00:00Z' };
  const r = { generation: 7, machine: 'x', since: null };
  it.each([
    [b, r, 8], [b, null, 6], [null, r, 8], [null, null, 1], [{ ...b, generation: 9 }, r, 10],
  ] as const)('before %j restored %j -> %i, whatever the file kind (D34)', (before, restored, want) => {
    expect(generationAfterRestore(before, restored, 'me', 'now')).toEqual({ generation: want, machine: 'me', since: 'now' });
  });
});

describe('parse rows', () => {
  it('reads a generation line, 0 as none, and refuses anything else', () => {
    expect(parseGenRow('3|main.example|2026-10-28T10:00:00Z\n')).toEqual({ generation: 3, machine: 'main.example', since: '2026-10-28T10:00:00Z' });
    expect(parseGenRow('0||')).toBeNull();
    expect(parseGenRow('')).toBeUndefined();
    expect(parseGenRow('x|y|z')).toBeUndefined();
  });
  it('reads the restore record', () => {
    expect(parseRestoreState('true|a.dump|2026-10-28T01:00:00Z|4|m|2026-10-27T00:00:00Z')).toEqual({ pending: true, file: 'a.dump', at: '2026-10-28T01:00:00Z', floor: { generation: 4, machine: 'm', since: '2026-10-27T00:00:00Z' } });
    expect(parseRestoreState('')).toBeNull();
    expect(parseRestoreState('maybe|a|b|1|m|')).toBeUndefined();
  });
});

describe('noticeDue and rejoinDue', () => {
  const row = { generation: 4, machine: 'b', since: null };
  it.each([
    [row, undefined, true, true], [{ ...row, generation: 1 }, undefined, true, false], [row, undefined, false, false],
    [row, { generation: 3, machine: 'b', since: null, state: 'sent' }, true, true],
    [row, { generation: 4, machine: 'b', since: null, state: 'sent', triedAt: 0 }, true, false],
    [row, { generation: 4, machine: 'b', since: null, state: 'pending', triedAt: 0 }, true, true],
    [row, { generation: 4, machine: 'b', since: null, state: 'unknown', triedAt: Date.now() }, true, false],
    [row, { generation: 4, machine: 'b', since: null, state: 'unsupported', triedAt: 0 }, true, false],
  ] as const)('%j %j app %s -> %s', (r, rec, app, want) => {
    expect(noticeDue(r, rec as any, Date.now(), app)).toBe(want);
  });
  const mark = { mode: 'stream', phase: 'stopped', at: 'x', host: 'b', port: 1, cert: 'c', machine: 'b', generation: 4 } as any;
  const w = (g: number, sys = '7001', receiveMark: boolean | null = false) => ({ kind: 'writable', systemId: sys, timeline: 2, gen: { generation: g, machine: 'b', since: null }, receiveMark }) as any;
  it.each([
    [mark, w(4), true], [mark, w(3), false], [{ ...mark, phase: 'waiting' }, w(4), false], [{ ...mark, host: undefined }, w(4), false],
    [mark, { kind: 'in-recovery', systemId: '7001', timeline: 1, gen: null }, false], [mark, w(4, '9'), false],
    [{ ...mark, rejoinTriedAt: Date.now() }, w(4), false], [{ ...mark, rejoinTriedAt: Date.now() - 31 * 60_000 }, w(4), true],
    [mark, w(4, '7001', true), false], [mark, w(4, '7001', null), false],
    [mark, { ...w(4), gen: { generation: 4, machine: 'win.local', since: null } }, true],
  ])('%#', (m, p, want) => {
    expect(rejoinDue(m, p, Date.now(), '7001')).toBe(want);
  });
});

describe('the move code', () => {
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed; };
  const tame = (n: number) => Array.from({ length: n }, () => 'abcdefghijklmnopqrstuvwxyz0123456789._~-'[rnd() % 40]).join('');
  it('300 seeded codes round trip', () => {
    for (let i = 0; i < 300; i++) {
      const id = Array.from({ length: 24 }, () => '0123456789abcdef'[rnd() % 16]).join('');
      const code = { ...fakeJoin({ host: `h${tame(5)}.example`, port: 1 + (rnd() % 65535), machine: `m ${tame(6)}` }), recv: { user: 'smdb_receive', password: tame(32), id } };
      const text = encodeMoveCode(code);
      expect(isMoveCode(text)).toBe(true);
      expect(decodeMoveCode(text)).toEqual({ ok: true, code });
    }
  });
  it('a code without the receive id, or with a malformed one, is refused (D41)', () => {
    const base = { ...fakeJoin(), recv: { user: 'smdb_receive', password: 'p', id: '0123456789abcdef01234567' } };
    const enc = (o: Record<string, unknown>) => `smdbmove1.${Buffer.from(JSON.stringify(o)).toString('base64url')}`;
    expect(decodeMoveCode(enc(base))).toEqual({ ok: true, code: base });
    for (const id of [undefined, '', '0123456789abcdef0123456', '0123456789ABCDEF01234567', '0123456789abcdef012345678', 'g123456789abcdef01234567', 7]) {
      expect(decodeMoveCode(enc({ ...base, recv: { user: 'smdb_receive', password: 'p', id } }))).toEqual({ ok: false, why: 'it names no valid receive id' });
    }
  });
  it('each rejected field', () => {
    const base = { ...fakeJoin(), recv: { user: 'smdb_receive', password: 'p', id: '0123456789abcdef01234567' } };
    const enc = (o: Record<string, unknown>) => `smdbmove1.${Buffer.from(JSON.stringify(o)).toString('base64url')}`;
    expect(decodeMoveCode(enc({ ...base, recv: undefined }))).toEqual({ ok: false, why: 'it names no valid receive' });
    expect(decodeMoveCode(enc({ ...base, recv: { user: 'a b', password: 'p' } }))).toEqual({ ok: false, why: 'it names no valid receive user' });
    expect(decodeMoveCode(enc({ ...base, recv: { user: 'u', password: 'p p' } }))).toEqual({ ok: false, why: 'it names no valid receive password' });
    expect(decodeMoveCode(enc({ ...base, port: 0 }))).toEqual({ ok: false, why: 'it names no valid port' });
    expect(decodeMoveCode(enc({ ...base, fp: 'x' }))).toEqual({ ok: false, why: 'it names no valid fingerprint' });
    expect(decodeMoveCode('smdbmove1.!!')).toEqual({ ok: false, why: 'it is damaged (it does not decode)' });
  });
  it('a join code is not a move code, and back', () => {
    const join = encodeJoinCode(fakeJoin());
    expect(decodeMoveCode(join)).toEqual({ ok: false, why: 'it does not start with smdbmove1.' });
    const move = encodeMoveCode({ ...fakeJoin(), recv: { user: 'smdb_receive', password: 'p', id: '0123456789abcdef01234567' } });
    expect(decodeJoinCode(move)).toEqual({ ok: false, why: 'it does not start with smdbjoin1.' });
  });
});

describe('checksums', () => {
  const h = (c: string) => c.repeat(32);
  it('parses lines and refuses a value that is not an md5', () => {
    expect(parseChecksumLines(`checksum|"public"."t"|${h('a')}\nnoise\nchecksum|"s"."u"|${h('b')}\n`)).toEqual({ ok: true, sums: { '"public"."t"': h('a'), '"s"."u"': h('b') } });
    expect(parseChecksumLines('checksum|"public"."t"|xyz')).toEqual({ ok: false, error: 'a table checksum read back as checksum|"public"."t"|xyz' });
  });
  it('a table missing on either side differs, as does a different sum', () => {
    expect(compareChecksums({ t: h('a') }, { t: h('a') })).toEqual({ ok: true, text: '' });
    expect(compareChecksums({ t: h('a') }, { t: h('b') })).toEqual({ ok: false, text: 't holds different rows' });
    expect(compareChecksums({ t: h('a'), u: h('a') }, { t: h('a') })).toEqual({ ok: false, text: 'u is missing on the other side' });
    expect(compareChecksums({ t: h('a') }, { t: h('a'), u: h('a') })).toEqual({ ok: false, text: 'u is not in this database' });
  });
});

describe('noticeState (D30)', () => {
  it.each([
    [{ ok: true, status: 200, body: { success: true, posted: true, pinned: true, channel: 'posted' } }, { state: 'sent', channel: 'posted' }],
    [{ ok: true, status: 200, body: { success: true, posted: true, pinned: false, channel: 'failed', note: 'n' } }, { state: 'sent', channel: 'failed', note: 'n' }],
    [{ ok: true, status: 200, body: { success: true, posted: true, channel: 'none' } }, { state: 'sent', channel: 'none' }],
    [{ ok: true, status: 200, body: { success: true, posted: false, note: 'already' } }, { state: 'already', note: 'already' }],
    [{ ok: false, status: 404, error: 'x' }, { state: 'unsupported' }],
    [{ ok: false, status: 409, error: 'higher' }, { state: 'refused', error: 'higher' }],
    [{ ok: false, status: 502, unknown: true, error: 'u' }, { state: 'unknown', error: 'u' }],
    [{ ok: false, status: 502, error: 'Discord refused' }, { state: 'pending', error: 'Discord refused' }],
    [{ ok: false, unknown: true, error: 'switch-notice sent, no answer within 30 s' }, { state: 'unknown', error: 'switch-notice sent, no answer within 30 s' }],
    [{ ok: false, error: 'switch-notice unreachable: fetch failed' }, { state: 'pending', error: 'switch-notice unreachable: fetch failed' }],
  ])('%j', (r, want) => {
    expect(noticeState(r)).toEqual(want);
  });
});

describe('addressesState (D31)', () => {
  it.each([
    ['not-running', { state: 'not-running' }],
    [{ ok: true, status: 200, body: { success: true, applied: true } }, { state: 'applied' }],
    [{ ok: true, status: 200, body: { success: true, applied: true, note: 'n' } }, { state: 'applied', note: 'n' }],
    [{ ok: false, status: 400, error: 'bad' }, { state: 'refused', error: 'bad' }],
    [{ ok: false, status: 404, error: 'x' }, { state: 'unsupported' }],
    [{ ok: false, status: 409, error: 'files' }, { state: 'files', error: 'files', next: null }],
    [{ ok: false, status: 502, unknown: true, error: 'u' }, { state: 'pending', error: 'u' }],
    [{ ok: false, unknown: true, error: 't' }, { state: 'pending', error: 't' }],
    [{ ok: false, error: 'unreachable' }, { state: 'pending', error: 'unreachable' }],
  ] as const)('%j', (r, want) => {
    expect(addressesState(r as any)).toEqual(want);
  });
});

describe('replacedPlan over state x settled x held x hook x age (D36)', () => {
  const HELD = [undefined, 'yes', 'no', 'unknown', 'stopped', 'not-running'] as const;
  const HOOK = ['confirmed', 'unconfirmed', 'missing', 'none'] as const;
  const cases: Array<[string, boolean, string | undefined, string, number | undefined]> = [];
  for (const state of ['running', 'maintenance', 'off']) for (const settled of [true, false]) for (const held of HELD) for (const hook of HOOK) for (const age of [undefined, 60_000, 5 * 60_000]) cases.push([state, settled, held, hook, age]);
  const oracle = (state: string, settled: boolean, held: string | undefined, hook: string, age: number | undefined) => {
    if (state === 'off' && settled) return 'none';
    if (state === 'running' || !settled) return 'maintenance';
    if (held === 'yes' || held === 'not-running' || hook === 'missing' || hook === 'none') return 'off';
    return age === undefined || age >= 5 * 60_000 ? 'maintenance' : 'wait';
  };
  it.each(cases)('%s settled %s held %s hook %s age %s', (state, settled, held, hook, age) => {
    const now = 10_000_000;
    const rec = { state, settled, hook, message: '', orderedAt: 'x', login: 'blocked', savedByBot: null, ...(held ? { held: { state: held } } : {}) } as any;
    const off = age === undefined ? undefined : { state: 'held' as const, askedAt: now - age, at: 'x' };
    expect(replacedPlan(rec, off, now)).toBe(oracle(state, settled, held, hook, age));
  });
});

describe('dmDue (D37)', () => {
  const now = 10_000_000;
  type DmState = 'posted' | 'repeat' | 'failed' | 'unknown' | 'unsupported';
  const cases: Array<[DmState | undefined, number, boolean]> = [[undefined, 0, true]];
  for (const state of ['posted', 'repeat', 'unsupported'] as const) cases.push([state, 0, false], [state, 2 * 3600_000, false]);
  for (const state of ['failed', 'unknown'] as const) cases.push([state, 3600_000 - 1, false], [state, 3600_000, true]);
  it.each(cases)('%s after %i ms -> %s', (state, age, want) => {
    expect(dmDue(state ? { key: 'k', state, triedAt: now - age } : undefined, now)).toBe(want);
  });
});

describe('noticeDue over the seven states at the row generation', () => {
  const row = { generation: 4, machine: 'b', since: null };
  it.each([
    ['pending', true], ['unknown', true], ['refused', true], ['sent', false], ['already', false], ['unsupported', false], ['not-owed', false],
  ] as const)('%s, an hour after the last try -> %s', (state, want) => {
    const now = 10_000_000;
    expect(noticeDue(row, { generation: 4, machine: 'b', since: null, state, triedAt: now - 3600_000 }, now, true)).toBe(want);
    expect(noticeDue(row, { generation: 4, machine: 'b', since: null, state, triedAt: now - 60_000 }, now, true)).toBe(false);
  });
});

describe('the one-row tables name their key column one_row (PG-1, D40)', () => {
  const statements = [
    ['GENERATION_SCHEMA_SQL', GENERATION_SCHEMA_SQL],
    ['ensureGenerationSql', ensureGenerationSql('main.example')],
    ['raiseSql', raiseSql('main.example', 4)],
    ['restoreStateUpsertSql', restoreStateUpsertSql('a.dump', { generation: 3, machine: 'm', since: null })],
  ] as const;
  it.each(statements)('%s', (_name, sql) => {
    expect(sql).not.toMatch(/\(only\b|\bonly boolean\b|CHECK \(only\)/);
    expect(sql).toMatch(/one_row/);
  });
  it('the received table is keyed by the push id, and the copies table exists (D41, D50)', () => {
    expect(GENERATION_SCHEMA_SQL).toContain('push_id text PRIMARY KEY');
    expect(GENERATION_SCHEMA_SQL).toContain('CREATE TABLE IF NOT EXISTS smdb_manager.copies');
  });
});

describe('pushBrokenOf over received x the oid (D42)', () => {
  it.each([
    [true, 'same', false], [true, 'other', false], [true, 'missing', false],
    [false, 'same', false], [false, 'other', true], [false, 'missing', true],
  ] as const)('received %s, oid %s -> %s', (received, oid, want) => {
    const now = oid === 'same' ? '16384' : oid === 'other' ? '24576' : '';
    expect(pushBrokenOf('16384', now, received)).toBe(want);
  });
});

describe('formerVerdict over recovery x system id x generation order (D45)', () => {
  const peer = (kind: string, gen: number | null, sys = '7001') => (kind === 'writable' || kind === 'in-recovery'
    ? { kind, systemId: sys, timeline: 2, gen: gen === null ? null : { generation: gen, machine: 'b', since: null } }
    : { kind, reason: 'x', systemId: sys }) as any;
  const cases: Array<[string, unknown, string]> = [];
  for (const kind of ['writable', 'in-recovery']) for (const sys of ['7001', '8000']) for (const gen of [null, 4, 5, 6]) {
    const g = gen ?? 0;
    const want = kind === 'in-recovery' || sys !== '7001' ? 'gone' : g > 5 ? 'replaced' : g === 5 ? 'tie' : 'lower';
    cases.push([`${kind} ${sys} ${gen}`, peer(kind, gen, sys), want]);
  }
  cases.push(['unreachable', peer('unreachable', null), 'unknown'], ['login-refused', peer('login-refused', null), 'unknown'], ['fenced', peer('fenced', null), 'unknown'], ['none', null, 'unknown']);
  it.each(cases)('%s -> %s', (_n, p, want) => {
    expect(formerVerdict(5, p as any, '7001')).toBe(want);
  });
});

describe('replicationRoleEnsureSql (D59)', () => {
  it('makes the role NOLOGIN only when it is missing, with no password', () => {
    const sql = replicationRoleEnsureSql('replicator');
    expect(sql).toContain('IF NOT EXISTS');
    expect(sql).toContain('CREATE ROLE replicator NOLOGIN');
    expect(sql).not.toMatch(/LOGIN PASSWORD/);
  });
});

describe('peerCode (D56): the old code only for its host and port with its fingerprint or no certificate', () => {
  const OLD = encodeJoinCode(fakeJoin({ host: 'old.example', port: 5500, machine: 'old.example', fp: FIXTURE_FP }));
  const inst = (code: string | null) => ({
    id: 'a', displayName: 'A',
    fleetDb: {
      containerName: 'a-pg', user: 'app', db: 'app', volume: 'v',
      replication: { role: 'replicator', password: 'replpass', hostPort: 5433, publicHost: 'main.example', certHost: 'main.example' },
      ...(code === null ? {} : { formerMain: { code, slot: 's', machine: 'old.example', host: 'old.example', port: 5500, generation: 2, at: 'x' } }),
    },
  }) as any;
  const cases: Array<[string, string | null, string, string, boolean]> = [];
  for (const [fm, code] of [['absent', null], ['present', OLD], ['undecodable', 'not a code']] as const) {
    for (const [cert, pem] of [['the same fingerprint', FIXTURE_PEM], ['another fingerprint', COPY_PEM], ['no certificate', '']] as const) {
      for (const at of ['old.example:5500', 'other.example:5500', 'old.example:5501']) {
        const match = at === 'old.example:5500';
        cases.push([`formerMain ${fm}, ${cert}, target ${at}`, code, pem, at, fm === 'present' && match && cert !== 'another fingerprint']);
      }
    }
  }
  it.each(cases)('%s', (_n, code, pem, at, old) => {
    const [host, port] = at.split(':');
    const target = { host, port: Number(port), cert: pem, machine: host };
    const got = peerCode(inst(code), target);
    if (old) expect(got).toEqual({ ok: true, text: OLD, code: (decodeJoinCode(OLD) as any).code });
    else expect(got).toEqual(composeJoinCode(inst(code), target));
  });
});

describe('receiveMarkVerdict (D63) against an oracle', () => {
  const cases: Array<[string, { markId: string; pushIds: string[]; dbOid: string } | null, string, boolean]> = [];
  for (const m of ['absent', 'the oid now', 'another oid', 'an empty oid'] as const) for (const received of [false, true]) {
    const mark = m === 'absent' ? null : { markId: 'a1', pushIds: ['a1', 'b2'], dbOid: m === 'the oid now' ? '16384' : m === 'another oid' ? '24576' : '' };
    cases.push([`mark ${m}, received ${received}`, mark, '16384', received]);
  }
  it.each(cases)('%s', (_n, mark, oidNow, received) => {
    const want = !mark ? 'none' : received ? 'checked' : mark.dbOid !== '' && mark.dbOid === oidNow ? 'untouched' : 'unchecked';
    expect(receiveMarkVerdict(mark, oidNow, received)).toBe(want);
  });
});

describe('parseReceiveMark and markIdOf (D62)', () => {
  it.each([
    ['empty', '', null],
    ['one id', 'a1|a1|16384\n', { markId: 'a1', pushIds: ['a1'], dbOid: '16384' }],
    ['three ids', 'a1|a1,b2,c3|16384', { markId: 'a1', pushIds: ['a1', 'b2', 'c3'], dbOid: '16384' }],
    ['an empty oid', 'a1|a1,b2|', { markId: 'a1', pushIds: ['a1', 'b2'], dbOid: '' }],
    ['an id that is not hex', 'a1|a1,zz|16384', undefined],
    ['two fields', 'a1|a1', undefined],
    ['four fields', 'a1|a1|16384|x', undefined],
  ] as const)('%s', (_n, text, want) => {
    expect(parseReceiveMark(text)).toEqual(want);
  });
  it('markIdOf: the first prior id, else the push id', () => {
    expect(markIdOf({ pushId: 'c3', priorIds: ['a1', 'b2'] } as any)).toBe('a1');
    expect(markIdOf({ pushId: 'c3' } as any)).toBe('c3');
    expect(markIdOf({ pushId: 'c3', priorIds: [] } as any)).toBe('c3');
  });
  it('the SQL: an upsert on one_row, the PUBLIC grant, the literals; the clear by id or any row', () => {
    const w = receiveMarkSql('a1', ['a1', 'b2'], '16384');
    expect(w).toContain('ON CONFLICT (one_row) DO UPDATE');
    expect(w).toContain('GRANT SELECT ON smdb_manager.receive_mark TO PUBLIC');
    expect(w).toContain("VALUES (true, 'a1', 'a1,b2', '16384', now())");
    const c = receiveMarkClearSql('a1');
    expect(c).toContain('to_regclass');
    expect(c).toContain("mark_id = 'a1'");
    expect(receiveMarkClearSql(null)).not.toContain('WHERE');
  });
});
