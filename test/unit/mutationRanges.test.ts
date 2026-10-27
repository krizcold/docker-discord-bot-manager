import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import { createRequire } from 'module';
import os from 'os';
import path from 'path';
import ts from 'typescript';
import { pathToFileURL } from 'url';
import { describe, expect, it, onTestFinished } from 'vitest';
import { canonicalName } from '../mutation/keys.mjs';
import { PACKAGE_LOCKS, treeChanges, treePrint } from '../mutation/tree.mjs';

// ranges.mjs loads Stryker's own minimatch, and the widening is held to Stryker's instrumenter, so these rows skip
// where test/'s packages lack Stryker (a test/node_modules linked to another checkout's install); linux_mgr.sh's
// container installs them from the lockfile and runs every row.
const stryker = fs.existsSync(path.join(__dirname, '..', 'node_modules', '@stryker-mutator', 'core', 'package.json'));
type Ranges = typeof import('../mutation/ranges.mjs');
const {
  changeTarget, codeLines, commonLines, gates, gatesIn, inPattern, lineDiff, linesOfTarget, mergeRanges, mutatePatterns, notMutated, parseNameStatus,
  planChange, planFromGit, unmatchedPatterns, untouched, wholeTarget, structureLines, GLOB_NAME_WHY, beyondTree, checkerDiffers, rootGlobFree, rootRelatable,
  sandboxPatterns, strykerTakes, tokenLines, treeTsconfig, NO_CODE_WHY, linkOf, ownNames, mutatedName,
}: Ranges = stryker ? await import('../mutation/ranges.mjs') : ({} as Ranges);
type Instrumenting = typeof import('@stryker-mutator/instrumenter');
const { Instrumenter }: Instrumenting = stryker ? await import('@stryker-mutator/instrumenter') : ({} as Instrumenting);

// Small arrays drawn from a fixed seed (mulberry32), so a failing row draws the same inputs on every run.
function draws(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (max: number) => Math.floor(next() * (max + 1));
  const array = (from: string[], min: number, max: number) => Array.from({ length: min + int(max - min) }, () => from[int(from.length - 1)]);
  return { int, array };
}

// The touched-line ranges of the L5 gate (mutation/README.md): which lines a
// change touched, and how far each widens so that Stryker makes the mutants
// that touch it.

const SAMPLE = [
  'export function f(a: number, b: number) {', // 1
  '  if (a > 0 &&', // 2
  '      b > 0) {', // 3
  '    return a + b;', // 4
  '  }', // 5
  '  const table = {', // 6
  '    x: 1,', // 7
  '    y: () => 2,', // 8
  '  };', // 9
  '  return table.x;', // 10
  '}', // 11
].join('\n');

// Shapes where a changed expression holds a block-bodied callback, and the
// usual statements around them.
const SHAPES: Record<string, string> = {
  sample: SAMPLE,
  returnCompare: [
    'export function f(items: { ok: boolean }[]) {',
    '  return items.filter(i => {',
    '    return i.ok;',
    '  }).length > 0;',
    '}',
  ].join('\n'),
  conditionWithCallback: [
    'export function g(enabled: boolean, items: { ok: boolean }[]) {',
    '  if (enabled || items.some(i => {',
    '    return i.ok;',
    '  })) {',
    '    return 1;',
    '  } else if (items.length > 2) {',
    '    return 2;',
    '  }',
    '  return 0;',
    '}',
  ].join('\n'),
  chainAfterCallback: [
    'export function h(nodes: { up: boolean, ok: boolean }[]) {',
    '  const active = nodes',
    '    .filter(n => {',
    '      return n.up;',
    '    })',
    '    .every(n => n.ok);',
    '  return active;',
    '}',
  ].join('\n'),
  classLoopSwitch: [
    'export class Counter {',
    '  private count = 0;',
    '  bump(by: number): number {',
    '    for (let i = 0; i < by; i++) {',
    '      this.count += i % 2 === 0 ? 1 : 2;',
    '    }',
    '    switch (this.count) {',
    '      case 0:',
    '        return -1;',
    '      default:',
    '        return this.count > 10 ? 10 : this.count;',
    '    }',
    '  }',
    '}',
  ].join('\n'),
  callbacks: [
    'export const routes: Record<string, (x: number) => number> = {',
    '  double: x => {',
    '    const y = x * 2;',
    '    return y + 1;',
    '  },',
    '  half: x => x / 2,',
    '};',
    'export const total = [1, 2, 3].reduce((sum, n) => {',
    '  return sum + n;',
    '}, 0);',
  ].join('\n'),
  forNoCondition: [
    'export function retry(work: () => boolean): number {',
    '  for (let attempt = 0; ; attempt++) {',
    '    if (work()) return attempt;',
    '  }',
    '}',
  ].join('\n'),
  // On one line, the loop's false condition lies on the line, so it is made.
  forNoConditionOneLine: [
    'export async function poll(ready: () => Promise<boolean>): Promise<void> {',
    '  for (;;) if (await ready()) return;',
    '}',
  ].join('\n'),
  tryCatch: [
    'export async function load(read: () => Promise<string>): Promise<string | null> {',
    '  try {',
    '    const text = await read();',
    "    return text.trim() === '' ? null : text;",
    '  } catch (error) {',
    "    return error instanceof Error && error.message.includes('ENOENT') ? null : 'bad';",
    '  }',
    '}',
  ].join('\n'),
  // Clauses with no braces whose statements open bodies of their own: each line widens within the clause.
  bracelessClauses: [
    'export async function step(n: number, ready: () => Promise<boolean>, log: string[]): Promise<number> {',
    '  switch (n) {',
    '    case 1:',
    '      if (n > 0) {',
    "        log.push('one');",
    '      }',
    '      return 1;',
    "    case 2: log.push('two');",
    '      try {',
    "        log.push('again');",
    '      } catch {',
    '        return -2;',
    '      }',
    '      return 2;',
    '    default:',
    '      for (let i = 0; ; i++) {',
    '        if (await ready()) return i;',
    '      }',
    '  }',
    '}',
  ].join('\n'),
  // A clause whose one statement starts on its label line: any of its lines takes the whole clause.
  clauseFromItsLabel: [
    'export function tag(n: number, log: string[]): number {',
    '  switch (n) {',
    '    case 1: return log.push(',
    "      'one');",
    "    case 2: log.push('two');",
    '      return 2;',
    '    default:',
    '      return 0;',
    '  }',
    '}',
  ].join('\n'),
  clauseBlocksAndMethods: [
    'export function pick(n: number, log: string[]): number {',
    '  switch (n) {',
    '    case 1: {',
    "      log.push('one');",
    '      break;',
    '    }',
    '    default: {',
    "      log.push('other');",
    '    }',
    '  }',
    '  const handlers = {',
    '    run(x: number) {',
    '      return x + 1;',
    '    },',
    '    get size() {',
    '      return log.length;',
    '    },',
    '  };',
    '  const K = class {',
    '    twice(x: number) {',
    '      return x * 2;',
    '    }',
    '  };',
    '  return handlers.run(new K().twice(n)) + handlers.size;',
    '}',
  ].join('\n'),
};

const rangesOf = (text: string, lines: number[]) => changeTarget('src/a.ts', text, { changed: lines, deletedAfter: [] })?.ranges;

const managerRoot = path.resolve(__dirname, '..', '..');

