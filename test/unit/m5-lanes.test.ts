import { afterEach, describe, expect, it, vi } from 'vitest';
import { actionRows, laneOutcome, workingText } from '../../src/cli/tui/actions';
import { Bot, laneCall } from '../../src/cli/tui/api';
import { innerWidth } from '../../src/cli/tui/app';
import { noAnswer, ok, refused, Reply } from './m2-fake';
import { mainBot, replicationOn, switchBody } from './m4-fake';
import {
  CANCEL_FILE_Q, CANCEL_PROOF_Q, CANCEL_PUSH_Q, CANCEL_STREAM_Q, CANCELLED_HANDOVER, CANCELLED_MOVE, CATCH_UP_FAILED, copyOf, copyRecorded, HANDED_OVER,
  HELD_QUESTION, KEPT, LANE_BUSY, laneAccepted, laneDone, laneQuestion, laneRefused, NO_SECOND_MAIN, NOT_STREAMING, switchFrame, TOOK_OVER_ALREADY,
  UNCHECKED_Q,
} from './m5-fake';
import {
  bars, calls, closeAll, db, ENTER, ESC, flat, HANDOVER, held, inside, KEEP, mainLaneBot, mainRoutes, openDb, SWITCH, take, tick, toDb, V, WAIT_MS, wsFake,
} from './m5-lanekit';

vi.setConfig({ testTimeout: 40_000 });
afterEach(closeAll);

const OPTS = { op: 'hand-over', limitMs: 5000 };

