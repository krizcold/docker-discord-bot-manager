import YAML from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { processComposeForCasaOS } from '../../src/templates/pcsProcessing';

const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ['DATA_ROOT', 'APP_DOMAIN', 'APP_PUBLIC_IP_DASH'];
beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.DATA_ROOT = '/DATA';
  delete process.env.APP_DOMAIN;
  delete process.env.APP_PUBLIC_IP_DASH;
});
afterEach(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

const bot: any = { id: 'b1', displayName: 'Bot', sanitizedName: 'app1', envVars: {} };
const names = (content: string): string[] =>
  Object.values((YAML.parse(content).services ?? {}) as Record<string, any>).map(s => s.container_name).filter(Boolean);

describe('FU-3bs: one container name per compose in CasaOS mode', () => {
  it('a repo service named after the app gives its name to the status-page sidecar', () => {
    const src = 'name: app1\nservices:\n  bot:\n    image: x\n    container_name: app1\n  worker:\n    image: y\n    network_mode: "container:app1"\n';
    const out = processComposeForCasaOS(src, 'app1', bot);
    expect(out.sidecarInjected).toBe(true);
    const c = YAML.parse(out.content);
    expect(c.services['status-page'].container_name).toBe('app1');
    expect(c.services.bot.container_name).toBe('app1-bot');
    expect(c.services.worker.network_mode).toBe('container:app1-bot');
    expect(new Set(names(out.content)).size).toBe(names(out.content).length);
  });

  it('a non-main service holding the app name is renamed when the main service has a port', () => {
    const src = 'name: app1\nservices:\n  web:\n    image: x\n    ports: ["8080:80"]\n  worker:\n    image: y\n    container_name: app1\n';
    const out = processComposeForCasaOS(src, 'app1', bot);
    const c = YAML.parse(out.content);
    expect(c.services.web.container_name).toBe('app1');
    expect(c.services.worker.container_name).toBe('app1-worker');
  });

  it('refuses when the derived name is taken too', () => {
    const src = 'name: app1\nservices:\n  bot:\n    image: x\n    container_name: app1\n  other:\n    image: y\n    container_name: app1-bot\n';
    expect(() => processComposeForCasaOS(src, 'app1', bot)).toThrow(/app1-bot/);
  });

  it('refuses a compose whose own services share a container name', () => {
    const src = 'name: app1\nservices:\n  a:\n    image: x\n    ports: ["80:80"]\n  b:\n    image: y\n    container_name: app1-z\n  c:\n    image: y\n    container_name: app1-z\n';
    expect(() => processComposeForCasaOS(src, 'app1', bot)).toThrow(/app1-z/);
    expect(() => processComposeForCasaOS(src, 'app1', bot, { mode: 'docker', hostBotDir: '/h' })).toThrow(/app1-z/);
  });
});
