import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import YAML from 'yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Every chmod the manager makes is recorded, so a world-writable mode shows on
// every platform (Windows keeps no POSIX mode to stat afterwards).
const h = vi.hoisted(() => ({ modes: [] as Array<{ p: string; mode: number }> }));

vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>();
  const wrapped = {
    ...real,
    chmodSync: (p: any, mode: any) => {
      h.modes.push({ p: String(p), mode: typeof mode === 'number' ? mode : parseInt(String(mode), 8) });
      return real.chmodSync(p, mode);
    },
  };
  return { ...wrapped, default: wrapped };
});

import {
  attachBotToProxy, attachFleetToProxy, createVolumeDirectories, frontingGateway, newDeliveryReport,
  prepareDockerBotFiles, processComposeForCasaOS,
} from '../../src/templates/pcsProcessing';
import { substituteComposeNames } from '../../src/compose/nameSubstitution';

let tmp: string;
const saved: Record<string, string | undefined> = {};
const ENV_KEYS = ['DATA_ROOT', 'APP_DOMAIN', 'APP_PUBLIC_IP_DASH', 'PUID', 'PGID'];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fu-3b-'));
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.DATA_ROOT = path.join(tmp, 'DATA').replace(/\\/g, '/');
  delete process.env.APP_DOMAIN;
  delete process.env.APP_PUBLIC_IP_DASH;
  process.env.PUID = '4242';
  process.env.PGID = '4243';
  h.modes = [];
});

afterEach(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  fs.rmSync(tmp, { recursive: true, force: true });
});

const bot = (over: Record<string, unknown> = {}): any => ({
  id: 'b1', displayName: 'Bot', sanitizedName: 'bot1', envVars: {}, ...over,
});

const processed = (compose: string, appName: string, mode: 'casaos' | 'docker', hostBotDir = '/srv/b1'): any =>
  YAML.parse(processComposeForCasaOS(compose, appName, bot(), { mode, hostBotDir }).content);

describe('FU-3s a drive-letter source survives every rewrite of a string volume', () => {
  const vols = ['C:\\x:/app/x', 'C:/x:/app/x:ro'];

  for (const mode of ['casaos', 'docker'] as const) {
    it(`${mode} mode keeps a drive-letter source and its target and mode`, () => {
      const compose = `services:\n  bot:\n    image: x\n    volumes:\n${vols.map(v => `      - '${v}'`).join('\n')}\n`;
      expect(processed(compose, 'bot1', mode).services.bot.volumes).toEqual(vols);
    });
  }

  it('a built service keeps a drive-letter bind (it is not the build-context overlay)', () => {
    const compose = "services:\n  bot:\n    build: .\n    volumes:\n      - 'C:/x:/app'\n";
    expect(processed(compose, 'bot1', 'docker').services.bot.volumes).toEqual(['C:/x:/app']);
  });

  it('docker mode re-roots an AppData source on a drive letter under the bot dir', () => {
    process.env.DATA_ROOT = 'C:/DATA';
    const compose = "services:\n  bot:\n    image: x\n    volumes:\n      - 'C:/DATA/AppData/bot1/x:/app/x:ro'\n      - 'C:\\DATA\\other:/app/y'\n";
    expect(processed(compose, 'bot1', 'docker').services.bot.volumes).toEqual(['/srv/b1/x:/app/x:ro', 'C:\\DATA\\other:/app/y']);
  });

  it('the name substitution renames the target of a drive-letter volume and keeps its mode', () => {
    const compose = "name: coolbot\nservices:\n  app:\n    image: x\n    volumes:\n      - 'C:/AppData/coolbot/x:/coolbot/x:ro'\n      - 'C:\\data:/coolbot/y'\n";
    const doc = YAML.parse(substituteComposeNames(compose, 'coolbot', 'second').content);
    expect(doc.services.app.volumes).toEqual(['C:/AppData/second/x:/second/x:ro', 'C:\\data:/second/y']);
  });
});

