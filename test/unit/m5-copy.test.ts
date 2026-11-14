import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import * as ink from 'ink';
import { render } from 'ink-testing-library';
import { createApp } from '../../src/cli/tui/app';
import { actionRows, CHECKING_REFUSAL, CHECKING_TEXT, NO_SEED_TEXT, RESEED_QUESTION } from '../../src/cli/tui/actions';
import type { Bot } from '../../src/cli/tui/api';
import { LOST_CHECK, Session } from '../../src/cli/tui/session';
import { botList, fake, Fake, noAnswer, ok, Reply } from './m2-fake';
import { backupsBody, copyBot, entry, failed500, memoryBody, migrateBody, orphansBody, replicaBody, stateInfo, switchBody, T0 } from './m4-fake';
import {
  copyNoRecord, copyRecorded, copyRefused, JOIN_CODE, JOINED, joinedBody, NOT_A_CODE, NOT_JOINED, NOTHING_TO_RETIRE, PINS_LEFT, PINS_WARNING, PROMOTED,
  promotedQuestion, PROVISION_RUNNING, provisionStarted, REMOVED_WARNING, removedBody, RESEED_RUNNING, reseedStarted, retiredBody, SAME_HOST,
  sameHostQuestion, SEED_NOTE, SEED_RUNNING_REMOVE, seedCancelled, seedDismissed, seedParked, seedRunning, TIMELINE, timelineQuestion, UNREACHABLE, VOLUME,
  VOLUME_QUESTION, volumeQuestion,
} from './m5-fake';

const App = createApp(ink);
vi.setConfig({ testTimeout: 40_000 });
const ESC = '\u001B';
const ENTER = '\r';
const TAB = '\t';
const DOWN = '\u001B[B';
const START = '\x1b[200~';
const END = '\x1b[201~';

const WAIT_MS = 10_000;
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const flat = (frame: string) => frame.split('\n').map((l) => l.replace(/^\| /, '').replace(/\s*\|$/, '').trim()).join(' ').replace(/\s+/g, ' ');
const bars = (frame: string) => frame.split('\n').slice(-5, -1).join(' ');
const held = () => {
  let release: (r: Reply | Error) => void = () => undefined;
  const answer = () => new Promise<Reply | Error>((r) => {
    release = r;
  });
  return { answer: answer as () => Promise<Reply>, release: (r: Reply | Error) => release(r) };
};

const B = '/api/bots/b1';
const REPLICA = `${B}/fleet-replica`;
const JOIN = `${B}/fleet-join`;
const RESEED = `${B}/fleet-replica/reseed`;
const RETIRE = `${B}/fleet-replica/finish-retire`;
const SEED = `${B}/fleet-replica/seed`;
const SLOT = 'smdb_copy_b1';
const recordedBot = () => copyBot({ fleetDbReplica: { containerName: 'smdb-replica-b1', slot: SLOT } });
const bareBot = () => copyBot({ fleetDbReplica: null });
// No piece of the code is ever on screen: the field shows asterisks.
const PIECE = JOIN_CODE.slice(10, 30);

function withWs(f: Fake): Fake {
  (f.client as unknown as { openWs: unknown }).openWs = (_m: unknown, onOpen?: () => void) => {
    setTimeout(() => onOpen?.(), 1);
    return { close: () => undefined };
  };
  return f;
}

function routes(over: { replica?: Reply | (() => Reply); bot?: Record<string, unknown> } = {}): Fake {
  return withWs(fake())
    .on('GET', '/api/bots', botList([over.bot ?? bareBot()]))
    .on('GET', '/api/bots/fleet/orphan-backups', orphansBody())
    .on('GET', `${B}/maintenance`, stateInfo())
    .on('GET', `${B}/memory`, memoryBody())
    .on('GET', REPLICA, over.replica ?? replicaBody(copyNoRecord()))
    .on('GET', `${B}/fleet-backups`, backupsBody([entry('copy-hourly-2026-11-14T09-00-00-000Z.dump', { family: 'copy' })]))
    .on('GET', `${B}/fleet-switch`, switchBody())
    .on('GET', `${B}/migrate`, migrateBody());
}

