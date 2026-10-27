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
const fns = (...names: string[]) => names.filter((n) => pageHtml.includes(`function ${n}(`));

const applyBound = async (answer: Record<string, unknown>): Promise<string[][]> => {
  const messages: string[][] = [];
  const ctx = vm.createContext({
    showMessage: (t: string, m: string) => messages.push([t, m]),
    api: async (method: string) => method === 'GET'
      ? { replication: { enabled: true, publicHost: 'primary.invalid', hostPort: 15432 } }
      : answer,
    renderFleetReplication: () => {}, showNoAnswer: () => {},
  });
  vm.runInContext(fns('fleetReplEnableNotes', 'applyFleetReplBound').map(pageFunction).join('\n'), ctx);
  await ctx.applyFleetReplBound('b1');
  return messages;
};

describe('the WAL bound toast reports what its Enable changed', () => {
  it('names a new certificate and the copy block standbys need', async () => {
    const [[kind, text]] = await applyBound({ success: true, restartRequired: true, certRotated: true });
    expect(kind).toBe('success');
    expect(text).toMatch(/WAL retention bound applied/);
    expect(text).toMatch(/new server certificate was installed: existing standbys must be set up again with the new copy block/);
  });

  it('says which addresses the database keeps admitting without TLS, claiming no live connection', async () => {
    const [[, text]] = await applyBound({ success: true, restartRequired: true, certRotated: false, plainClientsKept: 1 });
    expect(text).toMatch(/database keeps admitting connections without TLS from 1 address\(es\) outside 172\.16\.0\.0\/12 that the bot may still use on its old URL, until a start finds none of them connected that way/);
    expect(text).not.toMatch(/is still connected/);
    expect(text).not.toMatch(/certificate/);
  });

  it('claims nothing more when the certificate was kept and no client was kept', async () => {
    const [[kind, text]] = await applyBound({ success: true, restartRequired: true, certRotated: false });
    expect(kind).toBe('success');
    expect(text).toBe('WAL retention bound applied (4096 MB). It takes effect immediately; wal_log_hints applies on the next restart.');
  });
});
