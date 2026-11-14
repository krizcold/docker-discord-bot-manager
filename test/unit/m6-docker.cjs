// A stand-in for docker in the M6 rows: node m6-docker.cjs <exit code> <report> <docker's arguments...>.
// It writes the arguments it was given to the report, then exits with the code.
const fs = require('fs');

const [code, report, ...args] = process.argv.slice(2);
fs.writeFileSync(report, JSON.stringify(args));
process.exit(Number(code));
