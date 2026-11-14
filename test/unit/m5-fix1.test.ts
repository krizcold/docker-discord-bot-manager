import { afterEach, describe, expect, it, vi } from 'vitest';
import { actionRows, cancelQuestion, PUSH_LIMIT_MS } from '../../src/cli/tui/actions';
import type { InkApi } from '../../src/cli/tui/app';
import { codeLines } from '../../src/cli/tui/codes';
import { copyInText, moveOutText } from '../../src/cli/tui/dbtext';
import { runTui } from '../../src/cli/tui/run';
import { restoreKindOf } from '../../src/instance/switchSql';
import { botList, fake, Reply } from './m2-fake';
import { replicaBody, switchBody } from './m4-fake';
import {
  CANCEL_PROOF_Q, CANCEL_STREAM_Q, copyNoRecord, copyOf, JOIN_CODE, joinCodeBody, JOINED, laneQuestion, laneRefused, MOVE_CODE, MOVE_CODE_2, MOVE_FILE, MOVE_TEXT,
  PROVISION_RUNNING, provisionRefused, receivedBody, VOLUME, VOLUME_QUESTION, volumeQuestion,
} from './m5-fake';
import {
  B, bars, calls, closeAll, copyRoutes, db, END, ENTER, ESC, flat, HANDOVER, held, mainLaneBot, mainRoutes, openDb, readWhole, START, start, take, tick, toDb, V,
  WAIT_MS,
} from './m5-lanekit';

vi.setConfig({ testTimeout: 40_000 });
afterEach(() => {
  vi.restoreAllMocks();
  closeAll();
});

const DOWN = '\u001B[B';
const UP = '\u001B[A';
const RECEIVE = `${B}/fleet-receive`;
const REPLICA = `${B}/fleet-replica`;
const ROOT = '/srv/smdb/data';
const STEM = '2026-11-14T10-00-00-000Z';
const RECEIVING = { startedAt: '2026-11-14T09:00:00.000Z', expiresAt: '2026-11-15T09:00:00.000Z', safetyDump: 'pre-receive-2026-11-14T09-00-00-000Z.dump' };
const LIST_CHANGED = 'The list changed; pick the action again with Up or Down.';
const CANCEL_NOT_CONFIRMED = 'Not confirmed: the cancel did not finish; the Move lines show what stands.';

const lines = (v: V) => v.frame().split('\n');
const codeShown = (v: V, code: string) => codeLines(code).every((l) => lines(v).includes(l));
const labels = (v: V) => db(v).actionRows().map((r) => r.label);
const readAgain = (v: V) => (db(v) as unknown as { tick(): void }).tick();

async function cursorOn(v: V, label: string) {
  for (const end = Date.now() + WAIT_MS; Date.now() < end && !lines(v).some((l) => l.includes(`> ${label}`));) await v.press(DOWN);
  expect(v.frame()).toContain(`> ${label}`);
}

async function pasteCode(v: V, code: string) {
  v.stdin.write(`${START}${code}${END}`);
  await tick(50);
  await v.press(ENTER);
}

