/**
 * Recovery-channel relay (PLAN_REPLICATION.md Section 18, RC-2).
 *
 * Standalone entrypoint run inside a helper container (the manager's own
 * image), NOT part of the manager process: the tunnel must survive manager
 * restarts, and only a container can publish a host port at runtime.
 *
 * Two personalities, one binary:
 *  - LISTEN (the reachable machine, the RECEIVER): TLS server on
 *    RELAY_TUNNEL_PORT presenting RELAY_TLS_CERT/KEY, accepting ONE
 *    authenticated tunnel. Each lane in RELAY_LANES ("name:port,...") is a
 *    plain TCP listener on that port; receiver-side clients (walreceiver,
 *    rsync client) dial the helper container by name and their bytes ride
 *    the tunnel.
 *  - DIAL (the NAT'd machine, the SOURCE): dials RELAY_ENDPOINT outbound with
 *    the pinned RELAY_PIN_CERT + RELAY_TOKEN, redials forever with capped
 *    backoff until the container is removed. Each lane in RELAY_LANES
 *    ("name:host:port,...") maps to a FIXED local target; the listening side
 *    can only name a lane, never an address, so the NAT'd machine exposes
 *    exactly the services its own manager chose.
 *
 * Framing after the handshake: [u32 streamId][u8 type][u32 length][payload].
 * Types: 1 OPEN (payload = lane name), 2 DATA, 3 CLOSE, 4 PING, 5 PONG.
 * Stream 0 is the control lane (ping/pong only). Backpressure is head-of-line
 * by design (two lanes, one of them idle in practice): a saturated local
 * writer pauses the tunnel reader, a saturated tunnel pauses every local
 * reader.
 *
 * Status: /tmp/relay-status.json rewritten every 5s; the manager reads it
 * with docker exec. Nothing sensitive is ever written there or logged.
 */

import * as tls from 'tls';
import * as net from 'net';
import * as fs from 'fs';
import * as crypto from 'crypto';

const FRAME_OPEN = 1;
const FRAME_DATA = 2;
const FRAME_CLOSE = 3;
const FRAME_PING = 4;
const FRAME_PONG = 5;

const PING_INTERVAL_MS = 15_000;
const DEAD_LINK_MS = 45_000;
const REDIAL_MIN_MS = 1_000;
const REDIAL_MAX_MS = 60_000;
const STATUS_PATH = '/tmp/relay-status.json';
const STATUS_INTERVAL_MS = 5_000;
const MAX_FRAME_BYTES = 4 * 1024 * 1024;

interface Handshake {
  token: string;
  role: 'source' | 'receiver';
  identity: Record<string, unknown>;
}

interface LaneTarget { lane: string; host: string; port: number }
interface LaneListen { lane: string; port: number }

const mode = process.env.RELAY_MODE;
const token = process.env.RELAY_TOKEN || '';
const selfRole = process.env.RELAY_SELF_ROLE === 'source' ? 'source' : 'receiver';
let selfIdentity: Record<string, unknown> = {};
try { selfIdentity = JSON.parse(process.env.RELAY_SELF_IDENTITY || '{}'); } catch { /* stays empty */ }

const status = {
  mode,
  role: selfRole,
  tunnelUp: false,
  peerIdentity: null as Record<string, unknown> | null,
  streams: 0,
  bytesIn: 0,
  bytesOut: 0,
  lastError: null as string | null,
  connectedAt: null as number | null,
  updatedAt: 0,
};

function writeStatus(): void {
  status.updatedAt = Date.now();
  // tmp + rename: the manager reads this file with docker exec, and an
  // in-place truncating write hands it torn JSON on every unlucky tick.
  try {
    fs.writeFileSync(`${STATUS_PATH}.tmp`, JSON.stringify(status));
    fs.renameSync(`${STATUS_PATH}.tmp`, STATUS_PATH);
  } catch { /* status is best effort */ }
}
setInterval(writeStatus, STATUS_INTERVAL_MS).unref();

