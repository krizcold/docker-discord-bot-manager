// Which lines a change touched, which files it mutates, and the Stryker mutate
// ranges that cover them (VERIFY.md L5). git only names the files that changed
// and gives their text at the base; the changed lines come from the gate's own
// line diff (lineDiff), so no git setting, attribute or variable moves them.
// The caller runs git.
import fs from 'fs';
import { createRequire } from 'module';
import path from 'path';
import ts from 'typescript';
import { canonicalName } from './keys.mjs';

// Stryker's own copy of minimatch, which it matches mutate patterns with.
const strykerRequire = createRequire(createRequire(import.meta.url).resolve('@stryker-mutator/core/package.json'));
const { Minimatch, minimatch, escape } = strykerRequire('minimatch');

/**
 * @typedef {[number, number]} Range first and last line, 1-based
 * @typedef {{ status: string, file: string, from?: string }} Entry a file git names as changed; from: a rename's old name
 * @typedef {{ file: string, ranges: Range[] | null, gating: number[] | null, patterns: string[], deleted?: number[] }} Target
 *   ranges null: the whole file; deleted: where lines of code were taken out with fewer or none put back, each after
 *   the line named (0: the top)
 * @typedef {{ start: { line: number, column: number }, end: { line: number, column: number } }} Location
 */

// Code, by its name; notMutated narrows it by name to src's code, and the
// planner (planChange) skips more, by link, name and content. The env scrub's
// scans of src read CODE as it is; the content rule's pinned list
// (unit/mutationRanges.test.ts) reads what the planner makes of src.
export const CODE = /\.(ts|tsx|mts|cts|js|cjs|mjs)$/;
const DECLARATION = /\.d\.[cm]?ts$/;
const VIEWS = 'src/webui/public/';

/**
 * Why a changed file gets no mutants, or null when it gets them.
 * @param {string} file
 * @returns {string | null}
 */
export function notMutated(file) {
  if (!file.startsWith('src/')) return 'outside src';
  if (file.startsWith(VIEWS)) return 'a browser view: copied into dist and never compiled; its tests read it as text or run it in a vm, so vitest related never selects them and L5 does not cover it';
  if (DECLARATION.test(file) || !CODE.test(file)) return 'not code';
  if (file.split('/').includes('node_modules')) return 'under a node_modules dir, which Stryker links into a sandbox and never copies, so no mutant can be made in it';
  if (file.includes('node_modules')) return "its path holds the text node_modules, and vitest's related runs drop every import whose path holds it, so no test would reach its mutants; rename it";
  return null;
}

// Line breaks TypeScript and Stryker's parser count but the line diff does not:
// in a file that holds one, the diff's line numbers and theirs disagree after it.
const EXTRA_BREAK = /\r(?!\n)|[\u2028\u2029]/;
export const EXTRA_BREAK_WHY = 'it holds a line break Stryker counts and the gate does not (a lone CR, U+2028 or U+2029), so its lines cannot be matched to the change; make it a plain line feed or an escape';

/** @param {string} text */
export const holdsExtraBreak = text => EXTRA_BREAK.test(text);

/**
 * A text's lines, split at LF or CRLF, without the empty one after a final break.
 * @param {string} text
 */
