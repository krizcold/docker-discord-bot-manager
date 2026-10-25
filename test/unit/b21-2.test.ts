import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const st = vi.hoisted(() => ({
  bots: [] as any[],
  calls: [] as string[][],
  // First matching rule answers a docker call: [predicate, ok, stdout, stderr].
  rules: [] as Array<[(args: string[]) => boolean, boolean, string, string]>,
  relayStatus: [] as any[],
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
  const execFile = (cmd: string, args: string[], _opts: any, cb: (err: any, stdout: string, stderr: string) => void) => {
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
  readDeployedCompose: () => 'compose',
  runningNonSidecarContainers: async () => [],
  updateInstanceRecoveryRescue: (id: string, rec: any) => {
    const b = st.bots.find(x => x.id === id);
    if (b) b.recoveryRescue = rec ?? undefined;
  },
  updateInstanceRecoveryChannel: () => true,
}));
vi.mock('../../src/templates/pcsProcessing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/templates/pcsProcessing')>()),
  fleetAppContainerName: () => 'app-1',
}));
vi.mock('../../src/config/appCapabilities', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/config/appCapabilities')>()),
  findAppCapabilities: () => ({ hooks: { port: 3000, basePath: '/hooks' } }),
}));
vi.mock('../../src/casaos/detector', () => ({ getDeploymentMode: async () => 'docker' }));

import { callAppHook } from '../../src/instance/appHookClient';
import { getRecoveryChannelStatus, reconcileRecoveryChannels } from '../../src/instance/recoveryChannel';
import { ensureRsyncDaemon } from '../../src/instance/recoveryControl';
import * as rescue from '../../src/instance/recoveryRescue';

const isInspectOf = (name: string) => (a: string[]) => a[0] === 'inspect' && a[a.length - 1] === name;
const timedOut: [boolean, string, string] = [false, '', 'the command was stopped (SIGTERM)'];

function receiver(extra: Record<string, unknown> = {}): any {
  return {
    id: 'b1', sanitizedName: 'bot1', displayName: 'Bot 1', status: 'stopped', sourceUrl: 'x', updateToken: 'tok',
    fleetDb: { containerName: 'bot1-db', user: 'u', db: 'd', volume: 'bot1-vol' },
    recoveryChannel: { mode: 'receiver', containerName: 'bot1-recovery-relay', token: 't', createdAt: 1, tunnelPort: 15433, publicHost: 'h', tlsKey: 'k', tlsCert: 'c' },
    ...extra,
  };
}

beforeEach(() => {
  st.bots = [];
  st.calls.length = 0;
  st.rules = [];
  process.env.RECOVERY_RELAY_IMAGE = 'img';
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.RECOVERY_RELAY_IMAGE;
});

describe('appHookClient: a hook that times out is unknown, not failed', () => {
  it('says the call was sent and no answer came, and flags unknown', async () => {
    vi.stubGlobal('fetch', async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); });
    const r = await callAppHook({ id: 'b1', sourceUrl: 'x', updateToken: 'tok', envVars: {} } as any, 'promote', 'POST', {}, 5000);
    expect(r.ok).toBe(false);
    expect(r.unknown).toBe(true);
    expect(r.error).toBe("promote sent, no answer within 5 s; check the app's Fleet view before retrying");
  });

  it('keeps a connection failure as unreachable, without unknown', async () => {
    vi.stubGlobal('fetch', async () => { throw new TypeError('fetch failed'); });
    const r = await callAppHook({ id: 'b1', sourceUrl: 'x', updateToken: 'tok', envVars: {} } as any, 'promote');
    expect(r.unknown).toBeUndefined();
    expect(r.error).toMatch(/^promote unreachable/);
  });
});

