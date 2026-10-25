import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import YAML from 'yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Every chmod is recorded, and a path listed in uids stats as owned by that uid,
// so the owner rule shows on every platform.
const h = vi.hoisted(() => ({ modes: [] as Array<{ p: string; mode: number }>, uids: new Map<string, number>() }));

vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>();
  const norm = (p: any): string => String(p).replace(/\\/g, '/').replace(/\/+$/, '');
  const owned = (st: any, p: any): any => {
    const uid = h.uids.get(norm(p));
    if (uid === undefined || !st) return st;
    return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { uid });
  };
  const wrapped = {
    ...real,
    chmodSync: (p: any, mode: any) => {
      h.modes.push({ p: norm(p), mode: typeof mode === 'number' ? mode : parseInt(String(mode), 8) });
      return real.chmodSync(p, mode);
    },
    lstatSync: (p: any, o?: any) => owned(real.lstatSync(p, o), p),
    statSync: (p: any, o?: any) => owned(real.statSync(p, o), p),
  };
  return { ...wrapped, default: wrapped };
});

import { createVolumeDirectories, processComposeForCasaOS } from '../../src/templates/pcsProcessing';
import { substituteComposeNames } from '../../src/compose/nameSubstitution';

let tmp: string;
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ['DATA_ROOT', 'APP_DOMAIN', 'APP_PUBLIC_IP_DASH', 'PUID', 'PGID'];
const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fu-3bn-'));
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.DATA_ROOT = path.join(tmp, 'DATA').replace(/\\/g, '/');
  delete process.env.APP_DOMAIN;
  delete process.env.APP_PUBLIC_IP_DASH;
  process.env.PUID = '4242';
  process.env.PGID = '4243';
  h.modes = [];
  h.uids.clear();
});

afterEach(() => {
  Object.defineProperty(process, 'platform', realPlatform);
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  fs.rmSync(tmp, { recursive: true, force: true });
});

const bot = (): any => ({ id: 'b1', displayName: 'Bot', sanitizedName: 'bot1', envVars: {} });

// The build's order: name substitution when the instance name differs, then processing.
const deployed = (compose: string, appName: string, mode: 'casaos' | 'docker'): any => {
  const named = appName === 'coolbot' ? compose : substituteComposeNames(compose, 'coolbot', appName).content;
  return YAML.parse(processComposeForCasaOS(named, appName, bot(), { mode, hostBotDir: '/srv/b1' }).content);
};

const names = (doc: any): string[] => [...new Set(Object.values(doc.services).map((s: any) => s.container_name).filter(Boolean) as string[])];

