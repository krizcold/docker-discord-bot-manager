import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ saved: [] as string[], infoFails: true }));

vi.mock('../../src/casaos/detector', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/casaos/detector')>();
  return {
    ...real,
    setDeploymentMode: (mode: string) => { h.saved.push(mode); },
    getDeploymentInfo: async () => {
      if (h.infoFails) throw new Error('docker did not answer');
      return { mode: h.saved[h.saved.length - 1], casaosAvailable: false, autoDetected: false, forcedByEnv: false };
    },
  };
});
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

const put = async (body: any) => {
  const { createSystemRoutes } = await import('../../src/webui/routes/bots');
  const router = createSystemRoutes();
  const layer = (router as any).stack.find((l: any) => l.route?.path === '/deployment' && l.route.methods.put);
  const out = { status: 200, body: undefined as any };
  const res = { status(code: number) { out.status = code; return res; }, json(b: any) { out.body = b; return res; } };
  await layer.route.stack[layer.route.stack.length - 1].handle({ query: {}, params: {}, body }, res);
  return out;
};

describe('PUT /api/system/deployment after the mode was saved', () => {
  it('answers success with a warning when the details cannot be read', async () => {
    h.saved.length = 0;
    h.infoFails = true;
    const res = await put({ mode: 'casaos' });
    expect(h.saved).toEqual(['casaos']);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.mode).toBe('casaos');
    expect(res.body.warning).toBe('The deployment mode was saved as casaos, but reading the deployment details failed: docker did not answer. Reload to see them.');
  });

  it('answers the details with no warning when they can be read', async () => {
    h.saved.length = 0;
    h.infoFails = false;
    const res = await put({ mode: 'docker' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, mode: 'docker', casaosAvailable: false, autoDetected: false, forcedByEnv: false });
  });
});
