// The time check of the run with no mutant after the reruns alone, and of
// Stryker's clock in the reruns (mutation/README.md; touched.mjs control()
// runs it).
import fs from 'fs';
import path from 'path';

/** @param {string} dir a run's report dir, where runner.mjs leaves its run with no mutant's monotonic time */
const msOf = dir => { try { const text = fs.readFileSync(path.join(dir, 'dry-ms.txt'), 'utf8').trim(); return text === '' ? NaN : Number(text); } catch { return NaN; } };

/**
 * Stryker's own time for a pass's run with no mutant (targets.mjs leaves it in
 * the pass's dry-timing.json), from which Stryker builds every mutant run's
 * budget in that pass, against that run's monotonic time (dry-ms.txt): clock
 * is 'unread' when a time could not be read, and 'stepped' when they differ by
 * more than a second plus a tenth of the run, or the overhead does, so the
 * clock of Stryker's process stepped during the run and the budgets are not
 * what it took (a step back can make them negative, and a step forward of days
 * overflows Node's timer, which then holds each run to 1 ms).
 * @param {string} dir the pass's report dir
 * @returns {{ clock: '' | 'unread' | 'stepped', net: number, overhead: number }}
 */
export function strykerClock(dir) {
  /** @type {{ net?: unknown, overhead?: unknown }} */
  let timing = {};
  try { timing = JSON.parse(fs.readFileSync(path.join(dir, 'dry-timing.json'), 'utf8')) ?? {}; } catch { timing = {}; }
  const [net, overhead, took] = [Number(timing.net), Number(timing.overhead), msOf(dir)];
  if (![net, overhead, took].every(Number.isFinite)) return { clock: 'unread', net, overhead };
  const margin = 1000 + 0.1 * Math.abs(took);
  return { clock: Math.abs(net - took) > margin || overhead < 0 || overhead > margin ? 'stepped' : '', net, overhead };
}

/**
 * Why a run with no mutant that passed still clears no timeout of the reruns:
 * a time could not be read; the clock of Stryker's process stepped during the
 * reruns' own run with no mutant (strykerClock), so the budget it built is not
 * what the reruns took; or this run's monotonic time did not fit in that
 * budget (`timeoutFactor` times Stryker's net time, plus `timeoutMS`, plus its
 * overhead, as Stryker built it), so the machine was as slow as the mutants
 * seemed. '' when it fits.
 * @param {string} reruns the reruns' report dir
 * @param {string} out this run's report dir
 * @param {{ timeoutFactor: number, timeoutMS: number }} budget
 */
export function pastBudget(reruns, out, { timeoutFactor, timeoutMS }) {
  const { clock, net, overhead } = strykerClock(reruns);
  const took = msOf(out);
  if (clock === 'unread' || !Number.isFinite(took)) return "its time, or the time of the reruns' own run with no mutant, could not be read";
  if (clock === 'stepped') {
    return "Stryker's own time for the reruns' run with no mutant does not match that run's monotonic time, so the clock of Stryker's process stepped and the budget it gave each rerun was not four times what they took";
  }
  const budget = timeoutFactor * net + timeoutMS + overhead;
  if (took <= budget) return '';
  return `it took ${Math.round(took / 1000)} s, past the ${Math.round(budget / 1000)} s Stryker gave each rerun, so the machine was too slow then to tell a slow mutant from a slow run`;
}