describe('B15-3n a compose with no top-level name gets per-instance container names', () => {
  const nameless = [
    'services:',
    '  app:',
    '    image: example/bot:1',
    '    container_name: musicbot',
    '    environment:',
    '      LAVALINK_HOST: lavalink-node',
    '    ports:',
    '      - "3000:3000"',
    '  lavalink:',
    '    image: example/lavalink:4',
    '    container_name: lavalink-node',
    '    networks:',
    '      - default',
    '      - shared',
    'networks:',
    '  shared:',
    '    external: true',
    '',
  ].join('\n');

  const names = (doc: any): string[] => Object.values(doc.services).map((s: any) => s.container_name).filter(Boolean) as string[];

  for (const mode of ['casaos', 'docker'] as const) {
    it(`${mode} mode: two instances share no container name`, () => {
      const one = names(processed(nameless, 'one', mode));
      const two = names(processed(nameless, 'two', mode));
      expect(one.length).toBe(2);
      expect(two.length).toBe(2);
      for (const n of one) expect(two).not.toContain(n);
    });

    it(`${mode} mode: the repo's name still resolves inside the project, never on an external network`, () => {
      const doc = processed(nameless, 'one', mode);
      expect(doc.services.lavalink.container_name).toBe('one-lavalink-node');
      expect(doc.services.lavalink.networks.default.aliases).toEqual(['lavalink-node']);
      expect(doc.services.lavalink.networks.shared?.aliases).toBeUndefined();
      expect(doc.services.app.environment.LAVALINK_HOST).toBe('lavalink-node');
    });
  }

  it('a container name already scoped to the instance is kept', () => {
    const compose = 'name: one\nservices:\n  app:\n    image: x\n    container_name: one-app\n  db:\n    image: y\n    container_name: one\n';
    const doc = processed(compose, 'one', 'docker');
    expect(doc.services.app.container_name).toBe('one-app');
    expect(doc.services.db.container_name).toBe('one');
  });

  it('a second processing changes nothing', () => {
    const once = processComposeForCasaOS(nameless, 'one', bot(), { mode: 'docker', hostBotDir: '/srv/b1' }).content;
    const twice = processComposeForCasaOS(once, 'one', bot(), { mode: 'docker', hostBotDir: '/srv/b1' }).content;
    expect(names(YAML.parse(twice))).toEqual(names(YAML.parse(once)));
  });

  it('a fronting gateway whose backend is named by its repo container name is still found', () => {
    const compose = [
      'services:',
      '  gate:',
      '    image: gate',
      '    environment:',
      '      BACKEND_HOST: core-backend',
      '      BACKEND_PORT: "8080"',
      '    ports:',
      '      - "80:80"',
      '  core:',
      '    image: core',
      '    container_name: core-backend',
      'x-casaos:',
      '  main: gate',
      '',
    ].join('\n');
    const doc = processed(compose, 'one', 'casaos');
    expect(frontingGateway(doc)).toEqual({ gateway: 'gate', backend: 'core', backendPort: 8080 });
  });

  for (const mode of ['casaos', 'docker'] as const) {
    it(`${mode} mode: a service that joins another container by its repo name follows the rename`, () => {
      const compose = [
        'services:',
        '  gluetun:',
        '    image: vpn',
        '    container_name: vpn',
        '  app:',
        '    image: x',
        '    network_mode: "container:vpn"',
        '    ipc: "container:vpn"',
        '    pid: "container:vpn"',
        '    volumes_from: ["container:vpn:ro", "container:vpn", "gluetun", "container:other"]',
        '',
      ].join('\n');
      const app = processed(compose, 'one', mode).services.app;
      expect(app.network_mode).toBe('container:one-vpn');
      expect(app.ipc).toBe('container:one-vpn');
      expect(app.pid).toBe('container:one-vpn');
      expect(app.volumes_from).toEqual(['container:one-vpn:ro', 'container:one-vpn', 'gluetun', 'container:other']);
    });

    it(`${mode} mode: a service only on fixed-name networks keeps its container name and gets no alias`, () => {
      const compose = [
        'services:',
        '  db:',
        '    image: db',
        '    container_name: musicdb',
        '    networks: [backend]',
        '  cache:',
        '    image: c',
        '    container_name: musiccache',
        'networks:',
        '  backend:',
        '    name: shared-backend',
        '  default:',
        '    name: shared-default',
        '',
      ].join('\n');
      const doc = processed(compose, 'one', mode);
      expect(doc.services.db.container_name).toBe('musicdb');
      expect(doc.services.db.networks.backend?.aliases).toBeUndefined();
      expect(doc.services.cache.container_name).toBe('musiccache');
      expect(doc.services.cache.networks?.default?.aliases).toBeUndefined();
    });

    it(`${mode} mode: a service only on external networks keeps its container name`, () => {
      const compose = [
        'services:',
        '  db:',
        '    image: db',
        '    container_name: musicdb',
        '    networks: [shared]',
        '  bot:',
        '    image: b',
        '    container_name: musicbot',
        '    networks: [shared, internal]',
        'networks:',
        '  shared:',
        '    external: true',
        '  internal: {}',
        '',
      ].join('\n');
      const doc = processed(compose, 'one', mode);
      expect(doc.services.db.container_name).toBe('musicdb');
      expect(doc.services.db.networks.shared?.aliases).toBeUndefined();
      expect(doc.services.bot.container_name).toBe('one-musicbot');
      expect(doc.services.bot.networks.internal.aliases).toEqual(['musicbot']);
      expect(doc.services.bot.networks.shared?.aliases).toBeUndefined();
    });
  }
});