const opened: Array<{ unmount: () => void; session: Session }> = [];
afterEach(() => {
  for (const o of opened.splice(0)) {
    o.unmount();
    o.session.stop();
  }
});

async function start(f: Fake, check = { reads: 4, everyMs: 30 }) {
  const session = new Session(f.client, () => T0);
  session.lostCheck = check;
  await session.refresh();
  const modes: string[] = [];
  const view = render(createElement(App, {
    machine: 'box1', session, onHandOff: vi.fn(), now: () => T0, writeMode: (m: string) => void modes.push(m),
    databaseOptions: { everyMs: 60_000, limitMs: 2000, env: { HOST_DATA_DIR: '/srv/smdb/data' }, timeZone: 'UTC' },
    stateOptions: { limitMs: 2000, waitMs: 1000 },
  }));
  (view.stdout as unknown as { rows: number }).rows = 50;
  Object.defineProperty(view.stdout, 'columns', { value: 120, configurable: true });
  view.stdout.emit('resize');
  opened.push({ unmount: () => view.unmount(), session });
  await tick();
  const frames: string[] = [];
  const frame = () => {
    const now = view.lastFrame() ?? '';
    frames.push(now);
    return now;
  };
  const press = async (...keys: string[]) => {
    for (const k of keys) {
      view.stdin.write(k);
      await tick();
    }
  };
  const until = async (text: string) => {
    for (const end = Date.now() + WAIT_MS; Date.now() < end && !flat(frame()).includes(text);) await tick(20);
    expect(flat(frame())).toContain(text);
  };
  const untilFn = async (test: () => boolean) => {
    for (const end = Date.now() + WAIT_MS; Date.now() < end && !test();) await tick(20);
    expect(test()).toBe(true);
  };
  return { ...view, session, frame, frames, press, until, untilFn, modes };
}

type V = Awaited<ReturnType<typeof start>>;

async function toDb(f: Fake, check?: { reads: number; everyMs: number }) {
  const v = await start(f, check);
  await v.press(ENTER);
  await v.until('Name mybot');
  await openDb(v);
  return v;
}

async function openDb(v: V) {
  for (const end = Date.now() + WAIT_MS; Date.now() < end && !flat(v.frame()).includes('Database: mybot');) {
    await v.press('d');
    await tick(50);
  }
  await v.until('Database: mybot');
}

async function take(v: V, label: string) {
  await v.untilFn(() => bars(v.frame()).includes('A Actions'));
  await v.press('a');
  await v.until('Actions: mybot');
  await v.until(label);
  for (let i = 0; i < 10 && !(v.frame().split('\n').find((l) => l.includes(`> ${label}`))); i++) await v.press(DOWN);
  expect(v.frame()).toContain(`> ${label}`);
  await v.press(ENTER);
}

// Pastes the code as a terminal with bracketed paste sends it: markers, a line break inside, then the trailing one.
async function paste(v: V) {
  v.stdin.write(`${START}${JOIN_CODE.slice(0, 64)}\r${JOIN_CODE.slice(64)}${END}`);
  await tick(50);
  v.stdin.write('\r');
  await tick(50);
}

const calls = (f: Fake, method: string, path: string) => f.calls.filter((c) => c.method === method && c.path === path);
const db = (v: V) => v.session.held.database!;
const noCodeAnywhere = (v: V) => {
  for (const fr of v.frames) expect(fr).not.toContain(PIECE);
  expect(JSON.stringify(v.session.notice ?? '')).not.toContain(PIECE);
};