function log(message: string): void {
  console.log(`[Relay] ${message}`);
}

function fail(message: string): never {
  console.error(`[Relay] FATAL: ${message}`);
  process.exit(1);
}

if (!token) fail('RELAY_TOKEN is required');
if (mode !== 'listen' && mode !== 'dial') fail('RELAY_MODE must be listen or dial');

// ─── Framing ───

function frame(streamId: number, type: number, payload: Buffer): Buffer {
  const header = Buffer.allocUnsafe(9);
  header.writeUInt32BE(streamId, 0);
  header.writeUInt8(type, 4);
  header.writeUInt32BE(payload.length, 5);
  return Buffer.concat([header, payload]);
}

class FrameParser {
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  constructor(private readonly onFrame: (streamId: number, type: number, payload: Buffer) => void,
              private readonly onCorrupt: (reason: string) => void) {}

  push(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.buffer.length < 9) return;
      const length = this.buffer.readUInt32BE(5);
      if (length > MAX_FRAME_BYTES) { this.onCorrupt(`frame of ${length} bytes exceeds the cap`); return; }
      if (this.buffer.length < 9 + length) return;
      const streamId = this.buffer.readUInt32BE(0);
      const type = this.buffer.readUInt8(4);
      const payload = this.buffer.subarray(9, 9 + length);
      this.buffer = this.buffer.subarray(9 + length);
      this.onFrame(streamId, type, payload);
    }
  }
}

// ─── Shared tunnel logic (both personalities converge here after handshake) ───

interface TunnelPeer {
  socket: tls.TLSSocket;
  streams: Map<number, net.Socket>;
  nextStreamId: number;
  lastHeard: number;
}

let activeTunnel: TunnelPeer | null = null;

function teardownTunnel(reason: string): void {
  if (!activeTunnel) return;
  const tunnel = activeTunnel;
  // The dialer's close handler fires after this destroy with socket.errored
  // null; stamping the reason keeps it from being overwritten by the generic
  // close message in the status file.
  (tunnel.socket as { teardownReason?: string }).teardownReason = reason;
  activeTunnel = null;
  status.tunnelUp = false;
  status.peerIdentity = null;
  status.connectedAt = null;
  status.streams = 0;
  status.lastError = reason;
  for (const [, local] of tunnel.streams) local.destroy();
  tunnel.streams.clear();
  tunnel.socket.destroy();
  log(`tunnel down: ${reason}`);
  writeStatus();
}

function attachStream(tunnel: TunnelPeer, streamId: number, local: net.Socket): void {
  tunnel.streams.set(streamId, local);
  status.streams = tunnel.streams.size;

  local.on('data', chunk => {
    status.bytesOut += chunk.length;
    if (!tunnel.socket.write(frame(streamId, FRAME_DATA, chunk))) {
      local.pause();
      tunnel.socket.once('drain', () => local.resume());
    }
  });
  local.on('close', () => {
    if (tunnel.streams.delete(streamId)) {
      status.streams = tunnel.streams.size;
      if (activeTunnel === tunnel) tunnel.socket.write(frame(streamId, FRAME_CLOSE, Buffer.alloc(0)));
    }
  });
  local.on('error', () => { /* close follows and handles it */ });
}

