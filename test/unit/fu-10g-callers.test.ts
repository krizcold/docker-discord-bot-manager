import { describe, expect, it, vi } from 'vitest';
import { parseDocument } from 'yaml';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'fu-10g-c-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  process.env.BOT_DOMAIN_BASE = 'dbot.example.invalid';
  process.env.BOT_PORT_BIND = '0.0.0.0';
  return { repo: nodePath.join(dir, 'repo') };
});

vi.mock('../../src/docker/dockerClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/docker/dockerClient')>()),
  listPublishedHostPorts: () => new Map(),
}));
vi.mock('../../src/env/manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/env/manager')>()),
  getEnvVarsWithStatus: () => ({ vars: {}, undecryptable: [], corrupt: false }),
}));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));
vi.mock('../../src/casaos/detector', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/casaos/detector')>()),
  getDeploymentMode: async () => 'docker',
}));
vi.mock('../../src/source/sourceManager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/source/sourceManager')>()),
  getSource: () => ({ id: 's1', sourceType: 'git', url: 'https://example.invalid/r.git' }),
  getSourceRepoPath: () => h.repo,
  isSourceCloned: () => true,
}));

import * as fs from 'fs';
import * as path from 'path';
import { applyDockerHostPort } from '../../src/docker/containerManager';
import { processComposeForDocker } from '../../src/templates/pcsProcessing';
import { applyVariableSubstitution } from '../../src/templates/variableSubstitution';
import { createSourceRoutes } from '../../src/webui/routes/sources';
import type { BotConfig, InstanceConfig } from '../../src/types';

const gated = `services:
  gateway:
    image: ghcr.io/yundera/appshield
    environment:
      BACKEND_HOST: app
      BACKEND_PORT: "3000"
      USER: \${WEBUI_USER}
      PASSWORD: \${WEBUI_PASSWORD}
    expose:
      - "80"
  app:
    image: example/app
x-casaos:
  main: gateway
  webui_port: 80
`;

describe('FU-10g callers with BOT_DOMAIN_BASE set', () => {
  it('Auto keeps Authelia on the domain route in front of a kept USER/PASSWORD gateway', () => {
    const envVars = { WEBUI_USER: 'admin', WEBUI_PASSWORD: 'operator-set' };
    const instance = { id: 'fu10g', sanitizedName: 'fu10g', displayName: 'fu10g', envVars, webAuth: 'auto' } as unknown as InstanceConfig;
    const bot = { id: 'fu10g', name: 'fu10g', envVars, webAuth: 'auto' } as unknown as BotConfig;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const processed = processComposeForDocker(applyVariableSubstitution(gated, bot), 'fu10g', bot).content;
    const out = applyDockerHostPort(processed, instance);
    const services = (parseDocument(out).toJSON() as any).services;
    expect(Object.keys(services)).toContain('gateway');
    const labels = services.gateway.labels || {};
    expect(labels['caddy.forward_auth']).toBe('authelia:9091');
  });

  it('the source env list on a loopback bind says an off-loopback BOT_PORT_BIND keeps the gateway', async () => {
    process.env.BOT_PORT_BIND = '127.0.0.1';
    fs.mkdirSync(h.repo, { recursive: true });
    fs.writeFileSync(path.join(h.repo, 'docker-compose.yml'), gated);
    const router: any = createSourceRoutes({ clients: new Set() } as any);
    const layer = router.stack.find((l: any) => l.route?.path === '/:id/envs' && l.route.methods.get);
    const res: any = { statusCode: 200 };
    res.status = (c: number) => { res.statusCode = c; return res; };
    res.json = (b: unknown) => { res.body = b; return res; };
    await layer.route.stack[layer.route.stack.length - 1].handle({ params: { id: 's1' }, query: {}, body: {} }, res);
    expect(res.statusCode).toBe(200);
    const note = res.body.vars.find((v: any) => v.key === 'WEBUI_USER')?.inactive || '';
    expect(note).toMatch(/BOT_PORT_BIND is off loopback/);
  });
});