describe('m5 laneCall', () => {
  it('answers refused, a question, done in the request, and accepted then judged by its frame', async () => {
    const f = wsFake();
    const send = () => laneCall(f.client, 'b1', 'POST', HANDOVER, { slot: 's' }, OPTS);
    f.on('POST', HANDOVER, laneRefused(LANE_BUSY));
    expect(await send()).toEqual({ kind: 'refused', text: LANE_BUSY });
    f.on('POST', HANDOVER, laneRefused('Bot not found', 404));
    expect(await send()).toEqual({ kind: 'refused', text: 'Bot not found' });
    f.on('POST', HANDOVER, laneQuestion(HELD_QUESTION));
    expect(await send()).toEqual({ kind: 'question', text: HELD_QUESTION });
    f.on('POST', HANDOVER, laneQuestion(UNCHECKED_Q, 'confirmUnchecked'));
    expect(await send()).toEqual({ kind: 'question', text: UNCHECKED_Q, confirmFlag: 'confirmUnchecked' });
    f.on('POST', HANDOVER, laneDone(CANCELLED_HANDOVER));
    expect(await send()).toEqual({ kind: 'done', text: CANCELLED_HANDOVER });
    f.on('POST', HANDOVER, () => {
      setTimeout(() => f.emit('bot:switch', switchFrame('op-1', true, HANDED_OVER)), 50);
      return laneAccepted('op-1');
    });
    let accepted = 0;
    expect(await laneCall(f.client, 'b1', 'POST', HANDOVER, {}, { ...OPTS, onAccepted: () => void accepted++ })).toEqual({ kind: 'ended', ok: true, text: HANDED_OVER });
    expect(accepted).toBe(1);
    f.on('POST', HANDOVER, () => {
      setTimeout(() => f.emit('bot:switch', switchFrame('op-2', false, CATCH_UP_FAILED)), 50);
      return laneAccepted('op-2');
    });
    expect(await send()).toEqual({ kind: 'ended', ok: false, text: CATCH_UP_FAILED });
    // Every call opened /ws once and closed it.
    expect(f.opens).toBe(7);
    expect(f.live()).toBe(0);
  });

  it('a frame that comes before the answer is kept and judges the lane', async () => {
    const f = wsFake().on('POST', HANDOVER, async () => {
      f.emit('bot:switch', switchFrame('op-9', true, HANDED_OVER));
      await tick(30);
      return laneAccepted('op-9');
    });
    expect(await laneCall(f.client, 'b1', 'POST', HANDOVER, {}, OPTS)).toEqual({ kind: 'ended', ok: true, text: HANDED_OVER });
  });

  it('frames for another opId, another bot, another type, or with data that is not a JSON object are ignored', async () => {
    const f = wsFake().on('POST', HANDOVER, () => {
      f.emit('bot:switch', switchFrame('op-other', false, 'not mine'));
      setTimeout(() => {
        f.emit('bot:switch', switchFrame('op-1', false, 'another bot', 'b2'));
        f.emit('bot:updated', { id: 'b1', opId: 'op-1', success: false, text: 'another type' });
        f.emit('bot:switch', 'op-1');
        f.emit('bot:switch', null);
        f.emit('bot:switch', ['op-1']);
        f.emit('bot:switch', 7);
        f.emit('bot:switch', { id: 'b1', success: false, text: 'no opId' });
        setTimeout(() => f.emit('bot:switch', switchFrame('op-1', true, HANDED_OVER)), 40);
      }, 30);
      return laneAccepted('op-1');
    });
    expect(await laneCall(f.client, 'b1', 'POST', HANDOVER, {}, OPTS)).toEqual({ kind: 'ended', ok: true, text: HANDED_OVER });
  });

  it('a /ws that does not open sends nothing', async () => {
    const f = wsFake().on('POST', HANDOVER, laneAccepted('op-1'));
    f.failOpen = 'connect ECONNREFUSED 127.0.0.1:8080';
    const r = await laneCall(f.client, 'b1', 'POST', HANDOVER, {}, OPTS);
    expect(r).toEqual({ kind: 'no-stream', text: "The manager's event stream did not open (connect ECONNREFUSED 127.0.0.1:8080), so nothing was sent." });
    expect(f.calls).toEqual([]);
    // An openWs that throws is the same.
    (f.client as unknown as { openWs: unknown }).openWs = () => {
      throw new Error('Invalid URL');
    };
    expect(await laneCall(f.client, 'b1', 'POST', HANDOVER, {}, OPTS)).toEqual({ kind: 'no-stream', text: "The manager's event stream did not open (Invalid URL), so nothing was sent." });
    expect(f.calls).toEqual([]);
  });

  it('/ws closing before the frame, during the wait or during the request, can only say can\'t confirm', async () => {
    const f = wsFake().on('POST', HANDOVER, () => {
      setTimeout(() => f.drop('closed (code 1006)'), 50);
      return laneAccepted('op-1');
    });
    const text = "Can't confirm the hand-over: the event stream closed (closed (code 1006)); it may still be running. The Move lines show what stands.";
    expect(await laneCall(f.client, 'b1', 'POST', HANDOVER, {}, OPTS)).toEqual({ kind: 'unconfirmed', text });
    f.on('POST', HANDOVER, async () => {
      f.drop('closed (code 1006)');
      await tick(30);
      return laneAccepted('op-2');
    });
    const at = Date.now();
    expect(await laneCall(f.client, 'b1', 'POST', HANDOVER, {}, OPTS)).toEqual({ kind: 'unconfirmed', text });
    expect(Date.now() - at).toBeLessThan(OPTS.limitMs);
    // Closed during the request but answered with a refusal: the refusal stands.
    f.on('POST', HANDOVER, async () => {
      f.drop('closed (code 1006)');
      return laneRefused(LANE_BUSY);
    });
    expect(await laneCall(f.client, 'b1', 'POST', HANDOVER, {}, OPTS)).toEqual({ kind: 'refused', text: LANE_BUSY });
  });

  it('past the limit with no frame it can only say can\'t confirm, and a frame after that changes nothing', async () => {
    const f = wsFake().on('POST', HANDOVER, laneAccepted('op-1'));
    const at = Date.now();
    const r = await laneCall(f.client, 'b1', 'POST', HANDOVER, {}, { op: 'take-over', limitMs: 300 });
    const took = Date.now() - at;
    expect(r).toEqual({ kind: 'unconfirmed', text: "Can't confirm the take-over: no result came within 300 ms; it may still be running. The Move lines show what stands." });
    expect(took).toBeGreaterThanOrEqual(250);
    expect(took).toBeLessThan(WAIT_MS);
    expect(f.live()).toBe(0);
  });

  it('no answer and a body that is not a JSON object are no answer, never a refusal', async () => {
    const f = wsFake().on('POST', HANDOVER, () => noAnswer());
    expect(await laneCall(f.client, 'b1', 'POST', HANDOVER, {}, OPTS)).toEqual({ kind: 'lost', text: 'connect ECONNREFUSED 127.0.0.1:8080' });
    f.on('POST', HANDOVER, refused(502, '<html>Bad Gateway</html>'));
    expect(await laneCall(f.client, 'b1', 'POST', HANDOVER, {}, OPTS)).toEqual({ kind: 'lost', text: 'the reply was not JSON, HTTP 502' });
    f.on('POST', HANDOVER, ok(''));
    expect(await laneCall(f.client, 'b1', 'POST', HANDOVER, {}, OPTS)).toEqual({ kind: 'lost', text: 'the reply was not JSON, HTTP 200' });
  });

  it('turns each answer into the page\'s text (switchRequest :3553, onBotSwitch :3534)', () => {
    expect(laneOutcome('hand-over', { kind: 'refused', text: '' })).toEqual({ ok: false, text: 'The hand-over was refused' });
    expect(laneOutcome('take-over', { kind: 'question', text: 'Take over now?' })).toEqual({ ok: false, text: 'Take over now?' });
    expect(laneOutcome('keep', { kind: 'done', text: '' })).toEqual({ ok: true, text: 'Done' });
    expect(laneOutcome('cancel', { kind: 'lost', text: 'socket hang up' })).toEqual({
      ok: null, text: 'No answer from the manager (socket hang up); the cancel may still be running. Check its state before trying again.',
    });
    expect(laneOutcome('hand-over', { kind: 'ended', ok: false, text: '' })).toEqual({ ok: false, text: 'The hand-over failed; the manager gave no reason.' });
    expect(laneOutcome('hand-over', { kind: 'ended', ok: true, text: HANDED_OVER })).toEqual({ ok: true, text: HANDED_OVER });
    expect(laneOutcome('hand-over', { kind: 'unconfirmed', text: 'x' })).toEqual({ ok: null, text: 'x' });
    expect(laneOutcome('hand-over', { kind: 'no-stream', text: 'y' })).toEqual({ ok: false, text: 'y' });
    expect(workingText('mybot')).toBe('Working on mybot; the result shows here when it finishes');
  });
});

