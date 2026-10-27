// The Stryker options of each pass (mutation/README.md, "The passes"), beyond
// the mutate patterns and the concurrency touched.mjs gives them.
import path from 'path';
import { fileURLToPath } from 'url';

// What every pass shares. configFile names an empty file, so Stryker never
// reads a config file it would otherwise find in the manager root (an inPlace,
// a buildCommand or an excluded mutator there would apply to every pass).
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export const COMMON = {
  configFile: path.join(path.dirname(fileURLToPath(import.meta.url)), 'stryker.json'),
  inPlace: false,
  testRunner: 'command',
  coverageAnalysis: 'off',
  tsconfigFile: 'tsconfig.json',
  tempDirName: '.stryker-tmp',
  incremental: false,
  reporters: ['progress', 'smdb-targets'],
  logLevel: /** @type {import('@stryker-mutator/api/core').LogLevel} */ ('warn'),
};

export const PASSES = {
  a: { checkers: ['typescript'], timeoutMS: 10_000, timeoutFactor: 2 },
  a2: { checkers: [], concurrency: 1, timeoutMS: 60_000, timeoutFactor: 4 },
};