function splitLines(text) {
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Where an optimal path through the edit graph of a[aLo, aHi) and b[bLo, bHi)
 * crosses its middle, as [i, j] (Myers' O(ND) bisection, run from both ends at
 * once, as diff-match-patch does it), or null when the two share no line.
 * @param {string[]} a
 * @param {number} aLo
 * @param {number} aHi
 * @param {string[]} b
 * @param {number} bLo
 * @param {number} bHi
 * @returns {[number, number] | null}
 */
function bisect(a, aLo, aHi, b, bLo, bHi) {
  const n = aHi - aLo;
  const m = bHi - bLo;
  const maxD = Math.ceil((n + m) / 2);
  const size = 2 * maxD;
  const v1 = new Int32Array(size).fill(-1);
  const v2 = new Int32Array(size).fill(-1);
  v1[maxD + 1] = 0;
  v2[maxD + 1] = 0;
  const delta = n - m;
  const front = delta % 2 !== 0;
  let k1start = 0;
  let k1end = 0;
  let k2start = 0;
  let k2end = 0;
  for (let d = 0; d < maxD; d++) {
    for (let k1 = -d + k1start; k1 <= d - k1end; k1 += 2) {
      const i1 = maxD + k1;
      let x1 = k1 === -d || (k1 !== d && v1[i1 - 1] < v1[i1 + 1]) ? v1[i1 + 1] : v1[i1 - 1] + 1;
      let y1 = x1 - k1;
      while (x1 < n && y1 < m && a[aLo + x1] === b[bLo + y1]) { x1++; y1++; }
      v1[i1] = x1;
      if (x1 > n) k1end += 2;
      else if (y1 > m) k1start += 2;
      else if (front) {
        const i2 = maxD + delta - k1;
        if (i2 >= 0 && i2 < size && v2[i2] !== -1 && x1 >= n - v2[i2]) return [aLo + x1, bLo + y1];
      }
    }
    for (let k2 = -d + k2start; k2 <= d - k2end; k2 += 2) {
      const i2 = maxD + k2;
      let x2 = k2 === -d || (k2 !== d && v2[i2 - 1] < v2[i2 + 1]) ? v2[i2 + 1] : v2[i2 - 1] + 1;
      let y2 = x2 - k2;
      while (x2 < n && y2 < m && a[aHi - 1 - x2] === b[bHi - 1 - y2]) { x2++; y2++; }
      v2[i2] = x2;
      if (x2 > n) k2end += 2;
      else if (y2 > m) k2start += 2;
      else if (!front) {
        const i1 = maxD + delta - k2;
        if (i1 >= 0 && i1 < size && v1[i1] !== -1 && v1[i1] >= n - x2) return [aLo + v1[i1], bLo + v1[i1] - (delta - k2)];
      }
    }
  }
  return null;
}

/**
 * Pairs [i, j] of equal lines a[i] === b[j], rising in both, as many as any
 * such list can hold: a longest common subsequence, so the lines left over are
 * a shortest edit (Myers' algorithm, in linear space).
 * @param {string[]} a
 * @param {string[]} b
 * @returns {[number, number][]}
 */
export function commonLines(a, b) {
  /** @type {[number, number][]} */
  const pairs = [];
  /**
   * @param {number} aLo
   * @param {number} aHi
   * @param {number} bLo
   * @param {number} bHi
   */
  const solve = (aLo, aHi, bLo, bHi) => {
    while (aLo < aHi && bLo < bHi && a[aLo] === b[bLo]) pairs.push([aLo++, bLo++]);
    /** @type {[number, number][]} */
    const tail = [];
    while (aLo < aHi && bLo < bHi && a[aHi - 1] === b[bHi - 1]) tail.push([--aHi, --bHi]);
    const split = aLo < aHi && bLo < bHi ? bisect(a, aLo, aHi, b, bLo, bHi) : null;
    if (split) {
      solve(aLo, split[0], bLo, split[1]);
      solve(split[0], aHi, split[1], bHi);
    }
    pairs.push(...tail.reverse());
  };
  solve(0, a.length, 0, b.length);
  return pairs;
}

/**
 * What changed from `before` to `after`, as lines of `after` (from 1): the
 * lines no longest common subsequence of the two keeps, and the lines after
 * which lines of code (a token on them) were taken out with fewer or none put
 * back (0: before the first line; a line of code made a comment or a blank line
 * counts, a line replaced one for one by code is only changed). Each text is
 * read as its name says (`file`, `baseFile`). Lines
 * end at LF or CRLF, so line endings alone change nothing. The lines added in
 * one place, or only taken out, count also over each unchanged line beside
 * them that repeats one of them, and on through each further one that does (an
 * `if` block added after an equal one counts in both places): every place
 * their first or last lines, or the whole run, could slide to passes only such
 * lines. The window starts from each piece the diff makes, and another change
 * in the file can split a run into pieces, so then which copy counts is the
 * diff's choice. A line kept counts only where the diff marks it, even when a
 * change moves it into or out of a block (mutation/README.md), unless the code
 * it holds differs: the kinds of its tokens, in order (lineCode), whatever on
 * another line made them differ (for example a comment, a string, a template or
 * JSX text opened or closed over part or all of it, or a regex read as a
 * division, a type as a value). Then it is changed when it holds code after,
 * and a place too when it holds fewer tokens.
 * @param {string} before
 * @param {string} after
 * @param {string} [file] the name `after` is read under
 * @param {string} [baseFile] the name `before` is read under
 * @returns {{ changed: number[], deletedAfter: number[] }}
 */
export function lineDiff(before, after, file = 'a.ts', baseFile = file) {
  const a = splitLines(before);
  const b = splitLines(after);
  const codeOut = lineCode(baseFile, before);
  const codeIn = lineCode(file, after);
  /**
   * @param {Map<number, number[]>} code
   * @param {number} from
   * @param {number} to
   */
  const count = (code, from, to) => Array.from({ length: to - from }, (_, k) => from + k + 1).filter(n => code.has(n)).length;
  const pairs = commonLines(a, b);
  const partner = new Int32Array(a.length).fill(-1);
  for (const [i, j] of pairs) partner[i] = j;
  /** @type {Set<number>} */
  const changed = new Set();
  /** @type {Set<number>} */
  const deletedAfter = new Set();
  let pi = -1;
  let pj = -1;
  for (const [i, j] of [...pairs, [a.length, b.length]]) {
    const [i0, i1, j0, j1] = [pi + 1, i, pj + 1, j];
    for (let k = j0; k < j1; k++) changed.add(k + 1);
    // The unchanged lines beside the lines added, up and down, while each
    // repeats one of them.
    const added = new Set(b.slice(j0, j1));
    for (let t = 1; i0 - t >= 0 && partner[i0 - t] === j0 - t && added.has(b[j0 - t]); t++) changed.add(j0 - t + 1);
    for (let t = 0; i1 + t < a.length && partner[i1 + t] === j1 + t && added.has(b[j1 + t]); t++) changed.add(j1 + t + 1);
    // More lines of code taken out than put back (a line deleted, or made a comment, beside an edited one or not; a
    // block taken away and its body re-indented).
    if (count(codeOut, i0, i1) > count(codeIn, j0, j1)) deletedAfter.add(j0);
    if (j1 === j0 && count(codeOut, i0, i1) > 0) {
      // Taken out only: the same, for the places in `after` where it could have been.
      const taken = new Set(a.slice(i0, i1));
      for (let t = 1; i0 - t >= 0 && j0 - t >= 0 && partner[i0 - t] === j0 - t && taken.has(a[i0 - t]); t++) deletedAfter.add(j0 - t);
      for (let t = 0; i1 + t < a.length && partner[i1 + t] === j0 + t && taken.has(a[i1 + t]); t++) deletedAfter.add(j0 + t + 1);
    }
    pi = i;
    pj = j;
  }
  // A kept line whose code differs: changed when it holds code after, and code
  // taken out there when it holds fewer tokens.
  for (const [i, j] of pairs) {
    const was = codeOut.get(i + 1) ?? [];
    const is = codeIn.get(j + 1) ?? [];
    if (was.length === is.length && was.every((part, k) => part === is[k])) continue;
    if (is.length > 0) changed.add(j + 1);
    if (was.length > is.length) deletedAfter.add(j);
  }
  /** @param {Set<number>} set */
  const sorted = set => [...set].sort((x, y) => x - y);
  return { changed: sorted(changed), deletedAfter: sorted(deletedAfter) };
}

/**
 * Reads `git diff --name-status -z` output.
 * @param {string} text
 * @returns {Entry[]}
 */
export function parseNameStatus(text) {
  const fields = text.split('\0');
  /** @type {Entry[]} */
  const entries = [];
  for (let i = 0; i < fields.length && fields[i] !== '';) {
    const status = fields[i][0];
    if (status === 'R' || status === 'C') {
      entries.push({ status, from: fields[i + 1], file: fields[i + 2] });
      i += 3;
    } else {
      entries.push({ status, file: fields[i + 1] });
      i += 2;
    }
  }
  return entries;
}

/**
 * Sorted, with overlapping or adjacent ranges joined: Stryker makes a mutant
 * only when one range holds all of it, so two ranges that meet must be one.
 * @param {Range[]} ranges
 * @returns {Range[]}
 */
export function mergeRanges(ranges) {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  /** @type {Range[]} */
  const out = [];
  for (const [start, end] of sorted) {
    const last = out[out.length - 1];
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}

// Statement lists in braces: a line wholly inside one widens by the statements in it.
const CONTAINERS = new Set([ts.SyntaxKind.Block, ts.SyntaxKind.ModuleBlock, ts.SyntaxKind.CaseBlock]);
// Statements and declarations whose parts (a condition, the parameters, a
// catch variable, a case label) widen apart from the bodies they hold: a case
// clause's statements are its body, braces or not.
const COMPOUND = new Set([
  ts.SyntaxKind.IfStatement, ts.SyntaxKind.DoStatement, ts.SyntaxKind.WhileStatement, ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForInStatement, ts.SyntaxKind.ForOfStatement, ts.SyntaxKind.SwitchStatement, ts.SyntaxKind.TryStatement,
  ts.SyntaxKind.CatchClause, ts.SyntaxKind.CaseClause, ts.SyntaxKind.DefaultClause, ts.SyntaxKind.LabeledStatement, ts.SyntaxKind.WithStatement, ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.ClassDeclaration, ts.SyntaxKind.MethodDeclaration, ts.SyntaxKind.Constructor, ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor, ts.SyntaxKind.ModuleDeclaration, ts.SyntaxKind.ClassStaticBlockDeclaration,
]);

/**
 * A file read as its name says (TypeScript's own reading of .ts, .tsx, .mts,
 * .cts, .js, .cjs and .mjs).
 * @param {string} file
 * @param {string} text
 */
function parse(file, text) {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
}

/**
 * The spans one line widens to: the statement it sits in, taken whole even
 * when a block-bodied callback sits inside it, so every mutant of a changed
 * operator, condition or call exists. The header of a compound statement or
 * declaration (a condition, a signature, a catch, a case label) widens to that
 * header only, never to its body; any other line holding a callback's start or end (a
 * route's header, a `});`) takes its whole statement, the callback's body
 * included. A line wholly inside a body widens within that body.
 * @param {ts.SourceFile} sf
 * @param {number} line 1-based
 * @returns {Range[]}
 */
function unitsOf(sf, line) {
  const starts = sf.getLineStarts();
  const lineStart = starts[line - 1];
  const code = sf.text.slice(lineStart, line < starts.length ? starts[line] : sf.text.length);
  const first = code.search(/\S/);
  // A blank line reaches here only inside a token (a multi-line template): it widens as the token's other lines do.
  const span = first < 0 ? { start: lineStart, end: lineStart } : { start: lineStart + first, end: lineStart + code.trimEnd().length };
  /** @param {number} pos */
  const lineOf = pos => sf.getLineAndCharacterOfPosition(pos).line + 1;
  /** @type {Range[]} */
  const units = [];
  /** @param {ts.Node} node */
  const overlaps = node => node.getStart(sf) < span.end && node.getEnd() > span.start;
  /** @param {ts.Node} node */
  const holdsLine = node => CONTAINERS.has(node.kind) && node.getStart(sf) < span.start && span.end < node.getEnd();
  /**
   * The innermost statement list below node whose braces hold the whole line.
   * @param {ts.Node} node
   * @returns {ts.Node | null}
   */
  const innermost = node => {
    /** @type {ts.Node | null} */
    let found = null;
    ts.forEachChild(node, child => {
      if (found || child.getStart(sf) > span.start || child.getEnd() < span.end) return;
      found = innermost(child) ?? (holdsLine(child) ? child : null);
    });
    return found;
  };
  /** @param {ts.Node} node */
  const visit = node => {
    ts.forEachChild(node, child => {
      if (!overlaps(child)) return;
      if (CONTAINERS.has(child.kind) || COMPOUND.has(child.kind)) { visit(child); return; }
      const inner = innermost(child);
      if (inner) visit(inner);
      else units.push([lineOf(child.getStart(sf)), lineOf(child.getEnd())]);
    });
  };
  visit(sf);
  return units;
}

/**
 * The merged ranges for a file's changed lines (each line itself, plus what it
 * widens to). A line that holds no token (blank, or a comment only) widens to
 * itself only: inside an object or a call it would otherwise take the statement.
 * @param {string} file
 * @param {string} text
 * @param {number[]} lines
 * @returns {Range[]}
 */
export function widen(file, text, lines) {
  const sf = parse(file, text);
  const held = heldLines(sf, true);
  /** @type {Range[]} */
  const ranges = [];
  for (const line of lines) ranges.push([line, line], ...(held.has(line) ? unitsOf(sf, line) : []));
  return mergeRanges(ranges);
}

// Tokens that carry no behaviour of their own: brackets and separators.
const STRUCTURE = new Set([
  ts.SyntaxKind.OpenBraceToken, ts.SyntaxKind.CloseBraceToken, ts.SyntaxKind.OpenParenToken, ts.SyntaxKind.CloseParenToken,
  ts.SyntaxKind.OpenBracketToken, ts.SyntaxKind.CloseBracketToken, ts.SyntaxKind.SemicolonToken, ts.SyntaxKind.CommaToken,
  ts.SyntaxKind.EndOfFileToken,
]);

/**
 * The lines a token starts on or runs across (a multi-line template), never a
 * JSDoc block's; brackets and separators count only when `structure` is set.
 * @param {ts.SourceFile} sf
 * @param {boolean} structure
 * @returns {Set<number>}
 */
function heldLines(sf, structure) {
  /** @param {number} pos */
  const lineOf = pos => sf.getLineAndCharacterOfPosition(pos).line + 1;
  /** @type {Set<number>} */
  const held = new Set();
  /** @param {ts.Node} node */
  const walk = node => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return;
    const children = node.getChildren(sf);
    if (children.length > 0) { children.forEach(walk); return; }
    if ((!structure && STRUCTURE.has(node.kind)) || node.getStart(sf) === node.getEnd()) return;
    for (let n = lineOf(node.getStart(sf)); n <= lineOf(node.getEnd() - 1); n++) held.add(n);
  };
  walk(sf);
  return held;
}

/**
 * The lines among `lines` that hold a token, brackets and separators included:
 * a blank or comment-only line changes no code, so it widens only to itself and
 * never gates.
 * @param {string} file
 * @param {string} text
 * @param {number[]} lines
 */
export function tokenLines(file, text, lines) {
  const held = heldLines(parse(file, text), true);
  return lines.filter(line => held.has(line));
}

const TEMPLATE_PARTS = new Set([ts.SyntaxKind.NoSubstitutionTemplateLiteral, ts.SyntaxKind.TemplateHead, ts.SyntaxKind.TemplateMiddle, ts.SyntaxKind.TemplateTail]);

/**
 * The code each line holds: the kind of each token on it, in order, brackets
 * and separators included (a comment, and a JSDoc one, holds none; a
 * template's parts are one kind, so a substitution added on one of its lines
 * leaves the others as they were). A line that holds a token is a key. A line
 * kept as it was holds the same text, so only how that text is read can
 * differ: as code of other kinds, or as a comment, a string, a template or JSX
 * text, for example. Lines are numbered as
 * lineDiff splits them (at LF or CRLF only): TypeScript also ends a line at a
 * lone CR or a line separator, which a base text may hold.
 * @param {string} file
 * @param {string} text
 * @returns {Map<number, number[]>}
 */
function lineCode(file, text) {
  const starts = [0];
  for (let at = text.indexOf('\n'); at >= 0; at = text.indexOf('\n', at + 1)) starts.push(at + 1);
  /** @param {number} pos */
  const lineOf = pos => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (starts[mid] <= pos) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };
  const sf = parse(file, text);
  /** @type {Map<number, number[]>} */
  const code = new Map();
  /** @param {ts.Node} node */
  const walk = node => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return;
    const children = node.getChildren(sf);
    if (children.length > 0) { children.forEach(walk); return; }
    if (node.getStart(sf) === node.getEnd()) return;
    const kind = TEMPLATE_PARTS.has(node.kind) ? ts.SyntaxKind.NoSubstitutionTemplateLiteral : node.kind;
    for (let n = lineOf(node.getStart(sf)); n <= lineOf(node.getEnd() - 1); n++) {
      const kinds = code.get(n);
      if (kinds) kinds.push(kind);
      else code.set(n, [kind]);
    }
  };
  walk(sf);
  return code;
}