describe('m5 the Move rows', () => {
  const sw = (over: Record<string, unknown> = {}) => ({ ok: true as const, value: { lines: [], copies: [], ...over } });
  const repl = { ok: true as const, value: (replicationOn().body as { replication: never }) };
  // Part 5's Receive, Stop receiving, new move code, backup for a move and Push rows are m5-move's.
  const PART5 = ['receive', 'stopreceive', 'newcode', 'moveout', 'push'];
  const part4 = (rows: ReturnType<typeof actionRows>) => rows.filter((r) => !PART5.includes(r.kind));
  const labels = (fleetDb: Record<string, unknown>, s: unknown = sw(), status = 'stopped') => part4(actionRows('main', { replication: repl, switch: s as never }, mainLaneBot(fleetDb, { status }) as Bot))
    .map((r) => r.label).filter((l) => l !== 'Disable replication' && l !== 'New join code');

  it('offers Hand over per streaming copy, with the slot its press sends', () => {
    const rows = actionRows('main', { switch: sw({ copies: [copyOf('yundera'), copyOf('hetzner', false), { slot: 'smdb_copy_x', streaming: true }] }) as never }, mainLaneBot() as Bot);
    expect(rows.filter((r) => r.kind === 'handover')).toEqual([
      { kind: 'handover', label: 'Hand over to yundera', slot: 'smdb_copy_yundera', machine: 'yundera' },
      { kind: 'handover', label: 'Hand over to smdb_copy_x', slot: 'smdb_copy_x', machine: 'smdb_copy_x' },
    ]);
  });

  it('offers Cancel, Keep and the rejoins by the records (:3609 to :3634)', () => {
    expect(labels({})).toEqual(['Rejoin as a copy (join code)']);
    expect(labels({ replication: null })).toEqual([]);
    expect(labels({ handover: { mode: 'stream', phase: 'waiting', machine: 'yundera' } })).toEqual(['Cancel the hand-over', 'Rejoin as a copy (join code)']);
    expect(labels({ handover: { mode: 'file', phase: 'waiting' } })).toEqual(['Cancel the move', 'Rejoin as a copy (join code)']);
    expect(labels({ handover: { mode: 'push', phase: 'waiting', machine: 'yundera' } })).toEqual(['Cancel the move', 'Rejoin as a copy (join code)']);
    const stopped = actionRows('main', { switch: sw() as never }, mainLaneBot({ handover: { mode: 'stream', phase: 'stopped', machine: 'yundera', host: 'y.example.net' } }) as Bot);
    expect(stopped.map((r) => r.label)).toEqual(['Cancel the hand-over', 'Rejoin as a copy']);
    expect(stopped[1]).toEqual({ kind: 'rejoin', label: 'Rejoin as a copy', machine: 'yundera', recorded: true });
    const noHost = actionRows('main', { switch: sw() as never }, mainLaneBot({ handover: { mode: 'stream', phase: 'stopped', machine: 'yundera' } }) as Bot);
    expect(noHost[1]).toEqual({ kind: 'rejoin', label: 'Rejoin as a copy', machine: 'yundera', recorded: false });
    const conflict = part4(actionRows('main', { switch: sw() as never }, mainLaneBot({ mainConflict: { machine: 'yundera' } }) as Bot));
    expect(conflict).toEqual([
      { kind: 'keep', label: 'Keep this machine as the main', machine: 'yundera' },
      { kind: 'rejoin', label: 'Rejoin as a copy', machine: 'yundera', recorded: false },
    ]);
    const replaced = part4(actionRows('main', { switch: sw() as never }, mainLaneBot({ replacedBy: { machine: 'yundera', generation: 5 } }) as Bot));
    expect(replaced).toEqual([{ kind: 'rejoin', label: 'Rejoin as a copy', machine: 'yundera', recorded: true }]);
    expect(part4(actionRows('main', { switch: sw() as never }, mainLaneBot({ replacedBy: {} }) as Bot))[0]).toMatchObject({ machine: 'the main' });
    const stale = part4(actionRows('main', { switch: sw() as never }, mainLaneBot({}, { status: 'running' }) as Bot));
    expect(stale).toEqual([{ kind: 'stale', label: 'Rejoin as a copy (join code)', host: 'db.example.net', port: '15432', running: true }]);
  });

  it('a failed, unanswered or missing switch read offers no Move row', () => {
    const fdb = { handover: { mode: 'stream', phase: 'stopped', machine: 'yundera', host: 'y' }, mainConflict: { machine: 'yundera' } };
    expect(labels(fdb, { ok: false, text: 'Bot not found' })).toEqual([]);
    expect(labels(fdb, { ok: null, text: 'the manager did not answer within 15 s' })).toEqual([]);
    expect(actionRows('main', { replication: repl }, mainLaneBot(fdb) as Bot).map((r) => r.label)).toEqual(['New join code', 'Disable replication']);
    expect(actionRows('main', { replication: repl }, mainBot() as Bot).map((r) => r.label)).toEqual(['New join code', 'Disable replication']);
  });

  it('the copy layout offers Take over from a switch read (:3596) or a promoted copy (:3207), once', () => {
    const replica = (r: Record<string, unknown>) => ({ ok: true as const, value: { replica: r } });
    const promoted = copyRecorded({ running: true, inRecovery: false, receiverStatus: null, caughtUp: null, replayLagSeconds: null });
    expect(actionRows('copy', { replica: replica(copyRecorded()), switch: sw() as never }).map((r) => r.label)).toEqual(['Remove replica', 'Re-seed now', 'Join the main with a join code', 'Take over']);
    expect(actionRows('copy', { replica: replica(promoted), switch: sw() as never }).filter((r) => r.kind === 'takeover')).toHaveLength(1);
    expect(actionRows('copy', { replica: replica(promoted), switch: { ok: false, text: 'x' } }).map((r) => r.label)).toEqual(['Remove replica', 'Join the main with a join code', 'Take over']);
    expect(actionRows('copy', { replica: replica(copyRecorded()), switch: { ok: null, text: 'x' } }).map((r) => r.label)).not.toContain('Take over');
    expect(actionRows('copy', { replica: { ok: false, text: 'x' }, switch: sw() as never }).map((r) => r.label)).toEqual(['Take over']);
    // A promoted record whose container is down shows the not-running line, not Take over (:3203).
    const down = copyRecorded({ running: false, inRecovery: false, receiverStatus: null, caughtUp: null, replayLagSeconds: null });
    expect(actionRows('copy', { replica: replica(down) }).map((r) => r.label)).not.toContain('Take over');
  });
});

