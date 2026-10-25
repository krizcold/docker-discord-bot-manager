import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const st = vi.hoisted(() => ({
  bots: [] as any[],
  calls: [] as string[][],
  rules: [] as Array<[(args: string[]) => boolean, boolean, string, string, boolean?]>,
}));

// rules: [match, ok, stdout, stderr, killed]; killed answers as node's execFile does when its timeout kills the child.
vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const execFile = (cmd: string, args: string[], opts: any, maybeCb?: (err: any, stdout: string, stderr: string) => void) => {
    const cb = typeof opts === 'function' ? opts : maybeCb!;
    if (cmd !== 'docker') throw new Error(`unexpected execFile ${cmd}`);
    st.calls.push(args);
    const rule = st.rules.find(([match]) => match(args));
    const [, ok, stdout, stderr, killed] = rule ?? [null, true, '', '', false];
    const err = ok ? null : killed
      ? Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM', code: null })
      : Object.assign(new Error('docker failed'), { code: 1 });
    setImmediate(() => cb(err, stdout, stderr));
    return { stdin: null };
  };
  return { ...real, execFile };
});
vi.mock('../../src/docker/containerManager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/docker/containerManager')>()),
  getAllBots: () => st.bots,
  getBot: (id: string) => st.bots.find(b => b.id === id) ?? null,
  registryFault: () => null,
  isShuttingDown: () => false,
  updateInstanceRecoveryChannel: (id: string, rec: any) => {
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

import { armReceiver, armSource } from '../../src/instance/recoveryChannel';

const RELAY = 'rcv1-recovery-relay';
const isRun = (a: string[]) => a[0] === 'run' && a.includes(RELAY);
const isRm = (a: string[]) => a[0] === 'rm' && a.includes(RELAY);

function bot(): any {
  return {
    id: 'r1', sanitizedName: 'rcv1', displayName: 'Rcv 1', status: 'running',
    fleetDb: { containerName: 'rcv1-db', user: 'u', db: 'd', volume: 'rcv1-vol' },
  };
}

beforeEach(() => {
  st.bots = [bot()];
  st.calls.length = 0;
  st.rules = [];
  process.env.RECOVERY_RELAY_IMAGE = 'img';
  st.rules.push([a => a[0] === 'inspect', true, 'net1\n', '']);
});
afterEach(() => {
  delete process.env.RECOVERY_RELAY_IMAGE;
});

describe('FU-9r a relay run that timed out is never proven gone by one rm', () => {
  it('keeps the record as disarming, naming the relay, when the rm finds no such container', async () => {
    st.rules.unshift([isRun, false, '', '', true]);
    st.rules.unshift([isRm, false, '', `Error response from daemon: No such container: ${RELAY}`]);
    const r = await armReceiver(st.bots[0], 'rcv.invalid', 15433);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/Disarm/);
    const kept = st.bots[0].recoveryChannel;
    expect(kept).toBeTruthy();
    expect(kept.disarmingAt).toBeGreaterThan(0);
    expect(kept.disarmLeft).toMatch(new RegExp(RELAY));
  });

  it('keeps the record when the rm after a timed-out run reports success', async () => {
    st.rules.unshift([isRun, false, '', '', true]);
    const r = await armReceiver(st.bots[0], 'rcv.invalid', 15433);
    expect(r.success).toBe(false);
    expect(st.bots[0].recoveryChannel?.disarmLeft).toMatch(new RegExp(RELAY));
  });

  it('still clears the record when a run that answered failed and the rm finds no such container', async () => {
    st.rules.unshift([isRun, false, '', 'Error response from daemon: port is already allocated']);
    st.rules.unshift([isRm, false, '', `Error response from daemon: No such container: ${RELAY}`]);
    const r = await armReceiver(st.bots[0], 'rcv.invalid', 15433);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/port is already allocated/);
    expect(st.bots[0].recoveryChannel).toBeUndefined();
  });
});

const RSYNCD = 'rcv1-recovery-rsyncd';
const PEM = '-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----\n';

describe('FU-9r an rsync daemon run that timed out is never proven gone by one rm', () => {
  beforeEach(() => {
    st.rules.unshift([a => a[0] === 'inspect' && a.includes(RSYNCD), false, '', `Error: No such object: ${RSYNCD}`]);
  });

  it('keeps the record as disarming, naming the rsync daemon, when the rm finds no such container', async () => {
    st.rules.unshift([a => a[0] === 'run' && a.includes(RSYNCD), false, '', '', true]);
    st.rules.unshift([a => a[0] === 'rm' && a.includes(RSYNCD), false, '', `Error response from daemon: No such container: ${RSYNCD}`]);
    const r = await armSource(st.bots[0], { host: 'rcv.invalid', port: 15433, cert: PEM, token: 't' });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/Disarm/);
    const kept = st.bots[0].recoveryChannel;
    expect(kept).toBeTruthy();
    expect(kept.disarmingAt).toBeGreaterThan(0);
    expect(kept.disarmLeft).toMatch(new RegExp(RSYNCD));
  });

  it('still clears the record when a daemon run that answered failed and the rm finds no such container', async () => {
    st.rules.unshift([a => a[0] === 'run' && a.includes(RSYNCD), false, '', 'Error response from daemon: image not found']);
    st.rules.unshift([a => a[0] === 'rm' && a.includes(RSYNCD), false, '', `Error response from daemon: No such container: ${RSYNCD}`]);
    const r = await armSource(st.bots[0], { host: 'rcv.invalid', port: 15433, cert: PEM, token: 't' });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/image not found/);
    expect(st.bots[0].recoveryChannel).toBeUndefined();
  });
});
