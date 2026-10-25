import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const st = vi.hoisted(() => ({
  bots: [] as any[],
  calls: [] as string[][],
  rules: [] as Array<[(args: string[]) => boolean, boolean, string, string]>,
  relayStatus: [] as any[],
  channelWrites: [] as any[],
  rescueWriteThrows: false,
  channelWriteThrows: false,
}));

vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>();
  const writeFileSync = (path: any, data: any, ...rest: any[]) => {
    if (String(path).startsWith('/tmp/relay-status')) { st.relayStatus.push(JSON.parse(String(data))); return; }
    return (real.writeFileSync as any)(path, data, ...rest);
  };
  const renameSync = (from: any, to: any) => {
    if (String(from).startsWith('/tmp/relay-status')) return;
    return real.renameSync(from, to);
  };
  return { ...real, writeFileSync, renameSync, default: { ...real, writeFileSync, renameSync } };
});

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const execFile = (cmd: string, args: string[], opts: any, maybeCb?: (err: any, stdout: string, stderr: string) => void) => {
    const cb = typeof opts === 'function' ? opts : maybeCb!;
    if (cmd !== 'docker') throw new Error(`unexpected execFile ${cmd}`);
    st.calls.push(args);
    const rule = st.rules.find(([match]) => match(args));
    const [, ok, stdout, stderr] = rule ?? [null, true, '', ''];
    setImmediate(() => cb(ok ? null : Object.assign(new Error('docker failed'), { code: 1 }), stdout, stderr));
    return { stdin: null };
  };
  return { ...real, execFile };
});
vi.mock('../../src/docker/containerManager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/docker/containerManager')>()),
  getAllBots: () => st.bots,
  getBot: (id: string) => st.bots.find(b => b.id === id) ?? null,
  isShuttingDown: () => false,
  updateInstanceRecoveryRescue: (id: string, rec: any) => {
    if (st.rescueWriteThrows) throw new Error('EACCES: registry write refused');
    const b = st.bots.find(x => x.id === id);
    if (b) b.recoveryRescue = rec ?? undefined;
  },
  updateInstanceRecoveryChannel: (id: string, rec: any) => {
    if (st.channelWriteThrows && rec?.disarmingAt) throw new Error('EACCES: registry write refused');
    st.channelWrites.push(rec);
    const b = st.bots.find(x => x.id === id);
    if (b) b.recoveryChannel = rec ?? undefined;
    return true;
  },
}));
vi.mock('../../src/instance/fleetReplication', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/fleetReplication')>()),
  generateCertPair: async (dir: string) => {
    const fs = await import('fs');
    const path = await import('path');
    fs.writeFileSync(path.join(dir, 'server.key'), 'k');
    fs.writeFileSync(path.join(dir, 'server.crt'), 'c');
    return { ok: true };
  },
}));
vi.mock('../../src/casaos/detector', () => ({ getDeploymentMode: async () => 'docker' }));

import { armSource, armReceiver, reconcileRecoveryChannels, getRecoveryChannelStatus } from '../../src/instance/recoveryChannel';
import * as rescue from '../../src/instance/recoveryRescue';

const isInspectOf = (name: string) => (a: string[]) => a[0] === 'inspect' && a[a.length - 1] === name;
const timedOut: [boolean, string, string] = [false, '', 'the command was stopped (SIGTERM)'];
const absent = (name: string): [(a: string[]) => boolean, boolean, string, string] => [isInspectOf(name), false, '', `Error: No such object: ${name}`];
const CERT_TEXT = '-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----\n';

function bot(extra: Record<string, unknown> = {}): any {
  return {
    id: 's1', sanitizedName: 'src1', displayName: 'Src 1', status: 'running',
    fleetDb: { containerName: 'src1-db', user: 'u', db: 'd', volume: 'src1-vol' },
    ...extra,
  };
}
const sourceChannel = { mode: 'source', containerName: 'src1-recovery-relay', token: 't', createdAt: 1, endpointHost: 'peer.invalid', endpointPort: 15433, pinCert: CERT_TEXT };

beforeEach(() => {
  st.bots = [];
  st.calls.length = 0;
  st.rules = [];
  st.channelWrites = [];
  st.rescueWriteThrows = false;
  st.channelWriteThrows = false;
  process.env.RECOVERY_RELAY_IMAGE = 'img';
});
afterEach(() => {
  delete process.env.RECOVERY_RELAY_IMAGE;
  vi.useRealTimers();
});

