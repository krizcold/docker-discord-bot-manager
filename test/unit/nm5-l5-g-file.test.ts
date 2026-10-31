import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm5-l5-g-file-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return { dir };
});

vi.mock('child_process', async (o) => (await import('./switch-harness')).childProcessMock(await o()));
vi.mock('../../src/instance/dbLogin', async (o) => (await import('./switch-harness')).dbLoginMock(await o()));
vi.mock('../../src/instance/maintenance', async (o) => (await import('./switch-harness')).maintenanceMock(await o()));
vi.mock('../../src/docker/containerManager', async (o) => (await import('./switch-harness')).containerManagerMock(await o()));
vi.mock('../../src/instance/fleetBackup', async (o) => (await import('./switch-harness')).fleetBackupMock(await o()));
vi.mock('../../src/instance/fleetJoin', async (o) => (await import('./switch-harness')).fleetJoinMock(await o()));
vi.mock('../../src/instance/fleetReplica', async (o) => (await import('./switch-harness')).fleetReplicaMock(await o()));
vi.mock('../../src/instance/appHookClient', async (o) => (await import('./switch-harness')).appHookMock(await o()));
vi.mock('../../src/instance/backupCheck', async (o) => (await import('./switch-harness')).backupCheckMock(await o()));
vi.mock('../../src/env/manager', async (o) => (await import('./switch-harness')).envMock(await o()));
vi.mock('../../src/config/appCapabilities', async (o) => (await import('./switch-harness')).capsMock(await o()));

import * as fs from 'fs';
import * as path from 'path';
import { PassThrough } from 'stream';
import { downloadPath, freeSpace, receiveUpload } from '../../src/instance/fleetMove';
import * as containerManager from '../../src/docker/containerManager';
import { freshDb, fake, mainFixture, resetHarness, writeRegistry } from './switch-harness';

const BOT = path.join(tmp.dir, 'backups', 'a');
const DIR = path.join(BOT, 'fleet-postgres');
const NOT_DUMP = 'This file is not a database backup made by the manager (pg_dump custom format), so it was not kept';
const nodeFs = require('fs') as typeof import('fs');
const syncExports = () => require('module').syncBuiltinESMExports();

type Result = { status: number; body: any };
const within = (p: Promise<Result>, ms = 3000) => Promise.race([p, new Promise<never>((_r, reject) => setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms))]);

/** A request stand-in: a stream with headers; `timeout` adds setTimeout and keeps its callback. */
function fakeReq(length: string | null, opts: { timeout?: boolean } = {}) {
  const req: any = new PassThrough();
  req.headers = length === null ? {} : { 'content-length': length };
  const destroy = req.destroy.bind(req);
  req.destroyCalls = 0;
  req.destroy = (...a: unknown[]) => { req.destroyCalls++; return destroy(...a); };
  if (opts.timeout) req.setTimeout = (ms: number, cb: () => void) => { req.timeoutMs = ms; req.onTimeout = cb; return req; };
  return req;
}
const upload = (req: any) => within(receiveUpload('a', req));
const left = () => (fs.existsSync(DIR) ? fs.readdirSync(DIR) : []);

const realWriteStream = nodeFs.createWriteStream;
let streams: Array<{ path: unknown; opts: unknown; stream: fs.WriteStream }> = [];