describe('relay inspect is tri-state', () => {
  it('reports an unanswered inspect as unknown, with its reason', async () => {
    st.rules.push([isInspectOf('bot1-recovery-relay'), ...timedOut]);
    const s = await getRecoveryChannelStatus(receiver());
    expect(s.containerState).toBe('unknown');
    expect(s.stateError).toContain('stopped');
    expect(s.containerRunning).toBe(false);
  });

  it('reports docker\'s "no such object" as absent', async () => {
    st.rules.push([isInspectOf('bot1-recovery-relay'), false, '', 'Error: No such object: bot1-recovery-relay']);
    const s = await getRecoveryChannelStatus(receiver());
    expect(s.containerState).toBe('absent');
  });

  it('names a failed status-file read instead of showing nothing', async () => {
    st.rules.push([isInspectOf('bot1-recovery-relay'), true, 'true\n', '']);
    st.rules.push([a => a[0] === 'exec', false, '', 'Error response from daemon: context deadline exceeded']);
    const s = await getRecoveryChannelStatus(receiver());
    expect(s.live).toBeNull();
    expect(s.liveError).toContain('context deadline exceeded');
  });

  it('carries the listener\'s last refused dial', async () => {
    st.rules.push([isInspectOf('bot1-recovery-relay'), true, 'true\n', '']);
    st.rules.push([a => a[0] === 'exec', true, JSON.stringify({ tunnelUp: false, lastRefusal: { reason: 'a dial offered the wrong channel token', at: 5 } }), '']);
    const s = await getRecoveryChannelStatus(receiver());
    expect(s.live?.lastRefusal).toEqual({ reason: 'a dial offered the wrong channel token', at: 5 });
  });
});

describe('the reconciler respawns only on a proven absence', () => {
  it('leaves the relay alone when its inspect goes unanswered', async () => {
    st.bots = [receiver()];
    st.rules.push([isInspectOf('bot1-recovery-relay'), ...timedOut]);
    st.rules.push([a => a[0] === 'inspect', true, 'net1\n', '']);
    await reconcileRecoveryChannels();
    expect(st.calls.filter(a => a[0] === 'rm' || a[0] === 'run' || a[0] === 'start')).toEqual([]);
  });

  it('respawns a relay docker reports missing', async () => {
    st.bots = [receiver()];
    st.rules.push([isInspectOf('bot1-recovery-relay'), false, '', 'Error: No such object: bot1-recovery-relay']);
    st.rules.push([a => a[0] === 'inspect', true, 'net1\n', '']);
    await reconcileRecoveryChannels();
    expect(st.calls.some(a => a[0] === 'run')).toBe(true);
  });

  it('ensureRsyncDaemon leaves an unread daemon alone and says so', async () => {
    st.rules.push([isInspectOf('bot1-recovery-rsyncd'), ...timedOut]);
    const r = await ensureRsyncDaemon(receiver(), 'img', 'net1');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/could not read the rsync daemon's state/);
    expect(st.calls.filter(a => a[0] === 'rm' || a[0] === 'run')).toEqual([]);
  });
});

describe('the rescue control call says whether the source answered', () => {
  it('words an answered refusal as a refusal', async () => {
    st.bots = [receiver()];
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ success: false, error: 'replication posture missing on the source' }), { status: 409 }));
    const r = await rescue.startRescue(st.bots[0], false);
    expect(r.error).toBe('The source refused: replication posture missing on the source');
  });

  it('words a call with no reply as no answer', async () => {
    st.bots = [receiver()];
    vi.stubGlobal('fetch', async () => { throw new TypeError('fetch failed'); });
    const r = await rescue.startRescue(st.bots[0], false);
    expect(r.error).toMatch(/^The source did not answer through the tunnel: control prepare unreachable/);
  });
});

describe('caught up needs an attached walsender', () => {
  const answered = (slotActive: boolean) => ({ ok: true, answered: true, body: { sourceLsn: '0/10', slotActive } });
  const replayed = { ok: true, stdout: 't|0\n', stderr: '' };

  it('is not caught up while the source reports no walsender on the slot', () => {
    const v = (rescue as any).streamingVerdict(answered(false), replayed);
    expect(v.caughtUp).toBe(false);
    expect(v.senderAttached).toBe(false);
    expect(v.lastError).toBe('Standby is up but not receiving from the sender');
  });

  it('is caught up with the slot active and no lag', () => {
    const v = (rescue as any).streamingVerdict(answered(true), replayed);
    expect(v).toMatchObject({ caughtUp: true, senderAttached: true, lastError: undefined });
  });

  it('cannot tell attachment from an unanswered status read', () => {
    const v = (rescue as any).streamingVerdict({ ok: false, answered: false, error: 'control status unreachable: x' }, null);
    expect(v.senderAttached).toBeNull();
    expect(v.lastError).toMatch(/did not answer the status read/);
  });

  it('refuses the swap until a walsender was seen attached', () => {
    const bot = receiver({ recoveryRescue: { phase: 'streaming', startedAt: 1, updatedAt: 1, caughtUp: true } });
    st.bots = [bot];
    const r = rescue.startSwap(bot, false);
    expect(r.success).toBe(false);
    expect(r.needsConfirm).toBeUndefined();
    expect(r.error).toMatch(/recovery slot/);
  });
});

