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
const optional = (names: string[]) => names.filter((n) => pageHtml.includes(`function ${n}(`));
const helpers = ['escapeHtml', 'namesAnExit', 'failbackRunHtml', 'failbackPhaseText', 'transferPhaseText']
  .concat(optional(['seedPurposeText', 'seedWarningHtml', 'seedAfterRetire', 'replicaPromotable', 'replicaTransferHtml', 'replicaConsentHtml', 'replicaPromiseText', 'panelHasEntry', 'copyDumpHtml', 'copyDumpLineHtml', 'autoReseedText']));

function page(fn: string, answer: any, extra: Record<string, unknown> = {}) {
  const body: any = { isConnected: true, innerHTML: '', querySelectorAll: () => [] };
  const ctx = vm.createContext({
    document: {
      activeElement: null,
      getElementById: (id: string) => id === 'fleet-replica-body' || id === 'fleet-replication-body' ? body : null,
      createElement: () => { const el: any = { textContent: '' }; Object.defineProperty(el, 'innerHTML', { get: () => String(el.textContent).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') }); return el; },
    },
    setTimeout: () => 0,
    bots: [{ id: 'b1', status: 'running', appHooks: false }],
    fleetBackupBotId: 'b1',
    replicaPollSeq: 0,
    jsArg: (v: unknown) => JSON.stringify(v),
    api: async (_m: string, url: string) => (url.includes('/app-facts') ? { success: false } : answer),
    ...extra,
  });
  vm.runInContext(helpers.map(pageFunction).join('\n') + '\n' + pageFunction(fn), ctx);
  return { ctx, body };
}

const replication = (failback: unknown, standIn: unknown = null, extra: Record<string, unknown> = {}) => page('renderFleetReplication', {
  success: true, replication: { enabled: true, publicHost: 'h', hostPort: 15432, live: null }, standIn, failback, ...extra,
});
const run = (extra: Record<string, unknown> = {}) => ({ mode: 'failback', phase: 'awaiting-block', standInNodeId: 'n2', startedAt: 1, parked: true, lastError: 'x', ...extra });

describe('B23-2s: the failback card names Continue only when the stop reason names no exit', () => {
  const card = (r: unknown): string => {
    const ctx = vm.createContext({});
    vm.runInContext(helpers.map(pageFunction).join('\n'), ctx);
    return ctx.failbackRunHtml('b1', r, true);
  };

  it('a reason that names its own exit is not followed by the generic Continue promise', () => {
    for (const lastError of ['the seed stopped; dismiss it on this modal, then Continue', 'Cancel this run', 'Dismiss this run']) {
      expect(card(run({ lastError }))).not.toContain('Continuing picks up from where it stopped.');
    }
    expect(card(run({ lastError: 'the bot did not answer' }))).toContain('the bot did not answer Continuing picks up from where it stopped.');
  });

  it('the consent card promises a restart only when the run stopped the instance', () => {
    const consent = (stoppedByRun: boolean) => card(run({ phase: 'wipe-consent', consentAt: null, stoppedByRun }));
    expect(consent(true)).toContain('Cancel starts the instance again with the database untouched');
    expect(consent(false)).toContain('Cancel leaves the instance stopped, as it was, with the database untouched');
    expect(consent(false)).not.toContain('starts the instance again');
  });
});

describe('B23-2s: Decommission hides while a run is recorded', () => {
  it('the replication panel offers no Decommission with a run on record, and offers it without one', async () => {
    for (const [answer, shown] of [[replication(run()), false], [replication(null), true]] as const) {
      await answer.ctx.renderFleetReplication('b1');
      expect(answer.body.innerHTML.includes('decommissionFleetDb(')).toBe(shown);
    }
  });

  it('the panel with replication off offers no Decommission with a run on record', async () => {
    for (const [failback, shown] of [[run(), false], [null, true]] as const) {
      const p = page('renderFleetReplication', { success: true, replication: { enabled: false }, failback });
      await p.ctx.renderFleetReplication('b1');
      expect(p.body.innerHTML.includes('decommissionFleetDb(')).toBe(shown);
    }
  });

  it('an app with hooks keeps Demote and loses Decommission and its tip while a run is recorded', async () => {
    const p = replication(run());
    p.ctx.bots = [{ id: 'b1', status: 'running', appHooks: true }];
    await p.ctx.renderFleetReplication('b1');
    expect(p.body.innerHTML).toContain('appDemote(');
    expect(p.body.innerHTML).not.toContain('decommissionFleetDb(');
    expect(p.body.innerHTML).not.toContain('<b>Decommission</b>');
  });
});

describe('B23-2s: a covered node\'s notice drops the by-hand stop while a run is on record', () => {
  const covered = (extra: Record<string, unknown> = {}) => ({ role: 'covered', namesThisNode: true, followsDelivered: true, holdReason: 'behind', standInNodeId: 'n2', ...extra });

  it('BEHIND A STAND-IN names the run instead of Stop this instance', async () => {
    const withRun = replication(run(), covered());
    await withRun.ctx.renderFleetReplication('b1');
    expect(withRun.body.innerHTML).toContain('BEHIND A STAND-IN');
    expect(withRun.body.innerHTML).toContain('The failback run on record owns the re-seed (its card shows its exits)');
    expect(withRun.body.innerHTML).not.toContain('Stop this instance, then paste');

    const without = replication(null, covered());
    await without.ctx.renderFleetReplication('b1');
    expect(without.body.innerHTML).toContain('Stop this instance, then paste');
  });

  it('DATABASE NOT INSTALLED names the run instead of Stop this instance', async () => {
    const withRun = replication(run(), covered({ followsDelivered: false }));
    await withRun.ctx.renderFleetReplication('b1');
    expect(withRun.body.innerHTML).toContain('DATABASE NOT INSTALLED');
    expect(withRun.body.innerHTML).toContain('The failback run on record owns the re-seed; its card shows its exits');
    expect(withRun.body.innerHTML).not.toContain('Stop this instance, then paste');

    const without = replication(null, covered({ followsDelivered: false }));
    await without.ctx.renderFleetReplication('b1');
    expect(without.body.innerHTML).toContain('Stop this instance, then paste');
  });
});

describe('B23-2s: the replica panel', () => {
  const record = { primaryHost: 'p.example', primaryPort: 15432, publicHost: 'h.example', hostPort: 15433 };
  const liveCopy = { running: true, inRecovery: true, receiverStatus: 'streaming', caughtUp: true };
  const replica = (extra: Record<string, unknown>) => page('renderFleetReplica', { success: true, replica: { present: true, record, live: liveCopy }, ...extra });

  it('a declined failback offers Fail back now only when the holding node names this node', async () => {
    const declined = { mode: 'failback', at: 1, phase: 'wipe-consent', standInNodeId: 'n2' };
    const html = async (namesThisNode: unknown) => {
      const p = replica({ failbackDeclined: declined, standIn: { read: 'ok', posture: { role: 'covered', namesThisNode, standInNodeId: 'n2', holdReason: 'behind' } } });
      await p.ctx.renderFleetReplica('b1');
      return p.body.innerHTML as string;
    };
    expect(await html(true)).toContain('openFailback(');
    const gone = await html(false);
    expect(gone).not.toContain('openFailback(');
    expect(gone).toContain('The node this bot followed no longer stands in for it, so there is no failback to run.');
    const unnamed = await html(undefined);
    expect(unnamed).not.toContain('openFailback(');
    expect(unnamed).toContain('Fail back now shows here once the node holding the fleet names this node as the one it stands in for.');
  });

  it('a parked transfer names Continue only when its reason names no exit', async () => {
    const card = async (lastError: string) => {
      const p = replica({ transfer: { phase: 'seeding', parked: true, lastError, startedAt: 1 }, standIn: { read: 'ok', posture: null } });
      await p.ctx.renderFleetReplica('b1');
      return p.body.innerHTML as string;
    };
    expect(await card('the seed stopped; Dismiss it')).not.toContain('Continuing picks up from where it stopped.');
    expect(await card('the bot did not answer')).toContain('the bot did not answer Continuing picks up from where it stopped.');
  });
});

describe('B23-2s: the Transfer toast words a continued run', () => {
  const toast = async (answer: Record<string, unknown>, resuming: boolean) => {
    const shown: [string, string][] = [];
    const ctx = vm.createContext({
      api: async () => ({ success: true, ...answer }),
      confirm: () => true,
      showMessage: (kind: string, text: string) => { shown.push([kind, text]); },
      showNoAnswer: () => { shown.push(['no-answer', '']); },
      renderFleetReplica: () => {},
      loadBots: () => {},
      refuseBadNumbers: () => false,
      document: { getElementById: () => null },
    });
    vm.runInContext(pageFunction('appTransfer'), ctx);
    await ctx.appTransfer('b1', false, false, resuming);
    return shown;
  };

  it('a resumed run says it continued, and a fresh one says it started', async () => {
    expect(await toast({ resumed: true }, true)).toEqual([['success', 'Transfer continued; progress shows in this panel']]);
    expect(await toast({}, false)).toEqual([['success', 'Transfer started; the bot reports progress in its own Fleet view']]);
  });
});
