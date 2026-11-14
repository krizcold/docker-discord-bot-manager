import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  actionRows, MOVE_CODE_SHOWN_TEXT, MOVE_OUT_QUESTION, moveCodeReadyText, newCodeQuestion, NO_MOVE_CODE_TEXT, noAnswerText, PUSH_LIMIT_MS, pushQuestion,
  receiveQuestion, workingText,
} from '../../src/cli/tui/actions';
import { Bot, laneCall } from '../../src/cli/tui/api';
import { codeLines } from '../../src/cli/tui/codes';
import { moveOutText } from '../../src/cli/tui/dbtext';
import { noAnswer, ok, Reply } from './m2-fake';
import { mainBot, switchBody } from './m4-fake';
import {
  ALREADY_PUSHED, BROKEN_DUMP, HELD_MOVE_Q, HELD_PUSH_Q, laneAccepted, laneQuestion, laneRefused, MOVE_CODE, MOVE_CODE_2, MOVE_DUMP_FAILED, MOVE_FILE,
  MOVE_TEXT, movedBody, NOT_A_MOVE_CODE, NOT_RECEIVING, OLD_MOVE_CODE, PUSH_FAILED, PUSHED, RECEIVE_BROKEN_TEXT, RECEIVE_NOT_OFF, RECEIVE_TEXT, receivedBody,
  RECVLOGIN, STOPPED_RECEIVING, switchFrame,
} from './m5-fake';
import {
  B, bars, calls, closeAll, db, END, ENTER, ESC, flat, held, mainLaneBot, mainRoutes, openDb, START, take, tick, toDb, V, wsFake,
} from './m5-lanekit';

vi.setConfig({ testTimeout: 40_000 });
afterEach(() => {
  vi.useRealTimers();
  closeAll();
});

const RECEIVE = `${B}/fleet-receive`;
const PUSH = `${B}/fleet-push`;
const MOVE_OUT = `${B}/fleet-move-out`;
const PIECES = [MOVE_CODE.slice(10, 40), MOVE_CODE.slice(300, 330), MOVE_CODE_2.slice(-30)];
const ROOT = '/srv/smdb/data';
// A switch read while receiving: a held move code is kept only while the read shows the receive.
const RECEIVING_READ = () => switchBody({ receive: { startedAt: '2026-11-14T09:00:00.000Z', expiresAt: '2026-11-15T10:00:00.000Z', safetyDump: 'pre-receive-2026-11-14T09-00-00-000Z.dump' } });

const labels = (r: Array<{ label: string }>) => r.map((x) => x.label);
const moveLabels = ['Receive a main', 'Make a backup for a move', 'Push the main'];

/** No frame, notice or Session string other than the held map shows a piece of a move code. */
function noCodeOutside(v: V) {
  for (const fr of v.frames) for (const p of PIECES) expect(fr).not.toContain(p);
  for (const p of PIECES) {
    expect(v.session.notice ?? '').not.toContain(p);
    expect(db(v)?.notice ?? '').not.toContain(p);
  }
}

/** The code screen is shown: its lines hold the code alone, from column 0. */
const codeShown = (v: V, code: string) => codeLines(code).every((l) => v.frame().split('\n').includes(l));

async function paste(v: V, code = MOVE_CODE) {
  v.stdin.write(`${START}${code.slice(0, 64)}\r${code.slice(64)}${END}`);
  await tick(50);
  v.stdin.write('\r');
  await tick(50);
}

const botOf = (fleetDb: Record<string, unknown>): Bot => mainBot({
  status: 'stopped', fleetDb: { containerName: 'smdb-db-b1', replication: { publicHost: 'h', hostPort: 1 }, ...fleetDb },
}) as unknown as Bot;