describe.runIf(stryker)('the change', () => {
  // A longest common subsequence's length the slow way, to hold commonLines to.
  const lcsLength = (a: string[], b: string[]) => {
    const row = new Array<number>(b.length + 1).fill(0);
    for (const x of a) {
      let diagonal = 0;
      for (let j = 1; j <= b.length; j++) {
        const above = row[j];
        row[j] = x === b[j - 1] ? diagonal + 1 : Math.max(row[j], row[j - 1]);
        diagonal = above;
      }
    }
    return row[b.length];
  };

  it('keeps as many lines as any common subsequence can, each pair equal and in order', () => {
    const draw = draws(20261027);
    const from = ['a', 'b', 'c', '}', ''];
    for (let n = 0; n < 3000; n++) {
      const [a, b] = [draw.array(from, 0, 14), draw.array(from, 0, 14)];
      const pairs = commonLines(a, b);
      pairs.forEach(([i, j], k) => {
        expect(a[i], JSON.stringify([a, b])).toBe(b[j]);
        if (k > 0) expect(i > pairs[k - 1][0] && j > pairs[k - 1][1], JSON.stringify([a, b])).toBe(true);
      });
      expect(pairs.length, JSON.stringify([a, b])).toBe(lcsLength(a, b));
    }
  });

  it('names the lines added or changed, and where lines were taken out with fewer or none put back', () => {
    const before = ['a', 'b', 'c', 'd', 'e'].join('\n');
    expect(lineDiff(before, ['a', 'B', 'c', 'd', 'e'].join('\n'))).toEqual({ changed: [2], deletedAfter: [] });
    expect(lineDiff(before, ['a', 'b', 'd', 'e'].join('\n'))).toEqual({ changed: [], deletedAfter: [2] });
    expect(lineDiff(before, ['b', 'c', 'd', 'e'].join('\n'))).toEqual({ changed: [], deletedAfter: [0] });
    // A line taken out beside an edited one, and a block taken away with its body re-indented.
    expect(lineDiff(before, ['a', 'B', 'd', 'e'].join('\n'))).toEqual({ changed: [2], deletedAfter: [1] });
    const guarded = ['export function f(ok: boolean) {', '  if (!ok) {', '    a();', '    b();', '  }', '}'].join('\n');
    expect(lineDiff(guarded, ['export function f(ok: boolean) {', '  a();', '  b();', '}'].join('\n'))).toEqual({ changed: [2, 3], deletedAfter: [1] });
    expect(lineDiff(before, ['a', 'b', 'c', 'd', 'e', 'f'].join('\n'))).toEqual({ changed: [6], deletedAfter: [] });
    // Line endings alone change nothing, nor does the break after the last line.
    expect(lineDiff(`${before}\n`, before.split('\n').join('\r\n'))).toEqual({ changed: [], deletedAfter: [] });
  });

  it('counts lines of code taken out: one made a comment or a blank line is, a comment or a blank line is not', () => {
    const before = ['a();', 'b();', 'c();'].join('\n');
    expect(lineDiff(before, ['a();', '// b();', 'c();'].join('\n'))).toEqual({ changed: [2], deletedAfter: [1] });
    expect(lineDiff(before, ['a();', '', 'c();'].join('\n'))).toEqual({ changed: [2], deletedAfter: [1] });
    expect(lineDiff(before, ['a();', 'B();', 'c();'].join('\n'))).toEqual({ changed: [2], deletedAfter: [] });
    const noted = ['a();', '// one', '', 'c();'].join('\n');
    expect(lineDiff(noted, ['a();', '// two', 'c();'].join('\n'))).toEqual({ changed: [2], deletedAfter: [] });
    expect(lineDiff(noted, ['a();', 'c();'].join('\n'))).toEqual({ changed: [], deletedAfter: [] });
    // Counted on the diff's own lines: a lone CR in the base ends none, so b() is on its line 2 there.
    const crossed = ['a();', '/* \r */ b();', 'c();'].join('\n');
    expect(lineDiff(crossed, ['a();', '/* \r */ // b();', 'c();'].join('\n'))).toEqual({ changed: [2], deletedAfter: [1] });
  });

  it('counts an unchanged line whose code a change on another line switched, in part too: changed, and taken out when it lost tokens', () => {
    // A comment that ran into the line ends earlier now: a(x > 0) is code again, b() was code all along.
    const opened = ['f();', '  /* off while the flag is out', '  a(x > 0); /* see the flag */ b();', 'g();'].join('\n');
    const closed = ['f();', '  // off while the flag is out', '  a(x > 0); /* see the flag */ b();', 'g();'].join('\n');
    expect(lineDiff(opened, closed)).toEqual({ changed: [2, 3], deletedAfter: [] });
    expect(lineDiff(closed, opened)).toEqual({ changed: [2, 3], deletedAfter: [2] });
    // A comment opened on a line of code hides the next line whole and stops at a comment on the one after.
    expect(lineDiff(["log('start');", 'a();', '/* x */ b();'].join('\n'), ["log('start'); /*", 'a();', '/* x */ b();'].join('\n')))
      .toEqual({ changed: [1], deletedAfter: [1] });
    // Template text made code by a backtick moved elsewhere, a line of one token made another of one token too.
    expect(lineDiff(['const s = `', 'f(admin);', '`;'].join('\n'), ['const s = ``;', 'f(admin);', 'const t = 1;'].join('\n')))
      .toEqual({ changed: [1, 2, 3], deletedAfter: [] });
    expect(lineDiff(['const s = `', '}', '`;'].join('\n'), ['function f() {', '}', 'const s = ``;'].join('\n')))
      .toEqual({ changed: [1, 2, 3], deletedAfter: [] });
    // The same kinds in another order: the backtick moved from after a > b to before it.
    expect(lineDiff(['a > b;; `; a > b;', '`;'].join('\n'), ['x = `', 'a > b;; `; a > b;', 'y();'].join('\n')))
      .toEqual({ changed: [1, 2, 3], deletedAfter: [] });
    // A substitution added to one line of a template leaves the code of its other lines as it was.
    expect(lineDiff(['const t = `one', 'two', 'three`;'].join('\n'), ['const t = `one', 'two ${x}', 'three`;'].join('\n')))
      .toEqual({ changed: [2], deletedAfter: [] });
    // Line endings alone change no line's code, a template's lines included.
    expect(lineDiff(['const t = `one', 'two', 'three`;'].join('\n'), ['const t = `one', 'two', 'three`;'].join('\r\n')))
      .toEqual({ changed: [], deletedAfter: [] });
    const plan = planChange({ entries: [{ status: 'M', file: 'src/a.ts' }], untracked: [], read: () => closed, readBase: () => opened, nameOf: file => file });
    expect(plan.skipped).toEqual([]);
    expect(plan.targets).toMatchObject([{ file: 'src/a.ts', gating: [3] }]);
  });

  it('counts an unchanged line a comment opened or closed elsewhere switched: on, as changed; off, as code taken out', () => {
    const hidden = ['a();', '/*', 'b();', '*/', 'n > 10;'].join('\n');
    // The comment taken away brings b() back, alone or beside an edit.
    expect(lineDiff(hidden, ['a();', 'b();', 'n > 10;'].join('\n'))).toEqual({ changed: [2], deletedAfter: [] });
    expect(lineDiff(hidden, ['a();', 'b();', 'n > 20;'].join('\n'))).toEqual({ changed: [2, 3], deletedAfter: [] });
    // A comment put around b() takes it out there, alone or beside an edit.
    const live = ['a();', 'b();', 'c();'].join('\n');
    expect(lineDiff(live, ['a();', '/*', 'b();', '*/', 'c();'].join('\n'))).toEqual({ changed: [2, 4], deletedAfter: [2] });
    expect(lineDiff(live, ['a();', '/*', 'b();', '*/', 'C();'].join('\n'))).toEqual({ changed: [2, 4, 5], deletedAfter: [2] });
    // Around a comment only, nothing is switched.
    expect(lineDiff(['a();', '// note', 'c();'].join('\n'), ['a();', '/*', '// note', '*/', 'c();'].join('\n'))).toEqual({ changed: [2, 4], deletedAfter: [] });
  });

  it('finds the few lines that changed in a long file, and copes with two that share nothing', () => {
    const long = Array.from({ length: 3000 }, (_, i) => `line ${i}`);
    const edited = long.map((line, i) => (i === 10 || i === 2000 ? `${line} edited` : line));
    edited.splice(1500, 0, 'inserted');
    expect(lineDiff(long.join('\n'), edited.join('\n'))).toEqual({ changed: [11, 1501, 2002], deletedAfter: [] });
    const other = Array.from({ length: 3000 }, (_, i) => `other ${i}`);
    expect(lineDiff(long.join('\n'), other.join('\n')).changed).toHaveLength(3000);
  });

  it('counts a run that could sit in more than one place in every place it could sit', () => {
    // An if block added after an equal one: either copy could be the new one.
    const block = ['  if (ready) {', '    count++;', '  }', ''];
    const before = ['export function f(ready: boolean) {', '  let count = 0;', ...block, '  return count;', '}'].join('\n');
    const after = ['export function f(ready: boolean) {', '  let count = 0;', ...block, ...block, '  return count;', '}'].join('\n');
    expect(lineDiff(before, after).changed).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
    // A repeated line taken out could have been any of its copies.
    expect(lineDiff(['a', 'x', 'x', 'x', 'b'].join('\n'), ['a', 'x', 'x', 'b'].join('\n'))).toEqual({ changed: [], deletedAfter: [1, 2, 3] });
    // A head of the run where another placement of it would sit: `a(); c();` of the run at 7-10 slides over line 6.
    const body = ['b();', 'k();', 'c();', 'c();', 'c();', 'a();'];
    const fn = (lines: string[]) => ['export function f() {', ...lines.map(line => `  ${line}`), '}'].join('\n');
    expect(lineDiff(fn(body), fn([...body.slice(0, 5), 'a();', 'c();', 'b();', 'a();', ...body.slice(5)])).changed).toContain(6);
    // And for lines taken out: `c(); b();` taken from b b c b x x could have sat after line 0 too.
    expect(lineDiff(['b', 'b', 'c', 'b', 'x', 'x'].join('\n'), ['b', 'b', 'x', 'x'].join('\n')).deletedAfter).toContain(0);
  });

  it('counts every place a run added or taken out in one place could sit', () => {
    // Small texts over three lines: wherever the one text reads as the other with a run of as many lines added (or
    // taken out) in one place, those lines are counted (or that place named). It can count more: a line beside the
    // run that repeats one of its lines, though no shortest diff changes it (a b gaining b a counts the first a).
    const same = (x: string[], y: string[]) => x.join('\n') === y.join('\n');
    const draw = draws(20261028);
    for (let n = 0; n < 500; n++) {
      const [a, at, added] = [draw.array(['a', 'b', 'c'], 0, 6), draw.int(6), draw.array(['a', 'b', 'c'], 1, 4)];
      const place = Math.min(at, a.length);
      const b = [...a.slice(0, place), ...added, ...a.slice(place)];
      const { changed, deletedAfter } = lineDiff(a.join('\n'), b.join('\n'));
      const r = added.length;
      for (let p = 0; p <= a.length; p++) {
        if (!same(b.slice(0, p), a.slice(0, p)) || !same(b.slice(p + r), a.slice(p))) continue;
        for (let k = 0; k < r; k++) expect(changed).toContain(p + k + 1);
      }
      // The same change the other way: b's lines taken out leave a.
      const back = lineDiff(b.join('\n'), a.join('\n')).deletedAfter;
      for (let q = 0; q <= a.length; q++) {
        if (!same(b.slice(0, q), a.slice(0, q)) || !same(b.slice(q + r), a.slice(q))) continue;
        expect(back).toContain(q);
      }
      expect(back.every(place => place >= 0)).toBe(true);
      expect(deletedAfter).toEqual([]);
    }
  });

  it('never names a place above the top for code taken out, where the walk up passes a line it does not keep', () => {
    expect(lineDiff(['p', 'q', 'p', 'q', 'p', 's'].join('\n'), ['q', 's'].join('\n')).deletedAfter).toEqual([0, 1]);
    expect(lineDiff(['p', 'q', 'r', 'p', 'q', 'r', 'p', 's'].join('\n'), ['q', 'r', 's'].join('\n')).deletedAfter).toEqual([0, 1, 2]);
  });

  it("reads git's names, a rename's two included", () => {
    expect(parseNameStatus(['M', 'src/a.ts', 'R096', 'updaters/u.ts', 'src/u.ts', 'D', 'src/odd name.ts', 'A', 'src/quote"d.ts', ''].join('\0'))).toEqual([
      { status: 'M', file: 'src/a.ts' },
      { status: 'R', from: 'updaters/u.ts', file: 'src/u.ts' },
      { status: 'D', file: 'src/odd name.ts' },
      { status: 'A', file: 'src/quote"d.ts' },
    ]);
  });

  /** A throwaway repo, and the gate's plan of what changed in it from its first commit. */
  function repoWith(files: Record<string, string | Buffer>) {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'smdb-change-'));
    onTestFinished(() => fs.rmSync(repo, { recursive: true, force: true }));
    const git = (args: string[], env: NodeJS.ProcessEnv = {}) =>
      execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
    const write = (file: string, text: string | Buffer) => {
      fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
      fs.writeFileSync(path.join(repo, file), text);
    };
    git(['init', '-q']);
    // A user's core.safecrlf would make a test's own git add fatal where it converts line endings.
    git(['config', 'core.safecrlf', 'false']);
    for (const [file, text] of Object.entries(files)) write(file, text);
    git(['add', '.']);
    git(['commit', '-q', '-m', 'base']);
    const base = git(['rev-parse', 'HEAD']).trim();
    const plan = (config: string[] = [], env: NodeJS.ProcessEnv = {}) => planFromGit({ git: (...args: string[]) => git([...config, ...args], env), base, root: repo });
    return { repo, git, write, plan };
  }
  const lines = (name: string, n: number) => Array.from({ length: n }, (_, i) => `export const ${name}${i} = ${i};`);
  const text = (list: string[]) => `${list.join('\n')}\n`;

  it('finds the same targets whatever git setting, attribute or variable the user has', () => {
    const fn = (name: string, arg: string) => [`export function ${name}(${arg}: number) {`, `  if (${arg} > 0) {`, '    return 1;', '  }', '  return 0;', '}', ''];
    const block = ['  if (ready) {', '    count++;', '  }', ''];
    const dup = (blocks: number) => text(['export function f(ready: boolean) {', '  let count = 0;', ...Array.from({ length: blocks }, () => block).flat(), '  return count;', '}']);
    const nul = String.fromCharCode(0);
    const { repo, git, write, plan } = repoWith({
      'src/a.ts': text(lines('a', 30)),
      'src/m.ts': [...fn('f', 'a'), ...fn('g', 'b')].join('\n'),
      'src/bin.ts': text(lines('bin', 10)),
      'src/zerobyte.ts': text([`export const z = '${nul}';`, ...lines('zero', 5)]),
      'src/old.ts': text(lines('old', 20)),
      'src/x.ts': text(lines('x', 20)),
      'src/gone.ts': '// gone\n',
      'src/dup.ts': dup(1),
      'src/case.ts': text(lines('kase', 5)),
      'src/case (1).ts': text(lines('kaseOne', 5)),
      'updaters/u.ts': text(lines('u', 30)),
      'safety-check.js': 'module.exports = 1;\n',
      'readmeAssets/img.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]),
    });
    write('src/a.ts', text(lines('a', 30).map((line, i) => (i === 2 || i === 5 ? line.replace('= ', '= 100 + ') : line))));
    write('src/m.ts', [...fn('g', 'b'), ...fn('f', 'a')].join('\n'));
    write('src/bin.ts', text(lines('bin', 10).map((line, i) => (i === 1 ? `${line} // edited` : line))));
    write('src/zerobyte.ts', text([`export const z = '${nul}';`, ...lines('zero', 5).map((line, i) => (i === 1 ? `${line} // edited` : line))]));
    git(['mv', 'src/old.ts', 'src/new.ts']);
    write('src/new.ts', text(lines('old', 20).map((line, i) => (i === 4 ? `${line} // edited` : line))));
    fs.mkdirSync(path.join(repo, 'tools'));
    git(['mv', 'src/x.ts', 'tools/x.ts']);
    fs.rmSync(path.join(repo, 'src', 'gone.ts'));
    write('src/dup.ts', dup(2));
    git(['mv', 'updaters/u.ts', 'src/u.ts']);
    write('src/u.ts', text(lines('u', 30).map((line, i) => (i === 1 ? `${line} // edited` : line))));
    write('safety-check.js', 'module.exports = 2;\n');
    write('readmeAssets/img.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 9, 9, 9]));
    write('src/fresh.ts', text(lines('fresh', 3)));
    write('src/mod/index.ts', text(lines('mod', 3)));
    git(['-C', path.join(repo, 'src', 'mod'), 'init', '-q']);
    // A file renamed by case outside git, where the disk does not tell case apart.
    if (process.platform === 'win32') {
      fs.renameSync(path.join(repo, 'src', 'case.ts'), path.join(repo, 'src', 'Case.ts'));
      write('src/Case.ts', text(lines('kase', 5).map((line, i) => (i === 0 ? `${line} // edited` : line))));
      // A name with characters a glob reads, but Stryker reads as themselves, is taken on disk the same way.
      fs.renameSync(path.join(repo, 'src', 'case (1).ts'), path.join(repo, 'src', 'Case (1).ts'));
      write('src/Case (1).ts', text(lines('kaseOne', 5).map((line, i) => (i === 0 ? `${line} // edited` : line))));
    }

    const attributes = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'smdb-attributes-')), 'attributes');
    onTestFinished(() => fs.rmSync(path.dirname(attributes), { recursive: true, force: true }));
    fs.writeFileSync(attributes, '*.ts binary\n*.ts -diff\n');
    const hostile = [
      '-c', 'diff.algorithm=histogram', '-c', 'diff.indentHeuristic=false', '-c', 'diff.renameLimit=1', '-c', 'diff.renames=false',
      '-c', 'diff.noprefix=true', '-c', 'diff.mnemonicPrefix=true', '-c', 'diff.relative=true', '-c', 'diff.context=5', '-c', 'diff.interHunkContext=20',
      '-c', 'core.quotePath=true', '-c', 'core.bigFileThreshold=16', '-c', `core.attributesFile=${attributes}`,
    ];
    const plain = plan();
    expect(plan(hostile, { GIT_DIFF_OPTS: '--unified=3' })).toEqual(plain);

    const target = (file: string) => plain.targets.find(t => t.file === file);
    expect(target('src/a.ts')?.gating).toEqual([3, 6]);
    expect(target('src/bin.ts')?.gating).toEqual([2]);
    expect(target('src/zerobyte.ts')?.gating).toEqual([3]);
    // Renamed within src: only its changed line. Moved in from outside src, new, untracked: whole.
    expect(target('src/new.ts')?.gating).toEqual([5]);
    for (const file of ['src/u.ts', 'src/fresh.ts']) expect(target(file), file).toEqual(wholeTarget(file));
    // The copy added could be either one: both gate (their blank lines hold no code, so they gate nothing).
    expect(target('src/dup.ts')?.gating).toEqual([3, 4, 5, 7, 8, 9]);
    expect(target('src/m.ts')?.gating?.length).toBeGreaterThan(0);
    if (process.platform === 'win32') expect(target('src/Case.ts')?.gating).toEqual([1]);
    if (process.platform === 'win32') expect(target('src/Case (1).ts')?.gating).toEqual([1]);
    expect(plain.skipped).toEqual(expect.arrayContaining([
      { file: 'tools/x.ts', why: 'outside src' },
      { file: 'src/x.ts', why: 'moved to tools/x.ts: nothing is left to mutate' },
      { file: 'src/gone.ts', why: 'deleted: nothing is left to mutate' },
      { file: 'safety-check.js', why: 'outside src' },
      { file: 'readmeAssets/img.png', why: 'outside src' },
      { file: 'src/mod/', why: 'an untracked git repository: git lists none of its files, so none is mutated' },
    ]));
    expect(plain.skipped.map(s => s.file)).not.toContain('src/u.ts');
    expect(plain.emptyScope).toBe(false);
  });

  it('says no src file changed only when none did: a deletion or a move out of src is a change', () => {
    const one = repoWith({ 'src/a.ts': text(lines('a', 3)), 'tools/t.js': 'module.exports = 1;\n' });
    one.write('tools/t.js', 'module.exports = 2;\n');
    expect(one.plan()).toEqual({ targets: [], skipped: [{ file: 'tools/t.js', why: 'outside src' }], emptyScope: true });
    fs.rmSync(path.join(one.repo, 'src', 'a.ts'));
    expect(one.plan().emptyScope).toBe(false);
    const two = repoWith({ 'src/x.ts': text(lines('x', 3)) });
    fs.mkdirSync(path.join(two.repo, 'tools'));
    two.git(['mv', 'src/x.ts', 'tools/x.ts']);
    expect(two.plan().emptyScope).toBe(false);
  });

  it('diffs a file only taken out of the index that git pairs with a near copy staged as a rename, and keeps the rename', () => {
    const { git, write, plan } = repoWith({ 'src/a.ts': text(lines('a', 20)) });
    write('src/b.ts', text(lines('a', 20).map((line, i) => (i === 3 ? line.replace('= ', '= 100 + ') : line))));
    git(['add', 'src/b.ts']);
    git(['rm', '--cached', '-q', 'src/a.ts']);
    const { targets, skipped } = plan();
    expect(targets.map(t => [t.file, t.gating])).toEqual([['src/b.ts', [4]]]);
    expect(skipped).toEqual([{ file: 'src/a.ts', why: NO_CODE_WHY }]);
  });
  it('counts a copy beside an edited line, and a repeated head or tail of the lines added, in every place it could sit', () => {
    const block = ['  if (queue.length > 0) {', '    handle(queue.shift());', '  }'];
    const drain = (first: string, blocks: number) =>
      ['export function drain(queue: number[], note: string) {', first, ...Array.from({ length: blocks }, () => block).flat(), '}'].join('\n');
    // The line before the blocks is edited too: both copies count.
    expect(lineDiff(drain('  console.log(note);', 1), drain('  console.log(`drain ${note}`);', 2)).changed).toEqual([2, 3, 4, 5, 6, 7, 8]);
    expect(lineDiff(['start();', 'bar();', 'end();'].join('\n'), ['start();', 'foo();', 'bar();', 'bar();', 'end();'].join('\n')).changed).toEqual([2, 3, 4]);
    expect(lineDiff(['start();', 'end();'].join('\n'), ['start();', 'start();', 'foo();', 'end();'].join('\n')).changed).toEqual([1, 2, 3]);
  });

  it('counts only the lines the diff changes, and names a changed line that can move the lines beside it', () => {
    const into = [
      'export function settle(ready: boolean, log: string[], lease: { release(): void }) {',
      '  if (ready) {',
      "    log.push('ready');",
      '  }',
      '  lease.release();',
      "  log.push('done');",
      '}',
    ];
    // The bracket moved below release(): release() now runs only when ready, and only the bracket line changed.
    const moved = [into[0], into[1], into[2], into[4], into[3], into[5], into[6]].join('\n');
    const { changed } = lineDiff(into.join('\n'), moved);
    expect(changed).toEqual([5]);
    expect(structureLines('src/a.ts', moved, changed)).toEqual([5]);
    // A closer with code of its own moved below report(): report() now runs in the loop, and only the closer changed.
    const loop = ['export function drain(q: { v: boolean }, report: () => void) {', '  do {', '    q.v = false;', '  } while (q.v);', '  report();', '}'];
    const down = [loop[0], loop[1], loop[2], loop[4], loop[3], loop[5]].join('\n');
    expect(lineDiff(loop.join('\n'), down).changed).toEqual([5]);
    expect(structureLines('src/a.ts', down, [5])).toEqual([5]);
    const lines = [
      'export function k(on: (f: () => void, g: () => void) => void, q: { v: boolean }, log: string[]) {', // 1
      '  on(() => {', // 2
      "    log.push('a');", // 3
      '  }, () => {', // 4
      '  });', // 5
      '  do {', // 6
      "    log.push('b');", // 7
      '  } while (q.v);', // 8
      '  Promise.resolve().then(() => {', // 9
      '  }).catch(e => log.push(String(e)));', // 10
      '  const o = {', // 11
      '    x: 1,', // 12
      '  };', // 13
      '  log.push(String(o.x),', // 14
      '  );', // 15
      '}', // 16
    ];
    // Brackets and separators only, or a brace of a block, code of its own or not (a header, a closer with a
    // condition or a call): not an object's brace or a line of code alone.
    expect(structureLines('src/a.ts', lines.join('\n'), lines.map((_, i) => i + 1))).toEqual([1, 2, 4, 5, 6, 8, 9, 10, 13, 15, 16]);
    // A line that opens the next part of a statement, with braces or none, mutants of its own or not: a default
    // only in a switch, never in an export or an object.
    const parts = [
      'export function p(n: string, b: boolean, log: string[]) {', // 1
      "  if (b) log.push('b');", // 2
      "  else log.push('c');", // 3
      '  switch (n) {', // 4
      "    case 'two': log.push('2'); break;", // 5
      "    default: log.push('d');", // 6
      '  }', // 7
      '  const d = { default: 1 };', // 8
      '  return d;', // 9
      '}', // 10
      'export default p;', // 11
    ];
    expect(structureLines('src/a.ts', parts.join('\n'), parts.map((_, i) => i + 1))).toEqual([1, 3, 4, 5, 6, 7, 10]);
  });

  it('names a submodule, and a file whose name Stryker would read as a glob, with the reason', () => {
    const plan = planChange({
      entries: [{ status: 'M', file: 'src/sub' }, { status: 'M', file: 'src/[id].ts' }],
      untracked: ['src/a{1,2}.ts'],
      read: () => 'export const x = 1;\n',
      readBase: () => '',
      nameOf: file => (/[[{]/.test(file) ? null : file),
      isDir: file => file === 'src/sub',
    });
    expect(plan.targets).toEqual([]);
    expect(plan.skipped).toEqual([
      { file: 'src/sub', why: 'a git submodule: git names only its commit, so none of its files is mutated' },
      { file: 'src/[id].ts', why: GLOB_NAME_WHY },
      { file: 'src/a{1,2}.ts', why: GLOB_NAME_WHY },
    ]);
  });

  it("gives pass A's type checker the tree's files only, never one git ignores that the root's tsconfig includes", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smdb-checker-'));
    onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
    const put = (file: string, text: string) => {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), text);
    };
    put('tsconfig.json', JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ['src'] }));
    put('src/api.ts', 'export const DEFAULTS = { retries: 3 };\n');
    // A module cloned into a dir git ignores: it reads the API, and holds an error of its own.
    put('src/modulesDev/m.ts', "import { DEFAULTS } from '../api';\nexport const n: number = DEFAULTS.retries;\nexport const s: number = 'stale';\n");
    const config = treeTsconfig(root, ['tsconfig.json', 'src/api.ts'], '.stryker-tmp');
    expect(config).toEqual({ extends: '../tsconfig.json', compilerOptions: { typeRoots: ['../node_modules/@types'] }, include: [], files: ['../src/api.ts'] });
    put('.stryker-tmp/tsconfig.l5.json', JSON.stringify(config));
    const errorsOf = (file: string) => {
      const { config: raw } = ts.readConfigFile(file, ts.sys.readFile);
      const parsed = ts.parseJsonConfigFileContent(raw, ts.sys, path.dirname(file), undefined, file);
      return ts.getPreEmitDiagnostics(ts.createProgram(parsed.fileNames, parsed.options)).map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
    };
    expect(errorsOf(path.join(root, 'tsconfig.json')).length).toBeGreaterThan(0);
    expect(errorsOf(path.join(root, '.stryker-tmp', 'tsconfig.l5.json'))).toEqual([]);
  });

  it("gives pass A's type checker, of the @types it takes with no import, the root's only, as the image's build does, not a dir's above the checkout", () => {
    const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'smdb-types-'));
    onTestFinished(() => fs.rmSync(outer, { recursive: true, force: true }));
    const root = path.join(outer, 'bot');
    const put = (file: string, text: string) => {
      fs.mkdirSync(path.dirname(path.join(outer, file)), { recursive: true });
      fs.writeFileSync(path.join(outer, file), text);
    };
    const configure = (typeRoots?: string[]) => put('bot/tsconfig.json', JSON.stringify({ compilerOptions: { strict: true, noEmit: true, typeRoots }, include: ['src'] }));
    put('bot/src/a.ts', 'export const fromRoot: string = OWN;\nexport const fromAbove: string = UP;\n');
    put('bot/node_modules/@types/own/index.d.ts', 'declare const OWN: string;\n');
    put('node_modules/@types/up/index.d.ts', 'declare const UP: string;\n');
    const tree = ['tsconfig.json', 'src/a.ts'];
    const errorsOf = (config: object, dir: string) => {
      const parsed = ts.parseJsonConfigFileContent(config, ts.sys, path.join(root, dir), undefined, path.join(root, dir, 'tsconfig.json'));
      return ts.getPreEmitDiagnostics(ts.createProgram(parsed.fileNames, parsed.options)).map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
    };
    const rootConfig = () => ts.readConfigFile(path.join(root, 'tsconfig.json'), ts.sys.readFile).config as object;
    configure();
    // tsc at the root takes a node_modules/@types above the checkout too; the image has none above /app.
    expect(errorsOf(rootConfig(), '.')).toEqual([]);
    expect(errorsOf(treeTsconfig(root, tree, '.stryker-tmp'), '.stryker-tmp')).toEqual(["Cannot find name 'UP'."]);
    // typeRoots the root's config sets are its own, and the image's build reads them too.
    configure(['node_modules/@types', '../node_modules/@types']);
    expect(treeTsconfig(root, tree, '.stryker-tmp')).toEqual({ extends: '../tsconfig.json', include: [], files: ['../src/a.ts'] });
    expect(errorsOf(treeTsconfig(root, tree, '.stryker-tmp'), '.stryker-tmp')).toEqual([]);
  });

  it('names a file outside the tree that a tree file imports or references, which the type checker would still judge', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smdb-beyond-'));
    onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
    const put = (file: string, text: string) => {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), text);
    };
    put('tsconfig.json', JSON.stringify({ compilerOptions: { strict: true, noEmit: true, moduleResolution: 'node' }, include: ['src'] }));
    put('src/api.ts', 'export const DEFAULTS = { retries: 3 };\n');
    put('src/modulesDev/m.ts', "import { DEFAULTS } from '../api';\nexport type N = typeof DEFAULTS.retries;\n");
    put('node_modules/pkg/index.d.ts', 'export type P = number;\n');
    const tree = ['tsconfig.json', 'src/api.ts', 'src/tree.ts'];
    const beyond = (text: string) => {
      put('src/tree.ts', text);
      return beyondTree(root, tree, treeTsconfig(root, tree, '.stryker-tmp'), '.stryker-tmp');
    };
    expect(beyond('export const x = 1;\n')).toEqual([]);
    expect(beyond("import type { P } from 'pkg';\nexport const x: P = 1;\n")).toEqual([]);
    expect(beyond("import type { N } from './modulesDev/m';\nexport const x: N = 1;\n")).toEqual(['src/modulesDev/m.ts']);
    expect(beyond('/// <reference path="./modulesDev/m.ts" />\nexport const x = 1;\n')).toEqual(['src/modulesDev/m.ts']);
  });

  it('never names a file under a node_modules dir: the root install through a link, and one above the checkout, which is not seen', () => {
    const outer = fs.mkdtempSync(path.join(os.tmpdir(), 'smdb-above-'));
    onTestFinished(() => {
      // The link first, so the removal never walks into the dir it names.
      fs.rmSync(path.join(outer, 'bot', 'node_modules'), { force: true });
      fs.rmSync(outer, { recursive: true, force: true });
    });
    const root = path.join(outer, 'bot');
    const put = (file: string, text: string) => {
      fs.mkdirSync(path.dirname(path.join(outer, file)), { recursive: true });
      fs.writeFileSync(path.join(outer, file), text);
    };
    put('bot/tsconfig.json', JSON.stringify({ compilerOptions: { strict: true, noEmit: true, moduleResolution: 'node' }, include: ['src'] }));
    // A job worktree whose root node_modules links to the main checkout's install, and a stray install above both.
    put('main/node_modules/shared/index.d.ts', 'export type S = number;\n');
    fs.symlinkSync(path.join(outer, 'main', 'node_modules'), path.join(root, 'node_modules'), 'junction');
    put('node_modules/stray/index.d.ts', 'export type T = number;\n');
    put('node_modules/@types/untyped/index.d.ts', 'export declare function f(n: number): void;\n');
    const tree = ['tsconfig.json', 'src/tree.ts'];
    const beyond = (text: string) => {
      put('bot/src/tree.ts', text);
      return beyondTree(root, tree, treeTsconfig(root, tree, '.stryker-tmp'), '.stryker-tmp');
    };
    expect(beyond("import type { S } from 'shared';\nexport const x: S = 1;\n")).toEqual([]);
    // Not seen: what the image's build never has, a package above the checkout, an untyped one's @types there included.
    expect(beyond("import type { T } from 'stray';\nexport const x: T = 1;\n")).toEqual([]);
    expect(beyond("// @ts-ignore\nimport { f } from 'untyped';\nexport const x = f(1);\n")).toEqual([]);
    // A file git ignores beside them is still named.
    put('bot/src/modulesDev/m.ts', 'export type M = number;\n');
    expect(beyond("import type { S } from 'shared';\nimport type { M } from './modulesDev/m';\nexport const x: S & M = 1;\n")).toEqual(['src/modulesDev/m.ts']);
  });

  it("holds what the type checker reads to the root lockfile: test/'s TypeScript, and npm's record of the root install holding the lockfile's packages and no other", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smdb-tsroot-'));
    onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
    const checking = (JSON.parse(fs.readFileSync(path.join(managerRoot, 'test', 'node_modules', 'typescript', 'package.json'), 'utf8')) as { version: string }).version;
    type Entry = { version?: string; integrity?: string; optional?: boolean; link?: boolean; resolved?: string };
    const lock = (file: string, packages: Record<string, Entry>) => {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), JSON.stringify({ packages }));
    };
    const ships = (packages: Record<string, Entry>) => lock('package-lock.json', { '': { version: '1.0.0' }, ...packages });
    const installs = (packages: Record<string, Entry>) => lock('node_modules/.package-lock.json', packages);
    const both = { 'node_modules/typescript': { version: checking }, 'node_modules/@types/express': { version: '5.0.1', integrity: 'sha512-registry' } };
    ships(both);
    installs(both);
    expect(checkerDiffers(root)).toBe('');
    // An optional package the platform skips may be absent; nothing else may be.
    ships({ ...both, 'node_modules/fsevents': { version: '2.3.3', optional: true } });
    expect(checkerDiffers(root)).toBe('');
    const why = 'so a mutant the checker rejects and the shipped build accepts would count as killed with no test run';
    ships({ ...both, 'node_modules/typescript': { version: '6.0.3' } });
    expect(checkerDiffers(root)).toBe(`the type checker runs TypeScript ${checking} (test/'s, installed) and the root lockfile ships 6.0.3, ${why}; pin test/package.json and its lockfile to 6.0.3 and run npm ci in test/ of a checkout whose test/node_modules is a dir of its own (a link names another checkout's: remove the link itself first, never what it names, from the manager root with node -e "require('fs').rmSync('test/node_modules')", which refuses a real dir)`);
    const stale = (name: string, is: string, shipsText: string) => `the type checker reads the packages installed at the root, and in npm's record of that install (node_modules/.package-lock.json) ${name} is ${is} where the root lockfile ${shipsText}, ${why}; run npm ci --install-strategy=hoisted --include=dev at the root (npm's default layout with the dev packages, whatever a config or NODE_ENV says) of a checkout whose node_modules is a dir of its own (a link names another checkout's install: remove the link itself first, never what it names, from the manager root with node -e "require('fs').rmSync('node_modules')", which refuses a real dir)`;
    // npm itself installed other content at the lockfile's version (npm install --no-save of a tarball, a fork, an alias).
    ships(both);
    installs({ ...both, 'node_modules/@types/express': { version: '5.0.1', integrity: 'sha512-fork', resolved: 'file:../fork.tgz' } });
    expect(checkerDiffers(root)).toBe(stale('node_modules/@types/express', 'at 5.0.1 with other content (file:../fork.tgz)', 'ships 5.0.1'));
    // A git dependency has no integrity: its resolved commit names its content.
    const git = (commit: string) => ({ version: '1.0.0', resolved: `git+ssh://git@github.com/org/lib.git#${commit}` });
    ships({ ...both, 'node_modules/lib': git('2222') });
    installs({ ...both, 'node_modules/lib': git('1111') });
    expect(checkerDiffers(root)).toBe(stale('node_modules/lib', `at 1.0.0 with other content (${git('1111').resolved})`, 'ships 1.0.0'));
    // A registry package's resolved, which npm can leave out of its record (omit-lockfile-registry-resolved), is not compared.
    ships({ ...both, 'node_modules/@types/express': { ...both['node_modules/@types/express'], resolved: 'https://registry.npmjs.org/@types/express/-/express-5.0.1.tgz' } });
    installs(both);
    expect(checkerDiffers(root)).toBe('');
    // An optional package that is installed is held like any other.
    ships({ ...both, 'node_modules/pg-cloudflare': { version: '1.4.0', optional: true } });
    installs({ ...both, 'node_modules/pg-cloudflare': { version: '1.3.0' } });
    expect(checkerDiffers(root)).toBe(stale('node_modules/pg-cloudflare', 'at 1.3.0', 'ships 1.4.0'));
    // A pull that moved a package's declarations, with no install since: the checker would read the old ones.
    ships({ ...both, 'node_modules/@types/express': { version: '5.0.3' } });
    installs(both);
    expect(checkerDiffers(root)).toBe(stale('node_modules/@types/express', 'at 5.0.1', 'ships 5.0.3'));
    installs({ 'node_modules/typescript': { version: checking } });
    expect(checkerDiffers(root)).toBe(stale('node_modules/@types/express', 'missing', 'ships 5.0.3'));
    // A package the lockfile does not name (a branch that dropped it, npm install --no-save): TypeScript would take its @types.
    ships(both);
    installs({ ...both, 'node_modules/@types/stale': { version: '1.0.0' } });
    expect(checkerDiffers(root)).toBe(stale('node_modules/@types/stale', 'at 1.0.0', 'names no such package'));
    // npm's linked layout records each package the root names as a link, with no version.
    installs({ ...both, 'node_modules/typescript': { resolved: `node_modules/.store/typescript@${checking}/node_modules/typescript`, link: true } });
    expect(checkerDiffers(root)).toBe(stale('node_modules/typescript', 'a link', `ships ${checking}`));
    // No install at all: the first package the lockfile names.
    fs.rmSync(path.join(root, 'node_modules', '.package-lock.json'));
    expect(checkerDiffers(root)).toBe(stale('node_modules/typescript', 'missing', `ships ${checking}`));
    fs.rmSync(path.join(root, 'package-lock.json'));
    expect(checkerDiffers(root)).toBe('the root lockfile (package-lock.json) names no TypeScript or could not be read, so what the shipped build compiles with is not known and the type checker cannot be held to it; restore the lockfile');
    expect(checkerDiffers(managerRoot)).toBe('');
    const locked = (dir: string) => (JSON.parse(fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8')) as { packages: Record<string, { version: string }> }).packages['node_modules/typescript'].version;
    expect(locked(path.join(managerRoot, 'test'))).toBe(locked(managerRoot));
    // The gate asks before pass A.
    const gate = fs.readFileSync(path.join(managerRoot, 'test', 'mutation', 'touched.mjs'), 'utf8');
    expect(gate.indexOf('if (compiler) throw new PassError(compiler);')).toBeGreaterThan(0);
    expect(gate.indexOf('if (compiler) throw new PassError(compiler);')).toBeLessThan(gate.indexOf("dir: 'a', mutate:"));
  });

  it("refuses a checkout path Stryker would read as a glob, exactly where Stryker's own matcher matches no file under it", async () => {
    const { FileMatcher } = await import('../node_modules/@stryker-mutator/core/dist/src/config/file-matcher.js');
    const base = path.join(os.tmpdir(), 'smdb-roots');
    // A POSIX class is a pattern minimatch cannot read: it throws, and Stryker can match nothing there.
    const refused = ['x [old]', 'x {a,b}', 'x {1..3}', 'x +(y)', 'x @(y)', 'x [[:digit:]]'];
    const taken = ['plain', 'x (copy)', 'x [old', 'x {a}', 'a+b', 'x#1 !y', 'Program Files (x86)', 'x !(y)', '!x', '#x'];
    for (const dir of [...refused, ...taken]) {
      const root = path.join(base, dir, 'bot');
      const file = path.join(root, 'src', 'a.ts');
      const stryker = (() => { try { return new FileMatcher(file, false).matches(file); } catch { return false; } })();
      expect(rootGlobFree(root), dir).toBe(taken.includes(dir));
      expect(stryker, dir).toBe(taken.includes(dir));
    }
  });

  it("refuses a checkout path that holds the text node_modules, as given or real, under which vitest's related runs drop every import", () => {
    // vitest's own rule, in the version installed: a related run skips an import whose path holds the text anywhere.
    const chunks = path.join(managerRoot, 'test', 'node_modules', 'vitest', 'dist', 'chunks');
    expect(fs.readdirSync(chunks).some(file => fs.readFileSync(path.join(chunks, file), 'utf8').includes('if (fsPath.includes("node_modules") ||'))).toBe(true);
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'smdb-relatable-'));
    onTestFinished(() => {
      // The link first, so the removal never walks into the dir it names.
      fs.rmSync(path.join(base, 'plain', 'link'), { force: true });
      fs.rmSync(base, { recursive: true, force: true });
    });
    for (const dir of ['plain/bot', 'node_modules_old/bot', 'x/node_modules/bot']) fs.mkdirSync(path.join(base, dir), { recursive: true });
    expect(rootRelatable(path.join(base, 'plain', 'bot'))).toBe(true);
    expect(rootRelatable(path.join(base, 'node_modules_old', 'bot'))).toBe(false);
    expect(rootRelatable(path.join(base, 'x', 'node_modules', 'bot'))).toBe(false);
    // vitest resolves an import to its real path, so a link to such a dir is refused too.
    fs.symlinkSync(path.join(base, 'node_modules_old', 'bot'), path.join(base, 'plain', 'link'), 'junction');
    expect(rootRelatable(path.join(base, 'plain', 'link'))).toBe(false);
    expect(rootRelatable(managerRoot)).toBe(true);
    // The gate asks at its start, after the glob check and before it reads git.
    const gate = fs.readFileSync(path.join(managerRoot, 'test', 'mutation', 'touched.mjs'), 'utf8');
    expect(gate.indexOf('if (!rootRelatable(root)) {')).toBeGreaterThan(gate.indexOf('if (!rootGlobFree(root)) {'));
    expect(gate.indexOf('if (!rootRelatable(root)) {')).toBeLessThan(gate.indexOf('planFromGit('));
  });

  it('names, and never mutates, a file listed under a name that leads through a link, as the disk tells it', () => {
    const links: Record<string, string | null> = { 'src/env.ts': 'test/helpers/env.ts', 'src/config.ts': 'test/vitest.config.ts', 'src/old/x.ts': 'src/real/x.ts', 'src/A.ts': 'src/a.ts', 'src/out/y.ts': null };
    const plan = planChange({
      entries: [{ status: 'A', file: 'src/env.ts' }, { status: 'M', file: 'src/old/x.ts' }, { status: 'M', file: 'src/real/X.ts' }, { status: 'M', file: 'src/A.ts' }],
      untracked: ['src/config.ts', 'src/out/y.ts'],
      read: () => 'export const x = 1;\n',
      readBase: () => 'export const x = 0;\n',
      nameOf: file => (file === 'src/real/X.ts' ? 'src/real/x.ts' : file),
      linkOf: file => (file in links ? links[file] : undefined),
    });
    // A file renamed by case outside git keeps its own name; a link that differs from its file only in case is a link.
    expect(plan.targets.map(target => target.file)).toEqual(['src/real/x.ts']);
    const to = (name: string) => `a link to ${name}: a file is mutated under its own name only, when git lists it changed`;
    const nowhere = 'it leads to no file in the manager root (a link to a directory or out of the root, a broken link, or a file gone since git listed it), so no sandbox holds it';
    expect(plan.skipped).toEqual([
      { file: 'src/env.ts', why: to('test/helpers/env.ts') },
      { file: 'src/old/x.ts', why: to('src/real/x.ts') },
      { file: 'src/A.ts', why: to('src/a.ts') },
      { file: 'src/config.ts', why: to('test/vitest.config.ts') },
      { file: 'src/out/y.ts', why: nowhere },
    ]);
    // On disk, through git: a link to a dir in the manager root and one to a dir out of it (junctions on Windows, which
    // git walks into; on POSIX git lists each link as a file).
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'smdb-outside-'));
    onTestFinished(() => fs.rmSync(outside, { recursive: true, force: true }));
    fs.writeFileSync(path.join(outside, 'y.ts'), 'export const y = 1;\n');
    const { repo, plan: fromGit } = repoWith({ 'src/a.ts': text(lines('a', 2)), 'test/helpers/env.ts': text(lines('e', 2)) });
    fs.symlinkSync(path.join(repo, 'test', 'helpers'), path.join(repo, 'src', 'link'), 'junction');
    fs.symlinkSync(outside, path.join(repo, 'src', 'out'), 'junction');
    onTestFinished(() => {
      fs.unlinkSync(path.join(repo, 'src', 'link'));
      fs.unlinkSync(path.join(repo, 'src', 'out'));
    });
    const linked = fromGit();
    expect(linked.targets).toEqual([]);
    if (process.platform === 'win32') {
      expect(linked.skipped).toEqual([{ file: 'src/link/env.ts', why: to('test/helpers/env.ts') }, { file: 'src/out/y.ts', why: nowhere }]);
    } else {
      // On POSIX git lists each link as a file, whose name is not code.
      expect(linked.skipped.map(s => s.file).sort()).toEqual(['src/link', 'src/out']);
    }
    // The disk decides, through every link on the way.
    expect(linkOf(repo, 'src/a.ts')).toBeUndefined();
    expect(linkOf(repo, 'src/link/env.ts')).toBe('test/helpers/env.ts');
    expect(linkOf(repo, 'src/out/y.ts')).toBeNull();
    // --mutate's tree holds a file reached only through a link under no name.
    expect([...ownNames(repo, ['src/a.ts', 'src/link/env.ts', 'src/out/y.ts'])]).toEqual(['src/a.ts']);
    if (fs.existsSync(path.join(repo, 'src', 'A.ts'))) {
      // A disk that does not tell case apart: another case of a file's name is the file itself, no link.
      expect(linkOf(repo, 'src/A.ts')).toBeUndefined();
    } else {
      // One that does: a link whose name differs from its file's only in case is a link (where links can be made).
      let made = true;
      try { fs.symlinkSync('a.ts', path.join(repo, 'src', 'A.ts')); } catch { made = false; }
      if (made) expect(linkOf(repo, 'src/A.ts')).toBe('src/a.ts');
    }
    // A submodule is a real dir, and a link to one is a link (lstat).
    expect(fs.readFileSync(path.join(__dirname, '..', 'mutation', 'ranges.mjs'), 'utf8')).toContain('fs.lstatSync(path.join(root, file)).isDirectory()');
  });

  it('gates a file that two changed names lead to (names that differ only in case) by either diff, and gives Stryker their ranges merged', () => {
    const now = ['export const a = 1;', 'export const b = 2;', 'export const c = 3;', 'export const d = 4;', 'export const e = 5;', ''].join('\n');
    const plan = planChange({
      entries: [{ status: 'M', file: 'src/REAL/x.ts' }, { status: 'M', file: 'src/real/x.ts' }],
      untracked: [],
      read: () => now,
      readBase: file => now.replace(file === 'src/REAL/x.ts' ? 'b = 2' : 'c = 3', 'z = 0'),
      nameOf: () => 'src/real/x.ts',
    });
    expect(plan.targets.map(target => [target.file, target.gating])).toEqual([['src/real/x.ts', [2]], ['src/real/x.ts', [3]]]);
    const at = (line: number) => ({ start: { line, column: 1 }, end: { line, column: 9 } });
    // The job's own edit, at line 3, is the second diff's: the first target alone would call it context.
    expect(gates(plan.targets[0], at(3))).toBe(false);
    expect(gatesIn(plan.targets, 'src/real/x.ts', at(3))).toBe(true);
    expect(gatesIn(plan.targets, 'src/real/x.ts', at(2))).toBe(true);
    expect(gatesIn(plan.targets, 'src/real/x.ts', at(5))).toBe(false);
    // Merged, so a mutant that spans both lines is made too.
    expect(mutatePatterns(plan.targets)).toEqual(['src/real/x.ts:2-3']);
    // A diff that only takes code out names its place and brings in nothing: the other diff's lines are all that is made.
    const taken = changeTarget('src/real/x.ts', now, { changed: [], deletedAfter: [3] })!;
    expect(mutatePatterns([taken, changeTarget('src/real/x.ts', now, { changed: [5], deletedAfter: [] })!])).toEqual(['src/real/x.ts:5-5']);
    expect(mutatePatterns([...plan.targets, wholeTarget('src/real/x.ts')])).toEqual(['src/real/x.ts']);
    // --mutate patterns stay as given.
    expect(mutatePatterns([{ file: 'src/a.ts', patterns: ['src/a.ts:1-2'] }, { file: 'src/a.ts', patterns: ['src/a.ts:2-3'] }])).toEqual(['src/a.ts:1-2', 'src/a.ts:2-3']);
  });

  it('sees a change git is told not to look at, and names a submodule and a name Stryker would read as a glob', () => {
    const edited = (name: string) => text(lines(name, 3).map((line, i) => (i === 1 ? `${line} // edited` : line)));
    const sub = repoWith({ 'index.ts': text(lines('s', 2)) });
    const { repo, git, write, plan } = repoWith({
      'src/a.ts': text(lines('a', 3)), 'src/b.ts': text(lines('b', 3)), 'src/c.ts': text(lines('c', 3)), 'src/[id].ts': text(lines('id', 3)),
      'src/d.ts': text(lines('d', 3)), 'src/e.ts': text(lines('e', 3)),
    });
    git(['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub.repo.split(path.sep).join('/'), 'src/sub']);
    git(['update-index', '--assume-unchanged', 'src/a.ts', 'src/d.ts']);
    git(['update-index', '--skip-worktree', 'src/b.ts', 'src/e.ts']);
    // Gone: d deleted (named), e left out as a sparse checkout leaves a file out.
    fs.rmSync(path.join(repo, 'src', 'd.ts'));
    fs.rmSync(path.join(repo, 'src', 'e.ts'));
    // core.ignoreStat marks each file git adds after it is set.
    git(['config', 'core.ignoreStat', 'true']);
    git(['add', 'src/c.ts']);
    for (const name of ['a', 'b', 'c', 'id']) write(`src/${name === 'id' ? '[id]' : name}.ts`, edited(name));
    write('src/new[1].ts', text(lines('n', 2)));
    // A config that hides submodules from the diff hides nothing from the gate.
    const result = plan(['-c', 'diff.ignoreSubmodules=all']);
    expect(result.targets.map(t => [t.file, t.gating]).sort()).toEqual([['src/a.ts', [2]], ['src/b.ts', [2]], ['src/c.ts', [2]]]);
    expect(result.skipped).toEqual(expect.arrayContaining([
      { file: 'src/sub', why: 'a git submodule: git names only its commit, so none of its files is mutated' },
      { file: 'src/[id].ts', why: GLOB_NAME_WHY },
      { file: 'src/new[1].ts', why: GLOB_NAME_WHY },
      { file: 'src/d.ts', why: 'deleted: nothing is left to mutate' },
    ]));
    expect(result.skipped.map(s => s.file)).not.toContain('src/e.ts');
  });

  it('names a gone file deleted only when the base held it as a file, whatever pathspec variable the user has', () => {
    const { repo, git, write, plan } = repoWith({ 'src/a.ts': text(lines('a', 3)), 'src/d.ts': text(lines('d', 2)), 'src/x/y.ts': text(lines('y', 2)) });
    write('src/b.ts', text(lines('b', 2)));
    write('src/c.ts', text(lines('c', 2)));
    git(['add', 'src/b.ts']);
    git(['add', '-N', 'src/c.ts']);
    // A file staged where the base held a dir.
    fs.rmSync(path.join(repo, 'src', 'x'), { recursive: true });
    write('src/x', text(lines('x', 2)));
    git(['add', '-A', 'src/x']);
    // A base file git is told not to look at: it is deleted.
    git(['update-index', '--assume-unchanged', 'src/d.ts']);
    for (const file of ['b.ts', 'c.ts', 'x', 'd.ts']) fs.rmSync(path.join(repo, 'src', file));
    const result = plan();
    expect(result.targets).toEqual([]);
    expect(result.skipped).toEqual([{ file: 'src/x/y.ts', why: 'deleted: nothing is left to mutate' }, { file: 'src/d.ts', why: 'deleted: nothing is left to mutate' }]);
    // git takes these from the user's env, and a command that reads a pathspec dies under them.
    for (const env of [{ GIT_GLOB_PATHSPECS: '1' }, { GIT_ICASE_PATHSPECS: '1' }]) expect(plan([], env), JSON.stringify(env)).toEqual(result);
    // Alone, such a file leaves no src file changed, and the report says so.
    const { repo: alone, git: gitAlone, write: writeAlone, plan: planAlone } = repoWith({ 'src/a.ts': text(lines('a', 3)) });
    writeAlone('src/b.ts', text(lines('b', 2)));
    gitAlone(['add', 'src/b.ts']);
    fs.rmSync(path.join(alone, 'src', 'b.ts'));
    expect(planAlone()).toEqual({ targets: [], skipped: [], emptyScope: true });
  });

  it('looks at every file itself, whatever a file-system monitor says', () => {
    const { repo, git, write, plan } = repoWith({ 'src/a.ts': text(lines('a', 3)), 'src/b.ts': text(lines('b', 3)) });
    // A monitor (protocol 2) that says nothing changed but a.ts.
    const hook = path.join(repo, '.git', 'monitor.sh');
    fs.writeFileSync(hook, "#!/bin/sh\nprintf 'token\\0src/a.ts\\0'\n");
    fs.chmodSync(hook, 0o755);
    git(['config', 'core.fsmonitor', hook.split(path.sep).join('/')]);
    git(['config', 'core.fsmonitorHookVersion', '2']);
    git(['update-index', '--fsmonitor']);
    git(['status', '--porcelain']);
    for (const name of ['a', 'b']) write(`src/${name}.ts`, text(lines(name, 3).map((line, i) => (i === 1 ? `${line} // edited` : line))));
    // git itself misses b.ts here.
    expect(git(['diff', '--name-only'])).not.toContain('src/b.ts');
    expect(plan().targets.map(t => t.file).sort()).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it("sees a same-size edit whose time was set back, which git's stat cache hides", () => {
    const { repo, git, plan } = repoWith({ 'src/a.ts': 'export const big = (n: number) => n > 10;\n', 'src/b.ts': text(lines('b', 3)) });
    // ctime is a file's creation time on Windows, and git need not look at it: here it never does.
    git(['config', 'core.trustctime', 'false']);
    const file = path.join(repo, 'src', 'a.ts');
    const { atime, mtime } = fs.statSync(file);
    // The index caches a.ts's stat a second later, so that time no longer reads as one git must check.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_100);
    git(['status', '--porcelain']);
    fs.writeFileSync(file, 'export const big = (n: number) => n < 10;\n');
    fs.utimesSync(file, atime, mtime);
    expect(git(['status', '--porcelain'])).toBe('');
    expect(plan().targets.map(t => t.file)).toEqual(['src/a.ts']);
    expect(plan().targets[0].gating).toEqual([1]);
  });

  it("names nothing the content check's hash alone tells apart: a blob that holds CRLF, an edit staged and then undone", () => {
    const { repo, git, write } = repoWith({ 'src/b.ts': text(lines('b', 3)) });
    write('src/a.ts', 'export const a = 1;\r\nexport const b = 2;\r\n');
    git(['-c', 'core.autocrlf=false', 'add', 'src/a.ts']);
    git(['-c', 'core.autocrlf=false', 'commit', '-q', '-m', 'crlf']);
    // git add would keep the CRLF blob as it is; hash-object, which reads no index, makes it LF.
    git(['config', 'core.autocrlf', 'true']);
    write('src/b.ts', text(lines('b', 3).map((line, i) => (i === 1 ? `${line} // staged` : line))));
    git(['add', 'src/b.ts']);
    write('src/b.ts', text(lines('b', 3)));
    for (const file of ['src/a.ts', 'src/b.ts']) expect(git(['hash-object', file]).trim(), file).not.toBe(git(['rev-parse', `:${file}`]).trim());
    const plan = planFromGit({ git: (...args: string[]) => git(args), base: git(['rev-parse', 'HEAD']).trim(), root: repo });
    expect(plan).toEqual({ targets: [], skipped: [], emptyScope: true });
  });

  it('lets into a sandbox only the files git lists: nothing it ignores, nothing of a repository inside, nothing made later', async () => {
    const sub = repoWith({ '.gitignore': '.env\n', 'index.ts': text(lines('s', 2)) });
    const odd = 'src/[id] {1,2} (x) !y #z +(w) @(v).ts';
    const { repo, git, write } = repoWith({ '.gitignore': '.env\nnode_modules/\nbackup*/\n', 'src/a.ts': text(lines('a', 3)), [odd]: text(lines('o', 1)) });
    git(['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub.repo.split(path.sep).join('/'), 'src/sub']);
    write('.env', 'TOKEN=x\n');
    write('node_modules/x/index.js', '');
    write('backup[1]/.env', 'TOKEN=z\n');
    write('src/fresh/b.ts', text(lines('b', 2)));
    write('src/sub/.env', 'TOKEN=s\n');
    write('src/mod/index.ts', text(lines('m', 2)));
    git(['-C', path.join(repo, 'src', 'mod'), 'init', '-q']);
    // A file git tracks in a node_modules dir, which Stryker links into the sandbox instead.
    write('lib/node_modules/v/index.js', '');
    git(['add', '-f', 'lib/node_modules/v/index.js']);
    // The gate's list (touched.mjs treeFiles): the tracked files, and the untracked ones git does not ignore.
    const listed = git(['-c', 'core.quotePath=false', 'ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean);
    const { patterns, unkept } = sandboxPatterns(listed);
    expect(unkept).toEqual([]);
    // Made after the list: a .env, a data dir, an untracked file.
    write('src/.env', 'TOKEN=late\n');
    write('data/state.json', '{}');
    write('src/late.ts', text(lines('l', 1)));
    // What Stryker's own crawl copies under these patterns.
    const core = path.dirname(createRequire(__filename).resolve('@stryker-mutator/core/package.json'));
    // Stryker's entry first: its modules need to load in its own order.
    await import(pathToFileURL(path.join(core, 'dist', 'src', 'index.js')).href);
    const { ProjectReader } = await import(pathToFileURL(path.join(core, 'dist', 'src', 'fs', 'project-reader.js')).href);
    const quiet = { warn() {}, info() {}, debug() {} };
    const reader = new ProjectReader(fs.promises, quiet, {
      mutate: [], tempDirName: '.stryker-tmp', ignorePatterns: patterns, incremental: false, incrementalFile: 'reports/stryker-incremental.json', force: false,
      htmlReporter: { fileName: 'reports/mutation/mutation.html' }, jsonReporter: { fileName: 'reports/mutation/mutation.json' }, testFiles: [],
    });
    const cwd = process.cwd();
    process.chdir(repo);
    let copied: string[];
    try {
      copied = ((await reader.resolveInputFileNames()) as string[]).map(file => path.relative(repo, file).split(path.sep).join('/')).sort();
    } finally {
      process.chdir(cwd);
    }
    expect(copied).toEqual(['.gitignore', '.gitmodules', odd, 'src/a.ts', 'src/fresh/b.ts'].sort());
    // Each name escaped as Stryker's matcher reads it, on Linux and on Windows; one it still cannot match is named.
    const BS = String.fromCharCode(92);
    const names = [`a${BS}b.ts`, `m{1}${BS}2.ts`, 'x{a,b}.ts', 'backup[1]/a.ts', 'src/mod/'];
    const ranges = pathToFileURL(path.join(managerRoot, 'test', 'mutation', 'ranges.mjs')).href;
    for (const [platform, left] of [['linux', [`m{1}${BS}2.ts`]], ['win32', [`a${BS}b.ts`, `m{1}${BS}2.ts`]]] as const) {
      const run = spawnSync(process.execPath, ['--input-type=module', '-e',
        `import { sandboxPatterns } from ${JSON.stringify(ranges)}; console.log(JSON.stringify(sandboxPatterns(JSON.parse(process.env.SMDB_NAMES))));`],
      { encoding: 'utf8', env: { ...process.env, __MINIMATCH_TESTING_PLATFORM__: platform, SMDB_NAMES: JSON.stringify(names) } });
      const result = JSON.parse(run.stdout) as { patterns: string[], unkept: string[] };
      expect(result.unkept, platform).toEqual(left);
      expect(result.patterns, platform).toContain(`!/backup${BS}[1${BS}]/a.ts`);
      expect(result.patterns.length, platform).toBe(1 + names.length - 1 - left.length);
    }
  });

  it('fingerprints the tree a run reads, and names what changed in it', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smdb-tree-'));
    onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, 'a.ts'), 'a');
    fs.writeFileSync(path.join(root, 'b.ts'), 'b');
    const before = treePrint(root, ['a.ts', 'b.ts', 'gone.ts']);
    expect(treeChanges(before, treePrint(root, ['a.ts', 'b.ts', 'gone.ts']))).toEqual([]);
    // The same size, and perhaps the same time: the content tells.
    fs.writeFileSync(path.join(root, 'a.ts'), 'A');
    fs.writeFileSync(path.join(root, 'c.ts'), 'c');
    expect(treeChanges(before, treePrint(root, ['a.ts', 'b.ts', 'c.ts', 'gone.ts']))).toEqual(['a.ts', 'c.ts']);
  });

  it('fingerprints the packages the runs load, by the lockfile npm keeps in the root\'s and test/\'s node_modules', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smdb-packages-'));
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'smdb-main-'));
    onTestFinished(() => {
      fs.unlinkSync(path.join(root, 'node_modules'));
      for (const dir of [root, elsewhere]) fs.rmSync(dir, { recursive: true, force: true });
    });
    expect(PACKAGE_LOCKS).toEqual(['node_modules/.package-lock.json', 'test/node_modules/.package-lock.json']);
    // The root's packages through a link (a worktree sharing the main checkout's), test/'s a dir.
    fs.mkdirSync(path.join(elsewhere, 'node_modules'));
    fs.writeFileSync(path.join(elsewhere, 'node_modules', '.package-lock.json'), '{}');
    fs.symlinkSync(path.join(elsewhere, 'node_modules'), path.join(root, 'node_modules'), 'junction');
    fs.mkdirSync(path.join(root, 'test', 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(root, 'test', 'node_modules', '.package-lock.json'), '{}');
    const before = treePrint(root, PACKAGE_LOCKS);
    expect([...before.values()].every(stamp => /^\d+:[\d.]+:[0-9a-f]{40}$/.test(stamp))).toBe(true);
    expect(treeChanges(before, treePrint(root, PACKAGE_LOCKS))).toEqual([]);
    // An install in the linked dir rewrites its lockfile; npm ci in test/ removes it first.
    fs.writeFileSync(path.join(elsewhere, 'node_modules', '.package-lock.json'), '{"x":1}');
    fs.rmSync(path.join(root, 'test', 'node_modules', '.package-lock.json'));
    expect(treeChanges(before, treePrint(root, PACKAGE_LOCKS))).toEqual(PACKAGE_LOCKS);
  });

});

describe.runIf(stryker)('the widening', () => {
  it('takes a whole multi-line condition when one of its lines changed, but not the body it guards', () => {
    expect(rangesOf(SAMPLE, [3])).toEqual([[2, 3]]);
    expect(rangesOf(SAMPLE, [2])).toEqual([[2, 3]]);
    expect(rangesOf(SHAPES.conditionWithCallback, [2])).toEqual([[2, 4]]);
  });

  it('takes the whole expression when a block-bodied callback sits inside it', () => {
    expect(rangesOf(SHAPES.returnCompare, [4])).toEqual([[2, 4]]);
    expect(rangesOf(SHAPES.chainAfterCallback, [6])).toEqual([[2, 6]]);
  });

  it('keeps a changed line in a body, a callback body included, to its own statement', () => {
    expect(rangesOf(SAMPLE, [4])).toEqual([[4, 4]]);
    expect(rangesOf(SAMPLE, [10])).toEqual([[10, 10]]);
    expect(rangesOf(SHAPES.returnCompare, [3])).toEqual([[3, 3]]);
    expect(rangesOf(SHAPES.callbacks, [3])).toEqual([[3, 3]]);
  });

  it('takes a whole statement that holds no block', () => {
    expect(rangesOf(SAMPLE, [7])).toEqual([[6, 9]]);
    expect(rangesOf(SAMPLE, [8])).toEqual([[6, 9]]);
    // A blank line inside a multi-line template is part of the template's text, so it widens as its other lines do.
    const usage = ['export function usage() {', '  return `usage:', '', '  smdb run`;', '}'].join('\n');
    expect(rangesOf(usage, [2])).toEqual([[2, 4]]);
    expect(rangesOf(usage, [3])).toEqual([[2, 4]]);
  });

  it('keeps a changed signature to the signature, and a closing brace or else line to its own line', () => {
    expect(rangesOf(SAMPLE, [1])).toEqual([[1, 1]]);
    expect(rangesOf(SAMPLE, [5])).toEqual([[5, 5]]);
    expect(rangesOf(SHAPES.conditionWithCallback, [6])).toEqual([[6, 6]]);
  });

  it('tells lines that hold code from blank, comment-only and brace-only ones, inside a statement too', () => {
    const text = [
      SAMPLE, // 1 to 11
      '// a comment', // 12
      '', // 13
      'export interface Role {', // 14
      '  /** a doc */', // 15
      '  name?: string;', // 16
      '  // a note', // 17
      '}', // 18
      'export const t = `a', // 19
      'b`;', // 20
      'if (t) {', // 21
      '  f(1, 2);', // 22
      '} else {', // 23
      '  f(2, 1);', // 24
      '}', // 25
    ].join('\n');
    expect(codeLines('src/a.ts', text, Array.from({ length: 25 }, (_, i) => i + 1))).toEqual([1, 2, 3, 4, 6, 7, 8, 10, 14, 16, 19, 20, 21, 22, 23, 24]);
  });

  it('joins ranges that meet, since Stryker needs one range to hold a whole mutant', () => {
    expect(rangesOf(SAMPLE, [3, 4])).toEqual([[2, 4]]);
    expect(mergeRanges([[9, 9], [1, 2], [3, 3], [5, 7], [6, 8]])).toEqual([[1, 3], [5, 9]]);
  });
});

// Stryker's own instrumenter, in memory: every mutant that touches a changed
// line must be made by the ranges, except one that touches the line only
// through a block nested inside it (the whole callback around a changed line
// of its body), and the emptying of the body of a compound statement or
// declaration, or of a bare block, that only begins or ends on the line (a
// changed `if (...) {`, signature or closing brace: making it would bring in
// the whole body), and the false condition of a for with no condition that
// spans more than one line, which spans the loop (a one-line loop's is made,
// and so is one whose every line changed, below), and the emptying of a case
// clause on more than one line (its label is a header, its statements a body,
// braces or not), unless the line lies in its label or in a statement that is
// neither a block nor a compound statement, when that starts on the label line
// and ends the clause (one whose every line changed is made, below; a label
// and a body line widen to themselves, below). Every other body's emptying is
// made (a callback's, a method of an object or a class expression), and what
// is not made is checked not to be.
describe.runIf(stryker)('the widening, against what Stryker makes', () => {
  const quiet = () => {};
  const logger = { debug: quiet, info: quiet, warn: quiet, error: quiet, trace: quiet, fatal: quiet, isDebugEnabled: () => false, isTraceEnabled: () => false, isInfoEnabled: () => false, isWarnEnabled: () => false, isErrorEnabled: () => false, isFatalEnabled: () => false };
  const instrumenter = stryker ? new Instrumenter(logger as never) : (null as never);
  const OPTIONS = { plugins: null, excludedMutations: [], ignorers: [], noHeader: true } as never;
  interface Made { mutatorName: string; replacement: string; location: { start: { line: number; column: number }; end: { line: number; column: number } } }
  const made = async (text: string, mutate: unknown): Promise<Made[]> =>
    (await instrumenter.instrument([{ name: 'src/a.ts', content: text, mutate } as never], OPTIONS)).mutants as unknown as Made[];
  const key = (m: Made) => `${m.mutatorName}|${m.replacement}|${m.location.start.line}:${m.location.start.column}-${m.location.end.line}:${m.location.end.column}`;
  const spansOf = (list: Made[]) => list.map((m): [number, number] => [m.location.start.line + 1, m.location.end.line + 1]);

  // The shapes above, and two real files: one with plain statements, one a
  // route file of block-bodied handlers.
  const real = (file: string) => fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8');
  const corpus: [string, string][] = [
    ...Object.entries(SHAPES),
    ['src/config/storeFile.ts', real('src/config/storeFile.ts')],
    ['src/webui/routes/sources.ts', real('src/webui/routes/sources.ts')],
  ];
  for (const [name, text] of corpus) {
    it(`makes every mutant that touches a changed line: ${name}`, { timeout: 120_000 }, async () => {
      const sf = ts.createSourceFile('a.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const at = (p: { line: number; column: number }) => sf.getPositionOfLineAndCharacter(p.line, p.column);
      const blocks: { start: number; end: number }[] = [];
      // The bodies of compound statements and declarations (a case clause's block included), and bare blocks: never
      // a callback's body, or the body of a method or accessor of an object or a class expression, each taken whole.
      const bodies = new Set<string>();
      // Each for with no condition on more than one line: its false condition spans the loop, so one changed line
      // does not make it (a one-line loop's is made, and the filter below keeps those out).
      const loops = new Set<string>();
      // Each case or default clause on more than one line, with the lines that make its emptying, which spans its
      // body: those of its label, or of a statement of it that is neither a block nor a compound statement, when
      // that starts on the label line and ends the clause (a line of it takes it whole). From any other line it is not
      // made. Read from the tree, not from the widening, so a widening that takes too much or too little fails.
      const clauses = new Map<string, Set<number>>();
      const inExpression = (node: ts.Node) => (ts.isMethodDeclaration(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node) || ts.isConstructorDeclaration(node))
        && (ts.isObjectLiteralExpression(node.parent) || ts.isClassExpression(node.parent));
      const walk = (node: ts.Node) => {
        if (ts.isBlock(node) || ts.isModuleBlock(node) || ts.isCaseBlock(node)) blocks.push({ start: node.getStart(sf), end: node.getEnd() });
        if (ts.isBlock(node) && !ts.isArrowFunction(node.parent) && !ts.isFunctionExpression(node.parent) && !inExpression(node.parent)) {
          bodies.add(`${node.getStart(sf)}-${node.getEnd()}`);
        }
        const lineAt = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line;
        if (ts.isForStatement(node) && !node.condition && lineAt(node.getStart(sf)) < lineAt(node.getEnd())) loops.add(`${node.getStart(sf)}-${node.getEnd()}`);
        if ((ts.isCaseClause(node) || ts.isDefaultClause(node)) && lineAt(node.getStart(sf)) < lineAt(node.getEnd())) {
          const [label, end] = [lineAt(node.getStart(sf)), lineAt(node.getEnd())];
          // The statements ranges.mjs COMPOUND widens apart from their bodies, listed here by hand: a kind added to
          // one list and not the other fails a clause shape that holds it. Only the clause's own statements are
          // read, so a braceless compound one on the label line whose statement ends the clause (`case 1: if (a)
          // g(` ... `);`) fails it too, though the widening makes the emptying from that statement's lines rightly.
          const compound = (part: ts.Node) => ts.isBlock(part) || ts.isIfStatement(part) || ts.isIterationStatement(part, false) || ts.isSwitchStatement(part)
            || ts.isTryStatement(part) || ts.isLabeledStatement(part) || ts.isWithStatement(part) || ts.isFunctionDeclaration(part) || ts.isClassDeclaration(part);
          const takers = new Set<number>();
          for (const part of [...(ts.isCaseClause(node) ? [node.expression] : []), ...node.statements]) {
            if (!compound(part) && lineAt(part.getStart(sf)) === label && lineAt(part.getEnd()) === end) for (let l = label; l <= end; l++) takers.add(l + 1);
          }
          clauses.set(`${node.getStart(sf)}-${node.getEnd()}`, takers);
        }
        ts.forEachChild(node, walk);
      };
      walk(sf);
      const whole = await made(text, true);
      const lines = text.split('\n');
      let checked = 0;
      for (let n = 1; n <= lines.length; n++) {
        const code = lines[n - 1];
        // A blank or comment-only line widens to nothing (below).
        if (tokenLines('a.ts', text, [n]).length === 0) continue;
        const lineStart = sf.getPositionOfLineAndCharacter(n - 1, 0);
        const span = { start: lineStart + code.search(/\S/), end: lineStart + code.trimEnd().length };
        const throughBlock = (m: Made) => blocks.some(b => at(m.location.start) <= b.start && b.end <= at(m.location.end) && b.start < span.start && span.end < b.end);
        const spanOf = (m: Made) => `${at(m.location.start)}-${at(m.location.end)}`;
        const braceOnly = (m: Made) => m.mutatorName === 'BlockStatement' && m.location.start.line < m.location.end.line && bodies.has(spanOf(m));
        const ranges = rangesOf(text, [n]) ?? [];
        const spansBody = (m: Made) => m.mutatorName === 'ConditionalExpression' && (loops.has(spanOf(m)) || clauses.get(spanOf(m))?.has(n) === false);
        const touching = whole.filter(m => m.location.start.line + 1 <= n && n <= m.location.end.line + 1 && !throughBlock(m));
        const expected = touching.filter(m => !braceOnly(m) && !spansBody(m));
        const mutate = ranges.map(([s, e]) => ({ start: { line: s - 1, column: 0 }, end: { line: e - 1, column: Number.MAX_SAFE_INTEGER } }));
        const here = await made(text, mutate);
        const got = new Set(here.map(key));
        const missing = expected.filter(m => !got.has(key(m))).map(m => `${m.mutatorName} ${key(m)}`);
        expect(missing, `${name} line ${n}: ${code.trim()}`).toEqual([]);
        // And what the README says is not made, is not.
        const unmade = touching.filter(m => (braceOnly(m) || spansBody(m)) && got.has(key(m))).map(m => `${m.mutatorName} ${key(m)}`);
        expect(unmade, `${name} line ${n}: ${code.trim()}`).toEqual([]);
        const through = whole.filter(m => m.location.start.line + 1 <= n && n <= m.location.end.line + 1 && throughBlock(m) && got.has(key(m)));
        expect(through.map(m => `${m.mutatorName} ${key(m)}`), `${name} line ${n}: ${code.trim()}`).toEqual([]);
        checked += expected.length;
        // The file taken whole names the line exactly when the line changed alone would.
        expect(untouched(name, text, [n], spansOf(whole)), `${name} line ${n}: ${code.trim()}`).toEqual(untouched(name, text, [n], spansOf(here)));
      }
      expect(checked).toBeGreaterThan(lines.length / 4);
    });
  }

  it('makes and gates what the changed lines widen to, a place where code was taken out beside them or not', async () => {
    const base = [
      "import { Router } from 'express';",
      'export const router = Router();',
      "router.get('/x', async (req, res) => {",
      '  const id = String(req.query.id);',
      '  res.json({ ok: true, id });',
      '});',
    ];
    const loc = (m: Made) => ({ start: { line: m.location.start.line + 1, column: m.location.start.column + 1 }, end: { line: m.location.end.line + 1, column: m.location.end.column + 1 } });
    const of = async (before: string, text: string) => {
      const target = changeTarget('src/a.ts', text, lineDiff(before, text))!;
      const here = await made(text, target.ranges!.map(([s, e]) => ({ start: { line: s - 1, column: 0 }, end: { line: e - 1, column: Number.MAX_SAFE_INTEGER } })));
      return { target, here, gating: here.filter(m => gates(target, loc(m))) };
    };
    // The handler's first line taken out and the next one edited: one hunk, two lines out and one in. The route's
    // header beside it is not widened, so the handler's emptying (an endless loop for a `for (;;)` body) is not made.
    const text = [base[0], base[1], base[2], '  res.json({ ok: false });', base[5]].join('\n');
    expect(lineDiff(base.join('\n'), text)).toEqual({ changed: [4], deletedAfter: [3] });
    const route = await of(base.join('\n'), text);
    expect(route.here.some(m => m.mutatorName === 'BlockStatement' && m.location.start.line + 1 === 3)).toBe(false);
    expect(route.gating.length).toBeGreaterThan(0);
    expect(route.here.every(m => m.location.start.line + 1 === 4 && m.location.end.line + 1 === 4)).toBe(true);
    // A new function whose body holds a blank or a comment line is made whole, and its emptying gates, with code
    // taken out of another function in the file or not.
    const g = ['export function g(b: number) {', '  const c = b * 2;', '  return c;', '}'];
    for (const gap of ['', '  // then the other']) {
      const fresh = ['export function remember(state: { last?: string; seen?: boolean }): void {', "  state.last = 'ok';", gap, '  state.seen = true;', '}'];
      for (const rest of [g, [g[0], '  return b > 3 ? b : 0;', g[3]]]) {
        const { target, here } = await of(g.join('\n'), [...fresh, ...rest].join('\n'));
        expect(target.deleted, JSON.stringify(gap)).toEqual(rest === g ? undefined : [6]);
        const body = here.find(m => m.mutatorName === 'BlockStatement' && m.location.start.line + 1 === 1 && m.location.end.line + 1 === 5);
        expect(body && gates(target, loc(body)), JSON.stringify(gap)).toBe(true);
      }
    }
  });

  it('makes and gates the false condition of a for with no condition when every line of the loop changed', async () => {
    const text = ['export async function wait(ready: () => Promise<boolean>) {', '  for (;;) {', '    if (await ready()) return;', '  }', '}'].join('\n');
    const loop = (m: Made) => m.mutatorName === 'ConditionalExpression' && m.location.start.line + 1 === 2 && m.location.end.line + 1 === 4;
    const of = async (changed: number[]) => {
      const target = changeTarget('src/a.ts', text, { changed, deletedAfter: [] })!;
      const here = await made(text, target.ranges!.map(([s, e]) => ({ start: { line: s - 1, column: 0 }, end: { line: e - 1, column: Number.MAX_SAFE_INTEGER } })));
      const found = here.find(loop);
      return found && gates(target, { start: { line: found.location.start.line + 1, column: 1 }, end: { line: found.location.end.line + 1, column: 1 } });
    };
    expect(await of([2, 3, 4])).toBe(true);
    // With the closer unchanged, the loop's range is not held whole, so it is not made.
    expect(await of([2, 3])).toBeUndefined();
  });

  it('makes and gates the emptying of a case clause when every line of it changed, as a clause a job adds', async () => {
    const text = ['export function f(n: number): number {', '  switch (n) {', '    case 1:', '      return 1;', '    default:', '      return 0;', '  }', '}'].join('\n');
    const clause = (m: Made) => m.mutatorName === 'ConditionalExpression' && m.location.start.line + 1 === 3 && m.location.end.line + 1 === 4;
    const of = async (changed: number[]) => {
      const target = changeTarget('src/a.ts', text, { changed, deletedAfter: [] })!;
      const here = await made(text, target.ranges!.map(([s, e]) => ({ start: { line: s - 1, column: 0 }, end: { line: e - 1, column: Number.MAX_SAFE_INTEGER } })));
      const found = here.find(clause);
      return found && gates(target, { start: { line: found.location.start.line + 1, column: 1 }, end: { line: found.location.end.line + 1, column: 1 } });
    };
    expect(await of([3, 4])).toBe(true);
    // One line of it alone holds neither the label's body nor the clause whole.
    expect(await of([3])).toBeUndefined();
    expect(await of([4])).toBeUndefined();
  });

  it('widens a changed case label, and a line of its body, to that line only, braces or not', () => {
    const text = [
      'export function f(n: number, log: () => void): number {',
      '  switch (n) {',
      '    case 0:',
      '      return -1;',
      '    case 1: {',
      '      log();',
      '      return 1;',
      '    }',
      '    default: log();',
      '      return 0;',
      '  }',
      '}',
    ].join('\n');
    for (const line of [3, 4, 5, 6, 8, 9, 10]) expect(rangesOf(text, [line]), `line ${line}`).toEqual([[line, line]]);
  });

  it('widens a changed comment-only line to itself only and gates nothing by it, inside an object or a condition too', async () => {
    const text = [
      'export function f(a: number, b: number) {',
      '  const table = {',
      '    x: a,',
      '    // the second',
      '    y: b,',
      '    inner: {',
      '      // deep',
      '      z: 1,',
      '    },',
      '  };',
      '  if (a > 0 &&',
      '      // and b',
      '      b > 0) return table;',
      '  return a + b > 0;',
      '}',
    ].join('\n');
    const gating = async (changed: number[]) => {
      const target = changeTarget('src/a.ts', text, { changed, deletedAfter: [] })!;
      const here = await made(text, target.ranges!.map(([s, e]) => ({ start: { line: s - 1, column: 0 }, end: { line: e - 1, column: Number.MAX_SAFE_INTEGER } })));
      return here.filter(m => gates(target, { start: { line: m.location.start.line + 1, column: 1 }, end: { line: m.location.end.line + 1, column: 1 } }))
        .map(m => `${m.mutatorName} ${m.location.start.line + 1}-${m.location.end.line + 1}`);
    };
    // Alone such a line changes no code, so there is no target; beside a line of code elsewhere it widens to itself.
    expect(changeTarget('src/a.ts', text, { changed: [4], deletedAfter: [] })).toBeNull();
    expect(rangesOf(text, [4, 14])).toEqual([[4, 4], [14, 14]]);
    const alone = await gating([14]);
    expect(alone.length).toBeGreaterThan(0);
    expect(await gating([4, 14])).toEqual(alone);
    expect(await gating([12, 14])).toEqual(alone);
    // Beside a changed code line that takes the statement whole, the comment in the nested object gates nothing.
    const beside = await gating([3, 7]);
    expect(beside).toContain('ObjectLiteral 2-10');
    expect(beside).not.toContain('ObjectLiteral 6-9');
  });

  it('names the lines of a file taken whole that only the emptying of their body covers', async () => {
    const text = [
      "import { Pool } from 'pg';",
      'export async function sweep(pool: Pool, a: string, b: string): Promise<void> {',
      '  await pool.query(a);',
      '  await pool.query(b);',
      '  if (a === b) return;',
      '  [a, b].forEach(name => {',
      '    console.log(name);',
      '  });',
      '}',
      '',
    ].join('\n');
    const whole = await made(text, true);
    expect(whole.filter(m => m.mutatorName === 'BlockStatement').map(m => m.location.start.line + 1)).toEqual([2, 6]);
    expect(untouched('src/a.ts', text, Array.from({ length: 10 }, (_, i) => i + 1), spansOf(whole))).toEqual([1, 2, 3, 4]);
  });

  it('names every line no mutant lies wholly on: an emptied object, array or arrow body, a split condition, a chained call', async () => {
    const text = [
      'export function names(items: { id: string; title: string }[]) {',
      '  return items.map(item => ({',
      '    id: item.id,',
      '    name: item.title,',
      '  }));',
      '}',
      'export const handlers = {',
      '  a: makeA(),',
      '  b: makeB(),',
      '};',
      'export const steps = [',
      '  stepA(),',
      '  stepB(),',
      '];',
      'export const ready = isReady() &&',
      '  hasLease();',
      'export function pick(rows: { ok: boolean }[], other: { ok: boolean }[]) {',
      '  const ready = other',
      '    .filter(r => r.ok)',
      '    .sort();',
      '  return ready;',
      '}',
      'export const config = Object.freeze({',
      '  retries: 3,',
      '});',
      '',
    ].join('\n');
    const whole = await made(text, true);
    expect(whole.map(m => `${m.mutatorName} ${m.location.start.line + 1}-${m.location.end.line + 1}`)).toEqual(expect.arrayContaining(
      ['ArrowFunction 2-5', 'ObjectLiteral 2-5', 'ObjectLiteral 7-10', 'ArrayDeclaration 11-14', 'LogicalOperator 15-16', 'MethodExpression 18-20',
        'ArrowFunction 19-19', 'ObjectLiteral 23-25']));
    expect(untouched('src/a.ts', text, Array.from({ length: 26 }, (_, i) => i + 1), spansOf(whole)))
      .toEqual([1, 2, 3, 4, 7, 8, 9, 11, 12, 13, 15, 16, 17, 18, 20, 21, 23, 24]);
  });

  it('names an else, try, finally or do line no mutant lies on: each carries behaviour', async () => {
    const text = [
      'export function f(ok: boolean) {',
      '  if (ok) {',
      '    run();',
      '  } else {',
      '    wait();',
      '  }',
      '  try {',
      '    run();',
      '  } finally {',
      '    done();',
      '  }',
      '  do {',
      '    run();',
      '  } while (ok);',
      '}',
      '',
    ].join('\n');
    const whole = await made(text, true);
    expect(untouched('src/a.ts', text, [4, 7, 9, 12], spansOf(whole))).toEqual([4, 7, 9, 12]);
  });
});

describe.runIf(stryker)('the targets', () => {
  // A plan of the given entries and untracked files: each file's text, and its
  // text at the base where that differs.
  const planOf = (entries: { status: string; file: string; from?: string }[], untracked: string[], texts: Record<string, string>, bases: Record<string, string> = {}) =>
    planChange({ entries, untracked, read: file => texts[file], readBase: file => bases[file] ?? texts[file], nameOf: file => file });
  const changedAt = (text: string, n: number) => text.split('\n').map((line, i) => (i === n - 1 ? `${line} // was` : line)).join('\n');

  it('names every changed file it does not mutate, and why', () => {
    const plan = planOf(
      [
        { status: 'M', file: 'src/webui/public/app.jsx' },
        { status: 'M', file: 'src/bot/types.d.ts' },
        { status: 'M', file: 'src/bot/modules/x/module.json' },
        { status: 'M', file: 'src/a.ts' },
        { status: 'D', file: 'src/gone.ts' },
      ],
      ['src/webui/public/new.js', 'src/new.ts', 'src/mod/', 'tools/mod/', 'src/vend/node_modules/a.ts'],
      { 'src/a.ts': SAMPLE, 'src/new.ts': 'export const n = 1;\n', 'src/vend/node_modules/a.ts': 'export const v = 1;\n' },
    );
    expect(plan.skipped.map(s => s.file)).toEqual([
      'src/webui/public/app.jsx', 'src/bot/types.d.ts', 'src/bot/modules/x/module.json', 'src/a.ts', 'src/gone.ts', 'src/webui/public/new.js', 'src/mod/', 'tools/mod/',
      'src/vend/node_modules/a.ts',
    ]);
    expect(plan.skipped.every(s => s.why.length > 0)).toBe(true);
    expect(plan.skipped.find(s => s.file === 'src/a.ts')?.why).toBe('no code changed (a rename, a mode change, line endings only, only blank lines or comments, or a file only taken out of the index)');
    expect(plan.skipped.find(s => s.file === 'src/mod/')?.why).toBe('an untracked git repository: git lists none of its files, so none is mutated');
    expect(plan.skipped.find(s => s.file === 'tools/mod/')?.why).toBe('outside src');
    expect(plan.targets).toEqual([wholeTarget('src/new.ts')]);
    expect(notMutated('test/x.ts')).toBe('outside src');
    // A TypeScript module named for its output's format is code, its declarations are not, and it is read as TypeScript.
    for (const file of ['src/a.mts', 'src/a.cts', 'src/a.tsx']) expect(notMutated(file), file).toBeNull();
    for (const file of ['src/a.d.mts', 'src/a.d.cts', 'src/a.d.ts']) expect(notMutated(file), file).toBe('not code');
    // Stryker links a node_modules dir into a sandbox and never copies it; and vitest's related runs drop an import whose
    // path holds the text anywhere, so a name that only holds it is named too.
    expect(notMutated('src/vend/node_modules/a.ts')).toBe('under a node_modules dir, which Stryker links into a sandbox and never copies, so no mutant can be made in it');
    const text = "its path holds the text node_modules, and vitest's related runs drop every import whose path holds it, so no test would reach its mutants; rename it";
    for (const file of ['src/node_modules.ts', 'src/bot/utils/node_modules_paths.ts', 'src/node_modules_cache/x.ts']) expect(notMutated(file), file).toBe(text);
    expect(notMutated('src/Node_Modules.ts')).toBeNull();
    // A diff names a file by git's name; after a rename by case outside git, its name on disk is judged too.
    const renamed = planChange({
      entries: [{ status: 'M', file: 'src/bot/utils/Node_Modules_Paths.ts' }, { status: 'R', from: 'src/old.ts', file: 'src/Node_Modules.ts' }],
      untracked: [],
      read: () => 'export const x = 1;\n',
      readBase: () => 'export const x = 0;\n',
      nameOf: file => file.toLowerCase(),
    });
    expect(renamed.targets).toEqual([]);
    expect(renamed.skipped).toEqual([
      { file: 'src/bot/utils/node_modules_paths.ts', why: text },
      { file: 'src/node_modules.ts', why: text },
      { file: 'src/old.ts', why: 'moved to src/node_modules.ts: nothing is left to mutate' },
    ]);
  });

  it('does not mutate a file where only comments changed, and names code made a comment as code taken out', () => {
    const lines = SAMPLE.split('\n');
    const noted = [...lines.slice(0, 6), '    // the first key', ...lines.slice(6)].join('\n');
    const commented = lines.map((line, i) => (i === 9 ? '  // return table.x;' : line)).join('\n');
    const plan = planOf(
      [{ status: 'M', file: 'src/noted.ts' }, { status: 'M', file: 'src/commented.ts' }],
      [],
      { 'src/noted.ts': noted, 'src/commented.ts': commented },
      { 'src/noted.ts': SAMPLE, 'src/commented.ts': SAMPLE },
    );
    expect(plan.skipped).toEqual([{ file: 'src/noted.ts', why: NO_CODE_WHY }]);
    expect(plan.targets).toEqual([{ file: 'src/commented.ts', ranges: [[10, 10]], gating: [], patterns: ['src/commented.ts:10-10'], deleted: [9] }]);
  });

  it('gates code a comment taken away brings back, though only comment lines changed', () => {
    const lines = SAMPLE.split('\n');
    const hidden = [...lines.slice(0, 9), '  /*', lines[9], '  */', ...lines.slice(10)].join('\n');
    const plan = planOf([{ status: 'M', file: 'src/revived.ts' }], [], { 'src/revived.ts': SAMPLE }, { 'src/revived.ts': hidden });
    expect(plan.skipped).toEqual([]);
    expect(plan.targets).toEqual([{ file: 'src/revived.ts', ranges: [[10, 10]], gating: [10], patterns: ['src/revived.ts:10-10'] }]);
  });

  it('takes a file new to the mutated code whole, and names one moved out of it', () => {
    const plan = planOf(
      [
        { status: 'R', from: 'updaters/u.ts', file: 'src/u.ts' },
        { status: 'R', from: 'src/webui/public/v.js', file: 'src/v.ts' },
        { status: 'A', file: 'src/added.ts' },
        { status: 'R', from: 'src/old.ts', file: 'src/new.ts' },
        { status: 'R', from: 'src/x.ts', file: 'tools/x.ts' },
      ],
      [],
      { 'src/u.ts': SAMPLE, 'src/v.ts': SAMPLE, 'src/added.ts': SAMPLE, 'src/new.ts': SAMPLE },
      { 'src/old.ts': changedAt(SAMPLE, 7) },
    );
    expect(plan.targets).toEqual([
      wholeTarget('src/u.ts'), wholeTarget('src/v.ts'), wholeTarget('src/added.ts'), changeTarget('src/new.ts', SAMPLE, { changed: [7], deletedAfter: [] }),
    ]);
    expect(plan.skipped).toEqual([{ file: 'tools/x.ts', why: 'outside src' }, { file: 'src/x.ts', why: 'moved to tools/x.ts: nothing is left to mutate' }]);
    expect(plan.emptyScope).toBe(false);
  });

  it('diffs a file only taken out of the index (git rm --cached) against the base, never as both deleted and new', () => {
    const plan = planOf(
      [{ status: 'D', file: 'src/kept.ts' }, { status: 'D', file: 'src/edited.ts' }, { status: 'D', file: 'src/gone.ts' }],
      ['src/kept.ts', 'src/edited.ts', 'src/fresh.ts'],
      { 'src/kept.ts': SAMPLE, 'src/edited.ts': SAMPLE, 'src/fresh.ts': SAMPLE },
      { 'src/edited.ts': changedAt(SAMPLE, 4) },
    );
    expect(plan.targets).toEqual([changeTarget('src/edited.ts', SAMPLE, { changed: [4], deletedAfter: [] }), wholeTarget('src/fresh.ts')]);
    expect(plan.skipped).toEqual([
      { file: 'src/kept.ts', why: NO_CODE_WHY },
      { file: 'src/gone.ts', why: 'deleted: nothing is left to mutate' },
    ]);
    // ... and so is one git pairs with an added file as a rename; the rename stays one, as the index holds it.
    const renamed = planOf([{ status: 'R', from: 'src/old.ts', file: 'src/new.ts' }], ['src/old.ts'], { 'src/old.ts': changedAt(SAMPLE, 4), 'src/new.ts': SAMPLE });
    expect(renamed.targets).toEqual([changeTarget('src/new.ts', SAMPLE, { changed: [4], deletedAfter: [] })]);
    expect(renamed.skipped).toEqual([{ file: 'src/old.ts', why: NO_CODE_WHY }]);
    // A move out of src keeps the file on disk diffed, never named as moved away.
    const out = planOf([{ status: 'R', from: 'src/old.ts', file: 'tools/old.ts' }], ['src/old.ts'], { 'src/old.ts': SAMPLE });
    expect(out.targets).toEqual([]);
    expect(out.skipped).toEqual([{ file: 'tools/old.ts', why: 'outside src' }, { file: 'src/old.ts', why: NO_CODE_WHY }]);
  });

  it('answers for every line a whole file or a pattern covers, and for the changed lines of a diff', () => {
    expect(linesOfTarget({ gating: [3, 7], patterns: ['src/a.ts:2-9'] }, 11)).toEqual([3, 7]);
    expect(linesOfTarget({ gating: null, patterns: ['src/new.ts'] }, 4)).toEqual([1, 2, 3, 4]);
    expect(linesOfTarget({ gating: null, patterns: ['src/a.ts:3-5', 'src/a.ts:5-6', 'src/a.ts:10-99'] }, 11)).toEqual([3, 4, 5, 6, 10, 11]);
  });

  it('does not mutate a file holding a line break the gate does not count, and says why', () => {
    const [ls, ps] = [String.fromCharCode(0x2028), String.fromCharCode(0x2029)];
    const texts: Record<string, string> = {
      'src/sep.ts': `export const s = 'a${ls}b';\nexport const t = 1;\n`,
      'src/cr.ts': 'export const a = 1;\r\rexport const b = 2;\n',
      'src/crlf.ts': 'export const a = 1;\r\nexport const b = 2;\r\n',
      'src/new.ts': `export const n = 'x${ps}y';\n`,
    };
    const plan = planOf(['src/sep.ts', 'src/cr.ts', 'src/crlf.ts'].map(file => ({ status: 'M', file })), ['src/new.ts'], texts,
      { 'src/sep.ts': '', 'src/cr.ts': '', 'src/crlf.ts': 'export const a = 1;\nexport const b = 3;\n' });
    expect(plan.skipped.map(s => s.file)).toEqual(['src/sep.ts', 'src/cr.ts', 'src/new.ts']);
    for (const s of plan.skipped) expect(s.why).toMatch(/^it holds a line break Stryker counts and the gate does not/);
    expect(plan.targets.map(t => [t.file, t.gating])).toEqual([['src/crlf.ts', [2]]]);
  });

  it('takes a file under the name it has on disk, relative to the manager root', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smdb-names-'));
    const outside = path.join(os.tmpdir(), `smdb-outside-${process.pid}.ts`);
    onTestFinished(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { force: true }); });
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'Foo.ts'), 'export const x = 1;\n');
    fs.writeFileSync(outside, 'export const y = 1;\n');
    expect(canonicalName(root, 'src/Foo.ts')).toBe('src/Foo.ts');
    expect(canonicalName(root, `.${path.sep}src${path.sep}Foo.ts`)).toBe('src/Foo.ts');
    expect(canonicalName(root, 'src/../src/Foo.ts')).toBe('src/Foo.ts');
    if (process.platform === 'win32') expect(canonicalName(root, 'SRC/foo.TS')).toBe('src/Foo.ts');
    for (const refused of ['src/missing.ts', 'src', 'src/*.ts', 'src/+(Foo|Bar).ts', outside]) expect(canonicalName(root, refused), refused).toBe(null);
  });

  it('gives Stryker a name exactly when Stryker reads it as itself: no glob magic, and its whole path matches itself', async () => {
    const { FileMatcher } = await import('../node_modules/@stryker-mutator/core/dist/src/config/file-matcher.js');
    const { Minimatch } = createRequire(createRequire(__filename).resolve('@stryker-mutator/core/package.json'))('minimatch') as typeof import('minimatch');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smdb-strykernames-'));
    onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
    const taken = ['src/plain.ts', 'src/a+b.ts', 'src/x!.ts', 'src/(old)/y.ts', 'src/@types/x.ts', 'src/foo (1).ts'];
    const refused = ['src/[id].ts', 'src/a{1,2}.ts', 'src/a{1..3}.ts', 'src/+(x).ts'];
    for (const name of [...taken, ...refused]) {
      fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
      fs.writeFileSync(path.join(root, name), 'export const x = 1;\n');
      // The name on disk, whatever it holds; whether Stryker takes it is asked apart.
      expect(canonicalName(root, name), name).toBe(name);
      const whole = path.join(root, name);
      // Stryker refuses a pattern with lines that holds magic, and matches a pattern to the files it crawls.
      const stryker = !new Minimatch(`${name}:1-2`).hasMagic() && (() => { try { return new FileMatcher(whole, false).matches(whole); } catch { return false; } })();
      expect(stryker, name).toBe(taken.includes(name));
      expect(strykerTakes(root, name), name).toBe(taken.includes(name));
    }
  });

  it('tells which mutants a pattern made by its lines', () => {
    const at = (start: number, end: number) => ({ start: { line: start, column: 1 }, end: { line: end, column: 9 } });
    expect(inPattern('src/a.ts', at(3, 4))).toBe(true);
    expect(inPattern('src/a.ts:2-5', at(3, 4))).toBe(true);
    expect(inPattern('src/a.ts:2-5', at(5, 6))).toBe(false);
    expect(inPattern('src/a.ts:2150-2150', at(215, 215))).toBe(false);
    const targets = ['src/a.ts:215-215', 'src/a.ts:2150-2150', 'src/a.ts:1-3', 'src/b.ts'].map(pattern => ({ file: pattern.replace(/:.*$/, ''), patterns: [pattern], gating: null }));
    expect(unmatchedPatterns(targets, [{ file: 'src/a.ts', location: at(215, 215) }])).toEqual(['src/a.ts:2150-2150', 'src/a.ts:1-3', 'src/b.ts']);
    expect(unmatchedPatterns([{ file: 'src/a.ts', patterns: ['src/a.ts:1-3'], gating: [2] }], [])).toEqual([]);
  });

  it('names a place where code was taken out and widens nothing for it', () => {
    expect(changeTarget('src/a.ts', SAMPLE, { changed: [], deletedAfter: [3] })).toEqual({ file: 'src/a.ts', ranges: [], gating: [], patterns: [], deleted: [3] });
    const edited = changeTarget('src/a.ts', SAMPLE, { changed: [7], deletedAfter: [] });
    expect(edited).not.toHaveProperty('deleted');
    expect(changeTarget('src/a.ts', SAMPLE, { changed: [7], deletedAfter: [3] })).toEqual({ ...edited, deleted: [3] });
    expect(changeTarget('src/a.ts', SAMPLE, { changed: [], deletedAfter: [] })).toBeNull();
  });

  it('gates the mutants that touch a changed line, and calls the rest context', () => {
    const target = changeTarget('src/a.ts', SAMPLE, { changed: [7], deletedAfter: [] });
    expect(target?.patterns).toEqual(['src/a.ts:6-9']);
    const at = (start: number, end: number) => ({ start: { line: start, column: 1 }, end: { line: end, column: 1 } });
    expect(gates({ gating: target?.gating ?? null }, at(7, 7))).toBe(true);
    expect(gates({ gating: target?.gating ?? null }, at(6, 9))).toBe(true);
    expect(gates({ gating: target?.gating ?? null }, at(8, 8))).toBe(false);
    expect(gates({ gating: null }, at(1, 1))).toBe(true);
  });
});
