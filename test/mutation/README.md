# The touched-line mutation gate (L5)

Documentation/process/VERIFY.md section 2, L5: every job runs mutation on the lines it touched before review, and ends
with zero surviving mutants or each survivor justified in the notes. Stryker runs through its command runner, never its
vitest runner (on vitest 5 that runner silently skips every test inside a describe: stryker-js issue #6210), so the
active mutant travels in `__STRYKER_ACTIVE_MUTANT__`.

| File | What it does |
|---|---|
| touched.mjs | the gate: finds the touched lines, runs the passes, writes the report; exit 0 PASS, 1 FAIL, 2 NO RESULT |
| ranges.mjs | (library) the files git names as changed, their changed lines from the gate's own line diff, and how far each widens; unit/mutationRanges.test.ts |
| verdict.mjs | (library) when a run counts as a kill, which mutants rerun alone, the verdict; unit/mutationVerdict.test.ts |
| runner.mjs | the command every pass runs inside Stryker's sandbox; unit/mutationRunner.test.ts |
| control.mjs | (library) the time check of the run with no mutant after the reruns, and of Stryker's clock in the reruns; unit/mutationRunner.test.ts |
| passes.mjs | (data) the Stryker options every pass shares, and each pass's own options and budget; unit/mutationRunner.test.ts |
| stryker.json | (data) empty on purpose: every pass names it as its config file, so Stryker never reads one it finds in the manager root |
| keys.mjs | (library) how a file and a mutant are named across passes; unit/mutationRanges.test.ts |
| targets.mjs | (Stryker reporter) which mutant ids a later pass runs tests for, and Stryker's own time for each run with no mutant; unit/mutationRunner.test.ts |
| tree.mjs | (library) the fingerprint of the tree a run reads and of the packages it loads, taken before the plan and before the verdict; unit/mutationRanges.test.ts |
| ../vitest.config.ts | the factor on the config's test and hook limits: 4 in a rerun alone and in the run with no mutant after the reruns (a limit a test or hook sets itself is not scaled) |

Rows of the three unit files that load Stryker skip where test/node_modules lacks it (a link to another checkout's
install); linux_mgr.sh installs the test packages from the lockfile and runs them all.

## Running it

The gate runs only in the throwaway container that linux_mut.sh (in the swarm folder of the records) starts, and refuses
anywhere else (NO RESULT): the manager's code names fixed paths (`/data/data`, `/DATA`, `/app`), the gate holds no
file back for that, and a mutant can send a test to any of them. The container clones the manager repository
read-only, checks out the job worktree's HEAD, copies the worktree's files over it (untracked ones included, deleted
ones removed), runs npm ci at the root and in test/, and runs the gate as root. It applies the job's files, not its
git index: a staged rename counts as a deletion and a new file, and a file taken out of the index with
`git rm --cached` stays tracked. Swarm jobs never stage, so this changes nothing for them. The command:

    bash linux_mut.sh <id> [--base REF] [--mutate PATTERN]... [--concurrency N] [--keep]

It prints the gate's exit and its `Verdict:` line, and leaves the gate's output (gate.log), the install's
(install.log), summary.txt and the whole report dir (report/) in out/<id>/l5/. A timeout around the run is the
caller's.

- With no option it mutates the change from HEAD to the working tree: the job before it is committed. For a job already
  committed, pass `--base` the commit before it (the clone holds the repository's local branches, so a branch name
  works too); `--base mgr-int` takes everything since the merge-base with mgr-int. A file new to src is taken whole: an
  untracked one, one added, and one moved in from outside src (or from a browser view, or from a name that is not
  code). A file renamed within src gates its changed lines only when git sees the rename: the new name is staged and
  the file is like enough to the old one for git's own measure (half its content, by default) to pair them. Otherwise
  it is a deletion and a new file, taken whole. A file only taken out of the index (`git rm --cached`, kept on disk and
  not ignored) is diffed against the base as a changed one; one git ignores is out of the tree, so it is a deletion. A
  name that leads through a link is not mutated, and is named (below): a file is mutated under its own name only, when
  git lists it changed.
- `--mutate src/x.ts:10-20` (a file in the manager root that exists and that a diff would mutate, or such a file and
  lines, repeatable; never a glob, never columns, never the suite's own files) skips git's diff (git still lists the
  tree, which is what a sandbox holds); every mutant it makes gates. A file git neither tracks nor would add (one it
  ignores, or one inside a submodule or an untracked repository) is refused: no sandbox holds it. Either way the name
  must be one Stryker reads as itself (ranges.mjs strykerTakes: no glob magic in it, and its whole path matches itself
  as Stryker matches it), so `[id].ts` or `a{1,2}.ts` is refused.
- `--concurrency N` sets pass A's parallel runs (default: half the cores): up to N test commands at once, and two at
  N = 1, since Stryker hands the type checker's slot to a test runner once checking ends. The reruns run one at a
  time: Stryker builds each run's budget from the pass's run with no mutant, made alone.
- `--keep` keeps the sandboxes in `.stryker-tmp/` of the container's clone; they go with the container, so it is of use
  only to someone who changes linux_mut.sh to look inside.
- Exit 0 is PASS, 1 FAIL, 2 NO RESULT (nothing was tested, the tree changed during the run, or the gate stopped: the
  report says which; or, with no report, the gate ran outside linux_mut.sh's container, the test packages are missing
  or test/node_modules is a link, the checkout's path does not match itself read as a glob as Stryker reads it or holds
  the text node_modules (vitest's related runs drop every import under such a path), .stryker-tmp could not be made,
  git could not list the tree, or the report itself could not be written) or a usage error. A mutant id left in the
  shell (`__STRYKER_ACTIVE_MUTANT__`) is ignored. Trust 0 and 1 only after the report's `Verdict:` line.

The gate needs nothing running: the manager's suite is one tier (fast, unit/), so every pass runs it. git only names
the files that changed, over the whole repo, and gives each one's text at the base; the gate finds the changed lines
itself, a shortest line diff of the two texts, so no git setting, attribute or variable moves them
(unit/mutationRanges.test.ts runs it under a hostile config). git does not look at every file (below), so the gate
checks every tracked file git does not name by its content.

## What it mutates

- Each changed line widens to the statement it sits in, taken whole even when a block-bodied callback sits inside, so
  every mutant of a changed operator, condition or call exists. Stryker makes a mutant only when one range holds all of
  it. A line wholly inside a body (a callback's included) widens within that body.
- The headers of compound statements and declarations (an `if`, `for`, `while` or `switch` header, a `catch`, a
  `case` or `default` label, the signature of a function declaration, or of a method, constructor or accessor of a
  class declaration, a class header) widen to that header only, never to the body. Any other line holding the start or
  end of a callback or a body (a route's `router.get('/x', async (req, res) => {`, a `});`, a property whose value is
  an arrow with a body, a method of an object or of a class expression) takes its whole statement: the body runs as
  context, and its emptying, which touches the line, gates.
- A changed line that holds no token (blank, or a comment only) changes no code: it widens to itself only and gates
  nothing. It still joins the ranges on either side of it, so a new function whose body holds a blank line is made
  whole. A file where only such lines changed, and no code was taken out, is not mutated.
- **Gating** mutants touch a changed line that holds code (a token, brackets and separators included). Some that touch
  one are not made: the emptying of a block that only holds the line, the emptying of the body of a compound statement
  or declaration, or of a bare block, that only begins or ends on the changed line, the false condition Stryker gives
  a `for` with no condition (it spans the whole loop), and the emptying of a case clause (it spans the clause). Each is
  made only where one range holds the whole of it (a loop or clause on one line, one whose every line changed, one
  inside a statement taken whole), and then gates as any mutant does. A changed header or label is named in the
  structure list, and in the no-mutant list when no mutant lies wholly on its line. unit/mutationRanges.test.ts holds
  this rule to Stryker's own instrumenter, line by line, both what is made and what is not, on made-up shapes and on
  two real files (src/config/storeFile.ts and src/webui/routes/sources.ts).
- The other mutants in the widened ranges are **context**: they run in pass A and are listed, but never fail the gate.
- What was taken out has no line left to mutate. The report names each place where lines of code were taken out with
  fewer or none put back (a pure deletion, a line deleted beside an edited one, one made a comment or a blank line, an
  unchanged one that a change on another line left with fewer tokens, a block taken away with its body re-indented),
  so a reviewer checks the code around each. A job that only takes code out makes no mutant: the gate names the places
  and ends NO RESULT, with no pass run.
- Lines added in one place, or only taken out, count also over each unchanged line beside them that repeats one of
  them (an `if` block added after an equal one counts in both places): every place the run could slide to passes
  only such lines. With another change in the same file, the diff can split such a run into pieces, and then which
  copy counts is the diff's choice.
- An unchanged line counts as changed when its code changed: the kinds of the tokens on it, read in both texts, in
  order. Whatever on another line made them differ (a comment, a string or a template opened or closed over it, a
  regex read as a division), the line counts as changed if it holds code after, and as a place where code was taken
  out if it holds fewer tokens. A change can also move an unchanged line into or out of a block (a bracket, an `else`,
  a `finally` or a `case` moved past it, a header put around it): that line is not gated. The changed lines that make
  such a move are named under their own heading (a line of brackets and separators only, one holding a brace of a
  block, one holding an `else`, `case`, `default`, `catch` or `finally`), so a reviewer checks the lines beside each.
  Not named: a line moved into or out of a braceless body, and a changed line whose first or last token joins it to
  an unchanged line beside it or splits it off. A reviewer reads each changed braceless header, and both ends of every
  changed line, for these.
- git does not look at every file: not at one its index marks assume-unchanged or skip-worktree, not at one a
  file-system monitor says is unchanged, and not at one whose cached size and time still hold. So the gate hashes every
  tracked file git does not name, with git's filters, and names it changed when that differs from git's index and its
  lines differ from the base's; it names one that is gone as deleted, unless skip-worktree left it out or the base
  never held it.
- Not mutated, and named in the report with the reason: files outside src (the root scripts, authelia/, tests, docs,
  images), files that are not code (code is `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.cjs` and `.mjs`), declaration
  files, the browser views under src/webui/public (copied into dist by the build and never compiled; the tests that
  run them read them as text or run them in a vm, which `vitest related` never selects, so L5 does not cover the
  views), a file under a node_modules dir in src, a file whose path only holds the text node_modules (rename it), a file
  deleted or moved out of src, an untracked git repository or a submodule under src, a file whose name Stryker would
  read as a glob (rename it), a name that leads through a link, a change that leaves no code changed (a rename git
  sees, a mode change, line endings only, only blank lines or comments, a file only taken out of the index), and a
  file that holds a line break Stryker counts and the gate does not (a lone CR, U+2028 or U+2029); `--mutate` refuses
  such a file.
- No file is held back for the paths its code names: a file that reads DATA_DIR or names `/data/data`, `/DATA` or
  `/app` is mutated like any other. A mutant of it (a check made false, a fallback chosen) can send a test to that
  path, which in the container is throwaway; this is why the gate runs nowhere else.
- A changed line of code that no mutant lies wholly on is named in the report: L5 says nothing about it. A mutant that
  spans several lines (emptying a body, an object or an array, flipping a condition split over lines, a chained call)
  counts for none of them; a mutant on one line counts for that whole line. So types, imports, signatures, a bare
  `await f();`, an `else`, `try`, `finally` or `do` line, and every line of a multi-line object, array, arrow body,
  call or condition with no mutant of its own land in the list. A line of brackets and separators only is left out of
  this list; a changed one is named under its own heading. A deleted file is named too. A `--mutate` pattern that made
  no mutant is named on its own.

## The passes

1. **Pass A.** Stryker instruments the ranges in a sandbox copy of the repo that holds the files the gate fingerprints
   and nothing else: the tracked files and the untracked ones git does not ignore, those under a node_modules dir
   aside, which Stryker links instead (ranges.mjs sandboxPatterns). So git's ignored files (`.env`, data/, dist) and
   any file made after the gate started stay out of every sandbox. The TypeScript checker turns type-invalid mutants
   into CompileError. It is given a tsconfig that extends the root's and lists the tree's files only (ranges.mjs
   treeTsconfig); when a tree file imports or references a file outside the tree, the gate stops before pass A with NO
   RESULT and names it (ranges.mjs beyondTree), since a mutant that broke only that file would count as killed with no
   test run. What the checker reads is held to the root lockfile, which the image's build installs: it runs test/'s
   TypeScript, which must be the lockfile's, and reads the packages installed at the root, whose record npm keeps in
   `node_modules/.package-lock.json`; that record must hold the lockfile's packages and no other, each at its version
   with the content the lockfile names. When either differs, the gate stops before pass A with NO RESULT naming the
   first difference (ranges.mjs checkerDiffers). The container's npm ci makes both match. The image builds with
   tsconfig.json, the config the checker extends, so the checker and the image judge the same program; a type error
   only a `.tsx`, `.mts` or `.cts` root that no `.ts` file imports would show is not seen. A gating mutant whose only
   type error is an unused `@ts-expect-error` (TS2578) meets pass A's tests again with no checker (`a-unchecked/`), and
   that run is its pass A. Each mutant run is `vitest related <mutated files> --project fast` with one worker, so only
   tests that import one of the mutated files, directly or through other files, by an ES import or an `import()` of a
   written-out name, run. A test that reaches them another way (any require, a file read, a child process) does not.
   There is no coverage analysis: every mutant runs those tests.
2. **Reruns alone (a2).** A gating mutant that timed out in pass A, or whose run there failed only on the machine's
   texts (below), reruns with pass A's tests, one mutant at a time, with four times the config's test and hook limits
   (20 s and 40 s) and Stryker a larger budget (four times what those tests take with no mutant, plus a minute). It
   counts as killed when the rerun fails a test, whatever the failure says, or times out alone: a test or its
   beforeEach or afterEach hook past its scaled limit, or the whole run past the budget. The scaled limits are below the
   budget's one minute, so a hung test times out by its own limit and the rerun leaves its report; a mutant that only
   slows several tests, each within its limit, past the budget counts as killed too. Each confirmed timeout is listed
   with its replacement, to check. One that survives the rerun is a survivor. A mutant the gate never reran (it
   stopped first) is inconclusive.
3. **A run with no mutant after the reruns.** When a rerun counted a kill or a timeout, the same tests run once more
   with no mutant, the way the reruns ran them: a Stryker run of its own over the reruns' spans, in a fresh sandbox of
   the tree, with the same code made and none of it active, which ends after its run with no mutant (`dryRunOnly`). If
   they fail, the machine went bad during the reruns, so what the reruns counted is inconclusive and the gate ends NO
   RESULT. When a rerun confirmed a timeout, the run must also fit in the budget Stryker gave each rerun, by a
   monotonic clock, or the machine was as slow as the mutant seemed and the gate ends NO RESULT the same way.
   Stryker's reporter leaves its time for the reruns' run with no mutant (dry-timing.json), and runner.mjs times that
   run by a monotonic clock (dry-ms.txt); where the two disagree by more than a second plus a tenth of the run, the
   clock of Stryker's process stepped, so the budget is not what the reruns took, and the gate ends NO RESULT
   (control.mjs). Its bound is an hour, above any rerun's budget. Not seen: a machine that was four times slower for
   one rerun only and well again by the end.

The tree is fingerprinted (every file git tracks or would add: size, time and content) before the plan reads a file,
and again before the verdict, so a tree that changed during the run ends NO RESULT, naming the files. The print also
holds npm's hidden lockfile (`.package-lock.json`) of the root's node_modules and test/node_modules, so an install
during the run ends NO RESULT too. test/node_modules must be a dir of the checkout's own: Stryker links only a dir into
a sandbox, so the gate stops at its start when it is a link.

A run Stryker counts as a kill is checked against vitest's report of it: it is a kill when a test itself failed, and a
timeout when every failing test (or its beforeEach or afterEach hook) timed out. In pass A, a failure that reads like
the machine's proves nothing by itself: refused or reset connections, exhausted resources, a file held or refused
(EBUSY, EPERM, ENOTEMPTY or EACCES). When every failing test failed so, or timed out beside such a failure, the mutant
reruns alone, where the texts are not read. The texts are matched against the first line of each failure unless it is
an AssertionError, never against a stack. Anything else is **inconclusive**: no report, a failure only in a beforeAll
or afterAll hook or at file level, an unhandled error with every test passing, a first run that failed only on the
machine's texts and was never rerun, or a type error only of an unused `@ts-expect-error` that never met the tests. A
failure the mutant itself causes only at load, only in a beforeAll or afterAll, or only as an unhandled error repeats
on every rerun, so the test that kills it must fail inside its own body: import the module with `import()` in a test
file none of whose static imports reaches it, call the hook's code in a test, await what rejects. A pass A kill
stands on one run, so a test that can fail by chance (its own Math.random, the clock, a fixed port or path shared with
a run beside it) still credits a kill. Fast tests use mkdtemp and port 0.

## The report

`test/mutation/reports/<time>-<process id>/` in the container's clone, which linux_mut.sh copies to out/<id>/l5/report/:

- `summary.txt` is the L5 report for the review packet: the scope, what was not mutated and why, patterns or lines no
  mutant touched, the changed lines that can move others, the places code was taken out, the gating mutants by
  outcome, every survivor, silenced and inconclusive mutant with its place and replacement (with why a kill or timeout
  did not count), the confirmed timeouts, the context mutants, the runs with no mutant after the reruns, why the gate
  stopped or which files changed during the run, and the verdict.
- `mutants.json` has every mutant: its place, original text and replacement, whether it gates, and per pass its
  status, the report dir its id is in (Stryker numbers each run's mutants anew) and the test that killed it.
- `a/`, `a-unchecked/` and `a2/` hold, for each mutant run, its vitest JSON report and log (`<id>-fast.json` and
  `.log`; `dry-*` is the run with no mutant, `dry-ms.txt` its monotonic time and `dry-timing.json` Stryker's).
  `a-unchecked/` and `a2/` also hold targets.json and run-ids.json, the mutants the pass is for. `control-a2/` holds
  the run with no mutant after the reruns.

The verdict is FAIL when a gating mutant ends Survived, NoCoverage, inconclusive (a pass that made no mutant at its
place included), RuntimeError, or Ignored (a `// Stryker disable` comment needs the same justification in the notes as
a survivor). A confirmed timeout counts as killed and is listed. CompileError counts as killed by the type checker,
unless its only error is an unused `@ts-expect-error`. The verdict is NO RESULT when no src file changed, when no
gating mutant was made, when every gating mutant was a type error, when the type checker would judge a file outside
the tree, when what it reads is not what the root lockfile ships, when a pass could not run (its run with no mutant
past Stryker's bound of five minutes included; a test that imports a changed file and also cuts that file's source
text at a written-out line fails here once the change covers the line, because Stryker's sandbox rewrites it:
test/unit/b02-1.test.ts cuts containerManager.ts at `if (deploymentMode === 'casaos')`. Then rerun with `--mutate`
ranges that leave the line out, or rewrite the test to check behaviour), when Stryker mutated a file no target names, when the run with no
mutant after the reruns failed (or ran past the reruns' budget, or its times could not be read), when the tree changed
during the run, or when a test's stand-in replaced vitest (SMDB_MUTATION_VITEST, for the gate's own tests only); the
report then says why, with the passes that did finish.

## Not yet proven

- No run of the gate on the manager has been checked end to end yet (the bot's suite has such a run, its bite test;
  the manager has none). The first linux_mut.sh run is that check.
- Code that only a child process or a real container reaches is reached by no test of the fast tier, so its mutants
  survive or go unmade; such a survivor is justified in the notes.
