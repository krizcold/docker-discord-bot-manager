// What the L5 gate concludes from its passes (mutation/README.md). Pure: the
// caller runs Stryker and reads vitest's reports.

/**
 * @typedef {import('./ranges.mjs').Location} Location
 * @typedef {'a' | 'a2'} PassName
 * @typedef {{ id: string | null, dir?: string, status: string, statusReason?: string, killedBy?: string, timeout?: string,
 *   inconclusive?: string, recheck?: string, voided?: string }} PassResult dir: the report dir the id's runs are in
 *   (Stryker numbers each run's mutants anew); recheck: the test that failed only on the machine's texts, so the
 *   mutant reruns alone; voided: why a rerun's kill or timeout no longer counts; a CompileError with an inconclusive
 *   is one only of an unused `@ts-expect-error` (TS2578), which no test met
 * @typedef {{ file: string, location: Location, mutator: string, original: string, replacement: string, gating: boolean,
 *   passes: Partial<Record<PassName, PassResult>> }} MutantRecord
 * @typedef {{ name: string, status?: string, message?: string,
 *   assertionResults?: { status: string, fullName: string, failureMessages?: string[] }[] }} FileReport
 */

// A failure the machine may cause as well as the mutant: a connection refused
// or reset, a resource that ran out, a file held or refused. Matched against
// the first line of a failure unless it is an AssertionError (a stack or a
// child's stderr is never read),
// and only in a pass's first run: a run whose failures all match reruns the
// mutant alone (toConfirm), where the texts are not read, since a failure that
// repeats with the mutant alone, while the run with no mutant after the reruns
// passes, is the mutant's. The list only spares reruns, so it need not be complete.
export const INFRASTRUCTURE = new RegExp([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE', 'EMFILE', 'ENOMEM', 'ENOSPC', 'heap out of memory',
  'EBUSY', 'EPERM', 'ENOTEMPTY', 'EACCES',
].join('|'));
// A test or its hook that ran out of vitest's time: the mutant may hang it, or
// the host was slow.
export const TIMEOUT = /(Test|Hook) timed out in \d+ ?ms/;