describe('m5 the copy layout rows', () => {
  const ok3 = (r: Record<string, unknown> | null) => ({ ok: true as const, value: { replica: r } });
  const labels = (r: Record<string, unknown> | null, bot?: Record<string, unknown>) => actionRows('copy', { replica: ok3(r) }, bot as Bot | undefined).map((x) => x.label);

  it('no record offers Join and Add; a record offers Remove, Re-seed while it is a copy, and Join', () => {
    expect(labels(copyNoRecord())).toEqual(['Join the main with a join code', 'Add a live copy']);
    expect(labels(null)).toEqual(['Join the main with a join code', 'Add a live copy']);
    expect(labels(copyRecorded())).toEqual(['Remove replica', 'Re-seed now', 'Join the main with a join code']);
    expect(labels(copyRecorded({ running: false, inRecovery: null, receiverStatus: null, caughtUp: null, replayLagSeconds: null }))).toEqual(['Remove replica', 'Re-seed now', 'Join the main with a join code']);
    // Promoted (:3207 and :3229): no Re-seed, and part 4's Take over; a record that could not be read: no Re-seed.
    expect(labels(copyRecorded({ running: true, inRecovery: false, receiverStatus: null, caughtUp: null, replayLagSeconds: null }))).toEqual(['Remove replica', 'Join the main with a join code', 'Take over']);
    expect(labels(copyRecorded(null))).toEqual(['Remove replica', 'Join the main with a join code']);
    const row = actionRows('copy', { replica: ok3(copyRecorded()) }, recordedBot() as Bot)[0];
    expect(row).toEqual({ kind: 'remove', label: 'Remove replica', slot: SLOT });
  });

  it('a seed in flight offers only its Cancel; a stopped one Finish retire and Dismiss; a seed note its Dismiss', () => {
    expect(labels(seedRunning())).toEqual(['Cancel the seed']);
    expect(labels(seedRunning({ cancelRequested: true }))).toEqual([]);
    expect(labels(seedRunning({ cancelable: false }))).toEqual([]);
    expect(labels({ ...copyRecorded(), ...seedRunning() })).toEqual(['Cancel the seed']);
    expect(labels(seedParked())).toEqual(['Dismiss the stopped seed', 'Join the main with a join code', 'Add a live copy']);
    expect(labels(seedParked({ pinsUnretired: ['DATABASE_URL'] }))).toEqual(['Finish retire (remove the env pins)', 'Dismiss the stopped seed', 'Join the main with a join code', 'Add a live copy']);
    expect(labels(seedParked({ pinsUnretired: [] }))).toEqual(['Dismiss the stopped seed', 'Join the main with a join code', 'Add a live copy']);
    expect(labels({ ...seedParked(), ...seedRunning() })).toEqual(['Dismiss the stopped seed', 'Cancel the seed']);
    expect(labels(copyRecorded(undefined, { seedNote: SEED_NOTE, seedNoteStartedAt: 7 }))).toEqual(['Dismiss the seed note', 'Remove replica', 'Re-seed now', 'Join the main with a join code']);
    expect(actionRows('copy', { replica: ok3(copyNoRecord({ seedNote: SEED_NOTE, seedNoteStartedAt: 7 })) })[0]).toEqual({ kind: 'seed', label: 'Dismiss the seed note', startedAt: 7, parked: true });
  });

  it('a failed, unanswered or missing replica read offers nothing', () => {
    expect(actionRows('copy', { replica: { ok: false, text: 'Bot not found' } })).toEqual([]);
    expect(actionRows('copy', { replica: { ok: null, text: 'the manager did not answer within 15 s' } })).toEqual([]);
    expect(actionRows('copy', {})).toEqual([]);
  });

  it('the lost-answer check reads 20 times, 3 s apart, as the page does', () => {
    expect(LOST_CHECK).toEqual({ reads: 20, everyMs: 3000 });
  });
});