describe('m5 move rows', () => {
  it('Receive, the backup for a move and Push with no move and no receive; Stop and a new code while receiving; none during a move', () => {
    const plain = actionRows('main', { switch: { ok: true, value: { copies: [] } } as never }, botOf({}));
    expect(labels(plain)).toEqual(expect.arrayContaining(moveLabels));
    expect(plain.find((r) => r.kind === 'receive')).toEqual({ kind: 'receive', label: 'Receive a main', safetyDump: null });
    const receiving = labels(actionRows('main', { switch: { ok: true, value: {} } as never }, botOf({ receive: { expiresAt: '2026-11-15T10:00:00.000Z' } })));
    expect(receiving).toContain('Stop receiving');
    expect(receiving).toContain('Make a new move code (the code shown before stops working)');
    for (const l of moveLabels) expect(receiving).not.toContain(l);
    for (const mode of ['stream', 'push', 'file']) {
      const moving = labels(actionRows('main', { switch: { ok: true, value: {} } as never }, botOf({ handover: { mode, phase: 'done', machine: 'yundera' } })));
      for (const l of [...moveLabels, 'Stop receiving']) expect(moving).not.toContain(l);
      expect(moving.some((l) => l.startsWith('Cancel the'))).toBe(true);
    }
    // A push that did not finish: Receive names the kept dump (:3653).
    const broken = actionRows('main', { switch: { ok: true, value: {} } as never }, botOf({ pushBroken: { at: 'x', safetyDump: BROKEN_DUMP } }));
    expect(broken.find((r) => r.kind === 'receive')).toEqual({ kind: 'receive', label: 'Receive a main', safetyDump: BROKEN_DUMP });
  });

  it('a failed or missing switch read offers none of them; a held code offers Show the move code first, on any layout', () => {
    for (const sw of [undefined, { ok: false, text: 'x' }, { ok: null, text: 'timeout' }]) {
      const r = labels(actionRows('main', { switch: sw as never }, botOf({})));
      for (const l of moveLabels) expect(r).not.toContain(l);
    }
    expect(labels(actionRows('main', { switch: { ok: true, value: {} } as never, moveCodeHeld: true }, botOf({})))[0]).toBe('Show the move code');
    expect(labels(actionRows('copy', { moveCodeHeld: true }, botOf({})))).toEqual(['Show the move code']);
    expect(labels(actionRows('none', { moveCodeHeld: true }, botOf({})))).toEqual(['Show the move code']);
    expect(labels(actionRows('main', { switch: { ok: true, value: {} } as never }, botOf({})))).not.toContain('Show the move code');
  });
});