describe('m5 fix 1: the Actions list sends only the row it showed (A1)', () => {
  it('a read that removes the row under the cursor between Down and Enter sends nothing; the next Enter takes the row now shown', async () => {
    let copies = [copyOf('yundera')];
    const bot = mainLaneBot({ handover: { mode: 'stream', phase: 'waiting', machine: 'yundera' } });
    const f = mainRoutes({ bot, switch: () => switchBody({ copies }) }).on('DELETE', HANDOVER, laneQuestion(CANCEL_STREAM_Q));
    const v = await toDb(f);
    await v.untilFn(() => labels(v).includes('Hand over to yundera') && bars(v.frame()).includes('A Actions'));
    await v.press('a');
    await cursorOn(v, 'Hand over to yundera');
    copies = [];
    readAgain(v);
    await v.untilFn(() => !labels(v).includes('Hand over to yundera'));
    await v.press(ENTER);
    await v.until(LIST_CHANGED);
    expect(calls(f, 'DELETE', HANDOVER)).toEqual([]);
    expect(db(v).confirm).toBeNull();
    expect(v.frame()).toContain('> Cancel the hand-over');
    // A3: a second Enter (a double press) sends nothing either; only Up or Down picks a row again.
    await v.press(ENTER);
    await tick(200);
    expect(calls(f, 'DELETE', HANDOVER)).toEqual([]);
    expect(db(v).confirm).toBeNull();
    expect(db(v).actions?.row).toBeNull();
    await v.press(UP, DOWN);
    expect(v.frame()).toContain('> Cancel the hand-over');
    await v.press(ENTER);
    await v.until('Y Cancel the hand-over');
    expect(calls(f, 'DELETE', HANDOVER)).toEqual([]);
    await v.press('y');
    await v.until(CANCEL_STREAM_Q.slice(0, 60));
    expect(calls(f, 'DELETE', HANDOVER)).toHaveLength(1);
  });

  it('a row that keeps its label but changes the slot it sends is not taken; the dialog then carries the new slot', async () => {
    let slot = 'smdb_copy_one';
    const f = mainRoutes({ switch: () => switchBody({ copies: [copyOf('yundera', true, slot)] }) }).on('POST', HANDOVER, laneQuestion('Held?'));
    const v = await toDb(f);
    await v.untilFn(() => labels(v).includes('Hand over to yundera') && bars(v.frame()).includes('A Actions'));
    await v.press('a');
    await cursorOn(v, 'Hand over to yundera');
    slot = 'smdb_copy_two';
    readAgain(v);
    await v.untilFn(() => db(v).actionRows().some((r) => r.kind === 'handover' && r.slot === 'smdb_copy_two'));
    await v.press(ENTER);
    await v.until(LIST_CHANGED);
    expect(db(v).confirm).toBeNull();
    await v.press(UP, DOWN);
    expect(v.frame()).toContain('> Hand over to yundera');
    await v.press(ENTER);
    await v.until('Y Hand over');
    await v.press('y');
    await v.until('Held?');
    expect(calls(f, 'POST', HANDOVER).map((c) => c.body)).toEqual([{ slot: 'smdb_copy_two' }]);
  });
});

describe('m5 fix 1: texts (A2, B1, G2) and the push limit (B3)', () => {
  it('A2: another key on the question asked after this database started and its row was deleted does not say nothing changed', async () => {
    const f = mainRoutes({ bot: mainLaneBot({ handover: { mode: 'stream', phase: 'stopped', machine: 'yundera' } }) })
      .on('DELETE', HANDOVER, laneQuestion(CANCEL_PROOF_Q));
    const v = await toDb(f);
    await take(v, 'Cancel the hand-over');
    await v.until('Y Cancel the hand-over');
    await v.press('y');
    await v.until('Y Confirm');
    await v.press('n');
    await v.until(CANCEL_NOT_CONFIRMED);
    expect(flat(v.frame())).not.toContain('nothing was cancelled');
    expect(calls(f, 'DELETE', HANDOVER)).toHaveLength(1);
  });

  it('B1: the move-out text copies the dump alone and renames it moved- on the other machine; its counts file is not copied', () => {
    const tail = ' The bot here did not stop (timeout); stop it, then press Rejoin as a copy.';
    expect(moveOutText(ROOT, 'b1', MOVE_FILE, MOVE_TEXT + tail)).toBe(
      `The backup ${MOVE_FILE} is ready. Folder on the host: ${ROOT}/backups/b1/fleet-postgres; Dump: ${MOVE_FILE}. Copy only the dump to the other `
      + `machine's backups folder for that bot, under a name that does not end in .dump (for example moved-${STEM}.part), then rename it `
      + `moved-${STEM}.dump there and restore it with the bot in Maintenance or Off. Do not copy its counts file ${MOVE_FILE}.json: it names `
      + `${MOVE_FILE}, so a copy renamed to match the moved- dump is refused, and a moved- dump restores without one. This bot stays stopped here, with its `
      + 'database login blocked, until you Cancel the move.' + tail,
    );
    expect(moveOutText(ROOT, 'b1', MOVE_FILE, MOVE_TEXT)).not.toContain(`moved-${STEM}.dump.json`);
    expect(restoreKindOf(`moved-${STEM}.dump`)).toBe('moved');
    expect(moveOutText(null, 'b1', MOVE_FILE, 'Something else entirely.')).toBe(
      `In the manager's data folder: backups/b1/fleet-postgres; Dump: ${MOVE_FILE}. Something else entirely.`,
    );
  });

  it('G2: the copy-in text says a counts file keeps its dump\'s name and a moved- dump restores without one', () => {
    const t = copyInText(ROOT, 'b1');
    expect(t).toContain('It restores when its counts file <name>.dump.json is copied beside it under the name it was written with: the counts file names '
      + 'its dump, and one renamed to fit another dump is refused.');
    expect(t).toContain('A dump named moved-<anything>.dump restores without a counts file, as a move: this machine becomes the bot\'s main.');
  });

  it('B3: an accepted push is waited for 110 min', () => {
    expect(PUSH_LIMIT_MS).toBe(110 * 60_000);
  });
});

