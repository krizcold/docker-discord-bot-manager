// How the gate names a file and a mutant across Stryker's passes (touched.mjs,
// targets.mjs): a file from the manager root with forward slashes, under the name
// it has on disk, and a mutant by its file, mutator, replacement and place as
// Stryker's results give it (lines and columns from 1).
import fs from 'fs';
import path from 'path';

/**
 * @param {string} root
 * @param {string} fileName a Stryker file name, absolute or relative to the root
 */
export const fileOf = (root, fileName) => path.relative(root, path.resolve(root, fileName)).split(path.sep).join('/');

/**
 * @param {string} file
 * @param {string} mutator
 * @param {string} replacement
 * @param {{ start: { line: number, column: number }, end: { line: number, column: number } }} l
 */
export const keyOf = (file, mutator, replacement, l) => `${file}|${mutator}|${replacement}|${l.start.line}:${l.start.column}-${l.end.line}:${l.end.column}`;

/**
 * A file under the name it has on disk (the case, and the path once links are
 * resolved), from the manager root with forward slashes; null when it is no file
 * in the manager root. Stryker crawls the disk and matches names as written, so
 * this is the name it can match, when it reads the name as itself
 * (ranges.mjs strykerTakes).
 * @param {string} root
 * @param {string} file however it was spelled
 * @returns {string | null}
 */
export function canonicalName(root, file) {
  let real;
  try {
    real = fs.realpathSync.native(path.resolve(root, file));
    if (!fs.statSync(real).isFile()) return null;
  } catch {
    return null;
  }
  const relative = path.relative(fs.realpathSync.native(root), real);
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) return null;
  return relative.split(path.sep).join('/');
}