describe('B06-3b no delivery directory is world-writable, and the bot user can still write', () => {
  const onWindows = process.platform === 'win32';
  const asRoot = !onWindows && typeof process.getuid === 'function' && process.getuid() === 0;
  const rootIt = asRoot ? it : it.skip;
  const posixIt = onWindows ? it.skip : it;

  const repoWithDir = (): string => {
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(path.join(repo, 'plugins', 'nested'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'plugins', 'nested', 'a.txt'), 'a');
    fs.writeFileSync(path.join(repo, 'application.yml'), 'x: 1\n');
    return repo;
  };

  const dockerCompose = (hostDir: string) => [
    'services:',
    '  lavalink:',
    '    image: x',
    '    volumes:',
    `      - ${hostDir}/plugins:/opt/plugins`,
    `      - ${hostDir}/data/empty:/data`,
    `      - ${hostDir}/application.yml:/opt/application.yml`,
    '',
  ].join('\n');

  const casaosCompose = () => {
    const appDir = `${process.env.DATA_ROOT}/AppData/app1`;
    return `services:\n  lavalink:\n    image: x\n    volumes:\n      - ${appDir}/plugins:/opt/plugins\n      - ${appDir}/data/empty:/data\n`;
  };

  const dirsUnder = (root: string): string[] => {
    const out: string[] = [];
    const walk = (p: string) => {
      if (!fs.statSync(p).isDirectory()) return;
      out.push(p);
      for (const e of fs.readdirSync(p)) walk(path.join(p, e));
    };
    walk(root);
    return out;
  };

  it('docker mode: no chmod the delivery makes sets the world-write bit', () => {
    const bot = path.join(tmp, 'bot');
    const report = newDeliveryReport();
    prepareDockerBotFiles(dockerCompose('/host/bot'), bot, '/host/bot', repoWithDir(), [], () => {}, report);
    expect(report.failed).toEqual([]);
    expect(fs.existsSync(path.join(bot, 'plugins', 'nested', 'a.txt'))).toBe(true);
    expect(h.modes.filter(m => m.mode & 0o002)).toEqual([]);
  });

  posixIt('docker mode: every directory the delivery leaves has no world-write bit', () => {
    const bot = path.join(tmp, 'bot');
    prepareDockerBotFiles(dockerCompose('/host/bot'), bot, '/host/bot', repoWithDir(), [], () => {}, newDeliveryReport());
    for (const d of dirsUnder(bot)) expect({ d, o: fs.statSync(d).mode & 0o002 }).toEqual({ d, o: 0 });
  });

  rootIt('docker mode, as root: an existing world-writable directory the manager made loses only the world-write bit', () => {
    const bot = path.join(tmp, 'bot');
    fs.mkdirSync(path.join(bot, 'plugins'), { recursive: true });
    fs.chmodSync(path.join(bot, 'plugins'), 0o777);
    prepareDockerBotFiles(dockerCompose('/host/bot'), bot, '/host/bot', repoWithDir(), [], () => {}, newDeliveryReport());
    expect(fs.statSync(path.join(bot, 'plugins')).mode & 0o777).toBe(0o775);
  });

  posixIt('casaos mode: every directory the delivery leaves has no world-write bit', async () => {
    const report = await createVolumeDirectories(casaosCompose(), 'app1', repoWithDir(), () => {});
    expect(report.failed).toEqual([]);
    expect(h.modes.filter(m => m.mode & 0o002)).toEqual([]);
    for (const d of dirsUnder(`${process.env.DATA_ROOT}/AppData/app1`)) {
      expect({ d, o: fs.statSync(d).mode & 0o002 }).toEqual({ d, o: 0 });
    }
  });

  rootIt('docker mode, as root: the delivered directories belong to PUID:PGID with owner and group write', () => {
    const bot = path.join(tmp, 'bot');
    prepareDockerBotFiles(dockerCompose('/host/bot'), bot, '/host/bot', repoWithDir(), [], () => {}, newDeliveryReport());
    for (const d of [path.join(bot, 'plugins'), path.join(bot, 'plugins', 'nested'), path.join(bot, 'data', 'empty')]) {
      const st = fs.statSync(d);
      expect({ d, uid: st.uid, gid: st.gid, mode: st.mode & 0o777 }).toEqual({ d, uid: 4242, gid: 4243, mode: 0o775 });
    }
  });

  posixIt('docker mode: every level the delivery creates above a bound directory has mode 775', () => {
    const bot = path.join(tmp, 'bot');
    prepareDockerBotFiles(dockerCompose('/host/bot'), bot, '/host/bot', repoWithDir(), [], () => {}, newDeliveryReport());
    for (const d of [path.join(bot, 'data'), path.join(bot, 'data', 'empty')]) {
      expect({ d, mode: fs.statSync(d).mode & 0o777 }).toEqual({ d, mode: 0o775 });
    }
  });

  rootIt('casaos mode, as root: the delivered directory belongs to PUID:PGID with owner and group write', async () => {
    await createVolumeDirectories(casaosCompose(), 'app1', repoWithDir(), () => {});
    const st = fs.statSync(`${process.env.DATA_ROOT}/AppData/app1/plugins`);
    expect({ uid: st.uid, gid: st.gid, mode: st.mode & 0o777 }).toEqual({ uid: 4242, gid: 4243, mode: 0o775 });
  });

  for (const mode of ['casaos', 'docker'] as const) {
    it(`${mode} mode: a service binding a bot data directory joins the PGID group, others do not`, () => {
      const appDir = mode === 'docker' ? '/srv/b1' : `${process.env.DATA_ROOT}/AppData/bot1`;
      const compose = [
        'services:',
        '  lavalink:',
        '    image: x',
        '    group_add: ["audio"]',
        '    volumes:',
        `      - ${appDir}/plugins:/opt/plugins`,
        '  redis:',
        '    image: y',
        '    volumes:',
        '      - cache:/data',
        '  web:',
        '    image: z',
        '    volumes:',
        '      - type: bind',
        '        source: ./www',
        '        target: /www',
        'volumes:',
        '  cache: {}',
        '',
      ].join('\n');
      const doc = processed(compose, 'bot1', mode);
      expect(doc.services.lavalink.group_add).toEqual(['audio', '4243']);
      expect(doc.services.redis.group_add).toBeUndefined();
      expect(doc.services.web.group_add).toEqual(['4243']);
    });
  }
});