describe('m5 fix 1: the held move code (B2, G1)', () => {
  it('B2: Make a new move code drops the code held before it; a switch read with no receive drops a held code', async () => {
    let sw: Reply = switchBody({ receive: RECEIVING });
    const f = mainRoutes({ bot: mainLaneBot({ receive: { expiresAt: RECEIVING.expiresAt } }), switch: () => sw }).on('POST', RECEIVE, receivedBody(MOVE_CODE_2));
    const v = await toDb(f);
    v.session.moveCodes.set('b1', { title: 'Move code of mybot', code: MOVE_CODE, notes: [] });
    await take(v, 'Make a new move code');
    await v.until('Y Make a new code');
    await v.press('y');
    await v.untilFn(() => codeShown(v, MOVE_CODE_2));
    await v.press(ESC);
    await v.until('Database: mybot');
    expect(v.session.moveCodes.has('b1')).toBe(false);
    expect(labels(v)).not.toContain('Show the move code');
    v.session.moveCodes.set('b1', { title: 'Move code of mybot', code: MOVE_CODE, notes: [] });
    readAgain(v);
    await tick(200);
    expect(v.session.moveCodes.has('b1')).toBe(true);
    sw = switchBody({ receive: null });
    readAgain(v);
    await v.untilFn(() => !v.session.moveCodes.has('b1'));
  });

  it('G1: Esc on a code screen too narrow for the code keeps it held, and Show the move code stays offered', async () => {
    const f = mainRoutes({ switch: switchBody({ receive: RECEIVING }) }).on('POST', RECEIVE, receivedBody());
    const v = await toDb(f, { columns: 64 });
    await take(v, 'Receive a main');
    await v.until('Y Receive');
    await v.press('y');
    await v.until('Widen the window to show the code');
    await v.press(ESC);
    await v.until('Database: mybot');
    expect(v.session.moveCodes.get('b1')?.code).toBe(MOVE_CODE);
    expect(labels(v)).toContain('Show the move code');
    await take(v, 'Show the move code');
    await v.until('Widen the window to show the code');
    await v.press(ESC);
    await v.until('Database: mybot');
    expect(v.session.moveCodes.get('b1')?.code).toBe(MOVE_CODE);
    expect(labels(v)).toContain('Show the move code');
    for (const fr of v.frames) expect(fr).not.toContain(MOVE_CODE.slice(10, 40));
  });
});

describe('m5 fix 1: a dialog draws its end whole when the Y bar wraps (C1)', () => {
  it('M4\'s restore at 50x24 reaches Y Restore', async () => {
    const v = await toDb(mainRoutes());
    await v.resize(50, 24);
    await v.until('> hourly-2026');
    await v.press(ENTER);
    await v.until('Down More');
    await readWhole(v, 'Y Restore', 50);
  });

  it('a scrolling Y Confirm at 40 columns', async () => {
    const f = mainRoutes({ bot: mainLaneBot({ handover: { mode: 'stream', phase: 'stopped', machine: 'yundera' } }) })
      .on('DELETE', HANDOVER, laneQuestion(CANCEL_STREAM_Q));
    const v = await toDb(f);
    await v.resize(40, 16);
    await take(v, 'Cancel the hand-over');
    await v.until('Down More');
    await readWhole(v, 'Y Cancel the hand-over', 40);
    await v.press('y');
    await v.until('Down More');
    await readWhole(v, 'Y Confirm', 40);
  });

  it('take-over\'s toggle bar at 70 columns', async () => {
    const v = await toDb(copyRoutes());
    await v.resize(70, 12);
    await take(v, 'Take over');
    await v.until('Down More');
    await readWhole(v, 'Y Take over', 70);
  });
});