describe('FU-9 an arm rolled back over an unread rsync daemon keeps a record naming it', () => {
  it('keeps the channel as disarming with the daemon named, and says so', async () => {
    st.bots = [bot()];
    st.rules.push([isInspectOf('src1-recovery-rsyncd'), ...timedOut]);
    st.rules.push([a => a[0] === 'inspect' && a[2] === '{{.Name}}', true, '/mgr\n', '']);
    st.rules.push([a => a[0] === 'inspect', true, 'net1\n', '']);
    const r = await armSource(st.bots[0], { host: 'peer.invalid', port: 15433, cert: CERT_TEXT, token: 't' });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/src1-recovery-rsyncd/);
    expect(r.error).toMatch(/Disarm/);
    const kept = st.bots[0].recoveryChannel;
    expect(kept).toBeTruthy();
    expect(kept.disarmingAt).toBeGreaterThan(0);
    expect(kept.disarmLeft).toMatch(/src1-recovery-rsyncd/);
    expect(st.calls.filter(a => a[0] === 'rm' && a.includes('src1-recovery-rsyncd'))).toEqual([]);
    const status = await getRecoveryChannelStatus(st.bots[0]);
    expect(status.disarming?.left).toMatch(/src1-recovery-rsyncd/);
  });

  it('keeps the record when the daemon it started could not be removed', async () => {
    st.bots = [bot()];
    st.rules.push(absent('src1-recovery-rsyncd'));
    st.rules.push([a => a[0] === 'volume', false, '', 'Cannot connect to the Docker daemon']);
    st.rules.push([a => a[0] === 'rm' && a.includes('src1-recovery-rsyncd'), false, '', 'Error response from daemon: device busy']);
    st.rules.push([a => a[0] === 'inspect' && a[2] === '{{.Name}}', true, '/mgr\n', '']);
    st.rules.push([a => a[0] === 'inspect', true, 'net1\n', '']);
    const r = await armSource(st.bots[0], { host: 'peer.invalid', port: 15433, cert: CERT_TEXT, token: 't' });
    expect(r.success).toBe(false);
    expect(st.bots[0].recoveryChannel?.disarmLeft).toMatch(/src1-recovery-rsyncd could not be removed/);
  });

  it('still clears the record when the rollback removed everything', async () => {
    st.bots = [bot()];
    st.rules.push(absent('src1-recovery-rsyncd'));
    st.rules.push([a => a[0] === 'volume', false, '', 'Error: No such volume: src1-vol']);
    st.rules.push([a => a[0] === 'inspect' && a[2] === '{{.Name}}', true, '/mgr\n', '']);
    st.rules.push([a => a[0] === 'inspect', true, 'net1\n', '']);
    const r = await armSource(st.bots[0], { host: 'peer.invalid', port: 15433, cert: CERT_TEXT, token: 't' });
    expect(r.success).toBe(false);
    expect(st.bots[0].recoveryChannel).toBeUndefined();
  });
});

