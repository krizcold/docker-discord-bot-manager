/**
 * Shared YAML document operations: in-place set/delete at a path, preserving
 * comments and key order via the `yaml` lib's CST-backed Document.
 *
 * Used with two policies:
 *  - the config serializer passes createMissing: true (user-driven guided edits
 *    may legitimately introduce keys/list entries the template lacked).
 *  - templateModifiers passes createMissing: false (a default-tweak only adjusts
 *    keys the bot already ships; it must never invent config).
 *
 * Fidelity note: when an edit actually changes the document we re-emit it via the
 * yaml lib, which is byte-stable for block-style 2-space YAML but normalizes flow
 * collections ([a, b] -> [ a, b ]) and non-canonical indentation/spacing even in
 * untouched regions. This is inherent to the yaml round-trip (and matches the
 * prior templateModifiers behavior). A wholly untouched body is returned verbatim.
 */
import { parseDocument } from 'yaml';
import { splitPath } from './configPath';

export interface YamlOp {
  path: string;
  value?: unknown;     // ignored when remove is true
  remove?: boolean;    // true => delete the node at path
}

export function applyYamlOps(body: string, ops: YamlOp[], opts?: { createMissing?: boolean }): string {
  const createMissing = opts?.createMissing ?? false;
  try {
    const doc = parseDocument(body);
    let changed = false;
    for (const op of ops) {
      const keys = splitPath(op.path);
      if (keys.length === 0) continue;
      try {
        if (op.remove) {
          if (doc.hasIn(keys)) { doc.deleteIn(keys); changed = true; }
        } else if (createMissing || doc.hasIn(keys)) {
          doc.setIn(keys, op.value);
          changed = true;
        }
      } catch (err) {
        // one bad op (e.g. setting a child under a scalar) is skipped, not fatal
        console.warn(`[yamlOps] skipped op for path "${op.path}":`, err instanceof Error ? err.message : err);
      }
    }
    // Only re-serialize when something actually changed, so an op that matched
    // nothing leaves the body byte-for-byte intact (no incidental reformatting).
    return changed ? doc.toString() : body;
  } catch {
    return body;   // malformed YAML: leave untouched
  }
}