async function frameAfter(v: V, path: string, f: { calls: Array<{ method: string; path: string }> }, n: number) {
  await v.untilFn(() => calls(f as never, 'POST', path).length === n);
}

describe('m5 Hand over', () => {
  it('the dialog, another key, Y Y Y sending one POST with the row\'s slot, Working on until the frame, then its text', async () => {
    const f = mainRoutes();
    let opId = 0;
    f.on('POST', HANDOVER, () => laneAccepted(`op-${++opId}`));
    const v = await toDb(f);
    await take(v, 'Hand over to yundera');
    await v.until("Hand over the main to yundera? The bot stays in maintenance; this machine's database stops once the copy holds every change, and it rejoins as a copy after yundera takes over.");
    await v.until('Y Hand over');
    await v.press('n');
    await v.until('Cancelled: nothing was sent.');
    await take(v, 'Hand over to yundera');
    await v.until('Y Hand over');
    await v.press('y', 'y', 'Y');
    await v.until('Working on mybot; the result shows here when it finishes');
    expect(calls(f, 'POST', HANDOVER).map((c) => c.body)).toEqual([{ slot: 'smdb_copy_yundera' }]);
    expect(bars(v.frame())).toContain('Waiting for the manager  Esc Back');
    await v.press('a', 'y', ENTER);
    expect(calls(f, 'POST', HANDOVER)).toHaveLength(1);
    expect(v.session.notice).toBe('mybot: Working on mybot; the result shows here when it finishes');
    f.emit('bot:switch', switchFrame('op-1', true, HANDED_OVER));
    await v.until(HANDED_OVER);
    expect(v.session.notice).toBe(`mybot: ${HANDED_OVER}`);
    expect(v.session.dbBusy.size).toBe(0);
    expect(f.live()).toBe(0);
  });

  it('the held question is a further dialog; Y sends again with confirm, another key sends nothing more', async () => {
    const f = mainRoutes();
    const answers: Reply[] = [laneQuestion(HELD_QUESTION), laneQuestion(HELD_QUESTION), laneAccepted('op-1')];
    f.on('POST', HANDOVER, () => answers.shift()!);
    const v = await toDb(f);
    await take(v, 'Hand over to yundera');
    await v.until('Y Hand over');
    await v.press('y');
    await v.until(HELD_QUESTION);
    await v.until('Y Confirm');
    await v.press('n');
    await v.until('Cancelled: the main was not handed over.');
    expect(calls(f, 'POST', HANDOVER)).toHaveLength(1);
    await take(v, 'Hand over to yundera');
    await v.until('Y Hand over');
    await v.press('y');
    await v.until('Y Confirm');
    await v.press('y', 'y');
    await v.until('Working on mybot');
    expect(calls(f, 'POST', HANDOVER).map((c) => c.body)).toEqual([{ slot: 'smdb_copy_yundera' }, { slot: 'smdb_copy_yundera' }, { slot: 'smdb_copy_yundera', confirm: true }]);
    f.emit('bot:switch', switchFrame('op-1', false, CATCH_UP_FAILED));
    await v.until(CATCH_UP_FAILED);
  });

  it('a second question after the confirm is shown as the answer, with no third send (switchRequest :3555 to :3561)', async () => {
    const f = mainRoutes().on('POST', HANDOVER, laneQuestion(HELD_QUESTION));
    const v = await toDb(f);
    await take(v, 'Hand over to yundera');
    await v.until('Y Hand over');
    await v.press('y');
    await v.until('Y Confirm');
    await v.press('y');
    await v.untilFn(() => calls(f, 'POST', HANDOVER).length === 2 && !v.session.dbBusy.size);
    await tick(100);
    expect(bars(v.frame())).not.toContain('Y Confirm');
    expect(calls(f, 'POST', HANDOVER)).toHaveLength(2);
    expect(v.session.notice).toBe(`mybot: ${HELD_QUESTION}`);
  });

  it('refusals, no answer, a /ws that does not open and a lost frame each show their text', async () => {
    let next: Reply = laneRefused(NOT_STREAMING);
    const f = mainRoutes().on('POST', HANDOVER, () => next);
    const v = await toDb(f, { db: { laneLimitMs: 300 } });
    const run = async (text: string) => {
      await take(v, 'Hand over to yundera');
      await v.until('Y Hand over');
      await v.press('y');
      await v.until(text);
    };
    await run(NOT_STREAMING);
    next = laneRefused(LANE_BUSY);
    await run(LANE_BUSY);
    next = laneRefused('');
    await run('The hand-over was refused');
    next = noAnswer();
    await run('No answer from the manager (connect ECONNREFUSED 127.0.0.1:8080); the hand-over may still be running. Check its state before trying again.');
    next = refused(502, '<html>Bad Gateway</html>');
    await run('No answer from the manager (the reply was not JSON, HTTP 502); the hand-over may still be running.');
    next = laneAccepted('op-late');
    const at = Date.now();
    await run("Can't confirm the hand-over: no result came within 300 ms; it may still be running. The Move lines show what stands.");
    expect(Date.now() - at).toBeLessThan(WAIT_MS);
    f.emit('bot:switch', switchFrame('op-late', true, HANDED_OVER));
    await tick(100);
    expect(flat(v.frame())).not.toContain(HANDED_OVER);
    const sent = calls(f, 'POST', HANDOVER).length;
    f.failOpen = 'connect ECONNREFUSED 127.0.0.1:8080';
    await run("The manager's event stream did not open (connect ECONNREFUSED 127.0.0.1:8080), so nothing was sent.");
    expect(calls(f, 'POST', HANDOVER)).toHaveLength(sent);
    f.failOpen = null;
    f.on('POST', HANDOVER, () => {
      setTimeout(() => f.drop('closed (code 1006)'), 50);
      return laneAccepted('op-drop');
    });
    await run("Can't confirm the hand-over: the event stream closed (closed (code 1006)); it may still be running.");
  });

  it('Esc during the POST and during the frame wait: a reopened screen waits, and the outcome lands on the bot screen', async () => {
    const h = held();
    const f = mainRoutes().on('POST', HANDOVER, h.answer);
    const v = await toDb(f);
    await take(v, 'Hand over to yundera');
    await v.until('Y Hand over');
    await v.press('y');
    await v.until('Handing over the main.');
    await v.press(ESC);
    await v.until('Name mybot');
    expect(v.session.held.database).toBeUndefined();
    await openDb(v);
    await v.until('Waiting for the manager');
    await v.press('a', ENTER, 'y');
    await v.press(ESC);
    await v.until('Name mybot');
    h.release(laneAccepted('op-1'));
    await v.until('mybot: Working on mybot; the result shows here when it finishes');
    await openDb(v);
    await v.until('Working on mybot');
    await v.press(ESC);
    await v.until('Name mybot');
    f.emit('bot:switch', switchFrame('op-1', true, HANDED_OVER));
    await v.until(`mybot: ${HANDED_OVER}`);
    expect(calls(f, 'POST', HANDOVER)).toHaveLength(1);
    expect(v.session.dbBusy.size).toBe(0);
  });

  it('a switch read landing during the dialog: the dialog\'s slot is sent', async () => {
    let copies = [copyOf('yundera')];
    const f = mainRoutes({ switch: () => switchBody({ copies }) }).on('POST', HANDOVER, laneDone('x'));
    const v = await toDb(f, { db: { everyMs: 200 } });
    await take(v, 'Hand over to yundera');
    await v.until('Y Hand over');
    const reads = calls(f, 'GET', SWITCH).length;
    copies = [copyOf('hetzner')];
    await v.untilFn(() => calls(f, 'GET', SWITCH).length > reads + 1);
    await v.untilFn(() => db(v).actionRows().some((r) => r.label === 'Hand over to hetzner'));
    await v.press('y');
    await frameAfter(v, HANDOVER, f, 1);
    expect(calls(f, 'POST', HANDOVER)[0].body).toEqual({ slot: 'smdb_copy_yundera' });
  });

  it('a long machine name wraps in the list and the dialog at 80 columns', async () => {
    const machine = 'copy-in-the-frankfurt-datacenter-of-a-long-provider.example.net';
    const f = mainRoutes({ switch: switchBody({ copies: [copyOf(machine)] }) }).on('POST', HANDOVER, laneDone('x'));
    const v = await toDb(f, { columns: 80, rows: 24 });
    await v.untilFn(() => bars(v.frame()).includes('A Actions'));
    await v.press('a');
    await v.until('Actions: mybot');
    await v.untilFn(() => db(v).actionRows().some((r) => r.kind === 'handover'));
    const inner = innerWidth(80);
    for (let i = 0; i < 5 && !v.frame().includes('> Hand over to'); i++) await v.press('\u001B[B');
    const lines = inside(v.frame());
    for (const l of v.frame().split('\n')) expect(l.length).toBeLessThanOrEqual(79);
    const at = lines.findIndex((l) => l.startsWith('> Hand over to'));
    expect(at).toBeGreaterThan(0);
    expect(lines.slice(at, at + 3).map((l) => l.slice(2)).join(' ').replace(/\s+/g, ' ')).toContain(`Hand over to ${machine}`);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(inner);
    await v.press(ENTER);
    await v.until('Y Hand over');
    await v.until(`rejoins as a copy after ${machine} takes over.`);
    for (const l of v.frame().split('\n')) expect(l.length).toBeLessThanOrEqual(79);
    await v.press('y');
    await frameAfter(v, HANDOVER, f, 1);
    expect(calls(f, 'POST', HANDOVER)[0].body).toEqual({ slot: copyOf(machine).slot });
  });
});