/**
 * The lines the no-mutant list counts: a token other than a bracket or a
 * separator starts on them or runs across them (a multi-line template). An else, try, finally
 * or do line holds code. Blank and comment-only lines are left out, and so is
 * a line of brackets and separators only, wherever it sits: what was taken out
 * of it (`}, 100);` made `});`), like a pure deletion, cannot be mutated.
 * @param {string} file
 * @param {string} text
 * @param {number[]} lines
 */
export function codeLines(file, text, lines) {
  const held = heldLines(parse(file, text), false);
  return lines.filter(line => held.has(line));
}

// Keywords that open the next part of a statement: a changed line holding one
// can move the lines beside it from one part to another. A default counts only
// in a switch, never in an export.
const PARTS = new Set([ts.SyntaxKind.ElseKeyword, ts.SyntaxKind.CaseKeyword, ts.SyntaxKind.DefaultKeyword, ts.SyntaxKind.CatchKeyword, ts.SyntaxKind.FinallyKeyword]);

/**
 * Whether a token opens or closes a block of statements or members: a body, a
 * switch's cases, a namespace, a class; never an object or a type.
 * @param {ts.Node} node
 */
const blockBrace = node => (node.kind === ts.SyntaxKind.OpenBraceToken || node.kind === ts.SyntaxKind.CloseBraceToken)
  && (ts.isBlock(node.parent) || ts.isCaseBlock(node.parent) || ts.isModuleBlock(node.parent) || ts.isClassLike(node.parent));

