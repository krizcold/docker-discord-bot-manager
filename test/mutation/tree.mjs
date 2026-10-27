// A fingerprint of the files a run reads (touched.mjs): taken when the gate
// plans and again before its verdict. Each pass, and each run with no mutant
// after the reruns, copies the tree as it is when it starts, so a tree that
// changed in between (an edit, a formatter, another session) leaves the
// verdict about no one tree, and the gate has no result. The packages are not
// copied, so each run loads them as they are then; the print holds npm's own
// record of each dir of them the runs load (PACKAGE_LOCKS).
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

/**
 * @param {string} root
 * @param {string[]} files from the root
 * @returns {Map<string, string>}
 */
export function treePrint(root, files) {
  return new Map(files.map(file => [file, stampOf(path.join(root, file))]));
}

/**
 * npm's hidden lockfile in each dir of packages the runs load: the root's
 * (src's packages: Stryker links it into each sandbox, or, when it is itself a
 * link, a run reaches it from the sandbox through the parent dirs) and test/'s
 * (the suite's, linked). A link is read as the dir it names. npm rewrites the
 * file at the end of an install that changes the dir, and npm ci removes it
 * first.
 */
export const PACKAGE_LOCKS = ['node_modules/.package-lock.json', 'test/node_modules/.package-lock.json'];

/** @param {string} full */
function stampOf(full) {
  try {
    const stat = fs.statSync(full);
    if (!stat.isFile()) return 'not a file';
    return `${stat.size}:${stat.mtimeMs}:${crypto.createHash('sha1').update(fs.readFileSync(full)).digest('hex')}`;
  } catch {
    return 'missing';
  }
}

/**
 * The files whose stamp differs between two prints, or that only one holds.
 * @param {Map<string, string>} before
 * @param {Map<string, string>} after
 */
export const treeChanges = (before, after) => [...new Set([...before.keys(), ...after.keys()])].filter(file => before.get(file) !== after.get(file)).sort();