describe('m5 Receive a main', () => {
  it('the dialog, Y Y Y sending one POST, the code screen with the page\'s text, then Esc dropping the code', async () => {
    const h = held();
    const f = mainRoutes().on('POST', RECEIVE, h.answer);
    const v = await toDb(f);
    await take(v, 'Receive a main');
    for (const l of receiveQuestion(null)) await v.until(l);
    expect(calls(f, 'POST', RECEIVE)).toEqual([]);
    await v.press('y', 'y', 'Y');
    await v.until('Dumping this database, then making the move code');
    expect(bars(v.frame())).toContain('Waiting for the manager  Esc Back');
    // Keys wait: A and J send nothing while the dump runs.
    await v.press('a', 'j');
    const lists = calls(f, 'GET', '/api/bots').length;
    h.release(receivedBody());
    await v.untilFn(() => codeShown(v, MOVE_CODE));
    expect(calls(f, 'POST', RECEIVE)).toHaveLength(1);
    expect(calls(f, 'POST', RECEIVE)[0].body).toBeUndefined();
    expect(calls(f, 'GET', `${B}/fleet-replication/join-code`)).toEqual([]);
    expect(flat(v.frame())).toContain('Move code of mybot');
    expect(flat(v.frame())).toContain(RECEIVE_TEXT);
    expect(v.frame().split('\n').some((l) => l.startsWith('|'))).toBe(false);
    expect(v.session.moveCodes.size).toBe(0);
    await v.press('q', 'h', ENTER);
    expect(codeShown(v, MOVE_CODE)).toBe(true);
    await v.press(ESC);
    await v.until(MOVE_CODE_SHOWN_TEXT.slice(0, 50));
    const after = v.frames.length;
    await v.press(ENTER);
    for (const fr of v.frames.slice(after)) for (const p of PIECES) expect(fr).not.toContain(p);
    for (const p of PIECES) expect(v.session.notice ?? '').not.toContain(p);
    expect(v.session.moveCodes.size).toBe(0);
    expect(db(v).actionRows().map((r) => r.label)).not.toContain('Show the move code');
    // The list and the screen are read again.
    await v.untilFn(() => calls(f, 'GET', '/api/bots').length > lists);
  });

  it('a push that did not finish: the dialog names the kept dump; another key sends nothing', async () => {
    const f = mainRoutes({ bot: mainLaneBot({ pushBroken: { at: '2026-11-13T08:00:00.000Z', safetyDump: BROKEN_DUMP } }) })
      .on('POST', RECEIVE, receivedBody(MOVE_CODE, RECEIVE_BROKEN_TEXT));
    const v = await toDb(f);
    await take(v, 'Receive a main');
    await v.until(`the dump ${BROKEN_DUMP}, taken before that push, stays with the backups.`);
    await v.press('n');
    await v.until('Cancelled: receiving was not started.');
    expect(calls(f, 'POST', RECEIVE)).toEqual([]);
    await take(v, 'Receive a main');
    await v.until('Y Receive');
    await v.press('y');
    await v.untilFn(() => codeShown(v, MOVE_CODE));
    expect(flat(v.frame())).toContain(RECEIVE_BROKEN_TEXT);
  });

  it('Esc during the dump: the code is held for this bot, the notice names where to show it without the code, and Show then Esc drops it', async () => {
    const h = held();
    const f = mainRoutes({ switch: RECEIVING_READ() }).on('POST', RECEIVE, h.answer);
    const v = await toDb(f);
    v.session.moveCodes.set('b2', { title: 'Move code of other', code: MOVE_CODE_2, notes: [] });
    await take(v, 'Receive a main');
    await v.until('Y Receive');
    await v.press('y');
    await v.untilFn(() => bars(v.frame()).includes('Waiting for the manager  Esc Back'));
    await v.press(ESC);
    await v.until('Name mybot');
    // A reopened screen waits for the same call and sends nothing.
    await openDb(v);
    await v.until('Waiting for the manager');
    await v.press('a', 'y');
    await v.press(ESC);
    await v.until('Name mybot');
    h.release(receivedBody());
    await v.untilFn(() => v.session.moveCodes.has('b1'));
    await v.until(moveCodeReadyText('mybot'));
    expect(v.session.notice).toBe(`mybot: ${moveCodeReadyText('mybot')}`);
    expect(v.session.moveCodes.get('b2')?.code).toBe(MOVE_CODE_2);
    expect(calls(f, 'POST', RECEIVE)).toHaveLength(1);
    noCodeOutside(v);
    await openDb(v);
    await take(v, 'Show the move code');
    await v.untilFn(() => codeShown(v, MOVE_CODE));
    expect(v.session.moveCodes.has('b1')).toBe(false);
    expect(v.session.moveCodes.get('b2')?.code).toBe(MOVE_CODE_2);
    await v.press(ESC);
    await v.until('Database: mybot');
    const after = v.frames.length;
    await v.press('a');
    await v.until('Actions: mybot');
    expect(db(v).actionRows().map((r) => r.label)).not.toContain('Show the move code');
    for (const fr of v.frames.slice(after)) for (const p of PIECES) expect(fr).not.toContain(p);
    expect(v.session.moveCodes.has('b1')).toBe(false);
    expect(v.session.moveCodes.get('b2')?.code).toBe(MOVE_CODE_2);
  });

  it('a refusal, a done answer with no code, and no answer', async () => {
    let next: Reply | Error = laneRefused(RECEIVE_NOT_OFF);
    const f = mainRoutes().on('POST', RECEIVE, () => next);
    const v = await toDb(f);
    const once = async (text: string) => {
      await take(v, 'Receive a main');
      await v.until('Y Receive');
      await v.press('y');
      await v.until(text);
    };
    await once(RECEIVE_NOT_OFF);
    next = laneRefused('', 500);
    await once('The receive was refused');
    next = ok({ success: true, text: ALREADY_PUSHED });
    await once(ALREADY_PUSHED);
    next = noAnswer();
    await once(noAnswerText('receive', 'connect ECONNREFUSED 127.0.0.1:8080'));
    expect(calls(f, 'POST', RECEIVE)).toHaveLength(4);
    expect(v.session.moveCodes.size).toBe(0);
  });
});