/**
 * The lines among `lines` that hold brackets and separators and nothing else,
 * a brace of a block (a header's `{`, a closer with code: `} while (x);`,
 * `}).catch(log);`), or an else, case, default, catch or finally. Such a line,
 * changed, can move the unchanged lines beside it into or out of a block, which
 * the gate does not gate (mutation/README.md), so the report names it, mutants
 * of its own or not.
 * @param {string} file
 * @param {string} text
 * @param {number[]} lines
 */
export function structureLines(file, text, lines) {
  const sf = parse(file, text);
  /** @param {number} pos */
  const lineOf = pos => sf.getLineAndCharacterOfPosition(pos).line + 1;
  /** @type {Set<number>} */
  const code = new Set();
  /** @type {Set<number>} */
  const brackets = new Set();
  /** @type {Set<number>} */
  const parts = new Set();
  /** @param {ts.Node} node */
  const walk = node => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode) return;
    const children = node.getChildren(sf);
    if (children.length > 0) { children.forEach(walk); return; }
    if (node.kind === ts.SyntaxKind.EndOfFileToken || node.getStart(sf) === node.getEnd()) return;
    const part = PARTS.has(node.kind) && (node.kind !== ts.SyntaxKind.DefaultKeyword || ts.isDefaultClause(node.parent));
    if (part || blockBrace(node)) parts.add(lineOf(node.getStart(sf)));
    const into = STRUCTURE.has(node.kind) ? brackets : code;
    for (let n = lineOf(node.getStart(sf)); n <= lineOf(node.getEnd() - 1); n++) into.add(n);
  };
  walk(sf);
  return lines.filter(line => parts.has(line) || (brackets.has(line) && !code.has(line)));
}

/**
 * The code lines among `lines` that no mutant lies wholly on. A mutant that
 * spans several lines (emptying a body, an object or an array, flipping a
 * condition split over lines, a chained call) counts for none of them: it says
 * nothing about each line it spans. A mutant on one line counts for that whole
 * line, as Stryker counts it. So the lines of a file taken whole are judged the
 * way the same lines changed alone are, and the list can name a line some
 * mutant reaches, but never leaves out one no mutant lies on.
 * @param {string} file
 * @param {string} text
 * @param {number[]} lines
 * @param {Range[]} spans each mutant's first and last line
 */
export function untouched(file, text, lines, spans) {
  return codeLines(file, text, lines).filter(n => !spans.some(([first, last]) => first === n && last === n));
}

/**
 * git arguments that name every file changed from base to the working tree,
 * over the whole repo (planChange names what it does not mutate): the names as
 * they are (-z), and a rename found by git's own measure with no limit on how
 * many files it compares (-M, -l0, whatever the user's config says). Only the
 * names come from here: the changed lines come from lineDiff.
 * @param {string} base
 */
export const changedArgs = base => ['diff', '--name-status', '-z', '-M', '-l0', '--ignore-submodules=none', '--no-relative', '--no-ext-diff', '--no-textconv', base, '--'];

/**
 * The target for a file's changed lines, widened. `gating` lists those that
 * hold code (a token): a mutant that touches one must be killed; the others in
 * the widened ranges are context, run and listed but never gating. `deleted`
 * names each place where lines of code were taken out with fewer or none put
 * back, for what was taken out is left nowhere to mutate; the lines beside it
 * are mutated only where a changed line widens to them. Null when no changed
 * line holds code and no code was taken out.
 * @param {string} file the name to mutate it under
 * @param {string} text
 * @param {{ changed: number[], deletedAfter: number[] }} change
 * @returns {Target | null}
 */