describe('FU-3bn a named compose gets per-instance container names too', () => {
  const named = [
    'name: coolbot',
    'services:',
    '  coolbot:',
    '    image: example/bot:1',
    '    container_name: coolbot',
    '    environment:',
    '      REDIS_HOST: redis',
    '  cache:',
    '    image: redis:7',
    '    container_name: redis',
    '    networks: [default, shared]',
    '  gluetun:',
    '    image: vpn',
    '    container_name: vpn',
    '    networks: [coolnet]',
    '  worker:',
    '    image: w',
    '    network_mode: "container:vpn"',
    '    volumes_from: ["container:redis:ro"]',
    '  db:',
    '    image: db',
    '    container_name: musicdb',
    '    networks: [backend]',
    'networks:',
    '  shared:',
    '    external: true',
    '  coolnet:',
    '    name: coolbot-net',
    '  backend:',
    '    name: dbm_internal',
    'x-casaos:',
    '  main: coolbot',
    '',
  ].join('\n');

  for (const mode of ['casaos', 'docker'] as const) {
    it(`${mode} mode: two instances of the source share no container name`, () => {
      const one = names(deployed(named, 'coolbot', mode)).filter(n => n !== 'musicdb');
      const two = names(deployed(named, 'second', mode)).filter(n => n !== 'musicdb');
      expect(one.length).toBe(3);
      expect(two.length).toBe(3);
      for (const n of one) expect(two).not.toContain(n);
    });

    it(`${mode} mode: the repo name stays an alias on project networks, never on an external one`, () => {
      const doc = deployed(named, 'second', mode);
      expect(doc.services.cache.container_name).toBe('second-redis');
      expect(doc.services.cache.networks.default.aliases).toEqual(['redis']);
      expect(doc.services.cache.networks.shared?.aliases).toBeUndefined();
      expect(doc.services.second.environment.REDIS_HOST).toBe('redis');
    });

    it(`${mode} mode: a network with a fixed name of its own carries the alias (it is named per instance)`, () => {
      const doc = deployed(named, 'second', mode);
      expect(doc.networks.coolnet.name).toBe('second_coolnet');
      expect(doc.services.gluetun.container_name).toBe('second-vpn');
      expect(doc.services.gluetun.networks.coolnet.aliases).toEqual(['vpn']);
      const first = deployed(named, 'coolbot', mode);
      expect(first.services.gluetun.container_name).toBe('coolbot-vpn');
      expect(first.services.gluetun.networks.coolnet.aliases).toEqual(['vpn']);
    });

    it(`${mode} mode: container references follow the rename`, () => {
      const worker = deployed(named, 'second', mode).services.worker;
      expect(worker.network_mode).toBe('container:second-vpn');
      expect(worker.volumes_from).toEqual(['container:second-redis:ro']);
    });

    it(`${mode} mode: a service only on a platform network keeps its name and gets no alias`, () => {
      const doc = deployed(named, 'second', mode);
      expect(doc.services.db.container_name).toBe('musicdb');
      expect(doc.services.db.networks.backend?.aliases).toBeUndefined();
    });
  }

  it('a second processing of a named compose changes nothing', () => {
    const sub = substituteComposeNames(named, 'coolbot', 'second').content;
    const once = processComposeForCasaOS(sub, 'second', bot(), { mode: 'docker', hostBotDir: '/srv/b1' }).content;
    const twice = processComposeForCasaOS(once, 'second', bot(), { mode: 'docker', hostBotDir: '/srv/b1' }).content;
    expect(YAML.parse(twice).services).toEqual(YAML.parse(once).services);
  });
});

describe('FU-3bn casaos repo delivery leaves the mode of a folder another uid owns', () => {
  const appDir = (): string => `${process.env.DATA_ROOT}/AppData/app1`;
  const compose = (): string => `services:\n  lavalink:\n    image: x\n    volumes:\n      - ${appDir()}/plugins:/opt/plugins\n`;
  const repo = (): string => {
    const r = path.join(tmp, 'repo');
    fs.mkdirSync(path.join(r, 'plugins', 'nested'), { recursive: true });
    fs.writeFileSync(path.join(r, 'plugins', 'nested', 'a.txt'), 'a');
    return r;
  };

  it('an existing folder owned by another uid gets no chmod, a root-owned one still gets 775', async () => {
    Object.defineProperty(process, 'platform', { ...realPlatform, value: 'linux' });
    const plugins = `${appDir()}/plugins`;
    fs.mkdirSync(`${plugins}/nested`, { recursive: true });
    h.uids.set(plugins, 322);
    h.uids.set(`${plugins}/nested`, 0);
    const report = await createVolumeDirectories(compose(), 'app1', repo(), () => {});
    expect(report.failed).toEqual([]);
    expect(fs.existsSync(`${plugins}/nested/a.txt`)).toBe(true);
    expect(h.modes.filter(m => m.p === plugins)).toEqual([]);
    expect(h.modes.filter(m => m.p === `${plugins}/nested`)).toEqual([{ p: `${plugins}/nested`, mode: 0o775 }]);
  });

  it('an existing folder owned by PUID still gets 775', async () => {
    Object.defineProperty(process, 'platform', { ...realPlatform, value: 'linux' });
    const plugins = `${appDir()}/plugins`;
    fs.mkdirSync(plugins, { recursive: true });
    h.uids.set(plugins, 4242);
    await createVolumeDirectories(compose(), 'app1', repo(), () => {});
    expect(h.modes.filter(m => m.p === plugins)).toEqual([{ p: plugins, mode: 0o775 }]);
  });
});
