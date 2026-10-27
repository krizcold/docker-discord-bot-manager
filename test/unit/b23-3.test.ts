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
const helpers = ['escapeHtml', 'seedPurposeText', 'seedWarningHtml']
  .concat(optional(['replicaPromotable', 'replicaTransferHtml', 'replicaConsentHtml', 'replicaPromiseText', 'panelHasEntry', 'copyDumpHtml']));

const record = { primaryHost: 'p.example', primaryPort: 15432, publicHost: 'h.example', hostPort: 15433 };
const liveCopy = { running: true, inRecovery: true, receiverStatus: 'streaming', caughtUp: true };

function page(fn: string, answers: any[], inputs: any[] = []) {
  const body: any = { isConnected: true, innerHTML: '', querySelectorAll: () => inputs };
  const timers: (() => void)[] = [];
  let reads = 0;
  const ctx = vm.createContext({
    document: {
      activeElement: null,
      getElementById: (id: string) => id === 'fleet-replica-body' || id === 'fleet-replication-body' ? body : null,
      createElement: () => { const el: any = { textContent: '' }; Object.defineProperty(el, 'innerHTML', { get: () => String(el.textContent).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') }); return el; },
    },
    setTimeout: (f: () => void) => { timers.push(f); return 0; },
    bots: [{ id: 'b1', status: 'running', appHooks: false }],
    fleetBackupBotId: 'b1',
    replicaPollSeq: 0,
    jsArg: (v: unknown) => JSON.stringify(v),
    api: async () => answers[Math.min(reads++, answers.length - 1)],
  });
  vm.runInContext(helpers.map(pageFunction).join('\n') + '\n' + pageFunction(fn), ctx);
  return { ctx, body, timers, reads: () => reads };
}

const enabled = { enabled: true, publicHost: 'h', hostPort: 15432, live: null };

describe('the replication panel re-reads while replication is enabled', () => {
  it('does not redraw over text the operator is typing, and keeps polling', async () => {
    const typed = { type: 'password', tagName: 'INPUT', value: 'postgresql://x', defaultValue: '' };
    const p = page('renderFleetReplication', [{ success: true, replication: enabled }], [typed]);
    await p.ctx.renderFleetReplication('b1');
    p.timers[0]();
    await new Promise((r) => setImmediate(r));
    expect(p.reads()).toBe(1);
    expect(p.timers.length).toBe(2);
  });
});

describe('the replica panel re-reads while a record is shown', () => {
  it('shows a re-seed that starts on a shown record', async () => {
    const p = page('renderFleetReplica', [
      { success: true, replica: { present: true, record, live: liveCopy } },
      { success: true, replica: { present: true, record, provisioning: { purpose: 'reseed-standby', phase: 'copy', forSeconds: 3, cancelable: true } } },
    ]);
    await p.ctx.renderFleetReplica('b1');
    expect(p.timers.length).toBe(1);
    p.timers[0]();
    await new Promise((r) => setImmediate(r));
    expect(p.body.innerHTML).toContain('Cancel</button>');
  });
});