function handleFrame(tunnel: TunnelPeer, openLane: (lane: string, streamId: number) => void,
                     streamId: number, type: number, payload: Buffer): void {
  tunnel.lastHeard = Date.now();
  if (type === FRAME_PING) { tunnel.socket.write(frame(0, FRAME_PONG, Buffer.alloc(0))); return; }
  if (type === FRAME_PONG) return;
  if (type === FRAME_OPEN) { openLane(payload.toString('utf8'), streamId); return; }
  const local = tunnel.streams.get(streamId);
  if (type === FRAME_DATA) {
    if (!local || local.destroyed) return; // late data for a closed/dying stream: drop
    status.bytesIn += payload.length;
    if (!local.write(payload)) {
      tunnel.socket.pause();
      // The release must fire on death as well as drain: a destroyed socket
      // never drains, and a permanently paused tunnel freezes lastHeard until
      // the dead-link check kills every other lane with it. One pending
      // release per socket: the parser drains its whole buffered backlog past
      // pause(), and a pair per failed write would stack listeners.
      if (!(local as { relayReleasePending?: boolean }).relayReleasePending) {
        (local as { relayReleasePending?: boolean }).relayReleasePending = true;
        const release = (): void => {
          local.off('drain', release);
          local.off('close', release);
          (local as { relayReleasePending?: boolean }).relayReleasePending = false;
          if (activeTunnel === tunnel) tunnel.socket.resume();
        };
        local.once('drain', release);
        local.once('close', release);
      }
    }
    return;
  }
  if (type === FRAME_CLOSE) {
    if (local) {
      tunnel.streams.delete(streamId);
      status.streams = tunnel.streams.size;
      local.end();
    }
  }
}

function startHeartbeat(tunnel: TunnelPeer): void {
  const timer = setInterval(() => {
    if (activeTunnel !== tunnel) { clearInterval(timer); return; }
    if (Date.now() - tunnel.lastHeard > DEAD_LINK_MS) {
      clearInterval(timer);
      teardownTunnel('no traffic or pong past the dead-link window');
      return;
    }
    tunnel.socket.write(frame(0, FRAME_PING, Buffer.alloc(0)));
  }, PING_INTERVAL_MS);
  timer.unref();
}

// ─── Handshake plumbing (length-prefixed JSON, then frame mode) ───

function readHandshake(socket: tls.TLSSocket, timeoutMs: number): Promise<Handshake> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => { cleanup(); reject(new Error('handshake timeout')); }, timeoutMs);
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 4) return;
      const length = buffer.readUInt32BE(0);
      if (length > 64 * 1024) { cleanup(); reject(new Error('handshake too large')); return; }
      if (buffer.length < 4 + length) return;
      cleanup();
      const rest = buffer.subarray(4 + length);
      try {
        const parsed = JSON.parse(buffer.subarray(4, 4 + length).toString('utf8'));
        if (rest.length > 0) socket.unshift(rest);
        resolve(parsed);
      } catch {
        reject(new Error('handshake is not JSON'));
      }
    };
    const onError = (err: Error): void => { cleanup(); reject(err); };
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
    };
    socket.on('data', onData);
    socket.on('error', onError);
  });
}

function writeHandshake(socket: tls.TLSSocket, payload: Record<string, unknown>): void {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(body.length, 0);
  socket.write(Buffer.concat([length, body]));
}