describe('m5 Cancel the hand-over or the move', () => {
  const DELETE = (f: { calls: Array<{ method: string; path: string }> }) => f.calls.filter((c) => c.method === 'DELETE' && c.path.startsWith(HANDOVER)).map((c) => c.path);

  it('its dialog, then each route question warns of two mains and Y sends ?confirm=1', async () => {
    for (const [q, done] of [[CANCEL_STREAM_Q, CANCELLED_HANDOVER], [CANCEL_PROOF_Q, CANCELLED_HANDOVER]]) {
      const f = mainRoutes({ bot: mainLaneBot({ handover: { mode: 'stream', phase: 'stopped', machine: 'yundera' } }) });
      f.on('DELETE', HANDOVER, laneQuestion(q)).on('DELETE', `${HANDOVER}?confirm=1`, laneDone(done));
      const v = await toDb(f);
      await take(v, 'Cancel the hand-over');
      await v.until('Y Cancel the hand-over');
      await v.press('y');
      await v.until(q);
      await v.until('Y Confirm');
      expect(DELETE(f)).toEqual([HANDOVER]);
      await v.press('y', 'y');
      await v.until(done);
      expect(DELETE(f)).toEqual([HANDOVER, `${HANDOVER}?confirm=1`]);
      expect(f.calls.filter((c) => c.method === 'DELETE').every((c) => c.body === undefined)).toBe(true);
      closeAll();
    }
  });

  it('the move\'s and the push\'s questions, another key, a refusal and no answer', async () => {
    let first: Reply = laneQuestion(CANCEL_FILE_Q);
    const f = mainRoutes({ bot: mainLaneBot({ handover: { mode: 'file', phase: 'waiting', file: 'pre-move-2026-11-14T09-00-00-000Z.dump' } }) });
    f.on('DELETE', HANDOVER, () => first).on('DELETE', `${HANDOVER}?confirm=1`, laneDone(CANCELLED_MOVE));
    const v = await toDb(f);
    await take(v, 'Cancel the move');
    await v.until('Y Cancel the move');
    await v.press('y');
    await v.until(CANCEL_FILE_Q);
    await v.press('n');
    await v.until('Not confirmed: the cancel did not finish; the Move lines show what stands.');
    expect(DELETE(f)).toEqual([HANDOVER]);
    first = laneQuestion(CANCEL_PUSH_Q);
    await take(v, 'Cancel the move');
    await v.until('Y Cancel the move');
    await v.press('y');
    await v.until(CANCEL_PUSH_Q);
    await v.press('y');
    await v.until(CANCELLED_MOVE);
    first = laneRefused(TOOK_OVER_ALREADY);
    await take(v, 'Cancel the move');
    await v.until('Y Cancel the move');
    await v.press('y');
    await v.until(TOOK_OVER_ALREADY);
    first = noAnswer();
    await take(v, 'Cancel the move');
    await v.until('Y Cancel the move');
    await v.press('y');
    await v.until('the cancel may still be running');
    expect(DELETE(f)).toEqual([HANDOVER, HANDOVER, `${HANDOVER}?confirm=1`, HANDOVER, HANDOVER]);
  });
});