describe('m5 fix 1: a join that happened stays said (C2, C3)', () => {
  const routes = () => copyRoutes({ replica: replicaBody(copyNoRecord()) });

  it('the question names the join first; another key and a refusal keep it', async () => {
    let next: (body: unknown) => Reply = volumeQuestion;
    const f = routes().on('POST', REPLICA, (body) => next(body));
    const v = await toDb(f);
    await take(v, 'Add a live copy');
    await v.until('Join code');
    await pasteCode(v, JOIN_CODE);
    await v.until('Y Add the copy');
    await v.press('y');
    await v.until('Y Clear and provision');
    expect(flat(v.frame())).toContain(`${JOINED} ${VOLUME_QUESTION} Clear ${VOLUME} and provision?`);
    await v.press('n');
    await v.until(`${JOINED} Cancelled: the copy was not started.`);
    next = (body) => provisionRefused(PROVISION_RUNNING, body);
    await v.untilFn(() => v.session.codeFocus !== null);
    await v.press(ENTER);
    await v.until('Y Add the copy');
    await v.press('y');
    await v.until(`${JOINED} The copy was not started: ${PROVISION_RUNNING}`);
    expect(calls(f, 'POST', REPLICA).map((c) => (c.body as { joinCode?: string }).joinCode)).toEqual([JOIN_CODE, JOIN_CODE]);
  });

  it('a question that lands after the screen closed names the join on the bot screen', async () => {
    const h = held();
    const f = routes().on('POST', REPLICA, h.answer);
    const v = await toDb(f);
    await take(v, 'Add a live copy');
    await v.until('Join code');
    await pasteCode(v, JOIN_CODE);
    await v.until('Y Add the copy');
    await v.press('y');
    await v.untilFn(() => bars(v.frame()).includes('Waiting for the manager  Esc Back'));
    await v.press(ESC);
    await v.until('Name mybot');
    h.release(volumeQuestion({ joinCode: JOIN_CODE }));
    await v.until(`mybot: ${JOINED} The copy was not started: the manager asked to confirm after the Database screen was closed (${VOLUME_QUESTION}).`);
  });
});

describe('m5 fix 1: Ctrl+C (D1)', () => {
  it('on the code screen it draws a frame without the code, then exits', async () => {
    const f = mainRoutes().on('GET', `${B}/fleet-replication/join-code`, joinCodeBody());
    const v = await toDb(f);
    await v.untilFn(() => bars(v.frame()).includes('J Join code'));
    await v.press('j');
    await v.untilFn(() => codeShown(v, JOIN_CODE));
    v.stdin.write('\x03');
    await tick(200);
    const last = v.frame();
    for (const l of codeLines(JOIN_CODE)) expect(last).not.toContain(l);
    expect(last).not.toContain(JOIN_CODE.slice(10, 40));
    await v.press(ESC, 'a', ESC, 'q');
    await tick(100);
    expect(v.frame()).toBe(last);
  });

  it('elsewhere it exits as before', async () => {
    const v = await start(mainRoutes());
    await v.until('mybot');
    v.stdin.write('\x03');
    await tick(200);
    const last = v.frame();
    await v.press(ENTER);
    await tick(100);
    expect(v.frame()).toBe(last);
  });

  it('runTui leaves Ctrl+C to the frame', async () => {
    let options: Record<string, unknown> = {};
    vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as typeof process.stdout.write);
    const fakeInk = {
      render: (_node: unknown, o: Record<string, unknown>) => {
        options = o;
        return { waitUntilExit: () => Promise.resolve(), cleanup: () => {}, unmount: () => {}, rerender: () => {}, clear: () => {} };
      },
    } as unknown as InkApi;
    await runTui(fake().on('GET', '/api/bots', botList([])).client, { ink: fakeInk });
    expect(options.exitOnCtrlC).toBe(false);
  });
});