describe('FU-9 a relay the arm rollback could not remove keeps a record naming it', () => {
  const relayRunTimesOut: [(a: string[]) => boolean, boolean, string, string] = [a => a[0] === 'run' && a.includes('src1-recovery-relay'), ...timedOut];
  let rmCount = 0;
  const secondRelayRmFails: [(a: string[]) => boolean, boolean, string, string] = [a => a[0] === 'rm' && a.includes('src1-recovery-relay') && ++rmCount >= 2, ...timedOut];
  beforeEach(() => { rmCount = 0; });

  it('source: keeps the record as disarming with the relay named', async () => {
    st.bots = [bot()];
    st.rules.push(relayRunTimesOut, secondRelayRmFails);
    st.rules.push([a => a[0] === 'inspect' && a[2] === '{{.Name}}', true, '/mgr\n', '']);
    st.rules.push([a => a[0] === 'inspect', true, 'net1\n', '']);
    const r = await armSource(st.bots[0], { host: 'peer.invalid', port: 15433, cert: CERT_TEXT, token: 't' });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/The arm was rolled back, but src1-recovery-relay could not be removed/);
    expect(st.bots[0].recoveryChannel?.disarmingAt).toBeGreaterThan(0);
    expect(st.bots[0].recoveryChannel?.disarmLeft).toMatch(/src1-recovery-relay could not be removed/);
  });

  it('receiver: keeps the record as disarming with the relay named', async () => {
    st.bots = [bot()];
    st.rules.push(relayRunTimesOut, secondRelayRmFails);
    st.rules.push([a => a[0] === 'inspect', true, 'net1\n', '']);
    const r = await armReceiver(st.bots[0], 'h.invalid', 15433);
    expect(r.success).toBe(false);
    expect(st.bots[0].recoveryChannel?.disarmingAt).toBeGreaterThan(0);
    expect(st.bots[0].recoveryChannel?.disarmLeft).toMatch(/src1-recovery-relay could not be removed/);
  });

  it('receiver: clears the record when the relay is proven gone', async () => {
    st.bots = [bot()];
    st.rules.push(relayRunTimesOut);
    st.rules.push([a => a[0] === 'rm', false, '', 'Error: No such container: src1-recovery-relay']);
    st.rules.push([a => a[0] === 'inspect', true, 'net1\n', '']);
    const r = await armReceiver(st.bots[0], 'h.invalid', 15433);
    expect(r.success).toBe(false);
    expect(st.bots[0].recoveryChannel).toBeUndefined();
  });

  it('says the channel stays armed when the disarming mark is refused', async () => {
    st.bots = [bot()];
    st.channelWriteThrows = true;
    st.rules.push([isInspectOf('src1-recovery-rsyncd'), ...timedOut]);
    st.rules.push([a => a[0] === 'inspect' && a[2] === '{{.Name}}', true, '/mgr\n', '']);
    st.rules.push([a => a[0] === 'inspect', true, 'net1\n', '']);
    const r = await armSource(st.bots[0], { host: 'peer.invalid', port: 15433, cert: CERT_TEXT, token: 't' });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/stays on record as armed/);
    expect(r.error).not.toMatch(/was rolled back/);
  });

  it('names an unread daemon once, in a sentence that starts with a capital', async () => {
    st.bots = [bot()];
    st.rules.push([isInspectOf('src1-recovery-rsyncd'), ...timedOut]);
    st.rules.push([a => a[0] === 'inspect' && a[2] === '{{.Name}}', true, '/mgr\n', '']);
    st.rules.push([a => a[0] === 'inspect', true, 'net1\n', '']);
    const r = await armSource(st.bots[0], { host: 'peer.invalid', port: 15433, cert: CERT_TEXT, token: 't' });
    expect(r.error!.match(/left as it is/g)?.length).toBe(1);
    expect(r.error).toMatch(/\. The arm was rolled back, but /);
  });
});

describe('FU-9 the reconciler checks the source rsync daemon while the relay runs', () => {
  it('claims no start when the record turns disarming before the start', async () => {
    st.bots = [bot({ recoveryChannel: { ...sourceChannel } })];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    st.rules.push([isInspectOf('src1-recovery-relay'), true, 'true\n', '']);
    st.rules.push([a => { if (isInspectOf('src1-recovery-rsyncd')(a)) { st.bots[0].recoveryChannel = { ...sourceChannel, disarmingAt: 5 }; return true; } return false; }, false, '', 'Error: No such object: src1-recovery-rsyncd']);
    await reconcileRecoveryChannels();
    expect(warn.mock.calls.some(c => /starting it again/.test(String(c[0])))).toBe(false);
    expect(st.calls.some(a => a[0] === 'run')).toBe(false);
    warn.mockRestore();
  });

  it('reports a missing daemon and starts it again', async () => {
    st.bots = [bot({ recoveryChannel: { ...sourceChannel } })];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    st.rules.push([isInspectOf('src1-recovery-relay'), true, 'true\n', '']);
    st.rules.push(absent('src1-recovery-rsyncd'));
    st.rules.push([a => a[0] === 'inspect', true, 'net1\n', '']);
    await reconcileRecoveryChannels();
    expect(warn.mock.calls.some(c => /rsync daemon src1-recovery-rsyncd .* is missing/.test(String(c[0])))).toBe(true);
    expect(warn.mock.calls.some(c => /starting it again/.test(String(c[0])))).toBe(false);
    expect(st.calls.some(a => a[0] === 'run' && a.includes('src1-recovery-rsyncd'))).toBe(true);
    expect(st.calls.filter(a => a[0] === 'rm' && a.includes('src1-recovery-relay'))).toEqual([]);
    warn.mockRestore();
  });

  it('leaves an unread daemon alone and says so', async () => {
    st.bots = [bot({ recoveryChannel: { ...sourceChannel } })];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    st.rules.push([isInspectOf('src1-recovery-relay'), true, 'true\n', '']);
    st.rules.push([isInspectOf('src1-recovery-rsyncd'), ...timedOut]);
    await reconcileRecoveryChannels();
    expect(warn.mock.calls.some(c => /Could not read the state of rsync daemon src1-recovery-rsyncd/.test(String(c[0])))).toBe(true);
    expect(st.calls.filter(a => a[0] === 'rm' || a[0] === 'run' || a[0] === 'start')).toEqual([]);
    warn.mockRestore();
  });

  it('does not touch a receiver for a daemon', async () => {
    st.bots = [bot({ recoveryChannel: { mode: 'receiver', containerName: 'src1-recovery-relay', token: 't', createdAt: 1, tunnelPort: 15433, publicHost: 'h', tlsKey: 'k', tlsCert: 'c' } })];
    st.rules.push([isInspectOf('src1-recovery-relay'), true, 'true\n', '']);
    await reconcileRecoveryChannels();
    expect(st.calls.filter(a => a.includes('src1-recovery-rsyncd'))).toEqual([]);
  });
});