/** @param {string} name */
const testFile = name => name.split('\\').join('/').replace(/^.*\/\.stryker-tmp\/sandbox-[^/]+\/test\//, '');
/** @param {string} text */
const firstLine = text => text.split('\n')[0];

/**
 * What a run that Stryker counted as a kill shows, from the vitest reports it
 * left: a kill when a test itself failed, in a first run for a reason other
 * than the machine's texts; a timeout only when every failing test timed out
 * and, in a first run, nothing else failed on the machine's texts (a file that
 * could not start included); a recheck when a first run's failing tests failed
 * only on them, or timed out beside them; anything else (no report, a failure
 * only in a beforeAll or afterAll hook or at file level, an unhandled error)
 * proves nothing. vitest counts a beforeEach or afterEach failure as its
 * test's, so it counts as a test's.
 * @param {{ testResults?: FileReport[] }[]} reports
 * @param {boolean} [alone] a rerun of the mutant alone: the machine's texts are not read
 * @returns {{ killedBy: string } | { timeout: string } | { recheck: string, inconclusive: string } | { inconclusive: string }}
 */
export function classifyKill(reports, alone = false) {
  if (reports.length === 0) return { inconclusive: 'no vitest report was written' };
  /** @type {{ test: string, message: string }[]} */
  const failed = [];
  /** @type {string[]} */
  const fileMessages = [];
  for (const report of reports) {
    for (const file of report.testResults ?? []) {
      if (file.status === 'failed' && file.message) fileMessages.push(firstLine(file.message));
      for (const test of file.assertionResults ?? []) {
        if (test.status === 'failed') failed.push({ test: `${testFile(file.name)} > ${test.fullName}`, message: (test.failureMessages ?? []).join('\n') });
      }
    }
  }
  if (failed.length === 0) {
    return { inconclusive: `no test failed: the run failed in a hook, at file level or on an unhandled error${fileMessages[0] ? ` (${fileMessages[0]})` : ''}` };
  }
  /** @param {{ message: string }} f */
  const assertion = f => f.message.startsWith('AssertionError');
  /** @param {{ message: string }} f */
  const machine = f => !alone && !assertion(f) && INFRASTRUCTURE.test(firstLine(f.message));
  /** @param {{ message: string }} f */
  const timedOutTest = f => !assertion(f) && TIMEOUT.test(firstLine(f.message));
  const real = failed.find(f => !machine(f) && !timedOutTest(f));
  if (real) return { killedBy: real.test };
  const machineText = [...failed.filter(machine).map(f => firstLine(f.message)), ...(alone ? [] : fileMessages.filter(text => INFRASTRUCTURE.test(text)))][0];
  const timedOut = failed.find(timedOutTest);
  if (timedOut && machineText === undefined) return { timeout: timedOut.test };
  const recheck = (failed.find(machine) ?? failed[0]).test;
  return { recheck, inconclusive: timedOut ? `a test timed out while the machine failed: ${machineText}` : `only the machine failed: ${firstLine(failed[0].message)}` };
}

/**
 * Whether a type checker's reason (tsc's formatted errors) names only unused
 * `@ts-expect-error` directives (TS2578): the mutated code type-checks, and the
 * one error is that a line under such a directive no longer needs it, so the
 * checker proves nothing and the mutant must meet the tests: a gating one meets
 * pass A's tests again with no checker, and that run is its pass A.
 * @param {string} reason
 */
export function onlyUnusedDirective(reason) {
  const codes = [...reason.matchAll(/error TS(\d+):/g)].map(m => m[1]);
  return codes.length > 0 && codes.every(code => code === '2578');
}

/**
 * One pass's outcome for a mutant.
 * @param {PassResult} result
 */
export function outcomeOf(result) {
  if (result.status === 'Killed') return result.killedBy ? 'Killed' : result.timeout ? 'Timeout' : result.recheck ? 'Recheck' : 'Inconclusive';
  if (result.status === 'CompileError' && result.inconclusive) return 'Inconclusive';
  return result.status;
}

/** @param {MutantRecord} m */
export const latest = m => /** @type {PassResult} */ (m.passes.a2 ?? m.passes.a);

/**
 * A mutant's outcome, counting for a gating one only what its rerun alone
 * confirmed: a timeout counts when the rerun, with four times the config's
 * time limits, times out alone (a test or its beforeEach or afterEach hook, or
 * the whole run past Stryker's budget) or fails a test, and so does a run that
 * failed only on the machine's texts. One the gate never reran, or whose rerun
 * was voided (the run with no mutant after it failed), is inconclusive.
 * @param {MutantRecord} m
 * @returns {{ outcome: string, why?: string }}
 */
export function confirmed(m) {
  const { a2 } = m.passes;
  const last = outcomeOf(latest(m));
  if (last === 'Recheck') return { outcome: 'Inconclusive', why: `${latest(m).inconclusive}, never rerun alone` };
  // Only a later pass can find no mutant at a place pass A made one: a rerun,
  // or pass A again with no checker.
  if (last === 'Missing') return { outcome: 'Inconclusive', why: `pass ${a2 ? 'a2' : 'A with no checker'} made no mutant at this place, so it ran no test on it` };
  if (!m.gating || (last !== 'Killed' && last !== 'Timeout')) return { outcome: last };
  const { voided } = latest(m);
  if (voided) return { outcome: 'Inconclusive', why: voided };
  if (!a2 && last === 'Timeout') return { outcome: 'Inconclusive', why: 'timed out, never rerun alone' };
  return { outcome: last };
}
/** @param {MutantRecord} m */
export const outcome = m => confirmed(m).outcome;

// A gating mutant that ends in one of these fails the gate.
export const FAILING = ['Survived', 'NoCoverage', 'Inconclusive', 'RuntimeError', 'Ignored'];

/**
 * The gating mutants pass A sends to a confirming run of their own (one at a
 * time, with four times the config's time limits): its timeouts, which count
 * when the rerun alone times out or fails a test, and the runs that failed
 * only on the machine's texts, which count when they fail alone.
 * @param {MutantRecord[]} mutants
 */
export const toConfirm = mutants => mutants.filter(m => {
  const status = m.passes.a && outcomeOf(m.passes.a);
  return m.gating && (status === 'Recheck' || status === 'Timeout');
});

/**
 * The gating mutants whose only type error in pass A was an unused
 * `@ts-expect-error`: they meet pass A's tests again with no checker.
 * @param {MutantRecord[]} mutants
 */
export const toUncheck = mutants => mutants.filter(m => m.gating && m.passes.a?.status === 'CompileError' && Boolean(m.passes.a.inconclusive));

/**
 * The verdict and the L5 report.
 * `stopped` names why the gate stopped before it finished (a pass that could
 * not run); the passes it did finish are still reported. `treeChanged` names
 * the files that changed during the run (tree.mjs), so no one tree was tested.
 * `controls` names the runs with no mutant made after the reruns, each passed.
 * `standIn` is set when a test replaced vitest (runner.mjs's
 * SMDB_MUTATION_VITEST): such a run proves nothing about the code.
 * @param {{ stamp: string, scope: string, emptyScope: boolean, skipped: { file: string, why: string }[], mutants: MutantRecord[],
 *   noMutant: { file: string, lines: number[] }[], brackets?: { file: string, lines: number[] }[], deleted?: { file: string, lines: number[] }[],
 *   unmatched: string[], report: string, stopped?: string[], treeChanged?: string[], controls?: string[], standIn?: string }} run
 *   brackets: the changed lines that can move others (ranges.mjs structureLines): brackets and separators only, a brace
 *   of a block, or an else, case, default, catch or finally; deleted: where lines of code were taken out with fewer or
 *   none put back, each after the line named (0: the top)
 * @returns {{ verdict: 'PASS' | 'FAIL' | 'NO RESULT', code: 0 | 1 | 2, lines: string[] }}
 */
export function judge(run) {
  const gating = run.mutants.filter(m => m.gating);
  const context = run.mutants.filter(m => !m.gating);
  const failing = gating.filter(m => FAILING.includes(outcome(m)));
  const made = [...new Set(run.mutants.map(m => m.file))];
  /** @type {'PASS' | 'FAIL' | 'NO RESULT'} */
  let verdict = failing.length > 0 ? 'FAIL' : 'PASS';
  let why = '';
  if (run.standIn) { verdict = 'NO RESULT'; why = `vitest was replaced by a test's stand-in (SMDB_MUTATION_VITEST=${run.standIn})`; }
  else if (run.stopped) { verdict = 'NO RESULT'; why = 'the gate stopped before it finished'; }
  else if (run.treeChanged?.length) { verdict = 'NO RESULT'; why = 'the tree changed during the run, so no one tree was tested'; }
  else if (run.emptyScope) { verdict = 'NO RESULT'; why = 'no src file changed; for a job already committed, pass --base the commit before it'; }
  else if (gating.length === 0) {
    verdict = 'NO RESULT';
    why = `no gating mutant was made, so L5 tested nothing (see what was not mutated, and why${(run.deleted ?? []).length > 0 ? ', and where lines of code were taken out' : ''})`;
  }
  else if (gating.every(m => outcome(m) === 'CompileError')) { verdict = 'NO RESULT'; why = 'every gating mutant was a type error, so no test ran against the change'; }

  /** @param {MutantRecord} m */
  const where = m => `${m.file}:${m.location.start.line}:${m.location.start.column}`;
  /** @param {MutantRecord} m */
  const note = m => {
    const last = latest(m);
    return confirmed(m).why ?? last.inconclusive ?? last.statusReason
      ?? (outcome(m) === 'Timeout' ? (last.timeout ? `timed out alone: ${last.timeout}` : "ran past Stryker's budget alone") : '');
  };
  /** @param {MutantRecord} m */
  const show = m => `  ${where(m)} ${m.mutator}: \`${m.original}\` -> \`${m.replacement}\`${note(m) ? ` (${note(m)})` : ''}`;
  /** @param {MutantRecord[]} list */
  const tally = list => ['Killed', 'Timeout', 'Survived', 'NoCoverage', 'Inconclusive', 'RuntimeError', 'Ignored', 'CompileError']
    .map(status => `${list.filter(m => outcome(m) === status).length} ${status}`).filter(entry => !entry.startsWith('0 ')).join(', ') || 'none';
  /**
   * @param {string} title
   * @param {MutantRecord[]} list
   */
  const section = (title, list) => (list.length > 0 ? [title, ...list.map(show)] : []);
  /** @param {string} status */
  const gatingAt = status => gating.filter(m => outcome(m) === status);

  const lines = [
    `L5 touched-line mutation, ${run.stamp}`,
    `Scope: ${run.scope}`,
    `Mutated: ${made.length > 0 ? made.join(', ') : 'nothing'}`,
    ...(run.skipped.length > 0 ? ['Not mutated:', ...run.skipped.map(s => `  ${s.file}: ${s.why}`)] : []),
    ...(run.unmatched.length > 0 ? ['Patterns that made no mutant:', ...run.unmatched.map(p => `  ${p}`)] : []),
    ...(run.noMutant.length > 0 ? ['Changed lines of code no mutant lies wholly on (L5 says nothing about them; types, imports, signatures, and the code lines of a multi-line object, array, arrow body, call or condition with no mutant of their own; a changed line of brackets and separators only, in a diff, is listed apart):',
      ...run.noMutant.map(n => `  ${n.file}: ${n.lines.join(', ')}`)] : []),
    ...((run.brackets ?? []).length > 0 ? ['Changed lines that can move the unchanged lines beside them into or out of a block (brackets and separators only, a brace of a block, or an else, case, default, catch or finally; the lines they move are not gated, so check them):',
      ...(run.brackets ?? []).map(n => `  ${n.file}: ${n.lines.join(', ')}`)] : []),
    ...((run.deleted ?? []).length > 0 ? ['Places where lines of code were taken out with fewer or none put back (a line made a comment or a blank line included), so what was taken out is left nowhere to mutate (each after the line named, as the file is now; 0 is its top); check the code around each:',
      ...(run.deleted ?? []).map(n => `  ${n.file}: after ${n.lines.join(', ')}`)] : []),
    `Gating mutants (they touch a changed line that holds code, not one blank or a comment only): ${gating.length}: ${tally(gating)}`,
    ...section('Survivors (each needs a test that kills it, or a justification in the notes):', [...gatingAt('Survived'), ...gatingAt('NoCoverage')]),
    ...section('Silenced by a Stryker disable comment (each needs a justification in the notes):', gatingAt('Ignored')),
    ...section("Inconclusive (no test failed for the mutant itself; rerun, or add a test that fails on it: a failure the mutant itself causes only at load, in a beforeAll or afterAll, or as an unhandled error repeats on every rerun, so that test must fail inside its own body, where no static import or failing hook stops it first; mutation/README.md says where):", [...gatingAt('Inconclusive'), ...gatingAt('RuntimeError')]),
    ...section("Timeouts (each timed out when run alone with four times the config's limit, or past the limit a test or hook sets itself: a test or its beforeEach or afterEach hook, or the whole run past its budget; counted as killed, so check each replacement):", gatingAt('Timeout')),
    `Context mutants (in the widened statements, not gating: they touch no changed line that holds code): ${context.length}: ${tally(context)}`,
    ...section('Context survivors:', context.filter(m => outcome(m) === 'Survived')),
    ...(run.controls?.length ? ['Runs with no mutant after the reruns:', ...run.controls.map(line => `  ${line}`)] : []),
    ...(run.stopped ? ['Stopped:', ...run.stopped.map(line => `  ${line}`)] : []),
    ...(run.treeChanged?.length ? ['Changed during the run (so no one tree was tested):',
      `  ${run.treeChanged.slice(0, 10).join(', ')}${run.treeChanged.length > 10 ? ` and ${run.treeChanged.length - 10} more` : ''}`] : []),
    `Report: ${run.report} (mutants.json has every mutant, its passes and what killed it)`,
    `Verdict: ${verdict}${why ? ` (${why})` : ''}`,
  ];
  return { verdict, code: verdict === 'PASS' ? 0 : verdict === 'FAIL' ? 1 : 2, lines };
}
