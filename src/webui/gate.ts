import { execFile } from 'child_process';
import crypto from 'crypto';
import http from 'http';
import net from 'net';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { getDeploymentMode } from '../casaos/detector';
import type { DeploymentMode } from '../types';

const LOOPBACK_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const HOOKS: Array<{ method: string; path: RegExp }> = [
  { method: 'GET', path: /^\/api\/bots\/[^/]+\/updates$/ },
  { method: 'POST', path: /^\/api\/bots\/[^/]+\/request-update$/ },
  { method: 'POST', path: /^\/api\/bots\/[^/]+\/webui-ready$/ },
];
const REREAD_MS = 30000;

export type Gate = {
  active: boolean;
  allows(req: http.IncomingMessage): boolean;
  isHook(req: http.IncomingMessage): boolean;
  middleware: RequestHandler;
  refresh(): Promise<void>;
};

type GateConfig = {
  secret: string;
  network: string;
  failClosed: boolean;
  readAddresses: (network: string) => Promise<string[]>;
  now?: () => number;
  log?: (line: string) => void;
};

function normalize(addr: string): string {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(addr);
  return m ? m[1] : addr.toLowerCase();
}

function toBits(addr: string): { v: number; n: bigint } | null {
  const a = normalize(addr);
  const v = net.isIP(a);
  if (v === 4) return { v, n: a.split('.').reduce((acc, p) => (acc << 8n) | BigInt(Number(p)), 0n) };
  if (v !== 6) return null;
  const [head, tail = ''] = a.split('::');
  const parts = (s: string) => (s ? s.split(':') : []);
  const h = parts(head);
  const t = parts(tail);
  if (a.includes('::')) h.push(...Array(8 - h.length - t.length).fill('0'), ...t);
  if (h.length !== 8) return null;
  return { v, n: h.reduce((acc, p) => (acc << 16n) | BigInt(parseInt(p, 16)), 0n) };
}

type Subnet = { address: string; v: number; base: bigint; mask: bigint };

function parseSubnet(entry: string): Subnet | null {
  const m = /^([^/]+)\/(\d+)$/.exec(entry);
  if (!m) return null;
  const bits = toBits(m[1]);
  const len = Number(m[2]);
  if (!bits) return null;
  const width = bits.v === 4 ? 32 : 128;
  if (len < 1 || len > width) return null;
  const mask = ((1n << BigInt(len)) - 1n) << BigInt(width - len);
  return { address: normalize(m[1]), v: bits.v, base: bits.n & mask, mask };
}

function inside(sub: Subnet, addr: string): boolean {
  const bits = toBits(addr);
  return !!bits && bits.v === sub.v && (bits.n & sub.mask) === sub.base;
}

export function createGate(cfg: GateConfig): Gate {
  const now = cfg.now || Date.now;
  const log = cfg.log || ((line: string) => console.log(line));
  const expected = Buffer.from(cfg.secret);
  let addresses: Subnet[] = [];
  let lastRead = -Infinity;
  let reading: Promise<void> | null = null;
  let warned = false;

  const secretMatches = (header: string | string[] | undefined): boolean => {
    if (!cfg.secret || typeof header !== 'string') return false;
    const given = Buffer.from(header);
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  };

  const refresh = (): Promise<void> => {
    if (reading) return reading;
    lastRead = now();
    reading = (async () => {
      let list: string[] = [];
      try { list = await cfg.readAddresses(cfg.network); } catch { list = []; }
      const next = list.filter((a) => typeof a === 'string').map(parseSubnet).filter((x): x is Subnet => !!x);
      addresses = next;
      if (next.length === 0) {
        if (!warned) log(`[Gate] Could not read this container's address on the network ${cfg.network}: only loopback and the bots' hooks are accepted until it can`);
        warned = true;
      } else {
        if (warned) log(`[Gate] Read this container's address on the network ${cfg.network}: its requests are accepted again`);
        warned = false;
      }
    })().finally(() => { reading = null; });
    return reading;
  };

  const allows = (req: http.IncomingMessage): boolean => {
    if (LOOPBACK_ADDRS.has(req.socket.remoteAddress || '')) return true;
    if (secretMatches(req.headers['x-dbm-gateway'])) return true;
    if (cfg.network) {
      const local = normalize(req.socket.localAddress || '');
      const remote = req.socket.remoteAddress || '';
      if (addresses.some((sub) => sub.address === local && inside(sub, remote))) return true;
    }
    return false;
  };

  const isHook = (req: http.IncomingMessage): boolean => {
    const token = req.headers['x-bot-token'];
    if (typeof token !== 'string' || !token) return false;
    const p = (req as Request).path ?? (req.url || '').split('?')[0];
    return HOOKS.some((h) => h.method === req.method && h.path.test(p));
  };

  const refused = (): string => {
    if (cfg.network && addresses.length === 0) {
      if (!reading && now() - lastRead >= REREAD_MS) void refresh();
      return `The manager refused this request: it could not read its own address on the network ${cfg.network}, so it cannot tell its AppShield from other apps. It reads it again at most every 30 seconds; reload in a minute, and restart the app if this stays.`;
    }
    if (!cfg.network && !cfg.secret && cfg.failClosed) {
      return 'The manager refused this request: MANAGER_GATE_NETWORK is not set, so it cannot tell its AppShield from other apps on this machine. Update the app; its compose sets it.';
    }
    return 'Forbidden';
  };

  const active = !!cfg.secret || !!cfg.network || cfg.failClosed;

  const gate: Gate = {
    active,
    allows: (req) => {
      if (allows(req)) return true;
      refused();
      return false;
    },
    isHook,
    middleware: (req: Request, res: Response, next: NextFunction) => {
      if (!active || allows(req) || isHook(req)) return next();
      res.status(403).json({ success: false, error: refused() });
    },
    refresh,
  };
  return gate;
}