describe('FU-9 a refused registry write in the driver catch stays inside the driver', () => {
  it('holds the failure on the card and rejects nothing', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => { unhandled.push(e); };
    process.on('unhandledRejection', onUnhandled);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      st.bots = [bot({ status: 'stopped', recoveryChannel: { mode: 'receiver', containerName: 'src1-recovery-relay', token: 't', createdAt: 1, tunnelPort: 15433, publicHost: 'h', tlsKey: 'k', tlsCert: 'c' },
        recoveryRescue: { phase: 'preflight', startedAt: 7, updatedAt: 7 } })];
      st.rescueWriteThrows = true;
      rescue.resumeRecoveryRescues();
      for (let i = 0; i < 50 && !warn.mock.calls.some(c => /retrying in/.test(String(c[0]))); i++) await new Promise(r => setImmediate(r));
      expect(warn.mock.calls.some(c => /\[RecoveryRescue\].*could not be written \(EACCES/.test(String(c[0])))).toBe(true);
      const card = rescue.getRescueStatus(st.bots[0]);
      expect(card?.lastError).toMatch(/preflight failed: .*its record could not be written \(EACCES: registry write refused\)/);
      expect(rescue.rescueRunnerLive('s1')).toBe(true);
      st.bots[0].recoveryRescue = undefined;
      await vi.advanceTimersByTimeAsync(30_000);
      for (let i = 0; i < 20 && rescue.rescueRunnerLive('s1'); i++) await new Promise(r => setImmediate(r));
      expect(rescue.rescueRunnerLive('s1')).toBe(false);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      warn.mockRestore();
    }
  });
});