describe('m5 fix 2: the rows that sent with no dialog ask first (A3)', () => {
  it('Cancel the hand-over: the dialog says what the route does; another key sends nothing; Y Y Y sends one DELETE', async () => {
    const h = held();
    const f = mainRoutes({ bot: mainLaneBot({ handover: { mode: 'stream', phase: 'stopped', machine: 'yundera' } }) })
      .on('DELETE', HANDOVER, h.answer);
    const v = await toDb(f);
    await take(v, 'Cancel the hand-over');
    await v.until('Cancel the hand-over to yundera?');
    await v.until('The manager first checks whether yundera took over; if it did, the cancel is refused.');
    await v.until('Y Cancel the hand-over');
    await v.press('n');
    await v.until('Cancelled: nothing was sent.');
    expect(calls(f, 'DELETE', HANDOVER)).toEqual([]);
    await take(v, 'Cancel the hand-over');
    await v.until('Y Cancel the hand-over');
    await v.press('y', 'y', 'y');
    expect(calls(f, 'DELETE', HANDOVER)).toHaveLength(1);
    h.release(laneQuestion(CANCEL_STREAM_Q));
    await v.until(CANCEL_STREAM_Q.slice(0, 60));
    expect(calls(f, 'DELETE', HANDOVER)).toHaveLength(1);
  });

  it('Cancel the move names the backup for a file move and the machine for a push', async () => {
    const file = 'pre-move-2026-11-14T09-00-00-000Z.dump';
    for (const [handover, want, yes] of [
      [{ mode: 'file', phase: 'waiting', file }, `so cancel only if the backup ${file} was not restored on another machine`, 'Y Cancel the move'],
      [{ mode: 'push', phase: 'pushing', machine: 'yundera' }, 'Cancel the push to yundera?', 'Y Cancel the push'],
    ] as const) {
      const f = mainRoutes({ bot: mainLaneBot({ handover }) }).on('DELETE', HANDOVER, laneQuestion('Cancel it?'));
      const v = await toDb(f);
      await take(v, 'Cancel the move');
      await v.until(want);
      await v.until(yes);
      expect(calls(f, 'DELETE', HANDOVER)).toEqual([]);
      await v.press('y');
      await v.until('Cancel it?');
      expect(calls(f, 'DELETE', HANDOVER)).toHaveLength(1);
      closeAll();
    }
  });

  it('Stop receiving: the dialog names the dump taken before receiving; another key sends nothing; Y Y sends one DELETE', async () => {
    const h = held();
    const f = mainRoutes({ bot: mainLaneBot({ receive: { expiresAt: RECEIVING.expiresAt, safetyDump: RECEIVING.safetyDump } }), switch: switchBody({ receive: RECEIVING }) })
      .on('DELETE', RECEIVE, h.answer);
    const v = await toDb(f);
    await take(v, 'Stop receiving');
    await v.until('Stop receiving a main for mybot?');
    await v.until(`until you restore the dump ${RECEIVING.safetyDump} taken before receiving`);
    await v.press('n');
    await v.until('Cancelled: nothing was sent.');
    expect(calls(f, 'DELETE', RECEIVE)).toEqual([]);
    await take(v, 'Stop receiving');
    await v.until('Y Stop receiving');
    await v.press('y', 'y');
    expect(calls(f, 'DELETE', RECEIVE)).toHaveLength(1);
    h.release(laneQuestion('Stop it?'));
    await v.until('Stop it?');
    expect(calls(f, 'DELETE', RECEIVE)).toHaveLength(1);
  });
});

