import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHECKING_REFUSAL, NO_CODE_TEXT, NO_SEED_TEXT, STALE_QUESTION, STALE_RUNNING, STALE_TIP } from '../../src/cli/tui/actions';
import { innerWidth } from '../../src/cli/tui/app';
import { wrap } from '../../src/cli/tui/install';
import { noAnswer, ok, Reply } from './m2-fake';
import { copyBot } from './m4-fake';
import {
  JOIN_CODE, laneAccepted, laneQuestion, laneRefused, MAIN_UP, NO_MAIN_RECORDED, OWN_CODE, rejoinStarted, SAME_HOST, SHARD_CAP, staleSameHost, staleVolume,
  STOP_FIRST, switchFrame, TAKEN_OVER, UNCHECKED_Q, UNPLANNED_Q, VOLUME, VOLUME_QUESTION,
} from './m5-fake';
import {
  bars, calls, closeAll, copyRoutes, db, END, ENTER, ESC, flat, mainLaneBot, mainRoutes, openDb, readWhole, RESEED_STALE, START, take, TAKEOVER, tick, toDb, V,
} from './m5-lanekit';

vi.setConfig({ testTimeout: 40_000 });
afterEach(closeAll);

const PIECE = JOIN_CODE.slice(10, 30);
const noCodeAnywhere = (v: V) => {
  for (const fr of v.frames) expect(fr).not.toContain(PIECE);
  expect(JSON.stringify(v.session.notice ?? '')).not.toContain(PIECE);
};
async function paste(v: V) {
  v.stdin.write(`${START}${JOIN_CODE.slice(0, 64)}\r${JOIN_CODE.slice(64)}${END}`);
  await tick(50);
  v.stdin.write('\r');
  await tick(50);
}
const TAKEOVER_TEXT = 'Make this copy the main database? The manager checks the old main first; if it handed over to this copy, nothing is lost.';

