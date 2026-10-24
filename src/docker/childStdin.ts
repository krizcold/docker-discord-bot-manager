import type { Writable } from 'stream';

/** Writes data to a child's stdin and ends it. A child that exits before reading makes the write fail (EPIPE); that error is ignored here because the child's own exit code reports the failure. */
export function feedStdin(stdin: Writable | null | undefined, data?: string | Buffer): void {
  if (!stdin) return;
  stdin.on('error', () => { /* the child's close or error event reports the outcome */ });
  if (data !== undefined) stdin.write(data);
  stdin.end();
}