describe('m5 Join with a join code', () => {
  it('a pasted code with a line break inside and a trailing one: Enter opens the dialog, sends nothing; Y sends once; success drops the code', async () => {
    const j = held();
    const f = routes().on('POST', JOIN, j.answer);
    const v = await toDb(f);
    await take(v, 'Join the main with a join code');
    await v.until('Join code');
    expect(bars(v.frame())).toContain('Enter Join  Esc Back');
    await v.untilFn(() => v.session.codeFocus === db(v).joinForm?.code && v.modes.includes('\x1b[?2004h'));
    v.stdin.write(`${START}${JOIN_CODE.slice(0, 64)}\r${JOIN_CODE.slice(64)}${END}`);
    await v.until(`${JOIN_CODE.length} characters, starts with smdbjoin1.`);
    expect(db(v).joinForm?.code.text).toBe(JOIN_CODE);
    v.stdin.write('\r');
    await v.until('Join mybot to the main in the pasted join code?');
    await v.until('Y Join');
    expect(calls(f, 'POST', JOIN)).toEqual([]);
    expect(v.session.codeFocus).toBeNull();
    await v.press('y', 'y', 'Y');
    await v.until(CHECKING_TEXT);
    expect(flat(v.frame())).not.toContain('Joined the main');
    expect(calls(f, 'POST', JOIN).map((c) => c.body)).toEqual([{ joinCode: JOIN_CODE }]);
    j.release(joinedBody());
    await v.until(JOINED);
    await v.untilFn(() => db(v).joinForm === null && v.session.codeFocus === null);
    expect(v.modes[v.modes.length - 1]).toBe('\x1b[?2004l');
    noCodeAnywhere(v);
    expect(calls(f, 'POST', JOIN)).toHaveLength(1);
  });

  it('Enter with an empty field refuses and opens no dialog; a refusal keeps the code; another key cancels; no answer starts no check', async () => {
    let next: Reply | Error = copyRefused(NOT_A_CODE);
    const f = routes().on('POST', JOIN, () => next);
    const v = await toDb(f);
    await take(v, 'Join the main with a join code');
    await v.until('Join code');
    await v.press(ENTER);
    await v.until("Paste the join code from the main's manager first");
    expect(flat(v.frame())).not.toContain('Y Join');
    await paste(v);
    await v.until('Y Join');
    await v.press('n');
    await v.until('Cancelled: nothing was sent.');
    await v.until(`${JOIN_CODE.length} characters, starts with smdbjoin1.`);
    await v.untilFn(() => v.session.codeFocus === db(v).joinForm?.code);
    const send = async (text: string) => {
      await v.press(ENTER);
      await v.until('Y Join');
      await v.press('y');
      await v.until(text);
      await v.until(`${JOIN_CODE.length} characters, starts with smdbjoin1.`);
      await v.untilFn(() => v.session.codeFocus === db(v).joinForm?.code);
    };
    await send(NOT_A_CODE);
    next = copyRefused(UNREACHABLE);
    await send(UNREACHABLE);
    next = ok({ success: false });
    await send('The join code was not used');
    next = noAnswer();
    await send('No answer from the manager (connect ECONNREFUSED 127.0.0.1:8080); the join may still be running. Check its state before trying again.');
    expect(v.session.lostChecks.size).toBe(0);
    expect(calls(f, 'POST', JOIN).map((c) => c.body)).toEqual(Array(4).fill({ joinCode: JOIN_CODE }));
    expect(db(v).joinForm?.code.text).toBe(JOIN_CODE);
    noCodeAnywhere(v);
    await v.press(ESC);
    await v.untilFn(() => db(v).joinForm === null && v.session.codeFocus === null);
    await v.until('Database: mybot');
  });

  it('Esc while the join runs leaves the screen; the outcome lands on the bot screen and the code is gone', async () => {
    const j = held();
    const f = routes().on('POST', JOIN, j.answer);
    const v = await toDb(f);
    await take(v, 'Join the main with a join code');
    await v.until('Join code');
    await paste(v);
    await v.until('Y Join');
    await v.press('y');
    await v.until(CHECKING_TEXT);
    await v.press(ESC);
    await v.until('Name mybot');
    expect(v.session.held.database).toBeUndefined();
    await openDb(v);
    await v.until('Waiting for the manager');
    await v.press('a', 'y', ENTER);
    expect(calls(f, 'POST', JOIN)).toHaveLength(1);
    await v.press(ESC);
    await v.until('Name mybot');
    const lists = calls(f, 'GET', '/api/bots').length;
    j.release(joinedBody());
    await v.until(`mybot: ${JOINED}`);
    await v.untilFn(() => calls(f, 'GET', '/api/bots').length > lists);
    expect(v.session.codeFocus).toBeNull();
    noCodeAnywhere(v);
  });
});