function tokenMatches(offered: string): boolean {
  const a = Buffer.from(String(offered || ''));
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ─── LISTEN personality ───

function parseListenLanes(raw: string): LaneListen[] {
  return raw.split(',').filter(Boolean).map(entry => {
    const [lane, port] = entry.split(':');
    if (!lane || !/^\d+$/.test(port || '')) fail(`bad RELAY_LANES entry: ${entry}`);
    return { lane, port: Number(port) };
  });
}

function runListener(): void {
  const key = process.env.RELAY_TLS_KEY || '';
  const cert = process.env.RELAY_TLS_CERT || '';
  const tunnelPort = Number(process.env.RELAY_TUNNEL_PORT || '9450');
  if (!key || !cert) fail('RELAY_TLS_KEY and RELAY_TLS_CERT are required in listen mode');
  const lanes = parseListenLanes(process.env.RELAY_LANES || '');
  if (lanes.length === 0) fail('RELAY_LANES is required');

  const server = tls.createServer({ key, cert, handshakeTimeout: 10_000 }, socket => {
    void (async () => {
      try {
        const hello = await readHandshake(socket, 15_000);
        if (!tokenMatches(hello.token)) {
          writeHandshake(socket, { ok: false, error: 'bad token' });
          socket.destroy();
          log('rejected a tunnel: bad token');
          return;
        }
        if (hello.role === selfRole) {
          writeHandshake(socket, { ok: false, error: `both ends are armed as ${selfRole}; one side must re-arm the other way` });
          socket.destroy();
          log(`rejected a tunnel: peer claims the same role (${selfRole})`);
          return;
        }
        // Single-tunnel policy: a newly authenticated dial replaces a dead
        // predecessor (the dialer redials after NAT rebinds; the stale socket
        // may not have errored yet on this side).
        if (activeTunnel) teardownTunnel('replaced by a new authenticated tunnel');
        writeHandshake(socket, { ok: true, role: selfRole, identity: selfIdentity });
        const tunnel: TunnelPeer = { socket, streams: new Map(), nextStreamId: 1, lastHeard: Date.now() };
        activeTunnel = tunnel;
        status.tunnelUp = true;
        status.peerIdentity = (hello.identity && typeof hello.identity === 'object') ? hello.identity : {};
        status.connectedAt = Date.now();
        status.lastError = null;
        log(`tunnel up (peer role ${hello.role})`);
        writeStatus();

        const parser = new FrameParser(
          (streamId, type, payload) => handleFrame(tunnel, () => { /* listener never receives OPEN */ }, streamId, type, payload),
          reason => { if (activeTunnel === tunnel) teardownTunnel(`corrupt frame: ${reason}`); });
        socket.on('data', chunk => parser.push(chunk));
        socket.on('error', err => { if (activeTunnel === tunnel) teardownTunnel(err.message); });
        socket.on('close', () => { if (activeTunnel === tunnel) teardownTunnel('tunnel socket closed'); });
        startHeartbeat(tunnel);
      } catch (err) {
        socket.destroy();
        log(`handshake failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
  });
  // This port faces the internet: cap unauthenticated concurrency (the one
  // legitimate peer plus redial overlap) - token auth only runs post-TLS.
  server.maxConnections = 16;
  server.listen(tunnelPort, () => log(`tunnel listener on :${tunnelPort}`));

  for (const { lane, port } of lanes) {
    const laneServer = net.createServer(local => {
      const tunnel = activeTunnel;
      if (!tunnel) { local.destroy(); return; }
      const streamId = tunnel.nextStreamId++;
      tunnel.socket.write(frame(streamId, FRAME_OPEN, Buffer.from(lane, 'utf8')));
      attachStream(tunnel, streamId, local);
    });
    laneServer.listen(port, () => log(`lane "${lane}" accepting on :${port}`));
  }
  writeStatus();
}

// ─── DIAL personality ───

function parseDialLanes(raw: string): LaneTarget[] {
  return raw.split(',').filter(Boolean).map(entry => {
    const parts = entry.split(':');
    if (parts.length !== 3 || !parts[0] || !parts[1] || !/^\d+$/.test(parts[2])) fail(`bad RELAY_LANES entry: ${entry}`);
    return { lane: parts[0], host: parts[1], port: Number(parts[2]) };
  });
}

function runDialer(): void {
  const endpoint = process.env.RELAY_ENDPOINT || '';
  const pinned = process.env.RELAY_PIN_CERT || '';
  const servername = process.env.RELAY_TLS_SERVERNAME || '';
  const [endpointHost, endpointPort] = endpoint.split(':');
  if (!endpointHost || !/^\d+$/.test(endpointPort || '')) fail('RELAY_ENDPOINT must be host:port');
  if (!pinned) fail('RELAY_PIN_CERT is required in dial mode');
  const targets = parseDialLanes(process.env.RELAY_LANES || '');
  if (targets.length === 0) fail('RELAY_LANES is required');
  const targetByLane = new Map(targets.map(t => [t.lane, t]));

  let backoff = REDIAL_MIN_MS;

  const dial = (): void => {
    log(`dialing ${endpointHost}:${endpointPort}`);
    const socket = tls.connect({
      host: endpointHost,
      port: Number(endpointPort),
      ca: pinned,
      servername: servername || endpointHost,
      rejectUnauthorized: true,
    }, () => {
      // Connected: the heartbeat owns dead-link detection from here. Without
      // clearing, an idle-but-healthy tunnel would trip the connect deadline.
      socket.setTimeout(0);
      void (async () => {
        try {
          writeHandshake(socket, { token, role: selfRole, identity: selfIdentity });
          const reply = await readHandshake(socket, 15_000);
          if (!(reply as any).ok) {
            // destroy WITH the reason: the error path carries it into the
            // status file and schedules the redial; a bare destroy would let
            // the generic close message overwrite it.
            const reason = String((reply as any).error || 'peer refused the handshake');
            log(`peer refused: ${reason}`);
            socket.destroy(new Error(reason));
            return;
          }
          const tunnel: TunnelPeer = { socket, streams: new Map(), nextStreamId: 1, lastHeard: Date.now() };
          // Backoff resets only once the tunnel PROVES it can hold: resetting
          // at handshake-ok lets two armed sources replace each other at the
          // minimum interval forever.
          setTimeout(() => { if (activeTunnel === tunnel) backoff = REDIAL_MIN_MS; }, 30_000).unref();
          activeTunnel = tunnel;
          status.tunnelUp = true;
          status.peerIdentity = ((reply as any).identity && typeof (reply as any).identity === 'object') ? (reply as any).identity : {};
          status.connectedAt = Date.now();
          status.lastError = null;
          log('tunnel up');
          writeStatus();

          const openLane = (lane: string, streamId: number): void => {
            const target = targetByLane.get(lane);
            if (!target) {
              tunnel.socket.write(frame(streamId, FRAME_CLOSE, Buffer.alloc(0)));
              log(`refused OPEN for unknown lane "${lane}"`);
              return;
            }
            const local = net.connect({ host: target.host, port: target.port });
            local.on('connect', () => { /* attached below; data flows once connected */ });
            local.on('error', () => {
              if (tunnel.streams.delete(streamId)) status.streams = tunnel.streams.size;
              if (activeTunnel === tunnel) tunnel.socket.write(frame(streamId, FRAME_CLOSE, Buffer.alloc(0)));
            });
            attachStream(tunnel, streamId, local);
          };

          const parser = new FrameParser(
            (streamId, type, payload) => handleFrame(tunnel, openLane, streamId, type, payload),
            reason => { if (activeTunnel === tunnel) teardownTunnel(`corrupt frame: ${reason}`); });
          socket.on('data', chunk => parser.push(chunk));
          startHeartbeat(tunnel);
        } catch (err) {
          status.lastError = err instanceof Error ? err.message : String(err);
          socket.destroy();
        }
      })();
    });
    const redial = (reason: string): void => {
      if (activeTunnel?.socket === socket) teardownTunnel(reason);
      else { status.lastError = reason; writeStatus(); }
      backoff = Math.min(backoff * 2, REDIAL_MAX_MS);
      // NEVER unref this timer: between dials it is the only handle keeping
      // the process alive, and an exiting dialer turns the coded backoff into
      // docker restart-policy flapping.
      setTimeout(dial, backoff);
    };
    // Deadline over the connect + TLS + handshake phase: a receiver that dies
    // after ACKing the ClientHello leaves no unacked data, so nothing else
    // would ever error this socket and the redial-forever guarantee dies with
    // it. Cleared in the connect callback above.
    socket.setTimeout(30_000, () => socket.destroy(new Error('connect/handshake deadline passed')));
    socket.on('error', err => redial(err.message));
    socket.on('close', () => {
      // error already scheduled the redial when it fired; a clean close (peer
      // teardown, replaced tunnel, dead-link teardown) has not.
      if (!socket.errored) redial((socket as { teardownReason?: string }).teardownReason || 'tunnel socket closed');
    });
  };

  dial();
  writeStatus();
}

if (mode === 'listen') runListener();
else runDialer();