describe('m5 fix 2: Ctrl+C inside an unfinished paste (D2)', () => {
  it('a paste start with no end, then Ctrl+C, exits', async () => {
    const v = await start(mainRoutes());
    await v.until('mybot');
    v.stdin.write(START);
    await tick(50);
    v.stdin.write('\x03');
    await tick(200);
    const last = v.frame();
    v.stdin.write(END);
    await tick(50);
    await v.press(ENTER, 'd');
    await tick(100);
    expect(v.frame()).toBe(last);
  });

  it('on the code screen the same leaves no code line', async () => {
    const f = mainRoutes().on('GET', `${B}/fleet-replication/join-code`, joinCodeBody());
    const v = await toDb(f);
    await v.untilFn(() => bars(v.frame()).includes('J Join code'));
    await v.press('j');
    await v.untilFn(() => codeShown(v, JOIN_CODE));
    v.stdin.write(START);
    await tick(50);
    v.stdin.write('\x03');
    await tick(200);
    const last = v.frame();
    for (const l of codeLines(JOIN_CODE)) expect(last).not.toContain(l);
    v.stdin.write(END);
    await tick(50);
    await v.press(ESC, 'a');
    await tick(100);
    expect(v.frame()).toBe(last);
  });
});

describe('m5 fix 2: a switch read sent before the move code was made (B4)', () => {
  it('lands after the code is held and keeps it; a later read without the receive drops it', async () => {
    const h = held();
    const late = held();
    let sw: () => Reply | Promise<Reply> = () => switchBody({ receive: RECEIVING });
    const f = mainRoutes({ switch: (() => sw()) as never }).on('POST', RECEIVE, h.answer);
    const v = await toDb(f);
    await take(v, 'Receive a main');
    await v.until('Y Receive');
    await v.press('y');
    await v.untilFn(() => bars(v.frame()).includes('Waiting for the manager  Esc Back'));
    const reads = calls(f, 'GET', `${B}/fleet-switch`).length;
    sw = late.answer;
    readAgain(v);
    await v.untilFn(() => calls(f, 'GET', `${B}/fleet-switch`).length === reads + 1);
    sw = () => switchBody({ receive: RECEIVING });
    await v.press(ESC);
    await v.until('Name mybot');
    h.release(receivedBody());
    await v.untilFn(() => v.session.moveCodes.has('b1'));
    late.release(switchBody({ receive: null }));
    await tick(200);
    expect(v.session.moveCodes.get('b1')?.code).toBe(MOVE_CODE);
    await openDb(v);
    await v.untilFn(() => labels(v).includes('Show the move code'));
    sw = () => switchBody({ receive: null });
    readAgain(v);
    await v.untilFn(() => !v.session.moveCodes.has('b1'));
    expect(labels(v)).not.toContain('Show the move code');
  });
});

describe('m5 fix 3: Cancel the move after a finished push (A4)', () => {
  it('the dialog says the push finished, the other machine is the main and the cancel is refused; Y sends and shows the refusal', async () => {
    const finished = 'The push finished: yundera is the main. Rejoin this machine as a copy instead.';
    const f = mainRoutes({ bot: mainLaneBot({ handover: { mode: 'push', phase: 'done', machine: 'yundera' } }) })
      .on('DELETE', HANDOVER, laneRefused(finished));
    const v = await toDb(f);
    await take(v, 'Cancel the move');
    await v.until('The push to yundera finished: yundera is the main, so the manager refuses the cancel. Rejoin this machine as a copy instead.');
    expect(flat(v.frame())).not.toContain("This machine's database stays the main");
    expect(flat(v.frame())).not.toContain('asks once more');
    await v.until('Y Cancel the push');
    await v.press('y');
    await v.until(finished);
    expect(calls(f, 'DELETE', HANDOVER)).toHaveLength(1);
  });

  it('a push not finished keeps its text, and the row carries the phase', () => {
    expect(cancelQuestion('push', 'yundera', '', 'pushing').lines[1]).toContain("This machine's database stays the main; the push never changed it.");
    const rows = (phase: string) => actionRows('main', { switch: { ok: true, value: {} } as never }, mainLaneBot({ handover: { mode: 'push', phase, machine: 'yundera' } }) as never);
    expect(rows('done').find((r) => r.kind === 'cancel')).toMatchObject({ phase: 'done' });
    expect(rows('pushing').find((r) => r.kind === 'cancel')).toMatchObject({ phase: 'pushing' });
  });
});