describe('m5 Take over', () => {
  it('the dialog with the start toggle on Space; another key sends nothing', async () => {
    const f = copyRoutes().on('POST', TAKEOVER, laneAccepted('op-1'));
    const v = await toDb(f);
    await take(v, 'Take over');
    await v.until(TAKEOVER_TEXT);
    await v.until('[x] Start the bot here when done (Space changes it)');
    expect(bars(v.frame())).toContain('Y Take over  Space Start on/off  any other key Cancel');
    await v.press(' ');
    await v.until('[ ] Start the bot here when done');
    await v.press(' ');
    await v.until('[x] Start the bot here when done');
    await v.press('n');
    await v.until('Cancelled: nothing was sent.');
    expect(calls(f, 'POST', TAKEOVER)).toEqual([]);
  });

  it('at 80x24 the unchecked question is shown whole before Y, and confirmUnchecked goes only with its own Y', async () => {
    const answers: Reply[] = [laneQuestion(UNCHECKED_Q, 'confirmUnchecked'), laneAccepted('op-7')];
    const f = copyRoutes().on('POST', TAKEOVER, () => answers.shift()!);
    const v = await toDb(f, { columns: 80, rows: 24 });
    await take(v, 'Take over');
    await v.until('Y Take over');
    await v.press(' ', 'y');
    await v.untilFn(() => calls(f, 'POST', TAKEOVER).length === 1);
    expect(calls(f, 'POST', TAKEOVER)[0].body).toEqual({ start: false });
    await v.until('Down More');
    // Y before the last line was on screen does nothing.
    await v.press('y', 'Y');
    await tick(100);
    expect(calls(f, 'POST', TAKEOVER)).toHaveLength(1);
    const seen = await readWhole(v, 'Y Confirm', 80);
    const want = wrap(UNCHECKED_Q, innerWidth(80));
    expect(want.length).toBeGreaterThan(24);
    for (const l of want) expect(seen).toContain(l);
    expect(calls(f, 'POST', TAKEOVER)).toHaveLength(1);
    await v.press('y', 'y');
    await v.until('Working on mybot');
    expect(calls(f, 'POST', TAKEOVER).map((c) => c.body)).toEqual([{ start: false }, { start: false, confirm: true, confirmUnchecked: true }]);
    f.emit('bot:switch', switchFrame('op-7', true, TAKEN_OVER));
    await v.until('This machine is the main now (generation 5, 2026-11-14 10:00 UTC).');
    expect(v.session.notice).toBe(`mybot: ${TAKEN_OVER}`);
  });

  it('another key on the question sends nothing more; a question without a flag sends confirm alone', async () => {
    const answers: Reply[] = [laneQuestion(UNCHECKED_Q, 'confirmUnchecked'), laneQuestion(UNPLANNED_Q), laneAccepted('op-2')];
    const f = copyRoutes().on('POST', TAKEOVER, () => answers.shift()!);
    const v = await toDb(f);
    await take(v, 'Take over');
    await v.until('Y Take over');
    await v.press('y');
    await readWhole(v, 'Y Confirm', 120);
    await v.press('n');
    await v.until('Cancelled: this copy was not made the main.');
    expect(calls(f, 'POST', TAKEOVER)).toHaveLength(1);
    await take(v, 'Take over');
    await v.until('Y Take over');
    await v.press('y');
    await v.until('Take over now?');
    await readWhole(v, 'Y Confirm', 120);
    await v.press('y');
    await v.until('Working on mybot');
    expect(calls(f, 'POST', TAKEOVER).map((c) => c.body)).toEqual([{ start: true }, { start: true }, { start: true, confirm: true }]);
  });

  it('the shard cap refusal comes in the frame; a refusal before admit; no answer', async () => {
    let next: Reply = laneAccepted('op-3');
    const f = copyRoutes().on('POST', TAKEOVER, () => next);
    const v = await toDb(f);
    await take(v, 'Take over');
    await v.until('Y Take over');
    await v.press('y');
    await v.until('Working on mybot');
    f.emit('bot:switch', switchFrame('op-3', false, SHARD_CAP));
    await v.until('row-level security is forced on smdb_data.guild_shards, so Take over fails the same way until it is lifted.');
    await v.until('Then press Take over again.');
    expect(v.session.notice).toBe(`mybot: ${SHARD_CAP}`);
    next = laneRefused(MAIN_UP);
    await take(v, 'Take over');
    await v.until('Y Take over');
    await v.press('y');
    await v.until(MAIN_UP);
    next = noAnswer();
    await take(v, 'Take over');
    await v.until('Y Take over');
    await v.press('y');
    await v.until('the take-over may still be running');
    expect(calls(f, 'POST', TAKEOVER)).toHaveLength(3);
  });

  it('a promoted copy whose switch read failed still offers Take over', async () => {
    const promoted = { present: true, record: { primaryHost: 'db.example.net', primaryPort: 15432 }, live: { running: true, inRecovery: false } };
    const f = copyRoutes({ replica: ok({ success: true, replica: promoted, copyBackup: null, join: null, rebuild: null }), switch: { status: 500, ok: false, body: { success: false, error: 'boom' } } })
      .on('POST', TAKEOVER, laneAccepted('op-4'));
    const v = await toDb(f);
    await v.until('Could not read the move state (boom); retrying.');
    await take(v, 'Take over');
    await v.until('Y Take over');
  });
});