describe('m5 Add a live copy', () => {
  it('host and port go with the code; each question is a Y round with its flag kept; after three the answer shows', async () => {
    const answers = [volumeQuestion, sameHostQuestion, sameHostQuestion, sameHostQuestion];
    const f = routes().on('POST', REPLICA, (body) => answers.shift()?.(body) ?? provisionStarted());
    const v = await toDb(f);
    await take(v, 'Add a live copy');
    await v.until('Join code');
    expect(bars(v.frame())).toContain('Up/Down/Tab Field  Enter Add  Esc Back');
    v.stdin.write(`${START}${JOIN_CODE}${END}`);
    await tick(50);
    await v.press(TAB, 'copy.example.net', TAB, '1543x', ENTER);
    await v.until('Not a number: port. Fix it, then try again. Nothing was sent.');
    await v.press('\x7f', '3', ENTER);
    await v.until('Add a live copy of the main\'s database for mybot?');
    await v.until('The manager joins the main in the pasted join code first.');
    await v.press('y');
    await v.until(`${VOLUME_QUESTION} Clear ${VOLUME} and provision?`);
    await v.until('Y Clear and provision');
    await v.press('y');
    await v.until(`${SAME_HOST} Provision it here anyway?`);
    await v.untilFn(() => calls(f, 'POST', REPLICA).length === 2 && bars(v.frame()).includes('Y Provision'));
    await v.press('y');
    await v.untilFn(() => calls(f, 'POST', REPLICA).length === 3 && bars(v.frame()).includes('Y Provision'));
    await v.press('y');
    await v.untilFn(() => calls(f, 'POST', REPLICA).length === 4 && !bars(v.frame()).includes('Y Provision') && !db(v).busy);
    await v.until(SAME_HOST);
    await tick(100);
    expect(bars(v.frame())).not.toContain('Y Provision');
    expect(calls(f, 'POST', REPLICA)).toHaveLength(4);
    const base = { joinCode: JOIN_CODE, publicHost: 'copy.example.net', hostPort: 15433 };
    expect(calls(f, 'POST', REPLICA).map((c) => c.body)).toEqual([
      base,
      { ...base, confirmVolume: VOLUME },
      { ...base, confirmVolume: VOLUME, confirm: true },
      { ...base, confirmVolume: VOLUME, confirm: true },
    ]);
    expect(db(v).joinForm?.code.text).toBe(JOIN_CODE);
    noCodeAnywhere(v);
  });

  it('success with the join message drops the code; no code sends the stored join; another key in a round sends nothing more', async () => {
    let next: Reply[] = [provisionStarted(JOINED)];
    const f = routes().on('POST', REPLICA, () => next.shift() ?? provisionStarted());
    const v = await toDb(f);
    await take(v, 'Add a live copy');
    await v.until('Join code');
    await paste(v);
    await v.until('Y Add the copy');
    await v.press('y');
    await v.until(`Provisioning started. ${JOINED}`);
    await v.untilFn(() => db(v).joinForm === null && v.session.codeFocus === null);
    next = [volumeQuestion()];
    await take(v, 'Add a live copy');
    await v.until('leave it empty to use the code this bot joined with');
    await v.press(TAB, TAB, '15433', ENTER);
    await v.until('Add a live copy of the main\'s database for mybot?');
    expect(flat(v.frame())).not.toContain('joins the main in the pasted join code');
    await v.press('y');
    await v.until('Y Clear and provision');
    await v.press('n');
    await v.until('Cancelled: nothing was started.');
    expect(calls(f, 'POST', REPLICA).map((c) => c.body)).toEqual([{ joinCode: JOIN_CODE }, {}]);
    expect(db(v).joinForm?.kind).toBe('add');
  });

  it('refusals keep the fields; no answer says so and checks the copy until a seed shows', async () => {
    let next: Reply | Error = copyRefused(NOT_JOINED);
    let replica: Reply = replicaBody(copyNoRecord());
    const f = routes({ replica: () => replica }).on('POST', REPLICA, () => next);
    const v = await toDb(f, { reads: 100, everyMs: 50 });
    await take(v, 'Add a live copy');
    await v.until('Join code');
    await v.press(TAB, 'copy.example.net');
    const send = async (text: string) => {
      await v.press(ENTER);
      await v.until('Y Add the copy');
      await v.press('y');
      await v.until(text);
    };
    await send(NOT_JOINED);
    next = copyRefused(PROVISION_RUNNING);
    await send(PROVISION_RUNNING);
    next = ok({ success: false });
    await send('Failed to start provisioning');
    expect(db(v).joinForm?.host.text).toBe('copy.example.net');
    next = noAnswer();
    await send('the provisioning may still be running');
    await v.untilFn(() => v.session.lostChecks.has('b1'));
    replica = replicaBody(seedRunning());
    await v.untilFn(() => !v.session.lostChecks.has('b1'));
    await tick(200);
    expect(flat(v.frame())).not.toContain(NO_SEED_TEXT);
    expect(calls(f, 'POST', REPLICA).map((c) => c.body)).toEqual(Array(4).fill({ publicHost: 'copy.example.net' }));
  });
});