describe('reviewer round 1 rows', () => {
  const waitFor = async (check: () => boolean, ms = 4000) => {
    const end = Date.now() + ms;
    while (!check()) {
      if (Date.now() > end) throw new Error('condition not reached');
      await new Promise(r => setTimeout(r, 10));
    }
  };

  it('a GET hook that times out says it did not answer, without unknown', async () => {
    vi.stubGlobal('fetch', async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); });
    const r = await callAppHook({ id: 'b1', sourceUrl: 'x', updateToken: 'tok', envVars: {} } as any, 'facts', 'GET', undefined, 5000);
    expect(r.unknown).toBeUndefined();
    expect(r.error).toBe('facts did not answer within 5 s');
  });

  it('words an answered status-read failure as an error answer, not a refusal', () => {
    const v = (rescue as any).streamingVerdict({ ok: false, answered: true, error: 'could not read the source database: x' }, null);
    expect(v.lastError).toBe('the source answered the status read with an error: could not read the source database: x');
  });

  it('stamps the relay identity with the time it was read', async () => {
    st.bots = [receiver({ id: 'b-id' })];
    st.rules.push([isInspectOf('bot1-recovery-relay'), false, '', 'Error: No such object: bot1-recovery-relay']);
    st.rules.push([a => a[0] === 'exec' && a.includes('psql'), true, '123|2|0/10\n', '']);
    st.rules.push([a => a[0] === 'inspect', true, 'net1\n', '']);
    const before = Date.now();
    await reconcileRecoveryChannels();
    const run = st.calls.find(a => a[0] === 'run')!;
    const identity = JSON.parse(run.find(a => a.startsWith('RELAY_SELF_IDENTITY='))!.slice('RELAY_SELF_IDENTITY='.length));
    expect(identity).toMatchObject({ systemId: '123', timeline: 2 });
    expect(identity.capturedAt).toBeGreaterThanOrEqual(before);
  });

  it('spawnRelay on a source leaves an rsync daemon it could not read', async () => {
    const source = receiver({ id: 'b-src', recoveryChannel: { mode: 'source', containerName: 'bot1-recovery-relay', token: 't', createdAt: 1, endpointHost: 'h', endpointPort: 15433, pinCert: 'c' } });
    st.bots = [source];
    st.rules.push([isInspectOf('bot1-recovery-relay'), false, '', 'Error: No such object: bot1-recovery-relay']);
    st.rules.push([isInspectOf('bot1-recovery-rsyncd'), ...timedOut]);
    st.rules.push([a => a[0] === 'inspect' && a[2] === '{{.Name}}', true, '/mgr\n', '']);
    st.rules.push([a => a[0] === 'inspect', true, 'net1\n', '']);
    await reconcileRecoveryChannels();
    expect(st.calls.some(a => a[0] === 'run')).toBe(true);
    expect(st.calls.filter(a => a[0] === 'rm' && a.includes('bot1-recovery-rsyncd'))).toEqual([]);
  });

  const catchupBot = (id: string, extra: Record<string, unknown>) => receiver({ id, recoveryRescue: { phase: 'catchup', startedAt: 1, updatedAt: 1, swapTargetLsn: '0/20', ...extra } });
  const behind = () => st.rules.push([a => a[0] === 'exec' && a.includes('psql'), true, 't|100\n', '']);

  it('catchup parks after ten minutes of answered reads with no walsender', async () => {
    const bot = catchupBot('b-park', { noSenderSince: Date.now() - 10 * 60_000 });
    st.bots = [bot];
    behind();
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ success: true, sourceLsn: '0/30', slotActive: false, slotWalStatus: 'reserved' })));
    rescue.resumeRecoveryRescues();
    await waitFor(() => bot.recoveryRescue?.parked === true);
    expect(bot.recoveryRescue.lastError).toMatch(/no walsender has been attached/);
  });

  it('catchup starts the no-walsender clock on an answered read showing none', async () => {
    const bot = catchupBot('b-start', {});
    st.bots = [bot];
    behind();
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ success: true, sourceLsn: '0/30', slotActive: false, slotWalStatus: 'reserved' })));
    rescue.resumeRecoveryRescues();
    await waitFor(() => bot.recoveryRescue?.noSenderSince !== undefined);
    expect(bot.recoveryRescue.parked).toBeFalsy();
  });

  it('an unanswered catchup read neither starts nor resets the clock', async () => {
    const fresh = catchupBot('b-none', {});
    const old = catchupBot('b-keep', { noSenderSince: 42 });
    st.bots = [fresh, old];
    behind();
    vi.stubGlobal('fetch', async () => { throw new TypeError('fetch failed'); });
    rescue.resumeRecoveryRescues();
    await waitFor(() => /did not answer/.test(fresh.recoveryRescue?.lastError || '') && /did not answer/.test(old.recoveryRescue?.lastError || ''));
    expect(fresh.recoveryRescue.noSenderSince).toBeUndefined();
    expect(old.recoveryRescue.noSenderSince).toBe(42);
    expect(old.recoveryRescue.parked).toBeFalsy();
  });

  it('the streaming monitor saves whether a walsender is attached', async () => {
    const bot = receiver({ id: 'b-mon', recoveryRescue: { phase: 'streaming', startedAt: 1, updatedAt: 1 } });
    st.bots = [bot];
    st.rules.push([a => a[0] === 'exec' && a.includes('psql'), true, 't|0\n', '']);
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ success: true, sourceLsn: '0/10', slotActive: false, slotWalStatus: 'reserved' })));
    rescue.resumeRecoveryRescues();
    await waitFor(() => bot.recoveryRescue?.senderAttached === false);
    expect(bot.recoveryRescue.caughtUp).toBe(false);
  });

  it('the status route answers 500 with the reason when its probe fails', async () => {
    const control = await import('../../src/instance/recoveryControl');
    st.bots = [receiver({ id: 'b-st', recoveryChannel: { mode: 'source', containerName: 'bot1-recovery-relay', token: 'status-token', createdAt: 1 } })];
    st.rules.push([a => a[0] === 'exec', false, '', 'psql: connection refused']);
    control.startRecoveryControlServer();
    try {
      let res: Response | null = null;
      const end = Date.now() + 3000;
      while (!res) {
        try { res = await fetch(`http://127.0.0.1:${control.RECOVERY_CONTROL_PORT}/control/status`, { headers: { 'x-recovery-token': 'status-token' } }); }
        catch (err) { if (Date.now() > end) throw err; await new Promise(r => setTimeout(r, 20)); }
      }
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ success: false, error: 'could not read the source database: psql: connection refused' });
    } finally {
      control.stopRecoveryControlServer();
    }
  });
});