describe('m5 receiving', () => {
  const receiving = () => mainLaneBot({ receive: { expiresAt: '2026-11-15T10:00:00.000Z' } });

  it('Stop receiving: its dialog, one DELETE, the route\'s texts and no answer; a success drops this bot\'s held code only', async () => {
    const answers: Array<Reply | Error> = [laneRefused(NOT_RECEIVING), ok({ success: true, text: STOPPED_RECEIVING }), noAnswer()];
    const f = mainRoutes({ bot: receiving(), switch: RECEIVING_READ() }).on('DELETE', RECEIVE, () => answers.shift()!);
    const v = await toDb(f);
    v.session.moveCodes.set('b1', { title: 'Move code of mybot', code: MOVE_CODE, notes: [] });
    v.session.moveCodes.set('b2', { title: 'Move code of other', code: MOVE_CODE_2, notes: [] });
    await take(v, 'Stop receiving');
    await v.until('Y Stop receiving');
    await v.press('y');
    await v.until(NOT_RECEIVING);
    expect(calls(f, 'DELETE', RECEIVE)).toHaveLength(1);
    expect(calls(f, 'DELETE', RECEIVE)[0].body).toBeUndefined();
    expect(v.session.moveCodes.has('b1')).toBe(true);
    await take(v, 'Stop receiving');
    await v.until('Y Stop receiving');
    await v.press('y');
    await v.until(STOPPED_RECEIVING);
    expect(v.session.moveCodes.has('b1')).toBe(false);
    expect(v.session.moveCodes.has('b2')).toBe(true);
    await take(v, 'Stop receiving');
    await v.until('Y Stop receiving');
    await v.press('y');
    await v.until(noAnswerText('stop', 'connect ECONNREFUSED 127.0.0.1:8080'));
    expect(calls(f, 'DELETE', RECEIVE)).toHaveLength(3);
  });

  it('Make a new move code: its dialog says the old code stops working, Y sends the same POST once, the new code shows', async () => {
    const f = mainRoutes({ bot: receiving() }).on('POST', RECEIVE, receivedBody(MOVE_CODE_2));
    const v = await toDb(f);
    await take(v, 'Make a new move code');
    for (const l of newCodeQuestion('mybot')) await v.until(l);
    await v.press('x');
    await v.until('Cancelled: no new move code was made.');
    await take(v, 'Make a new move code');
    await v.until('Y Make a new code');
    await v.press('y', 'y');
    await v.untilFn(() => codeShown(v, MOVE_CODE_2));
    expect(calls(f, 'POST', RECEIVE)).toHaveLength(1);
  });
});