describe('m5 Rejoin as a copy', () => {
  const REJOIN_TEXT = "Rebuild this machine's database as a copy of yundera? A dump of it is kept with the backups first; it holds every change this machine has that yundera lacks.";

  it('recorded: the dialog, Y once with {replaced: true}, the page\'s texts', async () => {
    let next: Reply = rejoinStarted();
    const f = mainRoutes({ bot: mainLaneBot({ replacedBy: { machine: 'yundera', generation: 5 } }) }).on('POST', RESEED_STALE, () => next);
    const v = await toDb(f);
    await take(v, 'Rejoin as a copy');
    await v.until(REJOIN_TEXT);
    await v.press('n');
    await v.until('Cancelled: nothing was started.');
    await take(v, 'Rejoin as a copy');
    await v.until('Y Rejoin');
    await v.press('y', 'y', 'y');
    await v.until('Rejoining as a copy; the Database screen shows its progress');
    expect(calls(f, 'POST', RESEED_STALE).map((c) => c.body)).toEqual([{ replaced: true }]);
    next = ok({ success: false, error: NO_MAIN_RECORDED });
    await take(v, 'Rejoin as a copy');
    await v.until('Y Rejoin');
    await v.press('y');
    await v.until(NO_MAIN_RECORDED);
    next = ok({ success: false, error: '' });
    await take(v, 'Rejoin as a copy');
    await v.until('Y Rejoin');
    await v.press('y');
    await v.until('The rejoin was refused');
  });

  it('recorded, no answer: the page\'s text, then the check refuses a second rejoin until it ends', async () => {
    const f = mainRoutes({ bot: mainLaneBot({ replacedBy: { machine: 'yundera', generation: 5 } }) }).on('POST', RESEED_STALE, () => noAnswer());
    const v = await toDb(f, { check: { reads: 20, everyMs: 300 } });
    await take(v, 'Rejoin as a copy');
    await v.until('Y Rejoin');
    await v.press('y');
    await v.until('No answer from the manager (connect ECONNREFUSED 127.0.0.1:8080); the rejoin may still be running.');
    await v.untilFn(() => v.session.lostChecks.has('b1'));
    await v.press(ESC);
    await v.until('Name mybot');
    await openDb(v);
    await take(v, 'Rejoin as a copy');
    await v.until(CHECKING_REFUSAL);
    expect(db(v).confirm).toBeNull();
    expect(calls(f, 'POST', RESEED_STALE)).toHaveLength(1);
    await v.untilFn(() => !v.session.lostChecks.has('b1'));
    await v.until(NO_SEED_TEXT);
  });

  it('with a pasted code: the prompt, Enter opens the dialog with no code in it, Y sends {joinCode}; a refusal keeps the code', async () => {
    let next: Reply = ok({ success: false, error: OWN_CODE });
    const f = mainRoutes({ bot: mainLaneBot({ mainConflict: { machine: 'yundera' } }) }).on('POST', RESEED_STALE, () => next);
    const v = await toDb(f);
    await take(v, 'Rejoin as a copy');
    await v.until("Paste yundera's join code to rebuild this machine's database as its copy.");
    expect(bars(v.frame())).toContain('Enter Rejoin  Esc Back');
    await v.press(ENTER);
    await v.until(NO_CODE_TEXT);
    await paste(v);
    await v.until("Rebuild this machine's database as a copy of yundera from the pasted join code?");
    expect(calls(f, 'POST', RESEED_STALE)).toEqual([]);
    await v.press('y');
    await v.until(OWN_CODE);
    expect(calls(f, 'POST', RESEED_STALE).map((c) => c.body)).toEqual([{ joinCode: JOIN_CODE }]);
    expect(db(v).joinForm?.code.text).toBe(JOIN_CODE);
    next = rejoinStarted();
    await v.press(ENTER);
    await v.until('Y Rejoin');
    await v.press('y');
    await v.until('Rejoining as a copy; the Database screen shows its progress');
    expect(db(v).joinForm).toBeNull();
    expect(v.session.codeFocus).toBeNull();
    expect(calls(f, 'POST', RESEED_STALE)).toHaveLength(2);
    noCodeAnywhere(v);
  });
});

