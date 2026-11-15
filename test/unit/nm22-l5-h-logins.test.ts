import { afterEach, describe, expect, it } from 'vitest';
import { removeLoginOutcome, renewOutcome } from '../../src/cli/tui/actions';
import { DatabaseScreen } from '../../src/cli/tui/database';
import { replicationLines } from '../../src/cli/tui/dbtext';
import { fake, ok as cliOk } from './m2-fake';
import { mainBot, replicationOn } from './m4-fake';

const A = 'smdb_copy_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SA = 'fleet_standby_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const B = '/api/bots/b1';
const RM_PATH = `${B}/fleet-replication/logins/${A}`;
const RENEW_PATH = `${B}/fleet-replication/join-code/renew`;
const CODE_PATH = `${B}/fleet-replication/join-code`;
const RENEW_DONE = "Made a new join code and gave this machine's own login a new password. The old code no longer adds machines; machines that joined before keep their logins.";
const RM_Q = `The machine with the login ${A} streams from this database now (copy-a). Removing its login ends that stream, drops its slot and takes its address off the list: its copy stops following this database, and other machines stop listing it within an hour. Its manager can join again while it holds this join code; make a new join code too if that machine should stay out. Remove it?`;
const login = (over: Record<string, unknown> = {}) => ({ login: A, own: false, member: true, canLogin: true, slot: SA, slotState: 'absent', machine: 'copy-a', address: 'a.invalid:15433', client: null, ...over });
const replication = (logins?: unknown) => ({ enabled: true, publicHost: 'main.example', hostPort: 15432, live: { sslOn: true, standbys: [], slots: [], slotWalKeep: '4096MB', ...(logins === undefined ? {} : { logins }) } });
const until = async (test: () => boolean) => {
  for (const end = Date.now() + 5000; Date.now() < end && !test();) await new Promise(r => setTimeout(r, 10));
  expect(test()).toBe(true);
};
const deferred = () => {
  let resolve!: (v: unknown) => void;
  const p = new Promise(r => { resolve = r; });
  return { p, resolve };
};

describe('NM22 L5 h: the login and join code outcomes when the answer has no text', () => {
  it('removeLoginOutcome: a refusal with no text, a success with no text, a failure with no error', () => {
    expect(removeLoginOutcome(A, { ok: false, text: '' })).toEqual({ ok: false, text: `The login ${A} was not removed` });
    expect(removeLoginOutcome(A, { ok: false, text: 'boom' })).toEqual({ ok: false, text: 'boom' });
    expect(removeLoginOutcome(A, { ok: true, value: { success: true } })).toEqual({ ok: true, text: `Removed the login ${A}` });
    expect(removeLoginOutcome(A, { ok: true, value: { success: false } })).toEqual({ ok: false, text: `The login ${A} was not removed` });
  });

  it('renewOutcome: a refusal with no text, a success with no text, a failure with no error', () => {
    expect(renewOutcome({ ok: false, text: '' })).toEqual({ ok: false, text: 'The join code was not renewed' });
    expect(renewOutcome({ ok: false, text: 'boom' })).toEqual({ ok: false, text: 'boom' });
    expect(renewOutcome({ ok: true, value: { success: true } })).toEqual({ ok: true, text: 'Made a new join code.' });
    expect(renewOutcome({ ok: true, value: { success: false } })).toEqual({ ok: false, text: 'The join code was not renewed' });
  });

  it('a login whose slot is active with no client listed reads streaming', () => {
    const text = replicationLines({ ok: true, value: { replication: replication([login({ slotState: 'active', client: null })]) as never } }, () => 'then').map(l => l.text);
    expect(text).toContain(`copy-a (${A}): streaming`);
  });
});

