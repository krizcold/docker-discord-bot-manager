// The L5 gate (VERIFY.md section 2): mutation on the lines a change touched,
// through Stryker's command runner. It runs only in the throwaway container
// linux_mut.sh starts. How to run it and read it: mutation/README.md.
// Usage: node test/mutation/touched.mjs [--base REF] [--mutate PATTERN]... [--concurrency N] [--keep]
// Exit: 0 PASS, 1 FAIL, 2 NO RESULT or a usage error; any other code: interrupted.
// Trust 0 and 1 only after a Verdict line: a process killed on Windows exits 1 too.
import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { pastBudget } from './control.mjs';
import { PACKAGE_LOCKS, treeChanges, treePrint } from './tree.mjs';
import { canonicalName, fileOf as nameOf, keyOf } from './keys.mjs';
import { COMMON, PASSES } from './passes.mjs';

/**
 * @typedef {import('./ranges.mjs').Location} Location
 * @typedef {import('./verdict.mjs').MutantRecord} MutantRecord
 * @typedef {import('./verdict.mjs').PassName} PassName
 * @typedef {import('./verdict.mjs').PassResult} PassResult
 * @typedef {{ file: string, patterns: string[], gating: number[] | null, deleted?: number[] }} PassTarget
 * @typedef {{ id: string, fileName: string, location: Location, mutatorName: string, replacement?: string, status: string, statusReason?: string }} StrykerResult
 * @typedef {import('@stryker-mutator/api/core').PartialStrykerOptions} Options
 */

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 12)) {
  const node = process.env.SMDB_TEST_NODE;
  // A relaunch that is still too old stops here, instead of relaunching again.
  if (!node || process.env.SMDB_MUTATION_RELAUNCHED) {
    console.error(node
      ? `The mutation gate needs Node 22.12 or newer, and SMDB_TEST_NODE (${node}) runs ${process.version}; point it at a newer node binary.`
      : `The mutation gate needs Node 22.12 or newer (this is ${process.version}); set SMDB_TEST_NODE to a newer node binary.`);
    process.exit(2);
  }
  const run = spawnSync(node, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, SMDB_MUTATION_RELAUNCHED: '1' } });
  if (run.error) console.error(`The mutation gate could not start ${node}: ${run.error.message}`);
  process.exit(run.status ?? (run.signal ? 130 : 2));
}

// A mutant runs the manager's code with no fixed data root held back: it can
// write to /data, /DATA or a path an env variable names, so the gate runs only
// where those are throwaway.
if (process.env.SMDB_MUTATION_THROWAWAY !== '1') {
  console.log('Verdict: NO RESULT (the gate runs only in the throwaway container linux_mut.sh starts, which sets SMDB_MUTATION_THROWAWAY=1: a mutant can write to any path the code names, such as /data or /DATA)');
  process.exit(2);
}

// Stryker links into each sandbox only a node_modules that is a dir, never a
// link, and runner.mjs starts vitest from the sandbox's test/node_modules. Read
// before the libraries load through it: npm ci through a link empties the dir
// it names, another checkout's.
const testPackages = fs.lstatSync(fileURLToPath(new URL('../node_modules', import.meta.url)), { throwIfNoEntry: false });
if (testPackages !== undefined && !testPackages.isDirectory()) {
  console.log("Verdict: NO RESULT (test/node_modules is a link, not a dir of this checkout's own, and Stryker links only a dir into its sandboxes, so no run would find the suite's packages; first remove the link itself, never what it names, with node -e \"require('fs').rmSync('test/node_modules')\" from the manager root (it refuses a real dir), then run npm ci in test/: npm ci through the link would empty the other checkout's test/node_modules)");
  process.exit(2);
}

// The libraries load here, so a checkout without the test packages (npm ci in
// test/) ends NO RESULT rather than with a crash's exit code.
/** @type {typeof import('./ranges.mjs')} */
let ranges;
/** @type {typeof import('./verdict.mjs')} */
let verdicts;
try {
  ranges = await import('./ranges.mjs');
  verdicts = await import('./verdict.mjs');
} catch (error) {
  console.log(`Verdict: NO RESULT (the gate could not load: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}; run npm ci in test/, adding --include=dev where a config or NODE_ENV=production leaves dev packages out)`);
  process.exit(2);
}
const {
  structureLines, EXTRA_BREAK_WHY, GLOB_NAME_WHY, beyondTree, checkerDiffers, gatesIn, holdsExtraBreak, linesOfTarget, mutatePatterns,
  notMutated, ownNames, planFromGit, rootGlobFree, rootRelatable, sandboxPatterns, strykerTakes, treeTsconfig, unmatchedPatterns, untouched,
} = ranges;
const { classifyKill, judge, onlyUnusedDirective, outcome, toConfirm, toUncheck } = verdicts;