describe('FU-2c every value the manager writes into a label or x-casaos field is $-escaped', () => {
  it('casaos mode: the web, fleet and transfer caddy hosts hold the domain with $ written $$', () => {
    process.env.APP_DOMAIN = 'd$HOME.example';
    process.env.APP_PUBLIC_IP_DASH = '1-2-3-4';
    const compose = [
      'services:',
      '  bot:',
      '    image: x',
      '    ports:',
      '      - "3000:3000"',
      '    labels:',
      '      fleet.control-port: "9000"',
      '      fleet.transfer-port: "9001"',
      '',
    ].join('\n');
    const labels = processed(compose, 'bot1', 'casaos').services.bot.labels;
    const hosts = Object.entries(labels).filter(([k]) => /^caddy_\d+$/.test(k)).map(([, v]) => v);
    expect(hosts.length).toBeGreaterThanOrEqual(5);
    for (const v of hosts) expect(String(v)).not.toMatch(/(^|[^$])\$HOME/);
    expect(hosts).toContain('bot1-d$$HOME.example');
    expect(hosts).toContain('bot1-fleet-d$$HOME.example');
    expect(hosts).toContain('bot1-transfer-d$$HOME.example');
    expect(processed(compose, 'bot1', 'casaos')['x-casaos'].hostname).toBe('bot1-d$$HOME.example');
  });

  it('attachBotToProxy and attachFleetToProxy write the host with $ written $$', () => {
    const compose = 'services:\n  bot:\n    image: x\n';
    const viaBot = YAML.parse(attachBotToProxy(compose, 'h$HOME.example', 3000));
    expect(viaBot.services.bot.labels.caddy).toBe('h$$HOME.example');
    const viaFleet = YAML.parse(attachFleetToProxy(compose, 'h$HOME.example', 9000, { envAdvertise: null, service: 'bot' }));
    expect(viaFleet.services.bot.labels.caddy_0).toBe('h$$HOME.example');
  });

  it('the name substitution writes the title name with $ written $$, and keeps repo text as written', () => {
    const compose = [
      'name: coolbot',
      'services:',
      '  coolbot:',
      '    image: x',
      'x-casaos:',
      '  title:',
      '    en_us: coolbot',
      '  tagline:',
      '    en_us: coolbot costs $$5',
      '',
    ].join('\n');
    const doc = YAML.parse(substituteComposeNames(compose, 'coolbot', 'second', 'My $HOME bot').content);
    expect(doc['x-casaos'].title.en_us).toBe('My $$HOME bot');
    expect(doc['x-casaos'].tagline.en_us).toBe('second costs $$5');
  });
});
