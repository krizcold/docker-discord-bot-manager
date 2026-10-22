// The suite needs Node 22.12 or newer (vitest 5, testcontainers 12). This
// launcher stays plain CommonJS so an older node can start it, then runs
// vitest under this node when it is new enough, else under SMDB_TEST_NODE.
const { spawnSync } = require('child_process');
const path = require('path');

const [major, minor] = process.versions.node.split('.').map(Number);
const node = major > 22 || (major === 22 && minor >= 12) ? process.execPath : process.env.SMDB_TEST_NODE;
if (!node) {
  console.error(`The test suite needs Node 22.12 or newer (this is ${process.version}); set SMDB_TEST_NODE to a newer node binary.`);
  process.exit(1);
}
const vitest = path.join(__dirname, 'node_modules', 'vitest', 'vitest.mjs');
const run = spawnSync(node, [vitest, 'run', ...process.argv.slice(2)], { cwd: __dirname, stdio: 'inherit' });
process.exit(run.status === null ? 1 : run.status);