describe('m5 the lost-answer check held by the Session', () => {
  it('after a lost provision Join and Add refuse on a reopened screen and send nothing; none after the reads gives the page text', async () => {
    const f = routes().on('POST', REPLICA, () => noAnswer()).on('POST', JOIN, joinedBody());
    const v = await toDb(f, { reads: 20, everyMs: 300 });
    await take(v, 'Add a live copy');
    await v.until('Join code');
    await paste(v);
    await v.until('Y Add the copy');
    // Y: the form is still open on a reopened screen, so its Enter refuses too.
    await v.press('y');
    await v.until('the provisioning may still be running');
    await v.untilFn(() => v.session.lostChecks.has('b1'));
    await v.press(ENTER);
    await v.until(CHECKING_REFUSAL);
    expect(flat(v.frame())).not.toContain('Y Add the copy');
    await v.press(ESC);
    await v.press(ESC);
    await v.until('Name mybot');
    await openDb(v);
    await take(v, 'Join the main with a join code');
    await v.until(CHECKING_REFUSAL);
    expect(db(v).joinForm).toBeNull();
    await take(v, 'Add a live copy');
    await v.until(CHECKING_REFUSAL);
    expect(db(v).joinForm).toBeNull();
    expect(calls(f, 'POST', JOIN)).toEqual([]);
    expect(calls(f, 'POST', REPLICA)).toHaveLength(1);
    await v.untilFn(() => !v.session.lostChecks.has('b1'));
    await v.until(NO_SEED_TEXT);
    expect(v.session.notice).toBe(`mybot: ${NO_SEED_TEXT}`);
    const reads = calls(f, 'GET', REPLICA).length;
    expect(reads).toBeGreaterThanOrEqual(20);
    await take(v, 'Join the main with a join code');
    await v.until('Join code');
    expect(db(v).joinForm).not.toBeNull();
  });

  it('a parked seed ends the check; a Y given before the check started is refused at the send', async () => {
    let replica: Reply = replicaBody(copyNoRecord());
    const f = routes({ replica: () => replica }).on('POST', REPLICA, () => noAnswer());
    const v = await toDb(f, { reads: 50, everyMs: 50 });
    await take(v, 'Add a live copy');
    await v.until('Join code');
    await paste(v);
    await v.until('Y Add the copy');
    // A check started from another screen of this bot: the Session holds it, so this dialog's Y sends nothing.
    void v.session.followLost('b1', 2000, () => undefined);
    await v.untilFn(() => v.session.lostChecks.has('b1'));
    await v.press('y');
    await v.until(CHECKING_REFUSAL);
    expect(calls(f, 'POST', REPLICA)).toEqual([]);
    replica = replicaBody(seedParked());
    await v.untilFn(() => !v.session.lostChecks.has('b1'));
    expect(flat(v.frame())).not.toContain(NO_SEED_TEXT);
  });

  it('after a lost re-seed, Re-seed and Join refuse on a reopened screen until the check ends', async () => {
    const f = routes({ bot: recordedBot(), replica: replicaBody(copyRecorded()) }).on('POST', RESEED, () => noAnswer()).on('POST', JOIN, joinedBody());
    const v = await toDb(f, { reads: 20, everyMs: 300 });
    await take(v, 'Re-seed now');
    await v.until('Y Re-seed');
    await v.press('y');
    await v.until('No answer from the manager (connect ECONNREFUSED 127.0.0.1:8080); the re-seed may still be running.');
    await v.untilFn(() => v.session.lostChecks.has('b1'));
    await v.press(ESC);
    await v.until('Name mybot');
    await openDb(v);
    await take(v, 'Re-seed now');
    await v.until(CHECKING_REFUSAL);
    expect(flat(v.frame())).not.toContain('Y Re-seed');
    await take(v, 'Join the main with a join code');
    await v.until(CHECKING_REFUSAL);
    expect(calls(f, 'POST', RESEED)).toHaveLength(1);
    expect(calls(f, 'POST', JOIN)).toEqual([]);
    await v.until(NO_SEED_TEXT);
    await take(v, 'Re-seed now');
    await v.until('Y Re-seed');
  });
});