export function changeTarget(file, text, { changed, deletedAfter }) {
  const gating = [...new Set(tokenLines(file, text, changed))].sort((a, b) => a - b);
  if (gating.length === 0 && deletedAfter.length === 0) return null;
  const ranges = widen(file, text, changed);
  return {
    file, ranges, gating, patterns: ranges.map(([start, end]) => `${file}:${start}-${end}`),
    ...(deletedAfter.length > 0 ? { deleted: deletedAfter } : {}),
  };
}

/**
 * A file taken whole: every mutant in it gates.
 * @param {string} file
 * @returns {Target}
 */
export const wholeTarget = file => ({ file, ranges: null, gating: null, patterns: [file] });

/**
 * The patterns pass A gives Stryker, one set per file. Two targets can name one
 * file (two names git lists that differ only in case, on a disk that does not
 * tell case apart, both changed): the file is taken whole
 * when one of them takes it whole, or else by their ranges merged, since Stryker
 * makes a mutant only where one range holds it. --mutate patterns stay as given.
 * @param {{ file: string, patterns: string[], ranges?: Range[] | null }[]} targets
 * @returns {string[]}
 */
export function mutatePatterns(targets) {
  return [...new Set(targets.map(target => target.file))].flatMap(file => {
    const of = targets.filter(target => target.file === file);
    if (of.length === 1) return of[0].patterns;
    if (of.some(target => target.patterns.includes(file))) return [file];
    const ranges = of.map(target => target.ranges);
    if (ranges.every(Array.isArray)) return mergeRanges(ranges.flat()).map(([start, end]) => `${file}:${start}-${end}`);
    return of.flatMap(target => target.patterns);
  });
}

/**
 * The mutate targets for a change, and every changed file it does not mutate,
 * with the reason. A file git names as changed gates its changed lines, found
 * against its text at the base (a rename's against its old name's). A file new
 * to the mutated code is taken whole: one added, an untracked one, and one
 * moved in from a name never mutated (outside src, a browser view, a file that
 * is not code). One moved out of the mutated code is named, as a deletion is.
 * A file that holds a line break Stryker counts and the diff does not is named
 * and not mutated (EXTRA_BREAK_WHY), and so is a git submodule (`isDir`: git
 * names only its commit), a file whose name Stryker would read as a glob
 * (`nameOf` gives null) and one listed under a name that leads through a link
 * (`linkOf`, as ranges.mjs linkOf decides it on the disk: a file is mutated
 * under its own name only). `nameOf` gives the name a file is mutated under
 * (its name on disk, keys.mjs). emptyScope: nothing in src changed.
 * @param {{ entries: Entry[], untracked: string[], read: (file: string) => string, readBase: (file: string) => string,
 *   nameOf: (file: string) => string | null, linkOf?: (file: string) => string | null | undefined, isDir?: (file: string) => boolean }} change
 * @returns {{ targets: Target[], skipped: { file: string, why: string }[], emptyScope: boolean }}
 */
export function planChange({ entries, untracked, read, readBase, nameOf, linkOf: linkedTo = () => undefined, isDir = () => false }) {
  // A file only taken out of the index (git rm --cached) is untracked on disk
  // and, to git, deleted or the old name of a rename it paired with an added
  // file: it is the base's file still, diffed as a changed one, and the rename
  // stays a rename, as the index holds it.
  const unindexed = new Set(entries.map(entry => (entry.status === 'D' ? entry.file : entry.status === 'R' ? entry.from : undefined))
    .filter(file => file !== undefined && untracked.includes(file)));
  entries = entries.flatMap(entry => (entry.status === 'D' && unindexed.has(entry.file) ? [{ status: 'M', file: entry.file }]
    : entry.status === 'R' && entry.from !== undefined && unindexed.has(entry.from) ? [entry, { status: 'M', file: entry.from }] : [entry]));
  untracked = untracked.filter(file => !unindexed.has(file));
  /** @type {Target[]} */
  const targets = [];
  /** @type {{ file: string, why: string }[]} */
  const skipped = [];
  for (const entry of entries) {
    if (entry.status === 'D') { skipped.push({ file: entry.file, why: 'deleted: nothing is left to mutate' }); continue; }
    if (isDir(entry.file)) { skipped.push({ file: entry.file, why: 'a git submodule: git names only its commit, so none of its files is mutated' }); continue; }
    /** @param {string} file @param {string} why */
    const refuse = (file, why) => {
      skipped.push({ file, why });
      if (entry.from !== undefined && !unindexed.has(entry.from) && notMutated(entry.from) === null) skipped.push({ file: entry.from, why: `moved to ${file}: nothing is left to mutate` });
    };
    const why = notMutated(entry.file);
    if (why) { refuse(entry.file, why); continue; }
    const link = linkedTo(entry.file);
    if (link !== undefined) { skipped.push({ file: entry.file, why: linkWhy(link) }); continue; }
    const name = nameOf(entry.file);
    if (name === null) { skipped.push({ file: entry.file, why: GLOB_NAME_WHY }); continue; }
    // Its name on disk, the one it is mutated under and vitest reaches it by,
    // differs from git's after a rename by case outside git.
    const onDisk = notMutated(name);
    if (onDisk) { refuse(name, onDisk); continue; }
    const text = read(entry.file);
    if (holdsExtraBreak(text)) { skipped.push({ file: entry.file, why: EXTRA_BREAK_WHY }); continue; }
    const before = entry.status === 'A' || entry.status === 'C' ? null : entry.from ?? entry.file;
    if (before === null || notMutated(before) !== null) { targets.push(wholeTarget(name)); continue; }
    const target = changeTarget(name, text, lineDiff(readBase(before), text, name, before));
    if (target) targets.push(target);
    else skipped.push({ file: entry.file, why: NO_CODE_WHY });
  }
  for (const file of untracked) {
    if (file.startsWith('src/') && file.endsWith('/')) {
      skipped.push({ file, why: 'an untracked git repository: git lists none of its files, so none is mutated' });
      continue;
    }
    const why = notMutated(file);
    const link = why ? undefined : linkedTo(file);
    const name = why || link !== undefined ? null : nameOf(file);
    if (why) skipped.push({ file, why });
    else if (link !== undefined) skipped.push({ file, why: linkWhy(link) });
    else if (name === null) skipped.push({ file, why: GLOB_NAME_WHY });
    else if (holdsExtraBreak(read(file))) skipped.push({ file, why: EXTRA_BREAK_WHY });
    else targets.push(wholeTarget(name));
  }
  /** @param {string | undefined} file */
  const inSrc = file => file !== undefined && file.startsWith('src/');
  return { targets, skipped, emptyScope: !entries.some(entry => inSrc(entry.file) || inSrc(entry.from)) && !untracked.some(inSrc) };
}

