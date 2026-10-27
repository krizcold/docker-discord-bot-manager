// The command every Stryker pass runs (touched.mjs sets the files and the
// report dir in the env; Stryker adds the active mutant). It runs vitest's fast
// tier on the tests that import the mutated files (every file the gate mutates,
// in every run), stopping at the first failed test. A rerun alone
// (SMDB_MUTATION_CONFIRM=1) gives the config's test and hook limits four times
// their time (SMDB_TEST_TIME_SCALE, read by vitest.config.ts); a limit a test
// sets itself is not scaled. Vitest's output goes to files, one JSON report and
// one log per run, because Stryker buffers what a command prints with Node's
// 1 MB exec limit and an overflow would end the run and count as a kill.
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const started = performance.now();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const testDir = path.join(root, 'test');
// SMDB_MUTATION_VITEST: a test's stand-in for vitest (unit/mutationRunner.test.ts).
const vitest = process.env.SMDB_MUTATION_VITEST || path.join(testDir, 'node_modules', 'vitest', 'vitest.mjs');
const confirm = process.env.SMDB_MUTATION_CONFIRM === '1';
/** @type {string[]} */
const files = JSON.parse(process.env.SMDB_MUTATION_FILES ?? '[]').map((/** @type {string} */ file) => path.join(root, file));
const out = process.env.SMDB_MUTATION_OUT ?? '';
// touched.mjs gives every run with no mutant the id 'none'.
const active = process.env.__STRYKER_ACTIVE_MUTANT__ ?? 'none';
const mutant = active === 'none' ? 'dry' : active;

/** @param {string[]} args */
function fast(args) {
  const base = path.join(out, `${mutant}-fast`);
  const log = fs.openSync(`${base}.log`, 'w');
  try {
    // One worker per run: Stryker already runs several at once, and a run's
    // time must match the run with no mutant it is timed against. No results
    // cache: every sandbox links the one in test/node_modules, so earlier runs
    // would choose which file a run takes first.
    const run = spawnSync(process.execPath, [vitest, ...args, '--bail=1', '--no-cache', '--maxWorkers=1', '--project', 'fast', '--reporter=json', `--outputFile=${base}.json`], {
      cwd: testDir,
      stdio: ['ignore', log, log],
      env: { ...process.env, SMDB_TEST_TIME_SCALE: confirm ? '4' : '1' },
    });
    // A command line past the platform's limit, for one, starts nothing: say so where the report points.
    if (run.error) fs.writeSync(log, `runner.mjs could not start vitest: ${run.error.message}\n`);
    return run.status === 0 ? 0 : 1;
  } finally {
    fs.closeSync(log);
  }
}

if (!out || files.length === 0) {
  console.error('runner.mjs is run by touched.mjs, which sets SMDB_MUTATION_FILES and SMDB_MUTATION_OUT');
  process.exit(2);
}
// A pass on some of the mutants Stryker made runs no test for the others
// (targets.mjs lists the ids it is for; touched.mjs drops the rest's results).
// With no readable list, every mutant runs.
const runIds = process.env.SMDB_MUTATION_RUN;
if (runIds && mutant !== 'dry') {
  /** @type {unknown} */
  let ids = null;
  try { ids = JSON.parse(fs.readFileSync(runIds, 'utf8')); } catch { ids = null; }
  if (Array.isArray(ids) && !ids.includes(mutant)) process.exit(0);
}
// Relative to test/: more files fit on a command line than with the sandbox's absolute paths.
const code = fast(['related', ...files.map(file => path.relative(testDir, file).split(path.sep).join('/')), '--run']);
// A run with no mutant leaves its time, which the run with no mutant after a
// rerun's timeouts is held to (control.mjs), by a monotonic clock, which no
// clock step moves.
if (mutant === 'dry') fs.writeFileSync(path.join(out, 'dry-ms.txt'), String(Math.round(performance.now() - started)));
process.exit(code);
