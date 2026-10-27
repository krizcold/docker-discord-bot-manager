import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from 'vitest/config';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
// 4 when the mutation gate reruns a mutant alone (mutation/runner.mjs), so a
// rerun that times out means the mutant hangs the tests, not that the machine
// was slow. A limit a test or hook sets itself is not scaled.
const timeScale = Math.max(1, Number(process.env.SMDB_TEST_TIME_SCALE) || 1);

export default defineConfig({
  server: { fs: { allow: [repo] } },
  test: {
    root: here,
    pool: 'forks',
    testTimeout: 5_000 * timeScale,
    hookTimeout: 10_000 * timeScale,
    projects: [
      { extends: true, test: { name: 'fast', include: ['unit/**/*.test.ts'] } },
    ],
  },
});
