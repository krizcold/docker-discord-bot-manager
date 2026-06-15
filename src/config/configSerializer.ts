/**
 * Format-agnostic config (de)serialization for the guided config builder.
 *
 *  - parseConfig:    body -> plain object, for reading current field values.
 *  - serializeConfig: apply path-targeted set/delete ops to a body IN PLACE,
 *    preserving comments, key order, and formatting (JSONC via jsonc-parser,
 *    YAML via the shared yaml-document ops).
 *
 * The body string is always the single source of truth; it is edited in place
 * and never regenerated from scratch, so a config file's comments and layout
 * survive a full round-trip through the guided form. List settings are written
 * as a whole-array set at the array's path (the renderer rebuilds the array from
 * its rows), which keeps surrounding structure and comments intact. Op values
 * must already carry their intended JS type (number/boolean/string/array); the
 * form/op-builder coerces per the manifest field type before calling serialize.
 */
import { parseDocument } from 'yaml';
import { modify, applyEdits, parse as parseJsonc, ParseError, printParseErrorCode } from 'jsonc-parser';
import { splitPath } from './configPath';
import { applyYamlOps, YamlOp } from './yamlOps';

export type ConfigFormat = 'json' | 'yaml';

export interface ConfigOp {
  path: string;
  value?: unknown;     // ignored when remove is true
  remove?: boolean;    // true => delete the node at path
  insert?: boolean;    // true => insert value as a new array element at the index in path (JSON only)
}

export type ParseResult =
  | { ok: true; data: unknown }
  | { ok: false; error: string };

/**
 * Parse a config body to a plain object. JSONC comments and trailing commas are
 * tolerated. Returns ok:false with a message on malformed input (the caller
 * keeps the last good parse and pauses the guided view, never clobbering it).
 */
export function parseConfig(format: ConfigFormat, body: string): ParseResult {
  try {
    if (format === 'yaml') {
      const doc = parseDocument(body);
      if (doc.errors.length > 0) return { ok: false, error: doc.errors[0].message };
      return { ok: true, data: doc.toJSON() };
    }
    const errors: ParseError[] = [];
    const data = parseJsonc(body, errors, { allowTrailingComma: true, disallowComments: false });
    if (errors.length > 0) {
      const e = errors[0];
      return { ok: false, error: `${printParseErrorCode(e.error)} at offset ${e.offset}` };
    }
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Apply set/delete ops to a body in place. A no-op list returns the body
 * verbatim (byte-stable), so an untouched config is delivered exactly as shipped.
 */
export function serializeConfig(format: ConfigFormat, body: string, ops: ConfigOp[]): string {
  if (ops.length === 0) return body;

  if (format === 'yaml') {
    const yamlOps: YamlOp[] = ops.map(o => ({ path: o.path, value: o.value, remove: o.remove }));
    return applyYamlOps(body, yamlOps, { createMissing: true });
  }

  // json / jsonc: edit in place, preserving comments + formatting. `modify` with
  // an undefined value removes the node; with a value it sets/creates it
  // (creating missing intermediate objects). Each op is guarded so a
  // non-applicable op (removing an absent node, a parent type mismatch, an
  // out-of-range index) is a no-op instead of throwing out and discarding the
  // whole batch - matching the YAML branch's resilience.
  let out = body;
  const formattingOptions = { insertSpaces: true, tabSize: 2 };
  for (const op of ops) {
    const segments = splitPath(op.path);
    if (segments.length === 0) continue;
    const newValue = op.remove ? undefined : op.value;
    try {
      const modOpts = op.insert ? { formattingOptions, isArrayInsertion: true } : { formattingOptions };
      const edits = modify(out, segments, newValue, modOpts);
      out = applyEdits(out, edits);
    } catch {
      // op did not apply; leave the body unchanged and continue.
    }
  }
  return out;
}
