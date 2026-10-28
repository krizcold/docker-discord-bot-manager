import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm3-cert-'));
  process.env.DATA_DIR = dir;
  return { dir };
});

vi.mock('child_process', async (importOriginal) => (await import('./join-fake')).childProcessMock(await importOriginal<typeof import('child_process')>()));

import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import * as tls from 'tls';
import { certSource, fetchMainCertificate, mainCertificate } from '../../src/instance/fleetJoin';
import { docker, fakeJoin, FIXTURE_FP, FIXTURE_KEY, FIXTURE_PEM, resetDocker } from './join-fake';

type Behaviour = 'tls' | 'refuse' | 'close' | 'silent';
let servers: net.Server[] = [];

/** A Postgres-like listener: answers the SSLRequest with S and runs TLS with the fixture, or N, or closes, or says nothing. */
function listen(behaviour: Behaviour): Promise<number> {
  const server = net.createServer(socket => {
    socket.once('data', data => {
      expect(data.toString('hex')).toBe('0000000804d2162f');
      if (behaviour === 'refuse') { socket.write('N'); return; }
      if (behaviour === 'close') { socket.destroy(); return; }
      if (behaviour === 'silent') return;
      socket.write('S');
      const secure = new tls.TLSSocket(socket, { isServer: true, key: FIXTURE_KEY, cert: FIXTURE_PEM });
      secure.on('error', () => undefined);
    });
    socket.on('error', () => undefined);
  });
  servers.push(server);
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)));
}

beforeEach(() => resetDocker());
afterEach(async () => {
  await Promise.all(servers.map(s => new Promise(r => s.close(() => r(null)))));
  servers = [];
});
afterAll(() => fs.rmSync(tmp.dir, { recursive: true, force: true }));

describe('fetchMainCertificate reads the main\'s certificate from its TLS handshake', () => {
  it('returns the PEM and its fingerprint, equal to the fixture', async () => {
    const port = await listen('tls');
    const r = await fetchMainCertificate('127.0.0.1', port);
    expect(r).toMatchObject({ ok: true, fp: FIXTURE_FP });
    if (r.ok) expect(r.pem.replace(/\s+/g, '')).toBe(FIXTURE_PEM.replace(/\s+/g, ''));
  });

  it('a server that answers N offers no TLS', async () => {
    const port = await listen('refuse');
    expect(await fetchMainCertificate('127.0.0.1', port)).toEqual({ ok: false, reason: 'the server does not offer TLS' });
  });

  it('a server that closes before the answer byte', async () => {
    const port = await listen('close');
    const r = await fetchMainCertificate('127.0.0.1', port);
    expect(r.ok).toBe(false);
  });

  it('a server that stays silent past the timeout', async () => {
    const port = await listen('silent');
    expect(await fetchMainCertificate('127.0.0.1', port, 200)).toEqual({ ok: false, reason: 'no answer within 0 s' });
  });

  it('nothing listening', async () => {
    const port = await listen('tls');
    await new Promise(r => servers.pop()!.close(() => r(null)));
    const r = await fetchMainCertificate('127.0.0.1', port);
    expect(r.ok).toBe(false);
  });
});

describe('mainCertificate proves the main by the code\'s fingerprint (J3, C19)', () => {
  it('a remote main whose fingerprint matches', async () => {
    const port = await listen('tls');
    expect(await mainCertificate(fakeJoin({ host: '127.0.0.1', port }))).toMatchObject({ ok: true });
  });

  it('a remote main whose fingerprint differs gives T-16', async () => {
    const port = await listen('tls');
    const r = await mainCertificate(fakeJoin({ host: '127.0.0.1', port, fp: 'f'.repeat(64) }));
    expect(r).toMatchObject({ ok: false, kind: 'fingerprint' });
    if (!r.ok) expect(r.text).toBe(`The database at 127.0.0.1:${port} shows a certificate with fingerprint ${FIXTURE_FP.slice(0, 16)}..., not the ffffffffffffffff... in the join code, so the manager did not trust it; nothing was changed. Copy a new join code from the main's manager. If the main's certificate did not change, something else answers at that address.`);
  });

  it('an unreachable main gives T-15 with the reason', async () => {
    const real = certSource.fetch;
    certSource.fetch = async () => ({ ok: false, reason: 'connect ECONNREFUSED' });
    try {
      const r = await mainCertificate(fakeJoin());
      if (r.ok) throw new Error('expected a refusal');
      expect(r.text).toBe("Can't reach the main at main.invalid:15432 (connect ECONNREFUSED); nothing was changed. The main's machine must accept connections on that port. A machine that cannot open a port can be the main only when it runs alone.");
    } finally {
      certSource.fetch = real;
    }
  });

  it('a main on this same manager is read by docker exec, not the network', async () => {
    fs.writeFileSync(path.join(tmp.dir, 'instances.json'), JSON.stringify({ instances: {
      m: { id: 'm', displayName: 'm', sanitizedName: 'm', status: 'running', fleetDb: { containerName: 'm-fleet-postgres', user: 'smdb', db: 'smdb', volume: 'v', replication: { role: 'replicator', password: '', hostPort: 15432, publicHost: 'main.invalid', certHost: 'main.invalid' } } },
    } }));
    const fetched = vi.fn(certSource.fetch);
    const real = certSource.fetch;
    certSource.fetch = fetched;
    try {
      expect(await mainCertificate(fakeJoin())).toMatchObject({ ok: true });
      expect(docker.events).toContain('cert-exec');
      expect(fetched).not.toHaveBeenCalled();
      docker.mainCertExec = null;
      expect(await mainCertificate(fakeJoin())).toMatchObject({ ok: false, kind: 'unreachable' });
    } finally {
      certSource.fetch = real;
      fs.rmSync(path.join(tmp.dir, 'instances.json'), { force: true });
    }
  });
});
