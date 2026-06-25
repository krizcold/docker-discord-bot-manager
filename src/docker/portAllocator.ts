/**
 * Host-port allocation for standalone (docker mode) bot deployments.
 *
 * A bot's web UI is reached via a published host port (there is no Caddy gateway).
 * Ports are assigned from a configurable range, avoiding ports already taken by
 * other instances or bound on the host. A bot keeps its port across rebuilds so
 * its URL stays stable.
 */

const BASE = parseInt(process.env.BOT_HOST_PORT_BASE || '20000', 10);
const RANGE = parseInt(process.env.BOT_HOST_PORT_RANGE || '10000', 10);

/** Deterministic per-bot starting offset so a bot tends to land on the same port. */
function seedOffset(botId: string): number {
  let h = 0;
  for (let i = 0; i < botId.length; i++) {
    h = (h * 31 + botId.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % RANGE;
}

/**
 * Pick a free host port for a bot. Reuses the bot's previous port when still free
 * (stable URL); otherwise linear-probes from a deterministic offset. `used` are
 * ports claimed by other instances; `hostBound` are ports currently published on
 * the host (from dockerClient.listPublishedHostPorts). Returns null if the whole
 * range is taken.
 */
export function allocateHostPort(opts: {
  botId: string;
  reuse?: number;
  used: Set<number>;
  hostBound: Set<number>;
}): number | null {
  const { botId, reuse, used, hostBound } = opts;

  const isFree = (p: number) => !used.has(p) && !hostBound.has(p);

  if (reuse && reuse >= BASE && reuse < BASE + RANGE && isFree(reuse)) {
    return reuse;
  }

  const start = seedOffset(botId);
  for (let i = 0; i < RANGE; i++) {
    const candidate = BASE + ((start + i) % RANGE);
    if (isFree(candidate)) return candidate;
  }
  return null;
}