describe('m5 the stale-primary rejoin', () => {
  it('while the bot runs: the page\'s lines and no form', async () => {
    const f = mainRoutes({ bot: mainLaneBot({}, { status: 'running' }) });
    const v = await toDb(f);
    await take(v, 'Rejoin as a copy (join code)');
    await v.until(STALE_RUNNING);
    expect(db(v).joinForm).toBeNull();
    expect(calls(f, 'POST', RESEED_STALE)).toEqual([]);
  });

  it('the form with the replication host and port, the whole dialog, and postProvision\'s rounds with the re-seed verb', async () => {
    const answers: Reply[] = [staleVolume(), staleSameHost(), rejoinStarted()];
    const f = mainRoutes().on('POST', RESEED_STALE, () => answers.shift()!);
    const v = await toDb(f);
    await take(v, 'Rejoin as a copy (join code)');
    await v.until(STALE_TIP.slice(0, 60));
    await v.until('[db.example.net');
    await v.until('[15432');
    expect(bars(v.frame())).toContain('Up/Down/Tab Field  Enter Rejoin  Esc Back');
    await v.press(ENTER);
    await v.until(NO_CODE_TEXT);
    await paste(v);
    for (const p of STALE_QUESTION) await v.until(p);
    expect(calls(f, 'POST', RESEED_STALE)).toEqual([]);
    await v.press('y');
    await v.until(`${VOLUME_QUESTION} Clear ${VOLUME} and re-seed?`);
    await v.until('Y Clear and re-seed');
    await v.press('y');
    await v.until(`${SAME_HOST} Re-seed it here anyway?`);
    await v.until('Y Re-seed');
    await v.press('y');
    await v.until('Rejoining as a copy started');
    const base = { joinCode: JOIN_CODE, publicHost: 'db.example.net', hostPort: 15432 };
    expect(calls(f, 'POST', RESEED_STALE).map((c) => c.body)).toEqual([base, { ...base, confirmVolume: VOLUME }, { ...base, confirmVolume: VOLUME, confirm: true }]);
    expect(db(v).joinForm).toBeNull();
    noCodeAnywhere(v);
  });

  it('a bad port before the code, a refusal keeping the form, another key on a round', async () => {
    let next: Reply = ok({ success: false, error: STOP_FIRST });
    const f = mainRoutes().on('POST', RESEED_STALE, () => next);
    const v = await toDb(f);
    await take(v, 'Rejoin as a copy (join code)');
    await v.until('[15432');
    await v.press('\t', '\t', 'x', ENTER);
    await v.until('Not a number: port. Fix it, then try again. Nothing was sent.');
    await v.press('\x7f', '\t');
    await paste(v);
    await v.until('Y Rejoin');
    await v.press('y');
    await v.until(STOP_FIRST);
    expect(db(v).joinForm?.code.text).toBe(JOIN_CODE);
    next = staleSameHost();
    await v.press(ENTER);
    await v.until('Y Rejoin');
    await v.press('y');
    await v.until('Y Re-seed');
    await v.press('n');
    await v.until('Cancelled: nothing was started.');
    expect(calls(f, 'POST', RESEED_STALE)).toHaveLength(2);
    expect(db(v).joinForm?.code.text).toBe(JOIN_CODE);
  });

  it('no answer starts the check: the form\'s Enter and a reopened screen refuse, then the end text', async () => {
    const f = mainRoutes().on('POST', RESEED_STALE, () => noAnswer());
    const v = await toDb(f, { check: { reads: 20, everyMs: 300 } });
    await take(v, 'Rejoin as a copy (join code)');
    await v.until('[15432');
    await paste(v);
    await v.until('Y Rejoin');
    await v.press('y');
    await v.until('the re-seed may still be running');
    await v.untilFn(() => v.session.lostChecks.has('b1'));
    await v.press(ENTER);
    await v.until(CHECKING_REFUSAL);
    await v.press(ESC, ESC);
    await v.until('Name mybot');
    await openDb(v);
    await take(v, 'Rejoin as a copy (join code)');
    await v.until(CHECKING_REFUSAL);
    expect(db(v).joinForm).toBeNull();
    expect(calls(f, 'POST', RESEED_STALE)).toHaveLength(1);
    await v.untilFn(() => !v.session.lostChecks.has('b1'));
    await v.until(NO_SEED_TEXT);
    expect(flat(v.frame())).not.toContain(PIECE);
  });

  it('a copy bot without fleetDb offers no rejoin row', async () => {
    const f = copyRoutes({ bot: copyBot() });
    const v = await toDb(f);
    await v.untilFn(() => db(v).actionRows().length > 0);
    expect(db(v).actionRows().map((r) => r.kind)).not.toContain('stale');
  });
});