describe('m5 Remove replica', () => {
  it('the dialog names the slot of the row; a promoted copy asks once more and sends confirmPromoted; Y Y Y sends one', async () => {
    const answers: Array<() => Promise<Reply>> = [];
    const f = routes({ bot: recordedBot(), replica: replicaBody(copyRecorded()) }).on('DELETE', REPLICA, () => answers.shift()!());
    const first = held();
    const second = held();
    answers.push(first.answer, second.answer);
    const v = await toDb(f);
    await take(v, 'Remove replica');
    await v.until(`Remove this copy? The data volume is kept, but the MAIN keeps this copy's replication slot (${SLOT}), which retains WAL`);
    await v.until('Y Remove');
    await v.press('y', 'y', 'Y');
    await v.until('Removing the copy.');
    expect(calls(f, 'DELETE', REPLICA).map((c) => c.body)).toEqual([undefined]);
    first.release(promotedQuestion());
    await v.until(`${PROMOTED} Remove it anyway?`);
    await v.until('Y Remove');
    await v.press('y', 'y');
    await v.until('Removing the copy.');
    second.release(removedBody());
    await v.until(REMOVED_WARNING);
    expect(calls(f, 'DELETE', REPLICA).map((c) => c.body)).toEqual([undefined, { confirmPromoted: true }]);
  });

  it('another key on either question, a refusal, the fallback and no answer', async () => {
    let next: Reply | Error = promotedQuestion();
    const f = routes({ bot: recordedBot(), replica: replicaBody(copyRecorded()) }).on('DELETE', REPLICA, () => next);
    const v = await toDb(f);
    await take(v, 'Remove replica');
    await v.until('Y Remove');
    await v.press('n');
    await v.until('Cancelled: the copy was not removed.');
    expect(calls(f, 'DELETE', REPLICA)).toEqual([]);
    await take(v, 'Remove replica');
    await v.until('Y Remove');
    await v.press('y');
    await v.until('Remove it anyway?');
    await v.press('n');
    await v.until('Cancelled: the copy was not removed.');
    expect(calls(f, 'DELETE', REPLICA)).toHaveLength(1);
    const remove = async (text: string) => {
      await take(v, 'Remove replica');
      await v.until('Y Remove');
      await v.press('y');
      await v.until(text);
    };
    next = copyRefused(SEED_RUNNING_REMOVE);
    await remove(SEED_RUNNING_REMOVE);
    next = ok({ success: false });
    await remove('Failed to remove the copy');
    next = noAnswer();
    await remove('the copy removal may still be running');
    expect(calls(f, 'DELETE', REPLICA)).toHaveLength(4);
    expect(v.session.lostChecks.size).toBe(0);
  });

  it('Esc while the removal runs: the outcome reaches the bot screen; a question landing after Esc is not asked', async () => {
    const j = held();
    const f = routes({ bot: recordedBot(), replica: replicaBody(copyRecorded()) }).on('DELETE', REPLICA, j.answer);
    const v = await toDb(f);
    await take(v, 'Remove replica');
    await v.until('Y Remove');
    await v.press('y');
    await v.until('Removing the copy.');
    await v.press(ESC);
    await v.until('Name mybot');
    j.release(promotedQuestion());
    await v.until(`mybot: The copy was not removed: the manager asked to confirm after the Database screen was closed (${PROMOTED}).`);
    expect(calls(f, 'DELETE', REPLICA)).toHaveLength(1);
  });
});

