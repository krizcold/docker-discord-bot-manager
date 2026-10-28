import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { describe, expect, it } from 'vitest';

const pageHtml = fs.readFileSync(path.resolve(__dirname, '../../src/webui/public/index.html'), 'utf8');
const pageFunction = (name: string): string => {
  let start = pageHtml.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`no function ${name}`);
  if (pageHtml.slice(start - 6, start) === 'async ') start -= 6;
  let i = pageHtml.indexOf('(', start);
  for (let depth = 0; ; i++) {
    if (pageHtml[i] === '(') depth++;
    else if (pageHtml[i] === ')' && --depth === 0) break;
  }
  i = pageHtml.indexOf('{', i);
  for (let depth = 0; ; i++) {
    if (pageHtml[i] === '{') depth++;
    else if (pageHtml[i] === '}' && --depth === 0) return pageHtml.slice(start, i + 1);
  }
};
const escapeHtml = (t: unknown) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function page(names: string[], extra: Record<string, unknown> = {}) {
  const messages: string[][] = [];
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  const confirms: string[] = [];
  const answers: unknown[] = (extra.answers as unknown[]) ?? [];
  const ctx = vm.createContext({
    showMessage: (t: string, m: string) => messages.push([t, m]),
    showNoAnswer: () => messages.push(['noanswer', '']),
    escapeHtml,
    api: async (method: string, url: string, body?: unknown) => { calls.push({ method, url, body }); return answers.shift(); },
    confirm: (q: string) => { confirms.push(q); return extra.confirmAnswer !== false; },
    window: { confirm: (q: string) => { confirms.push(q); return extra.confirmAnswer !== false; } },
    document: { getElementById: (id: string) => (extra.fields as Record<string, unknown> | undefined)?.[id] ?? null },
    navigator: extra.navigator ?? { clipboard: { writeText: async () => undefined } },
    renderFleetReplica: () => {}, loadBots: () => {}, refuseBadNumbers: () => false, refuseWhileChecking: () => false,
    followLostProvisioning: async () => {}, setTimeout,
    ...extra,
  });
  vm.runInContext(names.map(pageFunction).join('\n'), ctx);
  return { ctx, messages, calls, confirms };
}

describe('the main\'s join code buttons', () => {
  it('Copy join code puts the code on the clipboard and warns that it holds passwords', async () => {
    let copied = '';
    const p = page(['fetchJoinCode', 'copyJoinCode'], { answers: [{ success: true, joinCode: 'smdbjoin1.abc' }], navigator: { clipboard: { writeText: async (t: string) => { copied = t; } } } });
    await p.ctx.copyJoinCode('m');
    expect(p.calls).toEqual([{ method: 'GET', url: '/bots/m/fleet-replication/join-code', body: undefined }]);
    expect(copied).toBe('smdbjoin1.abc');
    expect(p.messages).toEqual([['success', 'Join code copied. It holds database passwords: paste it only into your own managers.']]);
  });

  it('a refused clipboard says to press Show', async () => {
    const p = page(['fetchJoinCode', 'copyJoinCode'], { answers: [{ success: true, joinCode: 'smdbjoin1.abc' }], navigator: { clipboard: { writeText: async () => { throw new Error('denied'); } } } });
    await p.ctx.copyJoinCode('m');
    expect(p.messages).toEqual([['error', 'The join code could not be copied to the clipboard; press Show and copy it by hand.']]);
  });

  it('a refusal from the server is shown as it is', async () => {
    const p = page(['fetchJoinCode', 'copyJoinCode'], { answers: [{ success: false, error: 'Replication is not enabled, so there is no join code.' }] });
    await p.ctx.copyJoinCode('m');
    expect(p.messages).toEqual([['error', 'Replication is not enabled, so there is no join code.']]);
  });

  it('Show puts the code in a read-only field, and Hide clears it', async () => {
    const shown: any = { innerHTML: '' };
    const p = page(['fetchJoinCode', 'showJoinCode', 'hideJoinCode'], { answers: [{ success: true, joinCode: 'smdbjoin1.<x>' }], fields: { 'fleet-join-code-shown': shown } });
    await p.ctx.showJoinCode('m');
    expect(shown.innerHTML).toContain('readonly');
    expect(shown.innerHTML).toContain('smdbjoin1.&lt;x&gt;');
    p.ctx.hideJoinCode();
    expect(shown.innerHTML).toBe('');
  });
});