const USAGE = 'usage: node test/mutation/touched.mjs [--base REF] [--mutate PATTERN]... [--concurrency N] [--keep]';
/** @type {{ base: string, mutate: string[], concurrency: number, keep: boolean }} */
const opts = { base: 'HEAD', mutate: [], concurrency: Math.max(1, Math.floor(os.availableParallelism() / 2)), keep: false };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  const value = () => {
    if (i + 1 >= argv.length) { console.error(`${arg} needs a value\n${USAGE}`); process.exit(2); }
    return argv[++i];
  };
  if (arg === '--base') opts.base = value();
  else if (arg === '--mutate') opts.mutate.push(value());
  else if (arg === '--concurrency') opts.concurrency = Math.max(1, Number(value()) || 1);
  else if (arg === '--keep') opts.keep = true;
  else { console.error(USAGE); process.exit(2); }
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
process.chdir(root);
// No file-system monitor; planFromGit checks by content the files git still skips or trusts.
/** @param {string[]} args */
const git = (...args) => execFileSync('git', ['-c', 'core.quotePath=false', '-c', 'core.fsmonitor=false', ...args], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
/** @param {string} file */
const posix = file => file.split(path.sep).join('/');
/** @param {unknown} error */
const firstLine = error => (error instanceof Error ? error.message.split('\n')[0] : String(error));
if (!rootGlobFree(root)) {
  console.log(`Verdict: NO RESULT (the checkout's path, ${posix(root)}, does not match itself read as a glob, as Stryker reads it: a [ ] class, a { } with a comma or a range, an extglob such as +( ), or one minimatch cannot read; Stryker matches no file to mutate there, so move the checkout)`);
  process.exit(2);
}
if (!rootRelatable(root)) {
  console.log(`Verdict: NO RESULT (the checkout's path, ${posix(root)}, holds the text node_modules, as given or as its real path, and vitest's related runs drop every import under such a path, so no test would meet a mutant; move the checkout)`);
  process.exit(2);
}
// The sandboxes' dir ignores itself, so git status stays clean, from the first
// print on: a sandbox another Stryker run left there is no change.
try {
  fs.mkdirSync(path.join(root, '.stryker-tmp'), { recursive: true });
  fs.writeFileSync(path.join(root, '.stryker-tmp', '.gitignore'), '*\n');
} catch (error) {
  console.log(`Verdict: NO RESULT (the gate could not make .stryker-tmp, where Stryker puts its sandboxes: ${firstLine(error)})`);
  process.exit(2);
}
// The tree as the gate found it before reading any file (tree.mjs), and the
// files that make it: the tracked files and the untracked ones git does not
// ignore. An edit saved from here on shows at the end, and so does an install
// in a dir of packages the runs load (tree.mjs PACKAGE_LOCKS).
const treeFiles = () => git('ls-files', '-z', '--cached', '--others', '--exclude-standard').split('\0').filter(Boolean);
const packages = treePrint(root, PACKAGE_LOCKS);
/** @type {Map<string, string>} */
let planned;
try {
  planned = treePrint(root, treeFiles());
} catch (error) {
  console.log(`Verdict: NO RESULT (the gate could not read the tree: ${firstLine(error)})`);
  process.exit(2);
}
// Every sandbox holds those files and nothing else (ranges.mjs sandboxPatterns).
const sandbox = sandboxPatterns([...planned.keys()]);
// Every run with no mutant carries the id 'none' (runner.mjs), which names no
// mutant, so a test that reacts to the variable being there fails those runs
// too; it also overrides an id set in the shell, which Stryker passes on to the
// command it runs.
process.env.__STRYKER_ACTIVE_MUTANT__ = 'none';
// A pattern is a file, or a file and lines; one with columns names no file, so it is refused.
/** @param {string} pattern */
const fileOfPattern = pattern => pattern.replace(/:\d+-\d+$/, '');
/** @type {Set<string> | undefined} */
let inTree;
// Each --mutate file is taken under the name it has on disk (keys.mjs), the
// name Stryker matches, so its mutants find their target in the report. It
// must be in the tree, which is what a sandbox holds and the fingerprint covers.
opts.mutate = opts.mutate.map(pattern => {
  const file = fileOfPattern(pattern);
  const name = canonicalName(root, file);
  if (name === null) {
    console.error(`--mutate takes a file in the manager root that exists, or such a file and lines, never a glob: ${pattern}\n${USAGE}`);
    process.exit(2);
  }
  let text = '';
  try {
    text = fs.readFileSync(path.join(root, name), 'utf8');
  } catch (error) {
    console.error(`--mutate cannot take ${name}: it could not be read (${/** @type {NodeJS.ErrnoException} */ (error).code ?? firstLine(error)})`);
    process.exit(2);
  }
  inTree ??= ownNames(root, planned.keys());
  const why = !strykerTakes(root, name) ? GLOB_NAME_WHY : holdsExtraBreak(text) ? EXTRA_BREAK_WHY : notMutated(name)
    ?? (inTree.has(name) ? null : 'git neither tracks it nor would add it (it is ignored, or inside a submodule or an untracked repository), so no sandbox holds it');
  if (why) {
    console.error(`--mutate cannot take ${name}: ${why}`);
    process.exit(2);
  }
  return `${name}${pattern.slice(file.length)}`;
});

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
// The process id too: two runs in one checkout that start in the same
// millisecond would otherwise read each other's vitest reports.
const reportDir = path.join(root, 'test', 'mutation', 'reports', `${stamp}-${process.pid}`);

/** @type {PassTarget[]} */
let targets = [];
/**
 * Whether a target can gate: one whose changed lines hold no token, beside a
 * place code was taken out, makes no mutant.
 * @param {PassTarget} target
 */
const canGate = target => target.gating === null || target.gating.length > 0;
// One list: what pass A gives Stryker to mutate is every target of each file a
// target can gate in (all of them, so two names of one file, which differ only
// in case, merge as one diff), and every run, each pass and rerun and each run
// with no mutant, runs the tests related to exactly those files.
const mutated = () => targets.filter(target => targets.some(other => other.file === target.file && canGate(other)));
const changedFiles = () => [...new Set(mutated().map(target => target.file))];
/** @type {{ file: string, why: string }[]} */
let skipped = [];
let scope = opts.mutate.length > 0 ? `the patterns ${opts.mutate.join(' ')}` : `the change from ${opts.base} to the working tree`;
let emptyScope = false;
/** @type {MutantRecord[]} */
let mutants = [];
/** @type {string[]} */
const controls = [];
/** @type {Map<string, string[]>} */
const sources = new Map();

/** @param {string} file */
function linesOf(file) {
  if (!sources.has(file)) sources.set(file, fs.readFileSync(path.join(root, file), 'utf8').split('\n'));
  return sources.get(file) ?? [];
}

/**
 * @param {string} file
 * @param {Location} location
 */
function originalOf(file, location) {
  const first = linesOf(file)[location.start.line - 1] ?? '';
  const text = location.start.line === location.end.line
    ? first.slice(location.start.column - 1, location.end.column - 1)
    : `${first.slice(location.start.column - 1)} ...`;
  return text.length > 100 ? `${text.slice(0, 97)}...` : text;
}

/** @param {StrykerResult} r */
const fileOf = r => nameOf(root, r.fileName);
/** @param {StrykerResult} r */
const resultKey = r => keyOf(fileOf(r), r.mutatorName, r.replacement ?? '', r.location);
/** @param {MutantRecord} m */
const recordKey = m => keyOf(m.file, m.mutator, m.replacement, m.location);
/** @param {MutantRecord} m */
const spanOf = m => `${m.file}:${m.location.start.line}:${m.location.start.column - 1}-${m.location.end.line}:${m.location.end.column - 1}`;

/**
 * The vitest report one run left in a pass's dir.
 * @param {string} name
 * @param {string} id
 */
function reportsOf(name, id) {
  try { return [JSON.parse(fs.readFileSync(path.join(reportDir, name, `${id}-fast.json`), 'utf8'))]; } catch { return []; }
}

/**
 * What failed in the run with no mutant that a dir holds, a line per test file.
 * @param {string} name
 */
function dryFailures(name) {
  /** @type {string[]} */
  const lines = [];
  for (const report of reportsOf(name, 'dry')) for (const file of report.testResults ?? []) {
    if (file.status !== 'failed') continue;
    const failed = (file.assertionResults ?? []).filter((/** @type {{ status: string }} */ t) => t.status === 'failed');
    lines.push(`the run with no mutant failed in ${file.name}: ${(failed[0]?.failureMessages?.[0] ?? file.message ?? '').split('\n')[0]}`);
  }
  return lines;
}

/**
 * One pass's result for a mutant, with a kill checked against the reports.
 * @param {string} dir the pass's report dir
 * @param {StrykerResult} r
 * @param {boolean} [alone] a rerun of the mutant alone
 * @returns {PassResult}
 */
function resultOf(dir, r, alone = false) {
  /** @type {PassResult} */
  const result = { id: r.id, dir, status: r.status, ...(r.statusReason ? { statusReason: r.statusReason.split('\n')[0] } : {}) };
  // A type error only of an unused @ts-expect-error proves nothing: a gating one meets pass A's tests again, with no checker.
  if (r.status === 'CompileError' && onlyUnusedDirective(r.statusReason ?? '')) {
    return { ...result, inconclusive: 'a type error only because a @ts-expect-error went unused (TS2578), so no test ran on it' };
  }
  return r.status === 'Killed' ? { ...result, ...classifyKill(reportsOf(dir, r.id), alone) } : result;
}

class PassError extends Error {}

/** @type {Options} */
const common = {
  ...COMMON,
  commandRunner: { command: `"${process.execPath}" test/mutation/runner.mjs` },
  cleanTempDir: opts.keep ? false : 'always',
  // targets.mjs: in a pass on some of the mutants, the ids runner.mjs runs.
  plugins: ['@stryker-mutator/*', path.join(root, 'test', 'mutation', 'targets.mjs')],
};

/**
 * Runs Stryker once: every run is the fast tier's tests related to every file
 * the gate mutates (runner.mjs). A run `alone` (the reruns, a2, and the run
 * with no mutant after them) gets four times the config's time limits.
 * `keys`, when given, are the mutants the pass is for: Stryker makes every
 * mutant its spans hold, and the others run no test (targets.mjs).
 * @param {{ dir: string, mutate: string[], keys?: string[], alone?: boolean, extra: Options }} run
 * @returns {Promise<StrykerResult[]>}
 */
async function stryker({ dir, mutate, keys, alone = false, extra }) {
  const out = path.join(reportDir, dir);
  fs.mkdirSync(out, { recursive: true });
  process.env.SMDB_MUTATION_CONFIRM = alone ? '1' : '';
  process.env.SMDB_MUTATION_FILES = JSON.stringify(changedFiles());
  process.env.SMDB_MUTATION_OUT = out;
  process.env.SMDB_MUTATION_TARGETS = keys ? path.join(out, 'targets.json') : '';
  process.env.SMDB_MUTATION_RUN = keys ? path.join(out, 'run-ids.json') : '';
  if (keys) fs.writeFileSync(path.join(out, 'targets.json'), JSON.stringify(keys));
  if (sandbox.unkept.length > 0) {
    throw new PassError(`the gate cannot give Stryker ${sandbox.unkept.join(', ')} for a sandbox, for it would read the name as a glob; rename it`);
  }
  const { Stryker } = await import('@stryker-mutator/core');
  return new Stryker({ ...common, ignorePatterns: sandbox.patterns, mutate, ...extra }).runMutationTest();
}

/**
 * Runs one Stryker pass (stryker()); one that cannot run stops the gate, with
 * what its run with no mutant said.
 * @param {{ dir: string, mutate: string[], keys?: string[], alone?: boolean, extra: Options }} run
 * @returns {Promise<StrykerResult[]>}
 */
async function pass(run) {
  try {
    return await stryker(run);
  } catch (error) {
    if (error instanceof PassError) throw error;
    const out = path.join(reportDir, run.dir);
    const lines = [`pass ${run.dir} could not run: ${firstLine(error)}`, ...dryFailures(run.dir)];
    if (fs.readdirSync(out).some(f => f.startsWith('dry-') && f.endsWith('.log'))) lines.push(`the run with no mutant logged to ${posix(path.relative(root, out))}/dry-*.log`);
    throw new PassError(lines.join('\n'));
  }
}

/**
 * Runs pass A's tests once more with no mutant after the reruns alone counted
 * a kill or a timeout: those count only if the tests still pass without a
 * mutant. It runs as the reruns did, a Stryker run of its own over their spans
 * (a fresh sandbox of the tree, the same code made and none of it active), that
 * ends after its run with no mutant (dryRunOnly). When the tests fail, the
 * machine went bad during the reruns, so their results are voided and the gate
 * stops. When the reruns confirmed a timeout (`timed`), the tests must also
 * fit in the budget Stryker gave each rerun (control.mjs), or the machine was
 * as slow as the mutants seemed.
 * @param {MutantRecord[]} on
 * @param {boolean} timed
 */
async function control(on, timed) {
  const dir = 'control-a2';
  const out = path.join(reportDir, dir);
  console.log('L5: the same tests once with no mutant, to check the machine after pass a2');
  let failed = '';
  try {
    // Bound by an hour, above the budget any rerun had (four times its own run with no mutant, which ran under
    // Stryker's five minutes, plus a minute), so the budget, not the bound, judges the time.
    await stryker({ dir, mutate: [...new Set(on.map(spanOf))], alone: true, extra: { ...PASSES.a2, dryRunOnly: true, dryRunTimeoutMinutes: 60 } });
    if (timed) failed = pastBudget(path.join(reportDir, 'a2'), out, PASSES.a2);
  } catch (error) {
    if (error instanceof PassError) throw error;
    failed = firstLine(error);
  }
  const logs = `${posix(path.relative(root, out))}/dry-*.log`;
  if (failed) {
    const why = 'the run with no mutant after pass a2 failed';
    for (const m of on) {
      const result = m.passes.a2;
      if (result) m.passes.a2 = { ...result, voided: why };
    }
    throw new PassError([
      `${why} (${failed}), so what its reruns counted cannot be told from the machine's failures`,
      ...dryFailures(dir), ...(fs.readdirSync(out).some(f => f.endsWith('.log')) ? [`its logs: ${logs}`] : []),
    ].join('\n'));
  }
  controls.push(`after pass a2: passed (${logs})`);
}

/** @param {MutantRecord} m */
const credited = m => ['Killed', 'Timeout'].includes(outcome(m));

/**
 * Runs a pass on exactly the given mutants and records its results on them.
 * @param {PassName} name
 * @param {string} dir
 * @param {MutantRecord[]} on
 * @param {Options} extra
 */
async function passOn(name, dir, on, extra) {
  const results = await pass({ dir, mutate: [...new Set(on.map(spanOf))], keys: on.map(recordKey), alone: name === 'a2', extra });
  const byKey = new Map(results.map(r => [resultKey(r), r]));
  for (const m of on) {
    const r = byKey.get(recordKey(m));
    m.passes[name] = r ? resultOf(dir, r, name === 'a2') : { id: null, dir, status: 'Missing' };
  }
}

/**
 * The verdict, the report files and the exit, once the report has reached
 * stdout: awaited, it never settles, so nothing runs after it.
 * @param {string[]} [stopped]
 * @returns {Promise<never>}
 */
function finish(stopped) {
  try {
    report(stopped, [...treeChanges(planned, treePrint(root, treeFiles())), ...treeChanges(packages, treePrint(root, PACKAGE_LOCKS))].sort());
  } catch (error) {
    console.log(`Verdict: NO RESULT (the report could not be written: ${firstLine(error)})`);
    process.exit(2);
  }
  return new Promise(() => {});
}

/**
 * @param {string[] | undefined} stopped
 * @param {string[]} treeChanged
 */
function report(stopped, treeChanged) {
  /** @type {{ file: string, lines: number[] }[]} */
  const noMutant = [];
  /** @type {{ file: string, lines: number[] }[]} */
  const brackets = [];
  /** @type {{ file: string, lines: number[] }[]} */
  const deleted = [];
  const unmatched = stopped && mutants.length === 0 ? [] : unmatchedPatterns(targets, mutants);
  for (const target of targets) {
    const made = mutants.filter(m => m.file === target.file);
    if (stopped && mutants.length === 0) continue;
    let text;
    try {
      text = linesOf(target.file).join('\n');
    } catch (error) {
      // Deleted during the run: the tree check names it.
      if (treeChanged.length > 0) continue;
      throw error;
    }
    const moved = target.gating ? structureLines(target.file, text, target.gating) : [];
    if (moved.length > 0) brackets.push({ file: target.file, lines: moved });
    if (target.deleted) deleted.push({ file: target.file, lines: target.deleted });
    /** @type {[number, number][]} */
    const spans = made.map(m => [m.location.start.line, m.location.end.line]);
    const lines = untouched(target.file, text, linesOfTarget(target, text.split('\n').length), spans);
    if (lines.length > 0) noMutant.push({ file: target.file, lines });
  }
  const result = judge({ stamp, scope, emptyScope, skipped, mutants, noMutant, brackets, deleted, unmatched, report: posix(path.relative(root, reportDir)), stopped, treeChanged, controls, standIn: process.env.SMDB_MUTATION_VITEST });
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(path.join(reportDir, 'mutants.json'), `${JSON.stringify({ scope, skipped, targets, mutants, controls, verdict: result.verdict, stopped, treeChanged }, null, 2)}\n`);
  fs.writeFileSync(path.join(reportDir, 'summary.txt'), `${result.lines.join('\n')}\n`);
  // On POSIX a pipe takes stdout asynchronously: exit only once it has all of it.
  process.stdout.write(`${result.lines.join('\n')}\n`, () => process.exit(result.code));
}

try {
  // What to mutate: the explicit patterns (every mutant gates), or the change
  // from the merge-base of --base and HEAD to the working tree.
  if (opts.mutate.length > 0) {
    targets = opts.mutate.map(pattern => ({ file: fileOfPattern(pattern), patterns: [pattern], gating: null }));
  } else {
    const base = git('merge-base', opts.base, 'HEAD').trim();
    ({ targets, skipped, emptyScope } = planFromGit({ git, base, root, read: file => linesOf(file).join('\n') }));
    scope = `the change from ${opts.base} (merge-base ${base.slice(0, 7)}) to the working tree`;
  }
  // Nothing that could gate (only places where code was taken out): the report names them, and Stryker is never
  // given an empty list to mutate.
  if (!targets.some(canGate)) await finish();

  console.log(`L5: mutating ${scope}: ${changedFiles().length} file(s), pass A (in-process tests that import them)`);
  // The type checker judges the tree's files only (ranges.mjs treeTsconfig, beyondTree), with the TypeScript and
  // the packages the root lockfile ships (checkerDiffers).
  const compiler = checkerDiffers(root);
  if (compiler) throw new PassError(compiler);
  const checkerConfig = `.stryker-tmp/tsconfig.l5-${process.pid}.json`;
  const checker = treeTsconfig(root, planned.keys(), '.stryker-tmp');
  const beyond = beyondTree(root, planned.keys(), checker, '.stryker-tmp');
  if (beyond.length > 0) {
    throw new PassError(`the type checker would judge ${beyond.join(', ')}, which a file in the tree imports or references but no sandbox holds, so a mutant that broke only it would count as killed with no test run; make the tree's file stop importing or referencing it, or add it to the tree if it belongs there`);
  }
  fs.writeFileSync(path.join(root, checkerConfig), `${JSON.stringify(checker, null, 2)}\n`);
  const resultsA = await pass({ dir: 'a', mutate: mutatePatterns(mutated()), extra: { ...PASSES.a, concurrency: opts.concurrency, tsconfigFile: checkerConfig } })
    .finally(() => fs.rmSync(path.join(root, checkerConfig), { force: true }));
  const orphans = [...new Set(resultsA.map(fileOf).filter(file => !targets.some(t => t.file === file)))];
  if (orphans.length > 0) throw new PassError(`Stryker mutated ${orphans.join(', ')}, which no target names, so the report could not answer for it`);
  mutants = resultsA.map(r => {
    const file = fileOf(r);
    return {
      file,
      location: r.location,
      mutator: r.mutatorName,
      original: originalOf(file, r.location),
      replacement: r.replacement ?? '',
      gating: gatesIn(targets, file, r.location),
      passes: { a: resultOf('a', r) },
    };
  });

  // Their run with no checker is their pass A, and they go on from it like any other.
  const unchecked = toUncheck(mutants);
  if (unchecked.length > 0) {
    console.log(`L5: pass A again, with no type checker, on ${unchecked.length} mutant(s) whose only type error is an unused @ts-expect-error`);
    await passOn('a', 'a-unchecked', unchecked, { ...PASSES.a, checkers: [], concurrency: opts.concurrency });
  }

  const confirmA = toConfirm(mutants);
  if (confirmA.length > 0) {
    console.log(`L5: pass A again, one at a time, on ${confirmA.length} mutant(s) to confirm alone: timeouts, and runs that failed only on the machine's texts`);
    await passOn('a2', 'a2', confirmA, PASSES.a2);
    if (confirmA.some(credited)) await control(confirmA, confirmA.some(m => outcome(m) === 'Timeout'));
  }
  await finish();
} catch (error) {
  await finish(error instanceof PassError ? error.message.split('\n') : [`the gate stopped: ${firstLine(error)}`]);
}
