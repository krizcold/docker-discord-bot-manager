import { describe, expect, it } from 'vitest';
import { COMMON, CONTROL_DRY_RUN_MINUTES, DRY_RUN_MINUTES, PASSES } from '../mutation/passes.mjs';

// The shared options, then the pass's extra, in the order touched.mjs's stryker() spreads them.
function config(extra: object): Record<string, unknown> {
  return { ...COMMON, ignorePatterns: [], mutate: ['src/x.ts'], ...extra };
}

describe('NM7F: every pass gives its dry run an hour', () => {
  it('pass a', () => {
    expect(config({ ...PASSES.a, concurrency: 4, tsconfigFile: 'tsconfig.json' }).dryRunTimeoutMinutes).toBe(60);
  });

  it('the unchecked rerun of pass a', () => {
    expect(config({ ...PASSES.a, checkers: [], concurrency: 4 }).dryRunTimeoutMinutes).toBe(60);
  });

  it('pass a2', () => {
    expect(config(PASSES.a2).dryRunTimeoutMinutes).toBe(60);
  });

  it('the control run after a2 is bound above the largest budget a rerun can have', () => {
    expect(DRY_RUN_MINUTES).toBe(60);
    expect(CONTROL_DRY_RUN_MINUTES * 60_000).toBeGreaterThan(PASSES.a2.timeoutFactor * DRY_RUN_MINUTES * 60_000 + PASSES.a2.timeoutMS);
  });
});