describe('m5 Push the main', () => {
  it('a pasted code: Enter opens the dialog naming the bot and never the code, Y Y Y sends once, the question round, accepted, then the frame', async () => {
    const f = mainRoutes();
    const first = held();
    let n = 0;
    f.on('POST', PUSH, (body) => {
      n++;
      if (!(body as { confirm?: boolean }).confirm) return first.answer();
      setTimeout(() => f.emit('bot:switch', switchFrame('op-p', true, PUSHED)), 300);
      return laneAccepted('op-p');
    });
    const v = await toDb(f);
    await take(v, 'Push the main');
    await v.until('Move code');
    expect(bars(v.frame())).toContain('Enter Push  Esc Back');
    await v.press(ENTER);
    await v.until(NO_MOVE_CODE_TEXT);
    expect(n).toBe(0);
    await paste(v);
    for (const l of pushQuestion('mybot')) await v.until(l);
    expect(n).toBe(0);
    expect(v.session.codeFocus).toBeNull();
    await v.press('y', 'y', 'Y');
    await v.until('Pushing: this database is dumped first');
    first.release(laneQuestion(HELD_PUSH_Q));
    await v.until(HELD_PUSH_Q);
    expect(calls(f, 'POST', PUSH).map((c) => c.body)).toEqual([{ moveCode: MOVE_CODE }]);
    await v.until('Y Confirm');
    await v.press('y', 'y');
    await v.until(workingText('mybot'));
    expect(v.session.notice).toBe(`mybot: ${workingText('mybot')}`);
    await v.until(PUSHED.slice(0, 60));
    expect(calls(f, 'POST', PUSH).map((c) => c.body)).toEqual([{ moveCode: MOVE_CODE }, { moveCode: MOVE_CODE, confirm: true }]);
    expect(db(v).joinForm).toBeNull();
    expect(v.session.codeFocus).toBeNull();
    noCodeOutside(v);
  });

  it('a failure frame names the next step and keeps the code; RECVLOGIN; the old-code and not-a-code refusals; no answer', async () => {
    let next: () => Reply | Error = () => laneRefused(OLD_MOVE_CODE, 400);
    const f = mainRoutes();
    f.on('POST', PUSH, () => next());
    const v = await toDb(f);
    await take(v, 'Push the main');
    await paste(v);
    await v.until('Y Push');
    await v.press('y');
    await v.until(OLD_MOVE_CODE);
    expect(db(v).joinForm?.code.text).toBe(MOVE_CODE);
    const again = async (text: string) => {
      await v.press(ENTER);
      await v.until('Y Push');
      await v.press('y');
      await v.until(text);
      expect(db(v).joinForm?.code.text).toBe(MOVE_CODE);
    };
    next = () => laneRefused(NOT_A_MOVE_CODE, 400);
    await again(NOT_A_MOVE_CODE);
    for (const [id, text] of [['op-f', PUSH_FAILED], ['op-r', RECVLOGIN]]) {
      next = () => {
        setTimeout(() => f.emit('bot:switch', switchFrame(id, false, text)), 100);
        return laneAccepted(id);
      };
      await again(text.slice(0, 60));
    }
    next = () => noAnswer();
    await again(noAnswerText('push', 'connect ECONNREFUSED 127.0.0.1:8080'));
    expect(calls(f, 'POST', PUSH)).toHaveLength(5);
    for (const c of calls(f, 'POST', PUSH)) expect(c.body).toEqual({ moveCode: MOVE_CODE });
    noCodeOutside(v);
  });

  it('accepted, then /ws closing or the push limit passing: can\'t confirm', async () => {
    let id = 0;
    const f = mainRoutes();
    f.on('POST', PUSH, () => laneAccepted(`op-${++id}`));
    const v = await toDb(f, { db: { pushLimitMs: 400, laneLimitMs: 60_000 } });
    await take(v, 'Push the main');
    await paste(v);
    await v.press('y');
    await v.until("Can't confirm the push: no result came within 400 ms; it may still be running. The Move lines show what stands.");
    await v.press(ENTER);
    await v.until('Y Push');
    await v.press('y');
    await v.until(workingText('mybot'));
    f.drop('socket hang up');
    await v.until("Can't confirm the push: the event stream closed (socket hang up); it may still be running.");
    expect(db(v).joinForm?.code.text).toBe(MOVE_CODE);
  });

  it('the push waits 110 min for its frame by a fake clock: not yet a second before, ended a second after', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    expect(PUSH_LIMIT_MS).toBe(110 * 60_000);
    const f = wsFake().on('POST', PUSH, laneAccepted('op-1'));
    let r: unknown = null;
    void laneCall(f.client, 'b1', 'POST', PUSH, { moveCode: MOVE_CODE }, { op: 'push', limitMs: PUSH_LIMIT_MS }).then((x) => {
      r = x;
    });
    await vi.advanceTimersByTimeAsync(PUSH_LIMIT_MS - 1000);
    expect(r).toBeNull();
    await vi.advanceTimersByTimeAsync(2000);
    expect(r).toEqual({ kind: 'unconfirmed', text: "Can't confirm the push: no result came within 110 min; it may still be running. The Move lines show what stands." });
    expect(f.live()).toBe(0);
  });

  it('the screen passes 110 min to an accepted push by default', async () => {
    const f = mainRoutes();
    f.on('POST', PUSH, laneAccepted('op-d'));
    const v = await toDb(f);
    const seen: number[] = [];
    const real = global.setTimeout;
    const spy = vi.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      if (typeof ms === 'number' && ms >= 60_000) seen.push(ms);
      return real(fn, ms);
    }) as never);
    await take(v, 'Push the main');
    await paste(v);
    await v.press('y');
    await v.until(workingText('mybot'));
    await v.untilFn(() => seen.includes(PUSH_LIMIT_MS));
    spy.mockRestore();
  });
});