describe('the joining machine\'s panel', () => {
  it('Join posts the code, says it is checking, and shows the answer', async () => {
    const p = page(['joinFleetFromPanel'], { answers: [{ success: true, message: 'Joined the main at main.invalid:15432.' }], fields: { 'replica-join': { value: ' smdbjoin1.abc ' } } });
    await p.ctx.joinFleetFromPanel('b');
    expect(p.calls).toEqual([{ method: 'POST', url: '/bots/b/fleet-join', body: { joinCode: 'smdbjoin1.abc' } }]);
    expect(p.messages).toEqual([
      ['info', 'Checking the join code; the first check on a machine downloads the database image and can take a few minutes.'],
      ['success', 'Joined the main at main.invalid:15432.'],
    ]);
  });

  it('Add a live copy sends the code and the optional address, never a DSN or a certificate', async () => {
    const postProvision = async (url: string, body: unknown) => { calls.push({ url, body }); return { success: true }; };
    const calls: Array<{ url: string; body: unknown }> = [];
    const p = page(['provisionFleetReplica'], { postProvision, fields: { 'replica-join': { value: 'smdbjoin1.abc' }, 'replica-host': { value: 'copy.invalid' }, 'replica-port': { value: '15433' } } });
    await p.ctx.provisionFleetReplica('b');
    expect(calls).toEqual([{ url: '/bots/b/fleet-replica', body: { joinCode: 'smdbjoin1.abc', publicHost: 'copy.invalid', hostPort: 15433 } }]);
    const q = page(['provisionFleetReplica'], { postProvision, fields: { 'replica-join': { value: '' }, 'replica-host': { value: '' }, 'replica-port': { value: '15433' } } });
    calls.length = 0;
    await q.ctx.provisionFleetReplica('b');
    expect(calls).toEqual([{ url: '/bots/b/fleet-replica', body: {} }]);
  });

  it('Re-seed asks with the join code\'s wording, then answers a needsConfirm round', async () => {
    const p = page(['reseedStandbyNow'], { answers: [{ success: false, needsConfirm: true, error: 'The main in the join code is on timeline 2 and this copy on timeline 1, so ...' }, { success: true }] });
    await p.ctx.reseedStandbyNow('b');
    expect(p.confirms[0]).toBe("Re-seed this copy now?\n\nThe manager checks the main in this machine's join code, takes a dump of the copy (kept with the backups), then replaces the copy with a fresh copy of the main. If the check or the dump fails, nothing is deleted.");
    expect(p.confirms[1]).toBe('The main in the join code is on timeline 2 and this copy on timeline 1, so ...');
    expect(p.calls.map(c => c.body)).toEqual([{}, { confirm: true }]);
    expect(p.messages).toEqual([['success', 'Re-seed started']]);
  });

  it('a declined second question sends nothing more', async () => {
    let n = 0;
    const p = page(['reseedStandbyNow'], { answers: [{ success: false, needsConfirm: true, error: 'q' }], confirm: () => n++ === 0 });
    await p.ctx.reseedStandbyNow('b');
    expect(p.calls).toHaveLength(1);
    expect(p.messages).toEqual([]);
  });
});

describe('the rebuild on the panel', () => {
  const p = page(['seedPurposeText', 'rebuildLineHtml', 'alertOutcomeHtml', 'joinStateHtml', 'rebuiltLineHtml']);

  it('N5: shows the stored rebuild message outcome unless the seed note already carries it', () => {
    const rebuild = { kind: 'ok', text: null, alerts: {}, rebuilt: 'The copy was rebuilt automatically (the run started 2026-10-27 10:00 UTC). The owner was sent a Discord message.' };
    expect(p.ctx.rebuiltLineHtml(rebuild, {})).toBe('<div class="env-tip">The copy was rebuilt automatically (the run started 2026-10-27 10:00 UTC). The owner was sent a Discord message.</div>');
    expect(p.ctx.rebuiltLineHtml(rebuild, { rebuiltShown: true })).toBe('');
    expect(p.ctx.rebuiltLineHtml({ ...rebuild, rebuilt: null }, {})).toBe('');
    expect(p.ctx.rebuiltLineHtml(null, {})).toBe('');
  });

  it('N4: names why an automatic rebuild runs', () => {
    expect(p.ctx.seedPurposeText('reseed-standby', true, 'cleared')).toBe('Rebuilding the copy (it had been emptied by a Re-seed or rebuild that stopped)');
    expect(p.ctx.seedPurposeText('reseed-standby', true)).toBe('Rebuilding the copy');
  });

  it('names an automatic rebuild apart from a Re-seed', () => {
    expect(p.ctx.seedPurposeText('reseed-standby', true, 'slot')).toBe('Rebuilding the copy (the main no longer kept its place)');
    expect(p.ctx.seedPurposeText('reseed-standby', false)).toBe('Re-seeding the standby');
    expect(p.ctx.seedPurposeText('provision')).toBe('Provisioning the standby');
  });

  it('shows the watcher\'s line for held and unknown, with the message outcome for held, and nothing otherwise', () => {
    expect(p.ctx.rebuildLineHtml({ kind: 'held', text: 'It was not rebuilt automatically: x.', alerts: { held: { outcome: 'The owner was sent a Discord message.' } } }))
      .toBe('<div class="error-message">It was not rebuilt automatically: x.<div class="env-tip">The owner was sent a Discord message.</div></div>');
    expect(p.ctx.rebuildLineHtml({ kind: 'unknown', text: "Can't confirm whether ...", alerts: { held: { outcome: 'The owner was sent a Discord message.' } } }))
      .toBe(`<div class="error-message">Can't confirm whether ...</div>`);
    expect(p.ctx.rebuildLineHtml({ kind: 'ok', text: null, alerts: {} })).toBe('');
    expect(p.ctx.rebuildLineHtml({ kind: 'rebuild', text: null, alerts: {} })).toBe('');
    expect(p.ctx.rebuildLineHtml(null)).toBe('');
    expect(p.ctx.alertOutcomeHtml({ alerts: { held: { outcome: null } } }, 'held')).toBe('');
  });

  it('shows the joined main and the list\'s last error', () => {
    expect(p.ctx.joinStateHtml(null)).toBe('');
    const html = p.ctx.joinStateHtml({ host: 'main.invalid', port: 15432, machine: 'main.invalid', addressesError: 'boom', codeUnreadable: true });
    expect(html).toContain('Joined the main at <b>main.invalid:15432</b> (main.invalid).');
    expect(html).toContain('The stored join code no longer decrypts (the manager encryption key changed or was lost); paste the join code again.');
    expect(html).toContain('<div class="error-message">boom</div>');
  });
});