beforeEach(() => {
  resetHarness();
  fake.dbs['a-pg'] = freshDb();
  writeRegistry({ a: mainFixture() });
  fs.rmSync(BOT, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  streams = [];
  nodeFs.createWriteStream = ((p: any, o: any) => {
    const stream = realWriteStream(p, o);
    streams.push({ path: p, opts: o, stream });
    return stream;
  }) as typeof nodeFs.createWriteStream;
  syncExports();
});
afterEach(() => {
  nodeFs.createWriteStream = realWriteStream;
  syncExports();
});
afterAll(() => fs.rmSync(tmp.dir, { recursive: true, force: true }));

describe('downloadPath names', () => {
  it('a name with a space before a valid tail, and a name with text after .dump, are invalid', () => {
    expect(downloadPath('a', 'a b.dump')).toEqual({ ok: false, status: 400, error: 'Invalid dump file name' });
    expect(downloadPath('a', 'x.dump.bak')).toEqual({ ok: false, status: 400, error: 'Invalid dump file name' });
  });
  it('a folder with a dump name is not found', () => {
    fs.mkdirSync(path.join(DIR, 'folder.dump'));
    expect(downloadPath('a', 'folder.dump')).toEqual({ ok: false, status: 404, error: 'Dump file not found' });
  });
});

describe('receiveUpload refusals', () => {
  it('an unknown bot: 404', async () => {
    expect(await within(receiveUpload('zz', fakeReq('5')))).toEqual({ status: 404, body: { success: false, error: 'Bot not found' } });
  });
  it('shutting down: 503 with the refusal', async () => {
    const spy = vi.spyOn(containerManager, 'isShuttingDown').mockReturnValue(true);
    try {
      expect(await upload(fakeReq('5'))).toEqual({ status: 503, body: { success: false, error: containerManager.SHUTDOWN_REFUSAL } });
    } finally {
      spy.mockRestore();
    }
  });
  it.each(['abc', '-1'])('a length of %s: 411, nothing written', async (length) => {
    expect(await upload(fakeReq(length))).toEqual({ status: 411, body: { success: false, error: 'The upload carries no length' } });
    expect(left()).toEqual([]);
  });
  it('a length of 0 is taken, and the empty file is not a dump', async () => {
    const req = fakeReq('0');
    const r = upload(req);
    req.end();
    expect(await r).toEqual({ status: 400, body: { success: false, error: NOT_DUMP } });
    expect(left()).toEqual([]);
  });
  it('less free space than needed: 507 with success false', async () => {
    const spy = vi.spyOn(freeSpace, 'of').mockReturnValue(100);
    try {
      expect(await upload(fakeReq('5'))).toEqual({ status: 507, body: { success: false, error: 'Not enough free disk space for this file (0.0 GiB free, 0.5 GiB needed), so nothing was written' } });
    } finally {
      spy.mockRestore();
    }
  });
});

describe('receiveUpload keeps a dump', () => {
  const send = async (body: string, over: { timeout?: boolean } = {}) => {
    const req = fakeReq(String(body.length), over);
    const r = upload(req);
    req.end(Buffer.from(body));
    return { req, r: await r };
  };
  it('the backups folder missing with its parent: made, and the dump kept with success true and a log line', async () => {
    fs.rmSync(BOT, { recursive: true, force: true });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    let r: Result;
    try {
      r = (await send('PGDMP and more')).r;
      expect(log.mock.calls.map(c => c[0])).toContainEqual(expect.stringMatching(new RegExp(`^\\[Switch\\] A: uploaded a backup as ${r.body.file.replace(/\./g, '\\.')} \\(\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d UTC\\)$`)));
    } finally {
      log.mockRestore();
    }
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(left()).toEqual([r.body.file]);
  });
  it('free space equal to the need is enough', async () => {
    const spy = vi.spyOn(freeSpace, 'of').mockReturnValue(5 + 512 * 1024 * 1024);
    try {
      expect((await send('PGDMP')).r.status).toBe(200);
    } finally {
      spy.mockRestore();
    }
  });
  it('the tmp is written with mode 0600', async () => {
    expect((await send('PGDMP')).r.status).toBe(200);
    expect(streams).toHaveLength(1);
    expect(streams[0].opts).toEqual({ mode: 0o600 });
  });
  it('the tmp is synced and closed, then the folder is opened, synced and closed', async () => {
    const real = { open: nodeFs.openSync, fsync: nodeFs.fsyncSync, close: nodeFs.closeSync };
    const spare = path.join(tmp.dir, 'g-spare');
    fs.writeFileSync(spare, '');
    const log: string[] = [];
    let tmpFd = -1;
    let dirFd = -1;
    nodeFs.openSync = ((p: any, flags: any, mode?: any) => {
      if (p === DIR) {
        if (flags !== 'r') throw new Error(`bad flags ${flags}`);
        dirFd = real.open(spare, 'r+');
        log.push('open-dir');
        return dirFd;
      }
      const fd = real.open(p, flags, mode);
      if (String(p).endsWith('.dump.tmp')) { tmpFd = fd; log.push(`open-tmp:${flags}`); }
      return fd;
    }) as typeof nodeFs.openSync;
    nodeFs.fsyncSync = ((fd: number) => { if (fd === dirFd) log.push('fsync-dir'); else if (fd === tmpFd) log.push('fsync-tmp'); return real.fsync(fd); }) as typeof nodeFs.fsyncSync;
    nodeFs.closeSync = ((fd: number) => { if (fd === dirFd) log.push('close-dir'); else if (fd === tmpFd) { log.push('close-tmp'); tmpFd = -1; } return real.close(fd); }) as typeof nodeFs.closeSync;
    syncExports();
    try {
      expect((await send('PGDMP')).r.status).toBe(200);
    } finally {
      Object.assign(nodeFs, { openSync: real.open, fsyncSync: real.fsync, closeSync: real.close });
      syncExports();
    }
    expect(log).toEqual(['open-tmp:r+', 'fsync-tmp', 'close-tmp', 'open-dir', 'fsync-dir', 'close-dir']);
  });
});

describe('receiveUpload drops a cut upload', () => {
  it('60 seconds of silence: the request destroyed, 408, nothing kept', async () => {
    const req = fakeReq('100', { timeout: true });
    const r = upload(req);
    req.write(Buffer.from('PGDMP'));
    expect(req.timeoutMs).toBe(60_000);
    req.onTimeout();
    expect(await r).toEqual({ status: 408, body: { success: false, error: 'The upload stopped sending data for 60 seconds, so nothing was kept' } });
    expect(req.destroyCalls).toBe(1);
    expect(streams[0].stream.destroyed).toBe(true);
  });
  it('the request aborted: 400, the tmp stream destroyed', async () => {
    const req = fakeReq('100');
    const r = upload(req);
    req.emit('aborted');
    expect(await r).toEqual({ status: 400, body: { success: false, error: 'The upload was cut off, so nothing was kept' } });
    expect(streams[0].stream.destroyed).toBe(true);
  });
  it('the request errors: 500 naming it', async () => {
    const req = fakeReq('100');
    const r = upload(req);
    req.emit('error', new Error('socket hang up'));
    expect(await r).toEqual({ status: 500, body: { success: false, error: 'The file could not be written (socket hang up), so nothing was kept' } });
  });
  it('the file stream errors: 500 naming it', async () => {
    const req = fakeReq('100');
    const r = upload(req);
    streams[0].stream.emit('error', new Error('EIO: i/o error, write'));
    expect(await r).toEqual({ status: 500, body: { success: false, error: 'The file could not be written (EIO: i/o error, write), so nothing was kept' } });
  });
});
