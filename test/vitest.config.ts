import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from 'vitest/config';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');

export default defineConfig({
  server: { fs: { allow: [repo] } },
  test: {
    root: here,
    pool: 'forks',
    projects: [
      { extends: true, test: { name: 'fast', include: ['unit/**/*.test.ts'] } },
    ],
  },
});
