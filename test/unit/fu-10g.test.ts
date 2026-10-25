import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { frontingGatewayDropped, processComposeForDocker, publishHostPort } from '../../src/templates/pcsProcessing';

const GATEWAY_COMPOSE = [
  'services:',
  '  shield:',
  '    image: example/shield',
  '    environment:',
  '      BACKEND_HOST: app',
  '      BACKEND_PORT: "3000"',
  '      PASSWORD: ${WEBUI_PASSWORD}',
  '  app:',
  '    image: example/app',
  'x-casaos:',
  '  main: shield',
  '  webui_port: 8080',
  '',
].join('\n');

const saved = { bind: process.env.BOT_PORT_BIND, base: process.env.BOT_DOMAIN_BASE };
afterEach(() => {
  if (saved.bind === undefined) delete process.env.BOT_PORT_BIND; else process.env.BOT_PORT_BIND = saved.bind;
  if (saved.base === undefined) delete process.env.BOT_DOMAIN_BASE; else process.env.BOT_DOMAIN_BASE = saved.base;
  vi.restoreAllMocks();
});

const services = (bind: string | undefined, base: string | undefined, webAuth?: 'public'): string[] => {
  if (bind === undefined) delete process.env.BOT_PORT_BIND; else process.env.BOT_PORT_BIND = bind;
  if (base === undefined) delete process.env.BOT_DOMAIN_BASE; else process.env.BOT_DOMAIN_BASE = base;
  const out = processComposeForDocker(GATEWAY_COMPOSE, 'demo', { id: 'b1', webAuth } as any).content;
  return Object.keys(parse(out).services);
};

describe('FU-10g: an off-loopback bind keeps the bot\'s own login gateway', () => {
  it('keeps the gateway with BOT_DOMAIN_BASE set and BOT_PORT_BIND 0.0.0.0', () => {
    expect(services('0.0.0.0', 'dbot.example.invalid')).toContain('shield');
    expect(frontingGatewayDropped('docker', 'auto')).toBe(false);
  });

  it('keeps it without a domain base too', () => {
    expect(services('0.0.0.0', undefined)).toContain('shield');
  });

  it('a loopback bind still drops it, with or without a domain base', () => {
    expect(services(undefined, 'dbot.example.invalid')).not.toContain('shield');
    expect(services('127.0.0.1', undefined)).not.toContain('shield');
  });

  it('webAuth public and CasaOS keep it as before', () => {
    expect(services(undefined, 'dbot.example.invalid', 'public')).toContain('shield');
    expect(frontingGatewayDropped('casaos', 'auto')).toBe(false);
  });
});

describe('FU-10g: the publish warning says which login guards the port', () => {
  const warnText = (compose: string): string => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    publishHostPort(compose, 18080, 8080);
    return warn.mock.calls.map(c => String(c[0])).join('\n');
  };

  it('a kept gateway: its login guards the port', () => {
    process.env.BOT_PORT_BIND = '0.0.0.0';
    process.env.BOT_DOMAIN_BASE = 'dbot.example.invalid';
    const text = warnText(GATEWAY_COMPOSE);
    expect(text).toMatch(/the bot's own login gateway guards this port/);
    expect(text).not.toMatch(/no login/);
  });

  it('no fronting gateway: no login gateway guards the port', () => {
    process.env.BOT_PORT_BIND = '0.0.0.0';
    process.env.BOT_DOMAIN_BASE = 'dbot.example.invalid';
    const text = warnText('services:\n  app:\n    image: example/app\n');
    expect(text).toMatch(/no login gateway guards this port/);
    expect(text).toMatch(/Authelia login .* does not cover this port/);
  });
});
