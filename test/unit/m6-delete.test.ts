import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import * as ink from 'ink';
import { render } from 'ink-testing-library';
import { createApp } from '../../src/cli/tui/app';
import { DELETE_NO_ANSWER, deleteDoneText, deleteLines } from '../../src/cli/tui/botdelete';
import { Session } from '../../src/cli/tui/session';
import { fake, Fake, noAnswer, ok, refused, Reply } from './m2-fake';
import { botRow } from './m3-fake';

const App = createApp(ink);
vi.setConfig({ testTimeout: 30_000 });
const ESC = '\u001B';
const ENTER = '\r';
const DOWN = '\u001B[B';
const TAB = '\t';
const SPACE = ' ';
const WAIT_MS = 10_000;

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const flat = (frame: string) => frame.split('\n').map((l) => l.replace(/^\| /, '').replace(/\s*\|$/, '').trim()).join(' ').replace(/\s+/g, ' ');
const keyBar = (frame: string) => frame.split('\n').slice(-3, -1).map((l) => l.replace(/^\| /, '').replace(/\s*\|$/, '').trim()).join('  ');

const DEL = (keepData = true, keepEnv = true, flags = '') => `/api/bots/b1?keepData=${keepData}&keepEnv=${keepEnv}${flags}`;

// GET /api/bots (bots.ts:242): the mode is left out when getDeploymentMode threw (bots.ts:163).
const listOf = (bots: unknown[], mode?: string) => ok({ success: true, bots, ...(mode ? { deploymentMode: mode } : {}), portBind: { bind: '127.0.0.1', loopback: true } });
// DELETE success (bots.ts:516 to :521): vaulted and envDeleted always; keptDataDir only with keepData in docker mode
// (:420, hostBotDirFor containerManager.ts:118); dbDumpsKept only with dumps (:519).
const removed = (over: Record<string, unknown> = {}) => ok({ success: true, vaulted: false, envDeleted: false, ...over });
// hostBotDirFor (containerManager.ts:118 to :121) with the data root /srv/dbm.
const KEPT = '/srv/dbm/bots/b1';
// A docker-mode success with keepData true always names the kept folder (bots.ts:420, :517).
const kept = (over: Record<string, unknown> = {}) => removed({ keptDataDir: KEPT, ...over });
// The two questions of instanceRemovalRefusal (fleetReplica.ts:1291, :1316), sent as 409 by bots.ts:409.
const PROMOTED = "This instance's database copy no longer follows a primary: it was promoted, so the fleet may be serving from it now, and it may hold writes no other database has. Removing the instance takes that copy's container down at once";
const FLEET_DATA = "This instance runs an app that can be a fleet node, and its data folder /DATA/AppData/mybot holds 3 entries. On a fleet node they can include guilds no other node holds, the fleet's control records, or the backup copy of a master's data, and deleting them cannot be undone";
const askPromoted = () => refused(409, { success: false, needsConfirm: true, confirmFlag: 'confirmPromoted', error: PROMOTED });
const askFleetData = () => refused(409, { success: false, needsConfirm: true, confirmFlag: 'confirmFleetData', error: FLEET_DATA });
// The op lock (bots.ts:405).
const busy = () => refused(409, { success: false, error: "Operation 'build' already in progress" });
// A throw after the removal began (bots.ts:523): String(error).
const partial = () => refused(500, { success: false, error: 'Error: Failed to remove container mybot-bot-1: device or resource busy' });

function later() {
  let answer: (r: Reply) => void = () => {};
  const p = new Promise<Reply>((resolve) => {
    answer = resolve;
  });
  return { reply: () => p, answer: (r: Reply) => answer(r) };
}

/** A manager with one stopped bot; `gone` makes the list reads after the first DELETE answer leave it out. */
function manager(over: { bot?: Record<string, unknown>; mode?: string | null; others?: unknown[] } = {}) {
  const state = { deleted: false, bots: [botRow({ status: 'stopped', hasBeenStarted: true, ...over.bot }), ...(over.others ?? [])] };
  const mode = over.mode === null ? undefined : (over.mode ?? 'docker');
  const f = fake().on('GET', '/api/bots', () => listOf(state.deleted ? state.bots.filter((b) => (b as { id: string }).id !== 'b1') : state.bots, mode));
  return { f, state };
}

