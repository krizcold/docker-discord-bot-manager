import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseDocument } from 'yaml';
import { gatewayOnDefaultPassword, processComposeForDocker, publishHostPort } from '../../src/templates/pcsProcessing';
import type { BotConfig } from '../../src/types';

const compose = `services:
  gateway:
    image: ghcr.io/example/gate
    environment:
      BACKEND_HOST: app
      BACKEND_PORT: "3000"
    ports:
      - "80:80"
  app:
    image: example/app
x-casaos:
  main: gateway
  webui_port: 80
`;

const bot = { id: 'b1', name: 'b1' } as unknown as BotConfig;
const services = (yaml: string) =>
  Object.keys((parseDocument(yaml).toJSON() as { services: Record<string, unknown> }).services);

const saved = { bind: process.env.BOT_PORT_BIND, base: process.env.BOT_DOMAIN_BASE };
afterEach(() => {
  for (const [k, v] of [['BOT_PORT_BIND', saved.bind], ['BOT_DOMAIN_BASE', saved.base]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  vi.restoreAllMocks();
});

describe('B26-3 gateway strip reads BOT_PORT_BIND', () => {
  it('keeps the fronting gateway when the bind is off loopback and no domain route fronts the bot', () => {
    process.env.BOT_PORT_BIND = '0.0.0.0';
    delete process.env.BOT_DOMAIN_BASE;
    expect(services(processComposeForDocker(compose, 'b1', bot).content)).toContain('gateway');
  });

  it('keeps it for a LAN address bind too', () => {
    process.env.BOT_PORT_BIND = '192.168.1.5';
    delete process.env.BOT_DOMAIN_BASE;
    expect(services(processComposeForDocker(compose, 'b1', bot).content)).toContain('gateway');
  });

  it('still strips it on the default loopback bind', () => {
    delete process.env.BOT_PORT_BIND;
    delete process.env.BOT_DOMAIN_BASE;
    expect(services(processComposeForDocker(compose, 'b1', bot).content)).not.toContain('gateway');
    process.env.BOT_PORT_BIND = '127.0.0.2';
    expect(services(processComposeForDocker(compose, 'b1', bot).content)).not.toContain('gateway');
  });

  it('keeps it when a domain route also fronts the bot', () => {
    process.env.BOT_PORT_BIND = '0.0.0.0';
    process.env.BOT_DOMAIN_BASE = 'dbot.example.com';
    expect(services(processComposeForDocker(compose, 'b1', bot).content)).toContain('gateway');
  });

  it('logs the exposure when a host port is published off loopback', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.BOT_PORT_BIND = '0.0.0.0';
    publishHostPort('services:\n  app:\n    image: x\n', 20001, 3000);
    expect(warn.mock.calls.some(c => String(c[0]).includes('20001'))).toBe(true);
    warn.mockClear();
    process.env.BOT_PORT_BIND = '127.0.0.1';
    publishHostPort('services:\n  app:\n    image: x\n', 20002, 3000);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('B26-3 kept gateway never logs in with the public fallback password', () => {
  const gated = compose.replace('      BACKEND_PORT: "3000"\n', '      BACKEND_PORT: "3000"\n      USER: admin\n      PASSWORD: casaos\n');
  const savedPass = process.env.APP_DEFAULT_PASSWORD;
  afterEach(() => {
    if (savedPass === undefined) delete process.env.APP_DEFAULT_PASSWORD; else process.env.APP_DEFAULT_PASSWORD = savedPass;
  });

  it('refuses to publish off loopback when neither WEBUI_PASSWORD nor APP_DEFAULT_PASSWORD sets the PASSWORD', () => {
    process.env.BOT_PORT_BIND = '0.0.0.0';
    delete process.env.APP_DEFAULT_PASSWORD;
    expect(gatewayOnDefaultPassword(gated, false)).toBe(true);
    expect(gatewayOnDefaultPassword(gated.replace('PASSWORD: casaos', '- x').replace('      USER: admin\n      - x\n', '      USER: admin\n'), false)).toBe(false);
  });

  it('allows it once a real password is set, or on a loopback bind', () => {
    process.env.BOT_PORT_BIND = '0.0.0.0';
    delete process.env.APP_DEFAULT_PASSWORD;
    expect(gatewayOnDefaultPassword(gated, true)).toBe(false);
    process.env.APP_DEFAULT_PASSWORD = 'operator-set';
    expect(gatewayOnDefaultPassword(gated, false)).toBe(false);
    delete process.env.APP_DEFAULT_PASSWORD;
    process.env.BOT_PORT_BIND = '127.0.0.1';
    expect(gatewayOnDefaultPassword(gated, false)).toBe(false);
  });
});