describe('m5 Re-seed now', () => {
  it('the dialog, the route question sent with confirm, the started text; another key; refusals', async () => {
    let next: Reply | Error = timelineQuestion();
    const f = routes({ bot: recordedBot(), replica: replicaBody(copyRecorded()) }).on('POST', RESEED, (body: unknown) => ((body as { confirm?: boolean }).confirm ? reseedStarted() : next));
    const v = await toDb(f);
    await take(v, 'Re-seed now');
    await v.until(`${RESEED_QUESTION[0]} ${RESEED_QUESTION[1]}`);
    await v.press('y');
    await v.until(TIMELINE);
    await v.until('Y Re-seed');
    await v.press('y');
    await v.until('Re-seed started');
    expect(calls(f, 'POST', RESEED).map((c) => c.body)).toEqual([{}, { confirm: true }]);
    await take(v, 'Re-seed now');
    await v.until('Y Re-seed');
    await v.press('y');
    await v.until(TIMELINE);
    await v.press('n');
    await v.until('Cancelled: the re-seed was not started.');
    const reseed = async (text: string) => {
      await take(v, 'Re-seed now');
      await v.until('Y Re-seed');
      await v.press('y');
      await v.until(text);
    };
    next = copyRefused(RESEED_RUNNING);
    await reseed(RESEED_RUNNING);
    next = ok({ success: false });
    await reseed('Failed to start the re-seed');
    expect(calls(f, 'POST', RESEED).map((c) => c.body)).toEqual([{}, { confirm: true }, {}, {}, {}]);
  });
});

describe('m5 Finish retire and the seed rows on the copy layout', () => {
  it('Finish retire: removed, a warning, the refusals and no answer', async () => {
    let next: Reply | Error = retiredBody();
    const f = routes({ replica: replicaBody(seedParked({ pinsUnretired: ['DATABASE_URL'] })) }).on('POST', RETIRE, () => next);
    const v = await toDb(f);
    const retire = async (text: string) => {
      await take(v, 'Finish retire (remove the env pins)');
      await v.until(text);
    };
    await retire('The env pins are removed');
    next = ok({ success: true, warning: PINS_WARNING });
    await retire(PINS_WARNING);
    next = copyRefused(PINS_LEFT);
    await retire(PINS_LEFT);
    next = copyRefused(NOTHING_TO_RETIRE);
    await retire(NOTHING_TO_RETIRE);
    next = ok({ success: false });
    await retire('Failed to remove the env pins');
    next = noAnswer();
    await retire('the pins retire may still be running');
    expect(calls(f, 'POST', RETIRE)).toHaveLength(6);
  });

  it('Cancel and Dismiss send the run of the read their row was built from', async () => {
    let replica: Reply = replicaBody({ ...copyRecorded(), ...seedRunning() });
    const f = routes({ bot: recordedBot(), replica: () => replica }).on('DELETE', SEED, (body: unknown) => {
      if ((body as { parked: boolean }).parked) return seedDismissed();
      // The answer's re-read finds the seed done, with its note.
      replica = replicaBody(copyRecorded(undefined, { seedNote: SEED_NOTE, seedNoteStartedAt: 1_700_000_200_000 }));
      return seedCancelled();
    });
    const v = await toDb(f);
    await take(v, 'Cancel the seed');
    await v.until('Cancel requested');
    await v.untilFn(() => db(v).actionRows().some((r) => r.label === 'Dismiss the seed note'));
    await take(v, 'Dismiss the seed note');
    await v.until('Dismissed');
    expect(calls(f, 'DELETE', SEED).map((c) => c.body)).toEqual([
      { startedAt: 1_700_000_000_000, parked: false },
      { startedAt: 1_700_000_200_000, parked: true },
    ]);
  });
});

describe('m5 the copy layout refused read', () => {
  it('a refused replica read offers no A', async () => {
    // With the switch read refused too: part 4's Take over comes from that read (:3596).
    const f = routes({ replica: failed500('the copy could not be read') }).on('GET', `${B}/fleet-switch`, failed500('the switch view could not be read'));
    const v = await toDb(f);
    await v.until("Failed to load the copy's status");
    await v.until('Could not read the move state');
    await tick(100);
    expect(bars(v.frame())).not.toContain('A Actions');
    await v.press('a');
    await tick(100);
    expect(flat(v.frame())).not.toContain('Actions: mybot');
  });
});