async function start(f: Fake, opts: { columns?: number; rows?: number } = {}) {
  const session = new Session(f.client, () => 0);
  await session.refresh();
  const view = render(createElement(App, { machine: 'box1', session, onHandOff: vi.fn(), now: () => 0 }));
  const stdout = view.stdout as unknown as { rows: number };
  stdout.rows = opts.rows ?? 30;
  Object.defineProperty(view.stdout, 'columns', { value: opts.columns ?? 100, configurable: true });
  view.stdout.emit('resize');
  await tick();
  const frame = () => view.lastFrame() ?? '';
  const press = async (...keys: string[]) => {
    for (const k of keys) {
      view.stdin.write(k);
      await tick();
    }
  };
  const until = async (test: () => boolean, what: string) => {
    const end = Date.now() + WAIT_MS;
    while (!test() && Date.now() < end) await tick(20);
    expect(test(), what).toBe(true);
  };
  const untilText = (text: string) => until(() => flat(frame()).includes(text), text);
  const deletes = () => f.calls.filter((c) => c.method === 'DELETE').map((c) => c.path);
  return { ...view, session, frame, press, until, untilText, deletes };
}

async function openDelete(f: Fake, opts: Parameters<typeof start>[1] = {}) {
  const v = await start(f, opts);
  await v.press(ENTER);
  await v.untilText('Name mybot');
  await v.press('x');
  await v.untilText('Are you sure you want to remove mybot?');
  return v;
}

describe('m6 delete: the dialog', () => {
  it('docker mode: the page words, both toggles off, and the list whose last line follows the data toggle', async () => {
    const { f } = manager();
    const v = await openDelete(f);
    const text = flat(v.frame());
    expect(text).toContain("This will remove the bot's containers and the bot.");
    expect(text).toContain('> [ ] Also delete application data');
    expect(text).toContain('[ ] Also remove environment variables');
    expect(text).toContain('By default, data will be preserved. Check this to delete it permanently.');
    expect(text).toContain('By default, a copy goes to the Credentials Vault for recovery. Check this to delete them, even when data is preserved.');
    expect(text).toContain('This action cannot be undone:');
    expect(text).toContain('- Bot configuration will be permanently removed');
    expect(text).toContain("- The bot's containers will be removed");
    expect(text).toContain("- Without data deletion, all settings and user data will be preserved in this bot's own folder on the host; a new install does not reuse that folder");
    expect(keyBar(v.frame())).toContain('Y Remove bot');
    expect(keyBar(v.frame())).toContain('Space On/off');
    await v.press(SPACE);
    await v.untilText('> [x] Also delete application data');
    expect(flat(v.frame())).toContain('- All settings and user data will be permanently deleted');
    expect(v.deletes()).toEqual([]);
    v.unmount();
  });

  it('casaos mode and a list read with no mode each give their texts', async () => {
    const a = await openDelete(manager({ mode: 'casaos' }).f);
    expect(flat(a.frame())).toContain('This will uninstall the app from CasaOS and remove the bot.');
    expect(flat(a.frame())).toContain('- Application will be uninstalled from CasaOS');
    expect(flat(a.frame())).toContain('- Without data deletion, all settings and user data will be preserved');
    expect(flat(a.frame())).not.toContain("own folder on the host");
    a.unmount();
    const b = await openDelete(manager({ mode: null }).f);
    expect(flat(b.frame())).toContain('This will uninstall the app and remove the bot.');
    expect(flat(b.frame())).toContain('- Application will be uninstalled');
    b.unmount();
  });

  it('the data texts for a bot that hosts the fleet database or holds a copy (updateDataWarning, index.html:2050)', () => {
    const choice = { deleteData: true, deleteEnv: false, focus: 0 as const };
    expect(deleteLines('mybot', { id: 'b1', fleetDb: {} }, 'docker', choice, 200).join(' ')).toContain('This instance hosts the fleet database. While its volume exists the manager refuses to delete the data: decommission it on the Database modal first, which takes a safety dump');
    expect(deleteLines('mybot', { id: 'b1', fleetDbReplica: {} }, 'docker', choice, 200).join(' ')).toContain('This instance holds a copy of the fleet database. While its volume exists the manager refuses to delete the data: remove the replica on the Database modal first, which keeps that volume');
  });

  it('both toggles are off at each open, Space toggles the focused one, and Tab moves the focus', async () => {
    const { f } = manager();
    const v = await openDelete(f);
    await v.press(SPACE, TAB, SPACE);
    await v.untilText('[x] Also delete application data');
    await v.untilText('> [x] Also remove environment variables');
    await v.press(ESC);
    await v.untilText('Cancelled: mybot was not removed.');
    await v.press('x');
    await v.untilText('> [ ] Also delete application data');
    expect(flat(v.frame())).toContain('[ ] Also remove environment variables');
    expect(flat(v.frame())).not.toContain('[x]');
    expect(v.deletes()).toEqual([]);
    v.unmount();
  });

  it('the values sent are the toggles as they stand at Y', async () => {
    const { f, state } = manager();
    f.on('DELETE', DEL(true, false), () => {
      state.deleted = true;
      return kept({ envDeleted: true });
    });
    const v = await openDelete(f);
    await v.press(SPACE, TAB, SPACE, TAB, SPACE);
    await v.untilText('> [ ] Also delete application data');
    await v.press('y');
    await v.until(() => v.deletes().length === 1, 'one DELETE');
    expect(v.deletes()).toEqual([DEL(true, false)]);
    v.unmount();
  });

  it('X is not offered on a running bot and says why; nothing is sent', async () => {
    const v = await start(manager({ bot: { status: 'running' } }).f);
    await v.press(ENTER);
    await v.untilText('Name mybot');
    expect(keyBar(v.frame())).not.toContain('X Delete');
    await v.press('x');
    await v.untilText('Stop mybot to remove it.');
    v.unmount();
    const b = await start(manager({ bot: { activeOp: 'build' } }).f);
    await b.press(ENTER);
    await b.untilText('Name mybot');
    expect(keyBar(b.frame())).not.toContain('X Delete');
    await b.press('x');
    await b.untilText('mybot is busy, so it cannot be removed now.');
    expect(b.deletes()).toEqual([]);
    b.unmount();
  });
});

