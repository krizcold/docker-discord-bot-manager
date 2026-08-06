/**
 * Output + exit-code contract shared by every dbm verb.
 * JSON when stdout is not a TTY (or --json); human-readable tables otherwise.
 */

import { CliResponse } from './client';

export const EXIT_OK = 0;
export const EXIT_ERR = 1;
export const EXIT_USAGE = 2;
export const EXIT_TIMEOUT = 3;

export function jsonMode(flags: Record<string, unknown>): boolean {
  return Boolean(flags.json) || !process.stdout.isTTY;
}

export function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

export function fail(message: string, code = EXIT_ERR): never {
  process.stderr.write(`dbm: ${message}\n`);
  process.exit(code);
}

/** Render a plain aligned table for human mode. */
export function table(rows: Array<Record<string, unknown>>, columns: string[]): void {
  if (rows.length === 0) {
    process.stdout.write('(none)\n');
    return;
  }
  const widths = columns.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)));
  const line = (cells: string[]) => cells.map((cell, i) => cell.padEnd(widths[i])).join('  ').trimEnd();
  process.stdout.write(line(columns) + '\n');
  for (const r of rows) process.stdout.write(line(columns.map((c) => String(r[c] ?? ''))) + '\n');
}

/**
 * Terminal emit for a normal JSON API response: print, then exit non-zero if the
 * call failed. In human mode an optional table renderer formats a known list.
 */
export function emit(
  res: CliResponse,
  flags: Record<string, unknown>,
  humanFormat?: (body: unknown) => void,
): never {
  const body = res.body;
  const succeeded = res.ok && !(body && typeof body === 'object' && (body as { success?: boolean }).success === false);
  if (jsonMode(flags) || !humanFormat) {
    printJson(body);
  } else {
    humanFormat(body);
  }
  if (!succeeded) {
    const errMsg =
      body && typeof body === 'object' && 'error' in body ? String((body as { error: unknown }).error) : `HTTP ${res.status}`;
    if (!jsonMode(flags)) process.stderr.write(`dbm: request failed: ${errMsg}\n`);
    process.exit(EXIT_ERR);
  }
  process.exit(EXIT_OK);
}
