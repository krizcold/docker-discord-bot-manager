/**
 * Shared processing for docker/compose child-process output: ANSI stripping,
 * cross-chunk line assembly, and structural progress classification.
 * Progress keys let the UI and LogCollector coalesce repeated progress lines
 * (docker pull layers, BuildKit transfers, compose state) instead of stacking them.
 */

export type DockerLogFn = (line: string, progressKey?: string) => void;

const ANSI_PATTERN = /\x1b\[[0-9;?]*[A-Za-z]/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_PATTERN, '');
}

const LAYER_STATUS =
  'Already exists|Pulling fs layer|Waiting|Downloading|Verifying Checksum|Download complete|Extracting|Pull complete|Retrying in \\d+ seconds?';

const BK_BLOB = /^#(\d+) sha256:([0-9a-f]{8,}) [\d.]+[kKMGT]?i?B \/ [\d.]+[kKMGT]?i?B/;
const BK_EXTRACT = /^#(\d+) extracting sha256:([0-9a-f]{8,})/;
const BK_STEP = /^#(\d+) \[[^\]]*\]/;
const BK_WAIT = /^#(\d+) \.\.\.$/;
const PULL_COLON = new RegExp(`^([0-9a-f]{10,64}): (?:${LAYER_STATUS})\\b`);
const PULL_SPACE = new RegExp(`^([0-9a-f]{10,64}) (?:${LAYER_STATUS})\\b`);
const COMPOSE_RESOURCE =
  /^(Network|Volume|Container|Image) +("[^"]+"|\S+) +(Creating|Created|Starting|Started|Restarting|Stopping|Stopped|Removing|Removed|Recreating|Recreated|Running|Waiting|Healthy|Error|Pulling|Pulled|Building|Built)\b/;
const COMPOSE_SERVICE = /^(\S+) (Pulling|Pulled)$/;

export function classifyProgress(line: string): string | undefined {
  let m = BK_BLOB.exec(line);
  if (m) return `bk:${m[1]}:blob:${m[2].slice(0, 12)}`;
  m = BK_EXTRACT.exec(line);
  if (m) return `bk:${m[1]}:extract:${m[2].slice(0, 12)}`;
  m = BK_STEP.exec(line);
  if (m) return `bk:${m[1]}:step`;
  m = BK_WAIT.exec(line);
  if (m) return `bk:${m[1]}:wait`;
  m = PULL_COLON.exec(line);
  if (m) return `layer:${m[1]}`;
  m = PULL_SPACE.exec(line);
  if (m) return `layer:${m[1]}`;
  m = COMPOSE_RESOURCE.exec(line);
  if (m) return `res:${m[1]}:${m[2]}`;
  m = COMPOSE_SERVICE.exec(line);
  if (m) return `svc:${m[1]}`;
  return undefined;
}

const MAX_PARTIAL = 65536;

export function createLineHandler(onLine: DockerLogFn): {
  data: (chunk: Buffer) => void;
  flush: () => void;
} {
  let partial = '';

  const emitLine = (raw: string) => {
    const line = stripAnsi(raw).trim();
    if (!line) return;
    onLine(line, classifyProgress(line));
  };

  return {
    data: (chunk: Buffer) => {
      partial += chunk.toString();
      const parts = partial.split(/[\r\n]+/);
      partial = parts.pop() ?? '';
      for (const part of parts) emitLine(part);
      if (partial.length > MAX_PARTIAL) {
        emitLine(partial);
        partial = '';
      }
    },
    flush: () => {
      if (partial) {
        emitLine(partial);
        partial = '';
      }
    },
  };
}