describe('m6 delete: the answers', () => {
  it('success removes the bot: the notice is the page text and the frame goes to the list', async () => {
    const { f, state } = manager();
    f.on('DELETE', DEL(), () => {
      state.deleted = true;
      return kept({ vaulted: true });
    });
    const v = await openDelete(f);
    await v.press('y');
    await v.untilText(`mybot: Bot removed; its data stays in ${KEPT}, and a new install does not reuse that folder; environment values copied to the vault`);
    await v.untilText('No bots on this manager.');
    expect(v.session.deleteOutcomes.get('b1')?.text).toContain('Bot removed');
    v.unmount();
  });

  it('success texts for each toggle pair (index.html:2089 to :2096)', () => {
    expect(deleteDoneText({ vaulted: true, envDeleted: false }, true, true)).toBe('Bot removed (data preserved); environment values copied to the vault');
    expect(deleteDoneText({ vaulted: false, envDeleted: false }, true, true)).toBe('Bot removed (data preserved)');
    expect(deleteDoneText({ vaulted: true, envDeleted: false }, false, true)).toBe('Bot removed; environment values copied to the vault');
    expect(deleteDoneText({ vaulted: false, envDeleted: true }, true, false)).toBe('Bot removed (data preserved); environment values deleted');
    expect(deleteDoneText({ vaulted: false, envDeleted: false }, false, false)).toBe('Bot removed; deleting the environment values could not be confirmed');
    expect(deleteDoneText({ vaulted: false, envDeleted: true, keptReplicaVolume: 'mybot-replica', dbDumpsKept: { count: 1, folder: 'backups/b1/fleet-postgres' } }, false, false))
      .toBe("Bot removed; the replica volume mybot-replica that Remove replica kept was not deleted; its 1 database dump stays in the manager's backups/b1/fleet-postgres folder; environment values deleted");
    expect(deleteDoneText({ vaulted: false, envDeleted: false, dbDumpsKept: { count: 3, folder: 'backups/b1/fleet-postgres' } }, true, true))
      .toBe("Bot removed (data preserved); its 3 database dumps stay in the manager's backups/b1/fleet-postgres folder");
  });

  it('the promoted question with keepData true adds only its flag, then success', async () => {
    // A bot with a copy whose container answers that it left recovery (fleetReplica.ts:1188 to :1191, :1290).
    const { f, state } = manager({ bot: { fleetDbReplica: { containerName: 'smdb-replica-b1' } } });
    f.on('DELETE', DEL(), askPromoted());
    f.on('DELETE', DEL(true, true, '&confirmPromoted=true'), () => {
      state.deleted = true;
      return kept({ vaulted: true });
    });
    const v = await openDelete(f);
    await v.press('y');
    await v.untilText('Remove it anyway?');
    expect(flat(v.frame())).toContain(PROMOTED);
    expect(keyBar(v.frame())).toContain('Y Remove anyway');
    await v.press('y');
    await v.untilText(`mybot: Bot removed; its data stays in ${KEPT}, and a new install does not reuse that folder; environment values copied to the vault`);
    expect(v.deletes()).toEqual([DEL(), DEL(true, true, '&confirmPromoted=true')]);
    v.unmount();
  });

  it('the data question on a bot with no copy adds only its flag, then success', async () => {
    // keepData false on a fleet-capable app whose data folder holds entries (fleetReplica.ts:1305, :1316).
    const { f, state } = manager();
    f.on('DELETE', DEL(false, true), askFleetData());
    f.on('DELETE', DEL(false, true, '&confirmFleetData=true'), () => {
      state.deleted = true;
      return removed({ vaulted: true });
    });
    const v = await openDelete(f);
    await v.press(SPACE, 'y');
    await v.untilText('Delete this data anyway?');
    expect(flat(v.frame())).toContain(FLEET_DATA);
    expect(keyBar(v.frame())).toContain('Y Delete anyway');
    await v.press('y');
    await v.untilText('mybot: Bot removed; environment values copied to the vault');
    expect(v.deletes()).toEqual([DEL(false, true), DEL(false, true, '&confirmFleetData=true')]);
    v.unmount();
  });

  // A guard only: with keepData false a bot with a copy is refused on its replica volume before the data question
  // (fleetReplica.ts:1300 to :1303), so no real delete asks both questions.
  it('two question rounds, each adding only its flag, then success', async () => {
    const { f, state } = manager();
    f.on('DELETE', DEL(false, true), askPromoted());
    f.on('DELETE', DEL(false, true, '&confirmPromoted=true'), askFleetData());
    f.on('DELETE', DEL(false, true, '&confirmPromoted=true&confirmFleetData=true'), () => {
      state.deleted = true;
      return removed({ vaulted: true });
    });
    const v = await openDelete(f);
    await v.press(SPACE, 'y');
    await v.untilText('Remove it anyway?');
    expect(flat(v.frame())).toContain(PROMOTED);
    expect(keyBar(v.frame())).toContain('Y Remove anyway');
    await v.press('y');
    await v.untilText('Delete this data anyway?');
    expect(flat(v.frame())).toContain(FLEET_DATA);
    expect(keyBar(v.frame())).toContain('Y Delete anyway');
    await v.press('y');
    await v.untilText('mybot: Bot removed; environment values copied to the vault');
    expect(v.deletes()).toEqual([DEL(false, true), DEL(false, true, '&confirmPromoted=true'), DEL(false, true, '&confirmPromoted=true&confirmFleetData=true')]);
    v.unmount();
  });

  // A guard only: the route asks each flag while it is absent (fleetReplica.ts:1290, :1305), so it cannot ask a third time.
  it('a third question after two rounds is shown as the refusal, with nothing added', async () => {
    const { f } = manager();
    f.on('DELETE', DEL(false, true), askPromoted());
    f.on('DELETE', DEL(false, true, '&confirmPromoted=true'), askFleetData());
    f.on('DELETE', DEL(false, true, '&confirmPromoted=true&confirmFleetData=true'), askPromoted());
    const v = await openDelete(f);
    await v.press(SPACE, 'y');
    await v.untilText('Remove it anyway?');
    await v.press('y');
    await v.untilText('Delete this data anyway?');
    await v.press('y');
    await v.untilText(`mybot: ${PROMOTED}`);
    expect(v.deletes()).toHaveLength(3);
    expect(flat(v.frame())).not.toContain('Remove it anyway?');
    v.unmount();
  });

  it('another key on a question sends nothing more: Nothing was removed', async () => {
    const { f } = manager();
    f.on('DELETE', DEL(), askPromoted());
    const v = await openDelete(f);
    await v.press('y');
    await v.untilText('Remove it anyway?');
    await v.press('n');
    await v.untilText('mybot: Nothing was removed');
    expect(v.deletes()).toEqual([DEL()]);
    expect(flat(v.frame())).toContain('Name mybot');
    v.unmount();
  });

  it('a refusal shows the route text with nothing added', async () => {
    const { f } = manager();
    f.on('DELETE', DEL(), busy());
    const v = await openDelete(f);
    await v.press('y');
    await v.untilText("mybot: Operation 'build' already in progress");
    expect(flat(v.frame())).not.toContain('Nothing was removed');
    expect(flat(v.frame())).toContain('Name mybot');
    v.unmount();
  });

  it('a 500 after a partial delete shows the route text only; the next list read tells what remains', async () => {
    const { f, state } = manager();
    f.on('DELETE', DEL(), () => {
      state.deleted = true;
      return partial();
    });
    const v = await openDelete(f);
    await v.press('y');
    await v.untilText('No bots on this manager.');
    const text = flat(v.frame());
    expect(text).toContain('mybot: Error: Failed to remove container mybot-bot-1: device or resource busy');
    expect(text).not.toMatch(/Nothing was removed|not removed|Bot removed/);
    v.unmount();
    // The same 500 with the bot still listed keeps the bot screen.
    const again = manager();
    again.f.on('DELETE', DEL(), partial());
    const w = await openDelete(again.f);
    await w.press('y');
    await w.untilText('mybot: Error: Failed to remove container');
    await tick(200);
    expect(flat(w.frame())).toContain('Name mybot');
    w.unmount();
  });

  it('no answer and a body that is not JSON give the page text', async () => {
    for (const reply of [noAnswer(), { status: 502, ok: false, body: 'Bad Gateway' }] as Reply[]) {
      const { f } = manager();
      f.on('DELETE', DEL(), reply);
      const v = await openDelete(f);
      await v.press('y');
      await v.untilText(`mybot: ${DELETE_NO_ANSWER}`);
      expect(flat(v.frame())).toContain('Name mybot');
      v.unmount();
    }
  });
});

