/**
 * Parse a config path into segments for YAML/JSON node addressing.
 *  - a bracket index `[N]` becomes a numeric array index:
 *      "a.b[0].c" -> ['a', 'b', 0, 'c']
 *  - a bare dotted segment is ALWAYS a string key, even if all-digits:
 *      "m.429"    -> ['m', '429']   (the object key "429", not array index 429)
 * Use bracket form to address an array element; use dotted form for object keys.
 * Shared by the YAML and JSON serializers so addressing is identical across
 * formats.
 *
 * Limitation: there is no escaping, so a key that literally contains '.', '['
 * or ']' cannot be addressed. The target bots use identifier-style keys, so this
 * is acceptable; add a quoted-segment form (e.g. a["weird.key"]) if one ever
 * needs it.
 */
export function splitPath(path: string): Array<string | number> {
  if (!path) return [];
  const out: Array<string | number> = [];
  const token = /\[(\d+)\]|([^.[\]]+)/g;
  let m: RegExpExecArray | null;
  while ((m = token.exec(path)) !== null) {
    if (m[1] !== undefined) out.push(Number(m[1]));   // [N] -> array index
    else if (m[2]) out.push(m[2]);                     // dotted key (string, even if digits)
  }
  return out;
}
