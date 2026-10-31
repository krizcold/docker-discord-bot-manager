import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm5-file-'));
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
import * as http from 'http';
import * as path from 'path';
import { AddressInfo } from 'net';
import { downloadPath, freeSpace, moveOutByFile, receiveUpload } from '../../src/instance/fleetMove';
import { releaseFleetBackupBusy } from '../../src/instance/fleetBackupGuards';
import * as containerManager from '../../src/docker/containerManager';
import { fake, freshDb, h, mainFixture, resetHarness, stored, writeRegistry } from './switch-harness';

const FILE = 'pre-move-2026-10-28T12-00-00-000Z.dump';
const DIR = path.join(tmp.dir, 'backups', 'a', 'fleet-postgres');
const S_FILE = `The backup ${FILE} is ready and is downloading. Upload it in the other machine's manager (Upload a backup in the bot's Database window), then restore it there with the bot in Maintenance or Off. This bot stays stopped here, with its database login blocked, until you Cancel the move.`;

beforeEach(() => {
  resetHarness();
  releaseFleetBackupBusy('a');
  fake.dbs['a-pg'] = freshDb();
  writeRegistry({ a: mainFixture() });
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
});
afterAll(() => fs.rmSync(tmp.dir, { recursive: true, force: true }));

describe('O7 Move out by file', () => {
  it('F1: the pre-move dump, the file mark, the app stopped', async () => {
    const r = await moveOutByFile('a');
    expect(r).toMatchObject({ success: true, text: S_FILE, file: FILE });
    expect(stored('a').fleetDb.handover).toMatchObject({ mode: 'file', file: FILE, phase: 'done' });
    expect(h.events.filter(e => e.startsWith('dump:') || e.startsWith('stop-bot'))).toEqual(['dump:pre-move-', 'stop-bot:move-out']);
  });
  it('F2: held stopped asks with "move"; held unknown refuses', async () => {
    h.proof = { ok: true, state: 'maintenance', enforcement: 'database', botConfirmed: true, held: { state: 'stopped' } };
    expect(await moveOutByFile('a')).toMatchObject({ needsConfirm: true, text: 'The bot was stopped without confirming that it saved what it held. Whatever it had not saved was lost at that stop, not by this move, which loses nothing more. Make the backup anyway?' });
    h.proof = { ok: true, state: 'maintenance', enforcement: 'database', botConfirmed: true, held: { state: 'unknown' } };
    expect((await moveOutByFile('a')).text).toBe('The bot could not confirm that it saved every change it holds, so the move was refused and nothing was changed. Choose Maintenance again; the bot answers whether its changes are saved.');
    expect(h.events).not.toContain('dump:pre-move-');
  });
  it('F3: the dump fails', async () => {
    h.dump = { success: false, error: 'pg_dump died' };
    expect((await moveOutByFile('a')).text).toBe('The dump failed (pg_dump died), so nothing was changed');
  });
  it('F4: the mark write throws: the file kept', async () => {
    h.failSwitchWrite = 'ENOSPC';
    expect((await moveOutByFile('a')).text).toBe(`The move could not be recorded (ENOSPC); the dump ${FILE} was kept and nothing else was changed`);
    expect(h.events).not.toContain('stop-bot:move-out');
  });
  it('F5: the app stop fails: the mark set, S-FILE + MV-STOPFAIL', async () => {
    h.stop = { success: false, error: 'compose stop timed out' };
    const r = await moveOutByFile('a');
    expect(r.text).toBe(`${S_FILE} The bot here did not stop (compose stop timed out); stop it, then press Rejoin as a copy.`);
    expect(stored('a').fleetDb.handover.mode).toBe('file');
  });
  it('F14: a restore notice, or the read-only layer', async () => {
    h.memoryNotice = 'r.dump';
    expect((await moveOutByFile('a')).text).toMatch(/^A restore of r\.dump has not finished cleanly \(its notice is on the Database window\), so the move was refused and nothing was changed/);
    h.memoryNotice = null;
    h.fence = { ok: false, cls: 'other', error: 'timeout' };
    expect((await moveOutByFile('a')).text).toBe("The manager could not read whether the bot's database is READ-ONLY (timeout), so the move was refused and nothing was changed");
    expect(h.events).not.toContain('dump:pre-move-');
  });
});