describe('m6 delete: one send, the Session and the bot it names', () => {
  it('a double Y sends one DELETE; other keys during the call send nothing', async () => {
    const { f, state } = manager();
    const slow = later();
    f.on('DELETE', DEL(), () => slow.reply());
    const v = await openDelete(f);
    await v.press('y', 'y', 'Y', 'x', ENTER);
    await v.untilText('Asked the manager to remove mybot; waiting for the answer.');
    expect(v.deletes()).toEqual([DEL()]);
    state.deleted = true;
    slow.answer(kept({ vaulted: true }));
    await v.untilText('No bots on this manager.');
    expect(v.deletes()).toEqual([DEL()]);
    v.unmount();
  });

  it('Esc during the call leaves; X again sends nothing; the outcome lands through the Session', async () => {
    const { f, state } = manager({ others: [botRow({ id: 'b2', displayName: 'other' })] });
    const slow = later();
    f.on('DELETE', DEL(), () => slow.reply());
    const v = await openDelete(f);
    await v.press('y');
    await v.untilText('Asked the manager to remove mybot');
    await v.press(ESC);
    await v.untilText('The delete of mybot goes on; its outcome shows here when the manager answers.');
    expect(keyBar(v.frame())).not.toContain('X Delete');
    await v.press('x');
    await v.untilText('The delete of mybot is still running; waiting for the manager.');
    await v.press(ESC, DOWN, ENTER);
    await v.untilText('Name other');
    state.deleted = true;
    slow.answer(kept({ vaulted: true }));
    await v.untilText(`mybot: Bot removed; its data stays in ${KEPT}, and a new install does not reuse that folder; environment values copied to the vault`);
    expect(flat(v.frame())).toContain('Name other');
    expect(v.deletes()).toEqual([DEL()]);
    v.unmount();
  });

  it('Esc during the call while still on that bot: the frame goes to the list once the bot is gone', async () => {
    const { f, state } = manager();
    const slow = later();
    f.on('DELETE', DEL(), () => slow.reply());
    const v = await openDelete(f);
    await v.press('y');
    await v.untilText('Asked the manager to remove mybot');
    await v.press(ESC);
    await v.untilText('Name mybot');
    state.deleted = true;
    slow.answer(kept());
    await v.untilText('No bots on this manager.');
    expect(flat(v.frame())).toContain(`mybot: Bot removed; its data stays in ${KEPT}`);
    v.unmount();
  });

  it('while the DELETE runs the bot screen offers no S, R, B, U, E or C, and S and E send nothing', async () => {
    const { f, state } = manager();
    const slow = later();
    f.on('DELETE', DEL(), () => slow.reply());
    const v = await openDelete(f);
    await v.press('y');
    await v.untilText('Asked the manager to remove mybot');
    await v.press(ESC);
    await v.untilText('Name mybot');
    const bar = keyBar(v.frame());
    for (const k of ['S Start', 'R Restart', 'B Build', 'U Update', 'E Env', 'C Config']) expect(bar).not.toContain(k);
    const before = f.calls.length;
    await v.press('s', 'e', 'c', 'b', 'r', 'u');
    await tick(200);
    expect(f.calls.slice(before).filter((c) => !(c.method === 'GET' && c.path === '/api/bots'))).toEqual([]);
    expect(flat(v.frame())).toContain('Name mybot');
    state.deleted = true;
    slow.answer(kept());
    await v.untilText('No bots on this manager.');
    v.unmount();
  });

  it('a question that lands after Esc removes nothing and says how to answer it', async () => {
    const { f } = manager();
    const slow = later();
    f.on('DELETE', DEL(), () => slow.reply());
    const v = await openDelete(f);
    await v.press('y');
    await v.untilText('Asked the manager to remove mybot');
    await v.press(ESC);
    await v.untilText('Name mybot');
    slow.answer(askPromoted());
    await v.untilText('Nothing was removed: the manager asked this after the delete screen closed; press X to delete again and answer it.');
    expect(flat(v.frame())).not.toContain('Remove it anyway?');
    expect(v.deletes()).toEqual([DEL()]);
    v.unmount();
  });

  it('a list re-read during the dialog that moves the rows still sends the bot the dialog was opened for', async () => {
    const { f, state } = manager({ others: [botRow({ id: 'b2', displayName: 'other' })] });
    f.on('DELETE', DEL(), () => {
      state.deleted = true;
      return kept();
    });
    f.on('DELETE', '/api/bots/b2?keepData=true&keepEnv=true', kept({ keptDataDir: '/srv/dbm/bots/b2' }));
    const v = await openDelete(f);
    // A new bot listed first moves mybot down a row.
    state.bots = [botRow({ id: 'b0', displayName: 'newer' }), ...state.bots];
    await v.session.refresh();
    await tick(100);
    expect(flat(v.frame())).toContain('Are you sure you want to remove mybot?');
    await v.press('y');
    await v.until(() => v.deletes().length === 1, 'one DELETE');
    expect(v.deletes()).toEqual([DEL()]);
    v.unmount();
  });

  it('a bot that turned busy before Y gets nothing sent (index.html:2072)', async () => {
    const { f, state } = manager();
    const v = await openDelete(f);
    state.bots = [botRow({ status: 'starting', hasBeenStarted: true })];
    await v.session.refresh();
    await tick(100);
    await v.press('y');
    await v.untilText('mybot is busy (it is starting), so the delete was not sent.');
    expect(v.deletes()).toEqual([]);
    v.unmount();
  });
});

describe('m6 delete: columns', () => {
  for (const columns of [80, 100]) {
    it(`the dialog, a long question and the bar fit ${columns} columns whole`, async () => {
      const { f } = manager();
      f.on('DELETE', DEL(false, true), askFleetData());
      const v = await start(f, { columns, rows: 30 });
      await v.press(ENTER);
      await v.untilText('Name mybot');
      expect(keyBar(v.frame())).toContain('X Delete');
      await v.press('x');
      await v.untilText('Are you sure you want to remove mybot?');
      const lines = v.frame().split('\n');
      for (const l of lines) expect(l.length).toBeLessThanOrEqual(columns - 1);
      expect(flat(v.frame())).toContain('By default, a copy goes to the Credentials Vault for recovery. Check this to delete them, even when data is preserved.');
      expect(flat(v.frame())).toContain("in this bot's own folder on the host; a new install does not reuse that folder");
      await v.press(SPACE, 'y');
      await v.untilText('Delete this data anyway?');
      expect(flat(v.frame())).toContain(FLEET_DATA);
      for (const l of v.frame().split('\n')) expect(l.length).toBeLessThanOrEqual(columns - 1);
      v.unmount();
    });
  }
});