export const GLOB_NAME_WHY = 'its name holds characters Stryker reads as a glob, so it cannot be given to Stryker; rename it';

export const NO_CODE_WHY = 'no code changed (a rename, a mode change, line endings only, only blank lines or comments, or a file only taken out of the index)';

/**
 * Why a file listed under a name that leads through a link is not mutated
 * under it: a file is mutated under its own name only, when git lists it
 * changed (Stryker's copy does not follow a link to a directory, and a copy
 * made through a link to a file is not the file the tests import).
 * @param {string | null} name the file's own name; null when there is none in the manager root
 */
const linkWhy = name => (name === null
  ? 'it leads to no file in the manager root (a link to a directory or out of the root, a broken link, or a file gone since git listed it), so no sandbox holds it'
  : `a link to ${name}: a file is mutated under its own name only, when git lists it changed`);

/**
 * Where a listed name leads through a link, decided on the disk: undefined when
 * no link is on its way (a file renamed by case outside git included), the
 * file's own name (keys.mjs) when one is, null when it leads to no file in the
 * manager root. Node's own realpath, unlike the native one, keeps the case it is
 * given, so only a link changes the name.
 * @param {string} root
 * @param {string} file
 * @returns {string | null | undefined}
 */
export function linkOf(root, file) {
  const name = canonicalName(root, file);
  if (name === null) return null;
  try {
    const real = path.relative(fs.realpathSync(root), fs.realpathSync(path.join(root, file))).split(path.sep).join('/');
    return real === file ? undefined : name;
  } catch {
    return null;
  }
}

/**
 * The files listed under their own names (keys.mjs), as a sandbox holds them:
 * one reached only through a link is none of them, so `--mutate` refuses it.
 * @param {string} root
 * @param {Iterable<string>} files
 * @returns {Set<string>}
 */
export const ownNames = (root, files) => new Set([...files].filter(file => linkOf(root, file) === undefined).flatMap(file => {
  const name = canonicalName(root, file);
  return name === null ? [] : [name];
}));

/**
 * The name a file in the manager root `root` is mutated under: the one it has on
 * disk (keys.mjs), when Stryker can take it; null when it cannot
 * (GLOB_NAME_WHY). The planner's nameOf, which the content rule's pinned list
 * uses too.
 * @param {string} root
 * @param {string} file
 */
export function mutatedName(root, file) {
  const name = canonicalName(root, file);
  return name !== null && strykerTakes(root, name) ? name : null;
}

/**
 * planChange on what git says changed from base to the working tree of the manager
 * root `root`: `git` runs git there and returns what it printed, and `read`
 * gives a file's text. Each file is mutated under the name it has on disk
 * (keys.mjs), which Stryker matches: a file renamed by case outside git too.
 * git does not look at every file: not at one its index marks assume-unchanged
 * or skip-worktree (core.ignoreStat marks every file it adds), not at one a
 * file-system monitor says is unchanged, and not at one whose cached stat
 * still holds (its size and whole-second mtime, and its ctime, which on
 * Windows is when the file was made), so a same-size edit whose time was set
 * back shows in no diff. So every tracked file git did not name is checked by
 * its content: one gone is deleted, unless skip-worktree left it out (a sparse
 * checkout) or the base does not hold it as a file (a new file staged, then
 * taken off the disk), and one whose hash with git's filters differs from its
 * index blob is changed when its lines differ from the base's too.
 * @param {{ git: (...args: string[]) => string, base: string, root: string, read?: (file: string) => string }} io
 */
export function planFromGit({ git: run, base, root, read = file => fs.readFileSync(path.join(root, file), 'utf8') }) {
  /** @param {string[]} args */
  const git = (...args) => run('-c', 'core.fsmonitor=false', ...args);
  /** @param {string} file */
  const readBase = file => git('cat-file', 'blob', `${base}:${file}`);
  /** @param {string} file */
  const isFile = file => { try { return fs.statSync(path.join(root, file)).isFile(); } catch { return false; } };
  // base:file names the path as written, with no pathspec (so no GIT_*_PATHSPECS
  // variable reaches it), and -q fails with no message for one the base lacks.
  /** @param {string} file */
  const atBase = file => { try { return git('cat-file', '-t', git('rev-parse', '-q', '--verify', `${base}:${file}`).trim()).trim() === 'blob'; } catch { return false; } };
  const entries = parseNameStatus(git(...changedArgs(base)));
  const listed = new Set(entries.flatMap(entry => [entry.file, entry.from]));
  const sparse = new Set(git('ls-files', '-v', '-z').split('\0').filter(line => /^[sS] /.test(line)).map(line => line.slice(2)));
  // The hash can differ from the index with nothing changed: the index can hold
  // an edit staged and then undone, and hash-object reads no index, so a blob
  // that holds CRLF under text=auto hashes as LF. A file it flags is changed
  // only when its lines differ from the base's.
  /** @param {string} file */
  const linesDiffer = file => {
    let was;
    try { was = readBase(file); } catch { return true; }
    return splitLines(was).join('\n') !== splitLines(read(file)).join('\n');
  };
  /** @type {{ blob: string, file: string }[]} */
  const staged = [];
  for (const line of git('ls-files', '-s', '-z').split('\0')) {
    const m = /^10(?:0644|0755) ([0-9a-f]+) 0\t(.+)$/s.exec(line);
    if (!m || listed.has(m[2])) continue;
    if (isFile(m[2])) staged.push({ blob: m[1], file: m[2] });
    else if (!fs.existsSync(path.join(root, m[2])) && !sparse.has(m[2]) && atBase(m[2])) entries.push({ status: 'D', file: m[2] });
  }
  // In batches, as a command line has a length limit (32767 characters on Windows).
  for (let start = 0; start < staged.length;) {
    let end = start;
    for (let length = 0; end < staged.length && (end === start || length + staged[end].file.length < 8000); end++) length += staged[end].file.length + 1;
    const batch = staged.slice(start, end);
    const blobs = git('hash-object', '--', ...batch.map(s => s.file)).split('\n');
    batch.forEach((s, i) => { if (blobs[i] !== s.blob && linesDiffer(s.file)) entries.push({ status: 'M', file: s.file }); });
    start = end;
  }
  return planChange({
    entries,
    untracked: git('ls-files', '-z', '--others', '--exclude-standard').split('\0').filter(Boolean),
    read,
    readBase,
    // linkOf comes first, so a name here is the file's own.
    nameOf: file => mutatedName(root, file),
    linkOf: file => linkOf(root, file),
    // A submodule is a real dir; a link to one is a link (lstat).
    isDir: file => { try { return fs.lstatSync(path.join(root, file)).isDirectory(); } catch { return false; } },
  });
}