describe('O7 download', () => {
  it('F6: a bad name 400, a missing file 404, a present file its path', () => {
    expect(downloadPath('a', '../x.dump')).toEqual({ ok: false, status: 400, error: 'Invalid dump file name' });
    expect(downloadPath('a', 'x.sql')).toEqual({ ok: false, status: 400, error: 'Invalid dump file name' });
    expect(downloadPath('a', 'none.dump')).toEqual({ ok: false, status: 404, error: 'Dump file not found' });
    fs.writeFileSync(path.join(DIR, FILE), 'PGDMP');
    expect(downloadPath('a', FILE)).toEqual({ ok: true, path: path.join(DIR, FILE) });
  });
});

describe('O8 upload over a real HTTP request', () => {
  let server: http.Server;
  const start = () => new Promise<number>(resolve => {
    server = http.createServer((req, res) => {
      void receiveUpload('a', req as any).then(r => { res.writeHead(r.status, { 'content-type': 'application/json' }); res.end(JSON.stringify(r.body)); });
    });
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
  const send = async (body: Buffer | null, headers: Record<string, string> = {}) => {
    const port = await start();
    try {
      return await new Promise<{ status: number; body: any }>((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/', headers: { 'content-type': 'application/octet-stream', ...(body ? { 'content-length': String(body.length) } : {}), ...headers } }, res => {
          let text = '';
          res.on('data', d => { text += d; });
          res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(text) }));
        });
        req.on('error', reject);
        if (body) req.end(body); else req.end();
      });
    } finally {
      server.close();
    }
  };
  const left = () => fs.readdirSync(DIR);
  it('F7: a dump is kept as moved-<stamp>.dump, never the browser name', async () => {
    const r = await send(Buffer.from('PGDMP and the rest'), { 'x-file-name': 'evil/../x.dump' });
    expect(r.status).toBe(200);
    expect(r.body.file).toMatch(/^moved-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z\.dump$/);
    expect(r.body.message).toBe(`Uploaded as ${r.body.file}. Put the bot in Maintenance or Off, then restore this file: the restore makes this machine the main.`);
    expect(left()).toEqual([r.body.file]);
    expect(fs.readFileSync(path.join(DIR, r.body.file), 'utf-8')).toBe('PGDMP and the rest');
  });
  it('F8: not a custom-format dump: the tmp deleted, 400', async () => {
    const r = await send(Buffer.from('SELECT 1;'));
    expect(r).toEqual({ status: 400, body: { success: false, error: 'This file is not a database backup made by the manager (pg_dump custom format), so it was not kept' } });
    expect(left()).toEqual([]);
  });
  it('F10: less free space than the length plus 512 MiB: 507, nothing written', async () => {
    const spy = vi.spyOn(freeSpace, 'of').mockReturnValue(100);
    const r = await send(Buffer.from('PGDMP'));
    spy.mockRestore();
    expect(r.status).toBe(507);
    expect(r.body.error).toMatch(/^Not enough free disk space for this file \(0\.0 GiB free, 0\.5 GiB needed\), so nothing was written$/);
    expect(left()).toEqual([]);
  });
  it('F12: no main here 409; shutting down 503; no length 411', async () => {
    writeRegistry({ a: mainFixture({ fleetDb: undefined }) });
    expect(await send(Buffer.from('PGDMP'))).toEqual({ status: 409, body: { success: false, error: 'This instance holds no main database to restore into; install it with a blank Database URL first' } });
    writeRegistry({ a: mainFixture() });
    expect((await send(null, { 'transfer-encoding': 'chunked' })).body).toEqual({ success: false, error: 'The upload carries no length' });
    const spy = vi.spyOn(containerManager, 'isShuttingDown').mockReturnValue(true);
    const r = await send(Buffer.from('PGDMP'));
    spy.mockRestore();
    expect(r.status).toBe(503);
  });
});

