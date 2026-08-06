/**
 * Minimal argv parser: splits positionals from flags. Boolean flags never consume
 * the next token; every other `--flag` takes the following token as its value
 * unless written as `--flag=value`.
 */

const BOOLEAN_FLAGS = new Set(['json', 'wait', 'follow', 'scan', 'help', 'keep-data', 'no-keep-env']);

export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === '-h') {
      flags.help = true;
      continue;
    }
    if (!tok.startsWith('--')) {
      positionals.push(tok);
      continue;
    }
    const eq = tok.indexOf('=');
    if (eq >= 0) {
      flags[tok.slice(2, eq)] = tok.slice(eq + 1);
      continue;
    }
    const name = tok.slice(2);
    if (BOOLEAN_FLAGS.has(name)) {
      flags[name] = true;
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[name] = next;
      i++;
    } else {
      flags[name] = true;
    }
  }
  return { positionals, flags };
}

export function flagStr(flags: Record<string, string | boolean>, name: string): string | undefined {
  const v = flags[name];
  return typeof v === 'string' ? v : undefined;
}

export function flagInt(flags: Record<string, string | boolean>, name: string, fallback: number): number {
  const v = flagStr(flags, name);
  if (v === undefined) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}
