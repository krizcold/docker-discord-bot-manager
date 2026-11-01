import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as http from 'http';

const h = vi.hoisted(() => ({ port: 0, status: 200, body: '' as string }));

vi.mock('../../src/docker/containerManager', () => ({ readDeployedCompose: () => 'services: {}' }));
vi.mock('../../src/templates/pcsProcessing', () => ({ fleetAppContainerName: () => '127.0.0.1' }));
vi.mock('../../src/config/appCapabilities', async (o) => ({ ...(await o<typeof import('../../src/config/appCapabilities')>()), findAppCapabilities: () => ({ hooks: { port: h.port, basePath: '/api/managed' }, companionDb: { env: { url: 'DATA_BACKEND_URL' } } }) }));
vi.mock('../../src/instance/fleetSwitch', () => ({ switchTickOn: () => false }));

import { callAppHook } from '../../src/instance/appHookClient';
import { hookAnswer } from '../../src/instance/migrate';

let server: http.Server;
beforeAll(async () => {
  server = http.createServer((_req, res) => { res.writeHead(h.status, { 'content-type': 'application/json' }); res.end(h.body); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  h.port = (server.address() as any).port;
});
afterAll(() => new Promise<void>(r => server.close(() => r())));

const inst: any = { id: 'b1', sourceUrl: 'x', updateToken: 't', envVars: {} };
const call = async (status: number, body: unknown, method: 'GET' | 'POST' = 'POST') => {
  h.status = status;
  h.body = typeof body === 'string' ? body : JSON.stringify(body);
  return callAppHook(inst, 'migrate' as any, method, method === 'POST' ? { jobId: 'mgr-a', to: 'file' } : undefined, 2000);
};
const refusalBody = { success: false, error: 'The destination holds data' };

describe('callAppHook as NM5 committed it keeps every answer', () => {
  it.each([
    [200, { success: true, jobId: 'a', state: 'started' }, { ok: true, status: 200 }],
    [200, refusalBody, { ok: false, status: 200, body: refusalBody }],
    [400, refusalBody, { ok: false, status: 400, body: refusalBody }],
    [409, refusalBody, { ok: false, status: 409, body: refusalBody }],
    [500, refusalBody, { ok: false, status: 500, body: refusalBody }],
    [503, refusalBody, { ok: false, status: 503, body: refusalBody }],
    [502, { success: false, error: 'x', unknown: true }, { ok: false, status: 502, unknown: true }],
    [502, { success: false, error: 'x' }, { ok: false, status: 502 }],
    [404, { error: 'Not Found' }, { ok: false, status: 404 }],
    [401, { success: false, error: 'Invalid manager token' }, { ok: false, status: 401, body: { success: false, error: 'Invalid manager token' } }],
    [403, { success: false, error: 'Forbidden' }, { ok: false, status: 403 }],
    [500, 'not json', { ok: false, status: 500, body: null }],
  ])('HTTP %s %j', async (status, body, want) => {
    const r = await call(status, body);
    expect(r).toMatchObject(want);
    if (status === 502 && !(body as any).unknown) expect(r.unknown).toBeUndefined();
  });
});

describe('hookAnswer on each answer', () => {
  it('a POST: answer, refusal by body, refusal by status, no hook, auth, unknown', async () => {
    expect(hookAnswer(await call(200, { success: true, jobId: 'a', to: 'file', state: 'started' }), 'POST').kind).toBe('answer');
    expect(hookAnswer(await call(400, refusalBody), 'POST')).toEqual({ kind: 'refusal', status: 400, error: 'The destination holds data' });
    expect(hookAnswer(await call(500, 'not json'), 'POST')).toEqual({ kind: 'refusal', status: 500, error: 'the bot answered HTTP 500' });
    expect(hookAnswer(await call(404, {}), 'POST').kind).toBe('nohook');
    expect(hookAnswer(await call(401, { success: false, error: 'Invalid manager token' }), 'POST')).toEqual({ kind: 'auth', status: 401, error: 'Invalid manager token' });
    expect(hookAnswer(await call(502, { success: false, error: 'x', unknown: true }), 'POST').kind).toBe('noanswer');
  });
  it.each([
    ["can't confirm which store holds the data: the marker is unreadable", 'cantconfirm'],
    ["CAN'T CONFIRM WHICH STORE HOLDS THE DATA", 'cantconfirm'],
    ["Can't Confirm which store holds the data", 'cantconfirm'],
    ['the journal is busy', 'unusable'],
  ])('a GET { success: false } with %j is %s, never no answer', async (error, kind) => {
    expect(hookAnswer(await call(500, { success: false, error }, 'GET'), 'GET').kind).toBe(kind);
    expect(hookAnswer(await call(200, { success: false, error }, 'GET'), 'GET').kind).toBe(kind);
  });
  it('a GET answer that is neither usable nor can\'t-confirm is unusable', async () => {
    expect(hookAnswer(await call(500, 'not json', 'GET'), 'GET')).toEqual({ kind: 'unusable', status: 500, error: 'the bot answered HTTP 500' });
    expect(hookAnswer(await call(200, { success: true, job: { what: 1 } }, 'GET'), 'GET').kind).toBe('unusable');
    expect(hookAnswer(await call(200, { success: true, job: null }, 'GET'), 'GET').kind).toBe('answer');
    expect(hookAnswer(await call(403, { success: false, error: 'no' }, 'GET'), 'GET').kind).toBe('auth');
  });
  it('a transport failure is no answer', () => {
    expect(hookAnswer({ ok: false, error: 'migrate unreachable: ECONNREFUSED' }, 'GET')).toEqual({ kind: 'noanswer', error: 'migrate unreachable: ECONNREFUSED', unknown: false });
  });
});
