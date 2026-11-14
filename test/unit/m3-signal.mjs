// Runs editBody in its own process for the M3 signal rows: node m3-signal.mjs <signal> <report>.
// Once the fake editor reports, the process gets the signal: a real one off Windows, an emitted one on Windows
// (where a signal sent to a process ends it without running its handlers).
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const [signal, report] = process.argv.slice(2);
const { editBody } = await import(pathToFileURL(path.join(here, '..', '..', 'src', 'cli', 'tui', 'editbody.ts')).href);
const done = editBody('/app/secret.json', 'PLAINTEXT-BODY', { program: process.execPath, args: [path.join(here, 'm3-editor.cjs'), 'wait', report] });
for (let i = 0; i < 200 && !fs.existsSync(report); i++) await new Promise((r) => setTimeout(r, 25));
if (process.platform === 'win32') process.emit(signal, signal);
else process.kill(process.pid, signal);
await done;
console.log('the edit finished without the signal ending it');
process.exit(0);