describe('FU-9 relay refusal and dialer reasons', () => {
  const KEY = '-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgtM9o4pDpv0Cozikt\n4uwMJM46EUEJfbQjdtA2ByXUiKmhRANCAASCO4i47sdvseuYxeVB4O0rlxjNcVMU\n+oDBbAmwCX/c8cCbXLEKcl+wkz1IYT34cczAPZABg6O0Az0dRZ6eF3hp\n-----END PRIVATE KEY-----\n';
  const CERT = '-----BEGIN CERTIFICATE-----\nMIIBmTCCAT6gAwIBAgIUDgY+bMG7vClw3xqVXtdber+h0UswCgYIKoZIzj0EAwIw\nFTETMBEGA1UEAwwKcmVsYXkudGVzdDAgFw0yNjEwMjQxOTU2NTNaGA8yMTI2MDkz\nMDE5NTY1M1owFTETMBEGA1UEAwwKcmVsYXkudGVzdDBZMBMGByqGSM49AgEGCCqG\nSM49AwEHA0IABII7iLjux2+x65jF5UHg7SuXGM1xUxT6gMFsCbAJf9zxwJtcsQpy\nX7CTPUhhPfhxzMA9kAGDo7QDPR1Fnp4XeGmjajBoMB0GA1UdDgQWBBQqYKbJkFWh\nxPOcT7Q49mMc8zDPvjAfBgNVHSMEGDAWgBQqYKbJkFWhxPOcT7Q49mMc8zDPvjAP\nBgNVHRMBAf8EBTADAQH/MBUGA1UdEQQOMAyCCnJlbGF5LnRlc3QwCgYIKoZIzj0E\nAwIDSQAwRgIhAPguVl9lDTbwuZR4c91bTG90pN57G5fKrqNVJt6cb1HKAiEA/AUV\nrXUvU3u3dD9I72F/lLjbLGmWaqohTGadeXPYkCk=\n-----END CERTIFICATE-----\n';
  const RELAY_ENV = ['RELAY_MODE', 'RELAY_TOKEN', 'RELAY_SELF_ROLE', 'RELAY_TLS_KEY', 'RELAY_TLS_CERT', 'RELAY_TUNNEL_PORT', 'RELAY_LANES', 'RELAY_ENDPOINT', 'RELAY_PIN_CERT', 'RELAY_TLS_SERVERNAME'];
  const freePort = async () => {
    const net = await import('net');
    return new Promise<number>(resolve => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as any).port; s.close(() => resolve(p)); }); });
  };
  const waitStatus = async (check: (s: any) => boolean) => {
    const end = Date.now() + 8000;
    for (;;) {
      const hit = st.relayStatus.find(check);
      if (hit) return hit;
      if (Date.now() > end) throw new Error(`no matching status: ${JSON.stringify(st.relayStatus.slice(-3))}`);
      await new Promise(r => setTimeout(r, 20));
    }
  };
  const frame = (payload: unknown) => {
    const body = Buffer.from(JSON.stringify(payload));
    const len = Buffer.alloc(4); len.writeUInt32BE(body.length, 0);
    return Buffer.concat([len, body]);
  };
  beforeEach(() => { st.relayStatus = []; vi.resetModules(); });
  afterEach(() => { for (const k of RELAY_ENV) delete process.env[k]; });

  it('a listener records a dial that claims its own role as a refusal, with tunnelUp false', async () => {
    const tls = await import('tls');
    const port = await freePort();
    Object.assign(process.env, { RELAY_MODE: 'listen', RELAY_TOKEN: 'good-token', RELAY_SELF_ROLE: 'receiver', RELAY_TLS_KEY: KEY, RELAY_TLS_CERT: CERT, RELAY_TUNNEL_PORT: String(port), RELAY_LANES: `control:${await freePort()}` });
    await import('../../src/recovery/relay');
    let client: any = null;
    const end = Date.now() + 3000;
    while (!client) {
      client = await new Promise(resolve => {
        const s = tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false }, () => resolve(s));
        s.on('error', () => resolve(null));
      });
      if (!client) { if (Date.now() > end) throw new Error('listener did not start'); await new Promise(r => setTimeout(r, 20)); }
    }
    client.write(frame({ token: 'good-token', role: 'receiver', identity: {} }));
    const s = await waitStatus(x => !!x.lastRefusal);
    expect(s.lastRefusal.reason).toBe('a dial claimed the same role (receiver)');
    expect(s.lastError).toBeNull();
    expect(s.tunnelUp).toBe(false);
    client.destroy();
  });

  it('a dialer keeps the reason the peer gave for refusing it in lastError', async () => {
    const tls = await import('tls');
    const server = tls.createServer({ key: KEY, cert: CERT }, socket => {
      socket.once('data', () => socket.write(frame({ ok: false, error: 'bad token' })));
      socket.on('error', () => undefined);
    });
    const port = await new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as any).port)));
    try {
      Object.assign(process.env, { RELAY_MODE: 'dial', RELAY_TOKEN: 'good-token', RELAY_SELF_ROLE: 'source', RELAY_ENDPOINT: `127.0.0.1:${port}`, RELAY_PIN_CERT: CERT, RELAY_TLS_SERVERNAME: 'relay.test', RELAY_LANES: 'control:127.0.0.1:1' });
      await import('../../src/recovery/relay');
      const s = await waitStatus(x => !!x.lastError);
      expect(s.lastError).toBe('bad token');
      expect(s.tunnelUp).toBe(false);
    } finally {
      server.close();
    }
  });
});
