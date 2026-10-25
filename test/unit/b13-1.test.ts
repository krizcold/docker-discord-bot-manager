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
const helpers = ['escapeHtml', 'seedPurposeText', 'seedWarningHtml', 'transferPhaseText', 'failbackRunHtml', 'seedAfterRetire']
  .concat(['replicaPromotable', 'replicaTransferHtml', 'replicaConsentHtml', 'replicaPromiseText', 'copyDumpHtml', 'copyDumpLineHtml'].filter((n) => pageHtml.includes(`function ${n}(`)));

const record = { primaryHost: 'p.example', primaryPort: 15432, publicHost: 'h.example', hostPort: 15433 };
const liveCopy = { running: true, inRecovery: true, receiverStatus: 'streaming', caughtUp: true };

async function render(opts: { replica: any; facts: any; consent?: boolean | null }): Promise<string> {
  const body: any = { isConnected: true, innerHTML: '' };
  const ctx = vm.createContext({
    document: {
      getElementById: (id: string) => id === 'fleet-replica-body' ? body : null,
      createElement: () => { const el: any = { textContent: '' }; Object.defineProperty(el, 'innerHTML', { get: () => String(el.textContent).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') }); return el; },
    },
    setTimeout: () => 0,
    bots: [{ id: 'b1', appHooks: true, fleetBackupConsent: opts.consent ?? null }],
    fleetBackupBotId: 'b1',
    replicaPollSeq: 0,
    api: async (_m: string, url: string) => url.includes('/app-facts')
      ? opts.facts
      : { success: true, replica: opts.replica, standIn: { read: 'ok', posture: null } },
  });
  vm.runInContext(helpers.map(pageFunction).join('\n') + '\n' + pageFunction('renderFleetReplica'), ctx);
  await ctx.renderFleetReplica('b1');
  return body.innerHTML;
}

const plainFacts = { running: true, initialized: true, role: 'worker', backupMaster: false, followerHold: null, activeCapable: false, nodeId: 'n1' };

describe('the replica panel Transfer section follows the app role facts', () => {
  it('does not offer Transfer to a node that is not a designated backup, and names the Fleet Role change', async () => {
    const html = await render({ replica: { present: true, record, live: liveCopy }, facts: { success: true, facts: plainFacts } });
    expect(html).not.toContain('appTransfer(');
    expect(html).toContain('Fleet Role');
    expect(html).toMatch(/restart/i);
  });

  it('offers Transfer to a designated backup', async () => {
    const html = await render({ replica: { present: true, record, live: liveCopy }, facts: { success: true, facts: { ...plainFacts, backupMaster: true } } });
    expect(html).toContain(`appTransfer('b1', false)`);
  });

  it('offers Transfer to a follower hold that names this node', async () => {
    const hold = { reason: 'behind', namesThisNode: true };
    const html = await render({ replica: { present: true, record, live: liveCopy }, facts: { success: true, facts: { ...plainFacts, followerHold: hold } } });
    expect(html).toContain(`appTransfer('b1', false)`);
  });

  it('withholds Transfer and says it cannot confirm the role when the app does not answer', async () => {
    const html = await render({ replica: { present: true, record, live: liveCopy }, facts: { success: false, error: 'timeout' } });
    expect(html).not.toContain('appTransfer(');
    expect(html).toMatch(/can't confirm/);
  });

  it('keeps the promote promise off the provision panel of a node that is not a designated backup', async () => {
    const html = await render({ replica: { present: false }, facts: { success: true, facts: plainFacts } });
    expect(html).not.toContain('also promotes this copy');
    expect(html).toContain('Fleet Role');
  });

  it('keeps the promote promise for a designated backup', async () => {
    const html = await render({ replica: { present: false }, facts: { success: true, facts: { ...plainFacts, backupMaster: true } } });
    expect(html).toContain('also promotes this copy');
  });
});

describe('the replica panel Backup mode line says saved versus running', () => {
  it('says the running bot is still passive when the saved env is active', async () => {
    const html = await render({ replica: { present: true, record, live: liveCopy }, facts: { success: true, facts: { ...plainFacts, backupMaster: true, activeCapable: false } }, consent: true });
    expect(html).toMatch(/saved/i);
    expect(html).toMatch(/running bot[^<]*passive/i);
  });

  it('says the running bot is still active when the saved env is passive', async () => {
    const html = await render({ replica: { present: true, record, live: liveCopy }, facts: { success: true, facts: { ...plainFacts, backupMaster: true, activeCapable: true } }, consent: false });
    expect(html).toMatch(/running bot[^<]*active/i);
  });

  it('says both agree when the running bot matches the saved env', async () => {
    const html = await render({ replica: { present: true, record, live: liveCopy }, facts: { success: true, facts: { ...plainFacts, backupMaster: true, activeCapable: false } }, consent: false });
    expect(html).toMatch(/passive in this instance's saved env and in the running bot/);
  });

  it('treats a running bot with no fleet state yet as unread', async () => {
    const early = { running: true, nodeId: null, backupMaster: false, activeCapable: false };
    const html = await render({ replica: { present: true, record, live: liveCopy }, facts: { success: true, facts: early }, consent: true });
    expect(html).not.toContain('appTransfer(');
    expect(html).not.toMatch(/not a designated backup/);
    expect(html).toMatch(/active in this instance's saved env; can't confirm/);
    expect(html).toContain('has not reported its fleet state yet');
    const prov = await render({ replica: { present: false }, facts: { success: true, facts: early } });
    expect(prov).toMatch(/Can't confirm whether promoting/);
  });

  it('hedges the passive line when the running bot cannot be read', async () => {
    const html = await render({ replica: { present: true, record, live: liveCopy }, facts: { success: false, error: 'timeout' }, consent: false });
    expect(html).toMatch(/passive in this instance's saved env; can't confirm/);
  });
});
