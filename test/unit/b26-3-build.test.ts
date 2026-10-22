import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseDocument } from 'yaml';

vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'b26-3-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
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

import { applyDockerHostPort } from '../../src/docker/containerManager';
import { processComposeForDocker } from '../../src/templates/pcsProcessing';
import { applyVariableSubstitution } from '../../src/templates/variableSubstitution';
import type { BotConfig, InstanceConfig } from '../../src/types';

const shipped = `services:
  gateway:
    image: ghcr.io/yundera/appshield
    environment:
      BACKEND_HOST: app
      BACKEND_PORT: "3000"
      USER: admin
      PASSWORD: $APP_DEFAULT_PASSWORD
    expose:
      - "80"
  app:
    image: example/app
x-casaos:
  main: gateway
  webui_port: 80
`;

const saved = { bind: process.env.BOT_PORT_BIND, base: process.env.BOT_DOMAIN_BASE, pass: process.env.APP_DEFAULT_PASSWORD };
afterEach(() => {
  for (const [k, v] of [['BOT_PORT_BIND', saved.bind], ['BOT_DOMAIN_BASE', saved.base], ['APP_DEFAULT_PASSWORD', saved.pass]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  vi.restoreAllMocks();
});

function build(envVars: Record<string, string>): string {
  const instance = { id: 'b26x', sanitizedName: 'b26x', displayName: 'b26x', envVars } as unknown as InstanceConfig;
  const bot = { id: 'b26x', name: 'b26x', envVars } as unknown as BotConfig;
  const substituted = applyVariableSubstitution(shipped, bot);
  const processed = processComposeForDocker(substituted, 'b26x', bot).content;
  return applyDockerHostPort(processed, instance);
}

const mainPorts = (yaml: string) => {
  const c = parseDocument(yaml).toJSON() as { services: Record<string, { ports?: unknown[] }> };
  return c.services.gateway?.ports ?? [];
};

describe('B26-3 build lane: the kept gateway is never published on the casaos fallback', () => {
  it('publishes no host port on 0.0.0.0 with neither password set, and logs a rebuild hint', () => {
    process.env.BOT_PORT_BIND = '0.0.0.0';
    delete process.env.BOT_DOMAIN_BASE;
    delete process.env.APP_DEFAULT_PASSWORD;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = build({});
    expect(parseDocument(out).toJSON().services.gateway.environment.PASSWORD).toBe('casaos');
    expect(mainPorts(out)).toEqual([]);
    expect(warn.mock.calls.some(c => /not published/.test(String(c[0])) && /rebuild the bot/.test(String(c[0])))).toBe(true);
  });

  it('publishes the port once WEBUI_PASSWORD is set', () => {
    process.env.BOT_PORT_BIND = '0.0.0.0';
    delete process.env.BOT_DOMAIN_BASE;
    delete process.env.APP_DEFAULT_PASSWORD;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = build({ WEBUI_PASSWORD: 'operator-set' });
    expect(mainPorts(out).some(p => /^\d+:80$/.test(String(p)))).toBe(true);
  });
});