describe('F9, F11, F13: an upload that does not finish', () => {
  const DIR2 = path.join(tmp.dir, 'backups', 'a', 'fleet-postgres');
  const left = () => fs.readdirSync(DIR2);
  const serve = (seen: Array<Promise<{ status: number; body: any }>>) => new Promise<http.Server>(resolve => {
    const server = http.createServer((req, res) => {
      const p = receiveUpload('a', req as any);
      seen.push(p);
      void p.then(r => { if (!res.destroyed) { res.writeHead(r.status, { 'content-type': 'application/json' }); res.end(JSON.stringify(r.body)); } });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });

  it('F9: the browser aborts mid-body: the tmp deleted, nothing kept', async () => {
    const seen: Array<Promise<{ status: number; body: any }>> = [];
    const server = await serve(seen);
    const port = (server.address() as AddressInfo).port;
    try {
      const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/', headers: { 'content-type': 'application/octet-stream', 'content-length': '100000' } });
      req.on('error', () => undefined);
      req.write(Buffer.from('PGDMP partial'));
      await vi.waitFor(() => expect(left().some(n => n.endsWith('.dump.tmp'))).toBe(true));
      req.destroy();
      await vi.waitFor(() => expect(seen).toHaveLength(1));
      const r = await seen[0];
      expect(r.status).not.toBe(200);
      expect(left()).toEqual([]);
    } finally {
      server.close();
    }
  });

  it('F11: a write error: the tmp deleted, 500, UP-WRITE', async () => {
    const seen: Array<Promise<{ status: number; body: any }>> = [];
    const server = await serve(seen);
    const port = (server.address() as AddressInfo).port;
    const nodeFs = require('fs') as typeof import('fs');
    const realSync = nodeFs.fsyncSync;
    let thrown = false;
    nodeFs.fsyncSync = ((fd: number) => { if (thrown) return realSync(fd); thrown = true; throw new Error('EIO: i/o error, fsync'); }) as typeof nodeFs.fsyncSync;
    require('module').syncBuiltinESMExports();
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/', headers: { 'content-type': 'application/octet-stream', 'content-length': '10' } }, res => { res.resume(); resolve(res.statusCode!); });
        req.on('error', reject);
        req.end(Buffer.from('PGDMP12345'));
      });
      expect(status).toBe(500);
      expect((await seen[0]).body).toEqual({ success: false, error: 'The file could not be written (EIO: i/o error, fsync), so nothing was kept' });
      expect(left()).toEqual([]);
    } finally {
      nodeFs.fsyncSync = realSync;
      require('module').syncBuiltinESMExports();
      server.close();
    }
  });

  it('F13: a .tmp a crash left is deleted at the next start; a finished dump stays', async () => {
    const fb = await import('../../src/instance/fleetBackup');
    fs.writeFileSync(path.join(DIR2, 'moved-2026-10-30T10-00-00-000Z.dump.tmp'), 'PGDMP part');
    fs.writeFileSync(path.join(DIR2, 'moved-2026-10-29T10-00-00-000Z.dump'), 'PGDMP whole');
    const spy = vi.spyOn(globalThis, 'setInterval').mockImplementation((() => 0) as unknown as typeof setInterval);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      fb.startFleetBackupScheduler();
    } finally {
      spy.mockRestore();
      fb.stopFleetBackupScheduler();
      log.mockRestore();
    }
    expect(left()).toEqual(['moved-2026-10-29T10-00-00-000Z.dump']);
  });
});