describe('the relay records why a dial failed', () => {
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
  const frameHello = (payload: unknown) => {
    const body = Buffer.from(JSON.stringify(payload));
    const len = Buffer.alloc(4); len.writeUInt32BE(body.length, 0);
    return Buffer.concat([len, body]);
  };
  beforeEach(() => { st.relayStatus = []; vi.resetModules(); });
  afterEach(() => { for (const k of RELAY_ENV) delete process.env[k]; });

  it('a listener fed a bad token writes lastRefusal to its status file', async () => {
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
    client.write(frameHello({ token: 'wrong-token', role: 'source', identity: {} }));
    const s = await waitStatus(x => !!x.lastRefusal);
    expect(s.lastRefusal.reason).toBe('a dial offered the wrong channel token');
    expect(s.tunnelUp).toBe(false);
    client.destroy();
  });

  it('a dialer whose handshake reply is bad keeps that reason in lastError', async () => {
    const tls = await import('tls');
    const server = tls.createServer({ key: KEY, cert: CERT }, socket => {
      socket.once('data', () => {
        const junk = Buffer.from('not json');
        const len = Buffer.alloc(4); len.writeUInt32BE(junk.length, 0);
        socket.write(Buffer.concat([len, junk]));
      });
      socket.on('error', () => undefined);
    });
    const port = await new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as any).port)));
    try {
      Object.assign(process.env, { RELAY_MODE: 'dial', RELAY_TOKEN: 'good-token', RELAY_SELF_ROLE: 'source', RELAY_ENDPOINT: `127.0.0.1:${port}`, RELAY_PIN_CERT: CERT, RELAY_TLS_SERVERNAME: 'relay.test', RELAY_LANES: 'control:127.0.0.1:1' });
      await import('../../src/recovery/relay');
      const s = await waitStatus(x => !!x.lastError);
      expect(s.lastError).toBe('handshake is not JSON');
    } finally {
      server.close();
    }
  });
});