/**
 * What Stryker copies into a sandbox, as its ignorePatterns: everything left
 * out, then each of `files` let back in, so a sandbox holds those files and
 * nothing else (node_modules aside, which Stryker links, so a file git tracks
 * inside one is never let in over the link). Given the files the
 * gate fingerprints (tracked, or untracked and not ignored), no file git
 * ignores (.env, data dirs, dist), none of an untracked repository or a
 * submodule (git lists the dir only, and a dir lets nothing in), and none made
 * after the list is ever copied. Each name is escaped as Stryker's matcher
 * reads a pattern; one whose pattern still does not match it (on POSIX, a name
 * holding a backslash and a brace) is `unkept`, and the gate stops rather than
 * run without it. Stryker's copy does not follow a link to a directory, so a
 * file listed under a junction is not copied, and a tracked link to a
 * directory fails the copy.
 * @param {string[]} files from the manager root, with forward slashes; a dir ends in '/'
 * @returns {{ patterns: string[], unkept: string[] }}
 */
export function sandboxPatterns(files) {
  const options = { dot: true, flipNegate: true, nocase: true };
  const patterns = ['/**'];
  /** @type {string[]} */
  const unkept = [];
  for (const file of files) {
    if (file.endsWith('/') || file.split('/').includes('node_modules')) continue;
    const pattern = `!/${escape(file, { magicalBraces: true })}`;
    if (new Minimatch(pattern, options).match(`/${file}`)) patterns.push(pattern);
    else unkept.push(file);
  }
  return { patterns, unkept };
}

/**
 * Whether Stryker takes a file under this name, from the manager root, as itself:
 * it refuses a mutate pattern with lines whose name holds glob magic, and it
 * matches a pattern to the files it crawls by resolving it against the root,
 * turning backslashes into slashes and matching the whole path, read as a
 * glob, with minimatch. So the name must hold no magic, and its whole path must
 * match itself so: a [ ] class, a { } with a comma or a range, or an extglob
 * such as +( ) anywhere in it does not, nor does a pattern minimatch cannot
 * read and throws on. Other characters ( ) ! + @ are taken as they are.
 * @param {string} root
 * @param {string} name
 */
export function strykerTakes(root, name) {
  const whole = path.resolve(root, name).replace(/\\/g, '/');
  try {
    return !new Minimatch(name).hasMagic() && minimatch(whole, whole, { dot: false });
  } catch {
    return false;
  }
}

/**
 * Whether Stryker can match any file under the manager root: when it cannot, it
 * matches no file, and nothing is mutated.
 * @param {string} root
 */
export const rootGlobFree = root => strykerTakes(root, 'package.json');

/**
 * Whether vitest's related runs can find a test from the manager root: vitest 5
 * drops every import whose path holds the text node_modules anywhere, not only
 * as a dir of its own, and a sandbox's files lie under the root's path, so under
 * such a path no test would meet a mutant. Read
 * on the path as given and on the real path, which vitest resolves imports to.
 * A src file whose own path holds the text is not mutated (notMutated), for the
 * same reason.
 * @param {string} root
 */
export function rootRelatable(root) {
  let real = root;
  try { real = fs.realpathSync.native(root); } catch { real = root; }
  return ![root, real].some(dir => dir.includes('node_modules'));
}

/**
 * The tsconfig pass A's type checker is given. Stryker's checker compiles the
 * checkout from its working directory, not the sandbox, so with the root's
 * tsconfig it would judge files git ignores that the root's includes (a module
 * cloned into src), which no sandbox holds: such a file could turn a mutant
 * into a CompileError, counted as killed, or stop the pass. This one extends
 * the root's and lists only the files of the tree that the root's holds; a
 * file they import from outside the tree is still judged (beyondTree). Of the
 * @types it takes with no import, it takes the root's node_modules' only, as
 * the image's build does, not a node_modules' above the checkout, which
 * TypeScript would take too, unless the root's sets typeRoots of its own; an
 * import or a reference that reaches one is not seen (beyondTree).
 * @param {string} root
 * @param {Iterable<string>} tree the tree's files, from the manager root with forward slashes
 * @param {string} dir the dir it is written to, from the manager root
 */
export function treeTsconfig(root, tree, dir) {
  const rootConfig = path.join(root, 'tsconfig.json');
  const { config } = ts.readConfigFile(rootConfig, ts.sys.readFile);
  const held = ts.parseJsonConfigFileContent(config, ts.sys, root, undefined, rootConfig);
  const inTree = treeKeys(root, tree);
  /** @param {string} file */
  const from = file => path.relative(path.join(root, dir), file).split(path.sep).join('/');
  const files = held.fileNames.filter(file => inTree.has(fileKey(file))).map(file => from(path.resolve(file)));
  if (held.options.typeRoots) return { extends: from(rootConfig), include: [], files };
  return { extends: from(rootConfig), compilerOptions: { typeRoots: [from(path.join(root, 'node_modules', '@types'))] }, include: [], files };
}

/**
 * The files outside the tree that the type checker still judges with the
 * config treeTsconfig gives: TypeScript follows a tree file's imports and
 * references (a type-only one included) to a file git ignores, which no
 * sandbox holds. A file under a node_modules dir, wherever that dir is, is a
 * package and never named. Of those, checkerDiffers holds only the root's
 * install (through a link, another checkout's) and the TypeScript the checker
 * runs; any other node_modules TypeScript reads is not seen: one inside the
 * checkout other than the root's (made by hand in src, which TypeScript takes
 * before the root's for a file below it), and one above the checkout or above
 * the dir the root's node_modules links to, which an import or a reference the
 * root's install does not satisfy reaches, and which the image never has.
 * @param {string} root
 * @param {Iterable<string>} tree the tree's files, from the manager root with forward slashes
 * @param {object} config what treeTsconfig gave
 * @param {string} dir the dir it is written to, from the manager root
 * @returns {string[]} from the manager root with forward slashes
 */
