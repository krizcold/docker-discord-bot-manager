import { beforeEach, describe, expect, it, vi } from 'vitest';

const cm = vi.hoisted(() => ({
  refusal: null as null | { success: false; error: string },
  started: 0,
  broadcasts: [] as string[],
}));

vi.mock('../../src/docker/containerManager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/docker/containerManager')>()),
  getBot: (id: string) => ({ id, sourceType: 'git', status: 'stopped' }) as any,
  isBotBusy: () => null,
  startPreflightRefusal: () => cm.refusal,
  updatePreflightRefusal: () => cm.refusal,
  startBot: async () => { cm.started++; return { success: true }; },
  restartBot: async () => { cm.started++; return { success: true }; },
  pullAndRebuild: async () => { cm.started++; return { success: true }; },
}));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: (_w: unknown, type: string) => { cm.broadcasts.push(type); } }));

import { createBotRoutes } from '../../src/webui/routes/bots';

const router = createBotRoutes({ clients: new Set() } as any);
const call = async (routePath: string): Promise<{ status: number; body: any }> => {
  const layer = (router as any).stack.find((l: any) => l.route?.path === routePath && l.route.methods.post);
  const res: any = { statusCode: 200 };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (b: unknown) => { res.body = b; return res; };
  await layer.route.stack[layer.route.stack.length - 1].handle({ params: { id: 'b1' }, query: {}, body: {} }, res);
  return { status: res.statusCode, body: res.body };
};

beforeEach(() => {
  cm.refusal = null;
  cm.started = 0;
  cm.broadcasts = [];
});

describe('B03-4 routes answer synchronous refusals before accepting', () => {
  for (const route of ['/:id/start', '/:id/restart', '/:id/update']) {
    it(`${route} answers a preflight refusal with 409 and no opId`, async () => {
      cm.refusal = { success: false, error: 'refused now' };
      const r = await call(route);
      expect(r.status).toBe(409);
      expect(r.body).toEqual({ success: false, error: 'refused now' });
      expect(cm.started).toBe(0);
      expect(cm.broadcasts).toEqual([]);
    });

    it(`${route} with no refusal accepts with an opId`, async () => {
      const r = await call(route);
      expect(r.status).toBe(200);
      expect(r.body.opId).toBeTruthy();
    });
  }
});