describe('m5 Keep this machine as the main', () => {
  it('the dialog, Y once, done in the request; a refusal; another key', async () => {
    let next: Reply = laneDone(KEPT);
    const f = mainRoutes({ bot: mainLaneBot({ mainConflict: { machine: 'yundera' } }) }).on('POST', KEEP, () => next);
    const v = await toDb(f);
    await take(v, 'Keep this machine as the main');
    await v.until("Make this machine the main? Its generation is raised above yundera's; yundera's manager blocks its bot's login when it next reads this machine (it checks every 5 minutes while it can reach it).");
    await v.press('x');
    await v.until('Cancelled: nothing was sent.');
    expect(calls(f, 'POST', KEEP)).toEqual([]);
    await take(v, 'Keep this machine as the main');
    await v.until('Y Keep');
    await v.press('y', 'y');
    await v.until(KEPT);
    expect(calls(f, 'POST', KEEP)).toEqual([{ method: 'POST', path: KEEP, body: undefined }]);
    expect(v.session.notice).toBe(`mybot: ${KEPT}`);
    next = laneRefused(NO_SECOND_MAIN);
    await take(v, 'Keep this machine as the main');
    await v.until('Y Keep');
    await v.press('y');
    await v.until(NO_SECOND_MAIN);
    next = noAnswer();
    await take(v, 'Keep this machine as the main');
    await v.until('Y Keep');
    await v.press('y');
    await v.until('the keep may still be running');
    expect(calls(f, 'POST', KEEP)).toHaveLength(3);
  });
});

describe('m5 a failed switch read', () => {
  it('offers no Move action and shows the page\'s text; a generation error shows :3603\'s', async () => {
    let sw: Reply = noAnswer();
    const f = mainRoutes({ bot: mainLaneBot({ mainConflict: undefined }), switch: () => sw });
    const v = await toDb(f, { db: { everyMs: 200 } });
    await v.until('the move controls are not shown');
    expect(db(v).actionRows().map((r) => r.label)).toEqual(['New join code', 'Disable replication']);
    sw = switchBody({ generation: { error: 'connect ECONNREFUSED' }, copies: [copyOf('yundera')] });
    await v.until("Can't confirm this database's generation: connect ECONNREFUSED");
    await v.untilFn(() => db(v).actionRows().some((r) => r.kind === 'handover'));
    sw = { status: 404, ok: false, body: { success: false, error: 'Bot not found' } };
    await v.until('Could not read the move state (Bot not found); retrying.');
    expect(db(v).actionRows().map((r) => r.label)).toEqual(['New join code', 'Disable replication']);
  });
});
