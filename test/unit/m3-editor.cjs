// A stand-in for nano in the M3 rows: node m3-editor.cjs <mode> <report> <file>.
// It reports the file it was given and its mode, then rewrites it, leaves it, fails, or waits.
const fs = require('fs');

const [mode, report, file] = process.argv.slice(2);
const st = fs.statSync(file);
// nano's .save copy of the body, beside the file, before the report says the editor is running.
if (mode === 'wait') fs.writeFileSync(`${file}.save`, fs.readFileSync(file, 'utf8'));
fs.writeFileSync(report, JSON.stringify({ file, mode: st.mode & 0o777, body: fs.readFileSync(file, 'utf8') }));
if (mode === 'rewrite') fs.writeFileSync(file, 'edited: true\n');
if (mode === 'empty') fs.writeFileSync(file, '');
if (mode === 'fail') process.exit(1);
if (mode === 'delete') fs.unlinkSync(file);
if (mode === 'wait') setTimeout(() => {}, 3000);