describe('NM22 L5 h: the Database screen while Remove and New join code wait, and after it closes', () => {
  const open: DatabaseScreen[] = [];
  afterEach(() => { for (const s of open.splice(0)) s.close(); });

  const screen = async (logins: unknown, routes: Record<string, unknown>, showCode: () => boolean = () => true) => {
    const f = fake().on('GET', `${B}/fleet-replication`, replicationOn(replication(logins)));
    for (const [k, v] of Object.entries(routes)) {
      const [method, p] = k.split(' ');
      f.on(method, p, v as never);
    }
    const reports: Array<{ ok: boolean | null; text: string }> = [];
    const b = mainBot();
    const source = { bot: () => b, list: { bots: [b], readAt: 0, error: null } };
    const s = new DatabaseScreen(f.client, () => {}, 'b1', source as never, { everyMs: 60_000, limitMs: 2000, env: { HOST_DATA_DIR: '/srv/smdb/data' }, timeZone: 'UTC' },
      (r) => { reports.push(r as never); }, showCode);
    open.push(s);
    s.open();
    await until(() => s.actionRows().some(r => r.kind === 'disable'));
    const pick = (label: string) => {
      const i = s.actionRows().findIndex(r => r.label === label);
      expect(i).toBeGreaterThanOrEqual(0);
      s.key('a', {});
      for (let k = 0; k < i; k++) s.key('', { downArrow: true });
      s.key('', { return: true });
    };
    const yes = () => { s.view(100, 80); s.key('y', {}); };
    return { s, f, reports, pick, yes };
  };

  it('Remove: the waiting line names the login and Esc leaves; the question\'s key is Y Remove', async () => {
    const d = deferred();
    const t = await screen([login({ slotState: 'active', client: '10.0.0.5' })], { [`DELETE ${RM_PATH}`]: () => d.p });
    t.pick(`Remove the login ${A} (copy-a)`);
    await until(() => t.f.calls.some(c => c.method === 'DELETE'));
    const v = t.s.view(100, 80);
    expect(v.notice).toBe(`Removing the login ${A}.`);
    expect(v.keys).toBe('Waiting for the manager  Esc Back');
    expect(t.s.key('', { escape: true })).toEqual({ leave: true });
    d.resolve(cliOk({ success: false, needsConfirm: true, error: RM_Q }));
    await until(() => t.s.view(100, 80).body.join(' ').includes('Remove it?'));
    expect(t.s.view(100, 80).keys.split('  ')[0]).toBe('Y Remove');
  });

  it('Remove: the screen closed before the question came: nothing asked, the lost text reported', async () => {
    const d = deferred();
    const t = await screen([login({ slotState: 'active', client: '10.0.0.5' })], { [`DELETE ${RM_PATH}`]: () => d.p });
    t.pick(`Remove the login ${A} (copy-a)`);
    await until(() => t.f.calls.some(c => c.method === 'DELETE'));
    t.s.close();
    d.resolve(cliOk({ success: false, needsConfirm: true, error: RM_Q }));
    const want = { ok: false, text: `Nothing was removed: the manager asked to confirm after the Database screen was closed (${RM_Q}).` };
    await until(() => t.reports.some(r => r.text.startsWith('Nothing was removed')));
    expect(t.reports.at(-1)).toEqual(want);
    expect(t.f.calls.filter(c => c.method === 'DELETE')).toHaveLength(1);
  });

  it('Remove: a success that also carries needsConfirm (a manager of another build) is reported, never asked', async () => {
    const t = await screen([login()], { [`DELETE ${RM_PATH}`]: cliOk({ success: true, needsConfirm: true, text: 'Removed' }) });
    t.pick(`Remove the login ${A} (copy-a)`);
    await until(() => t.reports.length > 0);
    expect(t.reports.at(-1)).toEqual({ ok: true, text: 'Removed' });
    expect(t.s.view(100, 80).keys.split('  ')[0]).not.toBe('Y Remove');
    expect(t.f.calls.filter(c => c.method === 'DELETE')).toHaveLength(1);
  });

  it('Remove: a needsConfirm answer with no error asks the default question', async () => {
    const t = await screen([login({ slotState: 'active', client: '10.0.0.5' })], { [`DELETE ${RM_PATH}`]: cliOk({ success: false, needsConfirm: true }) });
    t.pick(`Remove the login ${A} (copy-a)`);
    await until(() => t.s.view(100, 80).keys.split('  ')[0] === 'Y Remove');
    expect(t.s.view(100, 80).body).toContain(`Remove the login ${A}?`);
  });

  it('New join code: the question\'s key is Y Make a new code; the waiting line, and Esc leaves', async () => {
    const d = deferred();
    const t = await screen([], { [`POST ${RENEW_PATH}`]: () => d.p, [`GET ${CODE_PATH}`]: cliOk({ success: true, joinCode: 'CODE-1' }) });
    t.pick('New join code');
    expect(t.s.view(100, 80).keys.split('  ')[0]).toBe('Y Make a new code');
    t.yes();
    await until(() => t.f.calls.some(c => c.method === 'POST'));
    const v = t.s.view(100, 80);
    expect(v.notice).toBe('Making a new join code.');
    expect(v.keys).toBe('Waiting for the manager  Esc Back');
    expect(t.s.key('', { escape: true })).toEqual({ leave: true });
    d.resolve(cliOk({ success: true, text: RENEW_DONE }));
    await until(() => t.s.notice !== null);
  });

  it('New join code: the code screen does not open: RENEW-NOCODE with the press-J reason, not RENEW-DONE', async () => {
    const t = await screen([], { [`POST ${RENEW_PATH}`]: cliOk({ success: true, text: RENEW_DONE }), [`GET ${CODE_PATH}`]: cliOk({ success: true, joinCode: 'CODE-1' }) }, () => false);
    t.pick('New join code');
    t.yes();
    await until(() => t.s.notice !== null);
    const text = `${RENEW_DONE} But the code could not be shown: the Database screen was closed before the code came; press J on it to show the code`;
    expect(t.s.notice).toBe(text);
    expect(t.reports.at(-1)).toEqual({ ok: false, text });
  });
});