describe('m5 Make a backup for a move', () => {
  it('the dialog, the held question round, then the text with this host\'s paths and the moved- names', async () => {
    const f = mainRoutes();
    f.on('POST', MOVE_OUT, (body) => ((body as { confirm?: boolean }).confirm ? movedBody() : laneQuestion(HELD_MOVE_Q)));
    const v = await toDb(f, { columns: 120 });
    await take(v, 'Make a backup for a move');
    for (const l of MOVE_OUT_QUESTION) await v.until(l);
    await v.press('y');
    await v.until(HELD_MOVE_Q);
    await v.press('y');
    const want = moveOutText(ROOT, 'b1', MOVE_FILE, MOVE_TEXT);
    await v.until(want.slice(0, 80));
    expect(calls(f, 'POST', MOVE_OUT).map((c) => c.body)).toEqual([{}, { confirm: true }]);
    expect(db(v).notice).toBe(want);
    expect(want).toContain(`Folder on the host: ${ROOT}/backups/b1/fleet-postgres`);
    expect(want).not.toContain('is downloading');
    expect(v.session.notice).toBe(`mybot: ${want}`);
  });

  it('without HOST_DATA_DIR the manager\'s data folder is named; refusal and no answer', async () => {
    const answers: Array<Reply | Error> = [movedBody(), laneRefused(MOVE_DUMP_FAILED, 500), noAnswer()];
    const f = mainRoutes().on('POST', MOVE_OUT, () => answers.shift()!);
    const v = await toDb(f, { db: { env: {} } });
    const once = async (text: string) => {
      await take(v, 'Make a backup for a move');
      await v.until('Y Make the backup');
      await v.press('y');
      await v.until(text);
    };
    await once("In the manager's data folder: backups/b1/fleet-postgres");
    await once(MOVE_DUMP_FAILED);
    await once(noAnswerText('move', 'connect ECONNREFUSED 127.0.0.1:8080'));
  });

  it('moveOutText: the route\'s sentence replaced, the rest kept; a text that starts otherwise kept whole after the paths', () => {
    const tail = ' The bot here did not stop (timeout); stop it, then press Rejoin as a copy.';
    expect(moveOutText(ROOT, 'b1', MOVE_FILE, MOVE_TEXT + tail)).toBe(
      `The backup ${MOVE_FILE} is ready. Folder on the host: ${ROOT}/backups/b1/fleet-postgres; Dump: ${MOVE_FILE}. Copy only the dump to the other `
      + "machine's backups folder for that bot, under a name that does not end in .dump (for example moved-2026-11-14T10-00-00-000Z.part), then "
      + 'rename it moved-2026-11-14T10-00-00-000Z.dump there and restore it with the bot in Maintenance or Off. Do not copy its counts file '
      + `${MOVE_FILE}.json: it names ${MOVE_FILE}, so a copy renamed to match the moved- dump is refused, and a moved- dump restores without one. This bot stays `
      + 'stopped here, with its database login blocked, until you Cancel the move.' + tail,
    );
    expect(moveOutText(null, 'b1', MOVE_FILE, 'Something else entirely.')).toBe(
      `In the manager's data folder: backups/b1/fleet-postgres; Dump: ${MOVE_FILE}. Something else entirely.`,
    );
    // The sentence of another file is not replaced.
    expect(moveOutText(ROOT, 'b1', 'pre-move-x.dump', MOVE_TEXT)).toContain(MOVE_TEXT);
  });

  it('a done answer without a file shows the route\'s text', async () => {
    const f = mainRoutes().on('POST', MOVE_OUT, movedBody(MOVE_TEXT, null));
    const v = await toDb(f);
    await take(v, 'Make a backup for a move');
    await v.until('Y Make the backup');
    await v.press('y');
    await v.until(MOVE_TEXT.slice(0, 60));
    expect(db(v).notice).toBe(MOVE_TEXT);
  });
});

describe('m5 part 5 frames', () => {
  it('the rows wrap inside 80 columns and the key bar of the push form fits', async () => {
    const f = mainRoutes({ bot: mainLaneBot({ receive: { expiresAt: '2026-11-15T10:00:00.000Z' } }) });
    const v = await toDb(f, { columns: 80, rows: 24 });
    await v.untilFn(() => bars(v.frame()).includes('A Actions'));
    await v.press('a');
    await v.until('Stop receiving');
    for (const l of v.frame().split('\n')) expect(l.length).toBeLessThanOrEqual(79);
    expect(flat(v.frame())).toContain('Make a new move code (the code shown before stops working)');
  });
});