export function beyondTree(root, tree, config, dir) {
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, path.join(root, dir), undefined, path.join(root, dir, 'tsconfig.json'));
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options, projectReferences: parsed.projectReferences });
  const inTree = treeKeys(root, tree);
  return program.getSourceFiles().map(source => path.relative(root, path.resolve(source.fileName)))
    .filter(file => !file.split(path.sep).includes('node_modules') && !inTree.has(fileKey(path.join(root, file))))
    .map(file => file.split(path.sep).join('/'));
}

/**
 * Why the type checker cannot stand in for the shipped build, or '': what it
 * reads is held to the root lockfile, which the build that ships installs (npm
 * install in the image), since a mutant the checker rejects and that build
 * accepts would count as killed with no test run. It runs test/'s installed
 * TypeScript, the one this file loads, which must be the lockfile's, and reads
 * the packages installed at the root (through a link, another checkout's),
 * whose record npm keeps (node_modules/.package-lock.json): it must hold the
 * lockfile's packages and no other (an optional one may be absent), each at
 * its version with the content the lockfile names (its integrity; a git
 * dependency, which has none, its resolved commit). npm writes that record at
 * its install, so a package placed at the root, or a package's files changed,
 * since (by hand, by another tool, by an npm rebuild) is not seen; npm's linked
 * layout records links, not versions, and an install that omits dev packages
 * lacks them, so either always differs. '' says only that: the checker judges
 * the tree's program, not the image's (README, The passes).
 * @param {string} root
 */
export function checkerDiffers(root) {
  /**
   * @param {string} file
   * @returns {Record<string, { version?: string, integrity?: string, resolved?: string, optional?: boolean, link?: boolean }> | undefined}
   */
  const read = file => { try { return JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')).packages; } catch { return undefined; } };
  const shipped = read('package-lock.json');
  const why = 'so a mutant the checker rejects and the shipped build accepts would count as killed with no test run';
  if (shipped?.['node_modules/typescript']?.version === undefined) {
    return 'the root lockfile (package-lock.json) names no TypeScript or could not be read, so what the shipped build compiles with is not known and the type checker cannot be held to it; restore the lockfile';
  }
  const version = String(shipped['node_modules/typescript'].version);
  if (version !== ts.version) {
    return `the type checker runs TypeScript ${ts.version} (test/'s, installed) and the root lockfile ships ${version}, ${why}; pin test/package.json and its lockfile to ${version} and run npm ci in test/ of a checkout whose test/node_modules is a dir of its own (a link names another checkout's: remove the link itself first, never what it names, from the manager root with node -e "require('fs').rmSync('test/node_modules')", which refuses a real dir)`;
  }
  const installed = read('node_modules/.package-lock.json') ?? {};
  for (const name of new Set([...Object.keys(shipped), ...Object.keys(installed)])) {
    const want = shipped[name];
    const have = installed[name];
    if (name === '' || (want?.optional && have === undefined)) continue;
    if (want && have && want.version === have.version && want.integrity === have.integrity && (want.integrity !== undefined || want.resolved === have.resolved)) continue;
    const other = want && have && want.version === have.version ? ` with other content (${have.resolved ?? 'no source recorded'})` : '';
    const is = have === undefined ? 'missing' : have.link ? 'a link' : `at ${have.version}${other}`;
    const ships = want === undefined ? 'names no such package' : want.link ? 'holds a link' : `ships ${want.version}`;
    return `the type checker reads the packages installed at the root, and in npm's record of that install (node_modules/.package-lock.json) ${name} is ${is} where the root lockfile ${ships}, ${why}; run npm ci --install-strategy=hoisted --include=dev at the root (npm's default layout with the dev packages, whatever a config or NODE_ENV says) of a checkout whose node_modules is a dir of its own (a link names another checkout's install: remove the link itself first, never what it names, from the manager root with node -e "require('fs').rmSync('node_modules')", which refuses a real dir)`;
  }
  return '';
}

/** @param {string} file a path, compared as the file system does (no case on Windows) */
const fileKey = file => (process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file));

/**
 * @param {string} root
 * @param {Iterable<string>} tree
 */
const treeKeys = (root, tree) => new Set([...tree].map(file => fileKey(path.join(root, file))));

/**
 * The lines a target answers for: its changed lines, or for a whole file or a
 * --mutate pattern, every line it covers.
 * @param {{ gating: number[] | null, patterns: string[] }} target
 * @param {number} lineCount
 * @returns {number[]}
 */
export function linesOfTarget(target, lineCount) {
  if (target.gating !== null) return target.gating;
  const lines = new Set();
  for (const pattern of target.patterns) {
    const range = /:(\d+)-(\d+)$/.exec(pattern);
    const [from, to] = range ? [Number(range[1]), Math.min(Number(range[2]), lineCount)] : [1, lineCount];
    for (let n = from; n <= to; n++) lines.add(n);
  }
  return [...lines].sort((a, b) => a - b);
}

/**
 * Whether a mutant (1-based lines, as Stryker reports them) lies within the
 * lines a --mutate pattern names (anywhere, when it names the whole file), as
 * Stryker decides it for a pattern of lines.
 * @param {string} pattern
 * @param {Location} location
 */
export function inPattern(pattern, location) {
  const range = /:(\d+)-(\d+)$/.exec(pattern);
  return !range || (Number(range[1]) <= location.start.line && location.end.line <= Number(range[2]));
}

/**
 * The --mutate patterns that made no mutant, each judged on its own lines, so
 * one beside another pattern on the same file is still named.
 * @param {{ file: string, patterns: string[], gating: number[] | null }[]} targets
 * @param {{ file: string, location: Location }[]} mutants
 */
export const unmatchedPatterns = (targets, mutants) => targets
  .filter(target => target.gating === null)
  .flatMap(target => target.patterns.filter(pattern => !mutants.some(m => m.file === target.file && inPattern(pattern, m.location))));

/**
 * Whether a mutant (1-based lines, as Stryker reports them) touches a gating
 * line.
 * @param {{ gating: number[] | null }} target
 * @param {Location} location
 */
export function gates(target, location) {
  return target.gating === null || target.gating.some(n => location.start.line <= n && n <= location.end.line);
}

/**
 * Whether a mutant of `file` gates for any target that names the file: two can
 * (two names git lists that differ only in case), each with its own diff, and
 * together they mutate and gate as one diff of all their changed lines would.
 * @param {{ file: string, gating: number[] | null }[]} targets
 * @param {string} file
 * @param {Location} location
 */
export const gatesIn = (targets, file, location) => targets.filter(target => target.file === file).some(target => gates(target, location));