export function readGateAddresses(
  network: string,
  run?: (file: string, args: string[]) => Promise<string>,
): Promise<string[]> {
  const self = process.env.HOSTNAME || 'discordbotmanagerapp';
  const exec = run || ((file: string, args: string[]) => new Promise<string>((resolve, reject) => {
    execFile(file, args, { timeout: 10000 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  }));
  return (async () => {
    try {
      const out = await exec('docker', ['inspect', '--format', '{{json .NetworkSettings.Networks}}', self]);
      const nets = JSON.parse(out);
      const entry = nets && typeof nets === 'object' ? nets[network] : undefined;
      if (!entry || typeof entry !== 'object') return [];
      const out4 = [entry.IPAddress, entry.IPPrefixLen];
      const out6 = [entry.GlobalIPv6Address, entry.GlobalIPv6PrefixLen];
      return [out4, out6]
        .filter(([a, len]) => typeof a === 'string' && a !== '' && Number.isInteger(len) && len > 0)
        .map(([a, len]) => `${a}/${len}`);
    } catch {
      return [];
    }
  })();
}

export async function initGate(deps: {
  env?: NodeJS.ProcessEnv;
  mode?: () => Promise<DeploymentMode>;
  readAddresses?: (network: string) => Promise<string[]>;
  now?: () => number;
} = {}): Promise<Gate> {
  const env = deps.env || process.env;
  const secret = env.MANAGER_GATEWAY_SECRET || '';
  const network = env.MANAGER_GATE_NETWORK || '';
  let failClosed = false;
  let modeError = '';
  try {
    failClosed = (await (deps.mode || getDeploymentMode)()) !== 'docker';
  } catch (err: any) {
    failClosed = true;
    modeError = String(err?.message || err);
  }
  const gate = createGate({ secret, network, failClosed, readAddresses: deps.readAddresses || readGateAddresses, now: deps.now });
  if (secret && network) {
    console.log(`[Gate] On: accepting requests with the X-DBM-Gateway header or that arrive on the network ${network}, from loopback, and the bots' hooks with a token`);
  } else if (network) {
    console.log(`[Gate] On: accepting requests that arrive on the network ${network}, from loopback, and the bots' hooks with a token`);
  } else if (secret) {
    console.log("[Gate] On: accepting requests with the X-DBM-Gateway header, from loopback, and the bots' hooks with a token");
  } else if (modeError) {
    console.log(`[Gate] The deployment mode could not be read (${modeError}) and no gate is set: only loopback and the bots' hooks are accepted`);
  } else if (failClosed) {
    console.log("[Gate] MANAGER_GATE_NETWORK is not set on a CasaOS install: only loopback and the bots' hooks are accepted");
  } else {
    console.log('[Gate] Off: MANAGER_GATEWAY_SECRET and MANAGER_GATE_NETWORK are not set, so every request is accepted');
  }
  if (network) await gate.refresh();
  return gate;
}
