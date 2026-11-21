import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm40-decom-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
  return {
    dir,
    project: 'mybot',
    running: [] as Array<{ name: string; service: string; image: string }>,
    down: 'all' as 'all' | 'leaveGateway',
    gateway: '',
    volume: 'absent' as 'absent' | 'exists',
    calls: [] as string[],
    execs: [] as string[],
    refuseStoreOnce: false,
    refuseCompose: false,
  };
});

// The env store's first write after refuseStoreOnce is set, and every compose write while refuseCompose is set, fail the way an unwritable file does.
vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>();
  const refused = (file: any) => {
    const f = String(file);
    if (h.refuseStoreOnce && /storage\.json(\.tmp)?/.test(f) && f.includes('env')) {
      h.refuseStoreOnce = false;
      return true;
    }
    return h.refuseCompose && f.includes('docker-compose.yml');
  };
  const writeFileSync = (file: any, ...rest: any[]) => {
    if (refused(file)) throw Object.assign(new Error(`EACCES: permission denied, open '${file}'`), { code: 'EACCES' });
    return (real.writeFileSync as any)(file, ...rest);
  };
  return { ...real, writeFileSync, default: { ...real, writeFileSync } };
});

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const answer = (line: string): string => {
    const project = /com\.docker\.compose\.project=([^"\s]+)/.exec(line)?.[1];
    const runs = project === h.project ? h.running : [];
    if (line.startsWith('docker ps -q')) return runs.map(c => `${c.name}-id`).join('\n');
    if (line.startsWith('docker ps') && line.includes('{{.Image}}')) return runs.map(c => `${c.name}|${c.service}|${c.image}`).join('\n');
    if (line.startsWith('docker ps')) return runs.map(c => c.name).join('\n');
    return '';
  };
  const exec = (cmd: string, opts: any, cb?: any) => {
    h.execs.push(cmd);
    const done = typeof opts === 'function' ? opts : cb;
    done(null, { stdout: answer(cmd), stderr: '' });
  };
  const execFile = (_cmd: string, args: string[], opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    if (args[0] === 'volume' && args[1] === 'inspect') {
      if (h.volume === 'exists') return done(null, '[]', '');
      return done(new Error('fail'), '', 'Error: No such volume');
    }
    done(null, '', '');
  };
  const mod = { ...real, exec, execFile };
  return { ...mod, default: mod };
});
vi.mock('../../src/casaos/detector', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/casaos/detector')>()),
  getDeploymentMode: async () => 'casaos',
}));
vi.mock('../../src/casaos/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/casaos/api')>()),
  composeDown: async (appName: string) => {
    h.calls.push(`down:${appName}`);
    h.running = h.down === 'all' ? [] : h.running.filter(c => c.name === h.gateway);
    return { success: true };
  },
}));
vi.mock('../../src/docker/dockerClient', async (importOriginal) => {
  const listing = () => h.running.map(c => ({
    id: `${c.name}-id`, name: c.name, state: 'running', status: '', ports: [], project: h.project, service: c.service, botId: 'b1',
  }));
  return {
    ...(await importOriginal<typeof import('../../src/docker/dockerClient')>()),
    listBotContainers: async () => listing(),
    listBotContainersAsync: async () => listing(),
    stopContainer: async (name: string) => { h.running = h.running.filter(c => c.name !== name); },
  };
});
vi.mock('../../src/docker/containerManager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/docker/containerManager')>()),
  startFleetDbSidecar: async () => { h.calls.push('start-db'); return { success: true }; },
  retireFleetDbSidecar: async () => { h.calls.push('retire'); return { success: true, volumeRemoved: true }; },
}));
vi.mock('../../src/instance/fleetBackupGuards', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/fleetBackupGuards')>()),
  claimFleetBackupBusy: () => true,
  releaseFleetBackupBusy: () => {},
}));
vi.mock('../../src/instance/fleetBackup', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/fleetBackup')>()),
  clearClaimFloor: () => {},
  forgetRestoreNotice: () => {},
  fencedSafetyDump: async () => { h.calls.push('dump'); return { success: true, file: 'fake.dump' }; },
}));
vi.mock('../../src/instance/appHookClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/instance/appHookClient')>()),
  capabilityRefusal: () => null,
}));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import * as fs from 'fs';
import * as path from 'path';
import YAML from 'yaml';
import * as containerManager from '../../src/docker/containerManager';
import * as envManager from '../../src/env/manager';
import { addFleetPostgresService, processComposeForCasaOS } from '../../src/templates/pcsProcessing';
import { readDatabaseUrl } from '../../src/config/databaseUrl';
import { decommissionFleetDb } from '../../src/instance/fleetReplica';
import { dataPlace } from '../../src/instance/dataPlace';
import { BOT_COMPOSE } from './nm40-compose';
import { applyVariableSubstitution } from '../../src/templates/variableSubstitution';
import { decommissionOutcome } from '../../src/cli/tui/dbtext';
import { previewFleetRestore } from '../../src/instance/fleetBackup';


const SMDB = 'https://github.com/x/fully-modular-discord-bot';
const SIDECAR = 'mybot-fleet-postgres';
const URL_VALUE = 'postgresql://smdb:fake-pass@mybot-fleet-postgres:5432/smdb?sslmode=no-verify';
const OTHER_URL = 'postgresql://smdb:fake-pass@elsewhere.invalid:5432/smdb';
const registryPath = () => path.join(h.dir, 'instances.json');
const composePath = () => path.join(h.dir, 'DATA', 'AppData', 'casaos', 'apps', h.project, 'docker-compose.yml');
const stored = (): any => JSON.parse(fs.readFileSync(registryPath(), 'utf-8')).instances.b1;

function instance(over: Record<string, unknown> = {}): any {
  return {
    id: 'b1', sanitizedName: h.project, displayName: 'My Bot', titleName: 'My Bot', status: 'stopped',
    sourceType: 'git', sourceUrl: SMDB, envVars: {},
    fleetDb: { containerName: SIDECAR, user: 'smdb', db: 'smdb', volume: 'mybot-fleet-postgres-data' },
    createdAt: '2026-11-21T00:00:00.000Z', updatedAt: '2026-11-21T00:00:00.000Z', ...over,
  };
}

type Running = { name: string; service: string; image: string };

let deployedPath = '';

/** The record, the env store and the deployed compose as the real writers leave them; env is stored before the compose sync. */
function deploy(over: Record<string, unknown> = {}, env: Record<string, string> = {}, compose = BOT_COMPOSE, mode: 'casaos' | 'docker' = 'casaos'): void {
  const inst = instance(over);
  fs.writeFileSync(registryPath(), JSON.stringify({ instances: { b1: inst } }));
  fs.mkdirSync(path.join(h.dir, 'bots', 'b1', 'env'), { recursive: true });
  if (Object.keys(env).length) envManager.setEnvVars('b1', env);
  const out = processComposeForCasaOS(compose, h.project, inst, { mode }).content;
  deployedPath = mode === 'casaos' ? composePath() : path.join(h.dir, 'bots', 'b1', 'docker-compose.yml');
  fs.mkdirSync(path.dirname(deployedPath), { recursive: true });
  fs.writeFileSync(deployedPath, out);
  containerManager.syncComposeEnvVars(containerManager.getBot('b1')!, deployedPath);
  h.gateway = svc('fullymodulardiscordbot').name;
}

/** The container docker runs for a service of the deployed compose: its container_name, its service key and its image. */
function svc(key: string, file = deployedPath): Running {
  const s = YAML.parse(fs.readFileSync(file, 'utf-8')).services?.[key] ?? {};
  return { name: s.container_name ?? '', service: key, image: s.image ?? '' };
}

const gw = () => svc('fullymodulardiscordbot');
const app = () => svc('fullymodulardiscordbotapp');
const db = (): Running => ({ name: SIDECAR, service: 'fleet-postgres', image: 'postgres:16.4-alpine' });

// A compose whose main service is the bot itself, with no gateway.
const NO_GATEWAY = `services:
  fullymodulardiscordbot:
    image: ghcr.io/krizcold/fully-modular-discord-bot:latest
    container_name: fullymodulardiscordbot
    expose:
      - 8080
x-casaos:
  main: fullymodulardiscordbot
  port_map: "8080"
`;

beforeEach(() => {
  fs.rmSync(path.join(h.dir, 'bots'), { recursive: true, force: true });
  fs.rmSync(path.join(h.dir, 'DATA'), { recursive: true, force: true });
  Object.assign(h, { running: [], down: 'all', gateway: '', volume: 'absent', calls: [], execs: [], refuseStoreOnce: false, refuseCompose: false });
});
afterAll(() => fs.rmSync(h.dir, { recursive: true, force: true }));

describe('NM40 part 1: the fronting gateway is left out of the instance container count', () => {
  it('the real CasaOS compose names the gateway and the app apart', () => {
    deploy();
    expect(gw().name).toBeTruthy();
    expect(gw().image).toBeTruthy();
    expect(app().name).toBeTruthy();
    expect(gw().name).not.toBe(app().name);
  });
  it('T1 with only the gateway and the sidecar running, runningNonSidecarContainers lists nothing', async () => {
    deploy();
    h.running = [gw(), db()];
    expect(await containerManager.runningNonSidecarContainers('b1')).toEqual([]);
  });
  it('T2 with the app running too, the list names only the app', async () => {
    deploy();
    h.running = [gw(), app(), db()];
    expect(await containerManager.runningNonSidecarContainers('b1')).toEqual([app().name]);
  });
  it('T3 a missing or unparsable compose leaves the gateway counted', async () => {
    deploy();
    const gateway = gw();
    h.running = [gateway, db()];
    fs.rmSync(composePath());
    expect(await containerManager.runningNonSidecarContainers('b1')).toEqual([gateway.name]);
    fs.writeFileSync(composePath(), 'services: [unclosed\n  : :');
    expect(await containerManager.runningNonSidecarContainers('b1')).toEqual([gateway.name]);
  });
  it('T4 a worker beside the gateway is still counted', async () => {
    const withWorker = BOT_COMPOSE.replace('\nx-casaos:\n  architectures', '  worker:\n    image: alpine:3.20\n    container_name: fmdbworker\n\nx-casaos:\n  architectures');
    deploy({}, {}, withWorker);
    h.running = [gw(), svc('worker'), db()];
    expect(await containerManager.runningNonSidecarContainers('b1')).toEqual([svc('worker').name]);
  });
  it('T5 with no fleet database, runningInstanceContainers leaves the gateway out', async () => {
    deploy({ fleetDb: undefined });
    h.running = [gw()];
    expect(await containerManager.runningInstanceContainers('b1')).toEqual([]);
    h.running = [gw(), app()];
    expect(await containerManager.runningInstanceContainers('b1')).toEqual([app().name]);
  });
  it('R6 an instance missing from the registry answers null from both listings', async () => {
    deploy();
    expect(await containerManager.runningInstanceContainers('nobody')).toBeNull();
    expect(await containerManager.runningNonSidecarContainers('nobody')).toBeNull();
  });
});

describe('NM40 R1: a container is left out only when it is the deployed gateway', () => {
  it('a bot still running from a compose with no gateway, after a build deployed one, is counted and Decommission refuses', async () => {
    const v1Path = path.join(h.dir, 'v1-compose.yml');
    fs.writeFileSync(v1Path, processComposeForCasaOS(NO_GATEWAY, h.project, instance()).content);
    const oldBot = svc('fullymodulardiscordbot', v1Path);
    deploy();
    expect(oldBot.name).toBe(gw().name);
    expect(oldBot.service).toBe(gw().service);
    expect(oldBot.image).not.toBe(gw().image);
    h.running = [oldBot, db()];
    expect(await containerManager.runningNonSidecarContainers('b1')).toEqual([oldBot.name]);
    const res = await decommissionFleetDb('b1');
    expect(res.success).toBe(false);
    expect(res.error).toContain(`Docker still runs ${oldBot.name} of this instance`);
    expect(h.calls).toEqual([]);
  });
  it('a container with the gateway name under another service label is counted', async () => {
    deploy();
    h.running = [{ ...gw(), service: 'other' }];
    expect(await containerManager.runningNonSidecarContainers('b1')).toEqual([gw().name]);
  });
  it('a deployed compose with YAML errors leaves the gateway counted', async () => {
    deploy();
    const gateway = gw();
    fs.appendFileSync(composePath(), 'name: again\n');
    h.running = [gateway];
    expect(await containerManager.runningNonSidecarContainers('b1')).toEqual([gateway.name]);
  });
});

describe('NM40 R2: a gateway that can receive the database is counted', () => {
  it('x-casaos.build names the main service', async () => {
    deploy({}, {}, BOT_COMPOSE.replace('  build: fullymodulardiscordbotapp', '  build: fullymodulardiscordbot'));
    h.running = [gw()];
    expect(await containerManager.runningNonSidecarContainers('b1')).toEqual([gw().name]);
  });
  it('no build key and the main service comes first', async () => {
    deploy({}, {}, BOT_COMPOSE.replace('  build: fullymodulardiscordbotapp\n', ''));
    h.running = [gw()];
    expect(await containerManager.runningNonSidecarContainers('b1')).toEqual([gw().name]);
  });
  it('the gateway has an env_file', async () => {
    deploy({}, {}, BOT_COMPOSE.replace('    user: "root"\n', '    user: "root"\n    env_file: .env\n'));
    expect(YAML.parse(fs.readFileSync(composePath(), 'utf-8')).services.fullymodulardiscordbot.env_file).toBeDefined();
    h.running = [gw()];
    expect(await containerManager.runningNonSidecarContainers('b1')).toEqual([gw().name]);
  });
  it('the gateway environment names a companion key', async () => {
    deploy({}, { DATA_BACKEND_URL: URL_VALUE }, BOT_COMPOSE.replace('      LISTEN_PORT: "80"\n', '      LISTEN_PORT: "80"\n      DB_LINK: ${DATA_BACKEND_URL}\n'));
    expect(JSON.stringify(YAML.parse(fs.readFileSync(composePath(), 'utf-8')).services.fullymodulardiscordbot.environment)).toContain('DATA_BACKEND_URL');
    h.running = [gw()];
    expect(await containerManager.runningNonSidecarContainers('b1')).toEqual([gw().name]);
  });
  it('the gateway environment holds the stored URL', async () => {
    deploy({}, { DATA_BACKEND_URL: URL_VALUE }, BOT_COMPOSE.replace('      LISTEN_PORT: "80"\n', `      LISTEN_PORT: "80"\n      DB_LINK: "${URL_VALUE}"\n`));
    h.running = [gw()];
    expect(await containerManager.runningNonSidecarContainers('b1')).toEqual([gw().name]);
  });
});

describe('NM40 F1, F2: a gateway that can reach the database another way is counted', () => {
  const withGatewayEnv = (line: string) => BOT_COMPOSE.replace('      LISTEN_PORT: "80"\n', () => `      LISTEN_PORT: "80"\n      ${line}\n`);
  const withGatewayKey = (block: string) => BOT_COMPOSE.replace('    user: "root"\n', () => `    user: "root"\n${block}`);
  const withSidecar = () => {
    const inst = containerManager.getBot('b1')!;
    fs.writeFileSync(composePath(), addFleetPostgresService(fs.readFileSync(composePath(), 'utf-8'), inst, { containerName: SIDECAR, volume: inst.fleetDb!.volume, password: 'p', user: 'smdb', db: 'smdb' }));
  };
  const counted = async () => {
    h.running = [gw()];
    expect(await containerManager.runningNonSidecarContainers('b1')).toEqual([gw().name]);
  };
  it('F1, G1 a stored URL to another host that cannot be decrypted, while the gateway holds it', async () => {
    deploy({}, { DATA_BACKEND_URL: OTHER_URL }, withGatewayEnv(`DB_LINK: "${OTHER_URL}"`));
    const storage = path.join(h.dir, 'bots', 'b1', 'env', 'storage.json');
    const store = JSON.parse(fs.readFileSync(storage, 'utf-8'));
    // The writer's own ciphertext, damaged by hand: no writer of this manager stores an undecryptable value.
    if (store.encrypted?.DATA_BACKEND_URL) store.encrypted.DATA_BACKEND_URL = 'not:a:ciphertext';
    else { delete store.vars.DATA_BACKEND_URL; store.encrypted = { ...(store.encrypted ?? {}), DATA_BACKEND_URL: 'not:a:ciphertext' }; }
    fs.writeFileSync(storage, JSON.stringify(store));
    expect(envManager.getEnvVarsWithStatus('b1').undecryptable).toContain('DATA_BACKEND_URL');
    await counted();
  });
  it('G2 a stored value readDatabaseUrl cannot parse, with a dollar sign, substituted into the gateway', async () => {
    const value = 'host=elsewhere.invalid dbname=smdb password=pa$s';
    expect(readDatabaseUrl(value).addresses).toEqual([]);
    const substituted = applyVariableSubstitution(withGatewayEnv('DB_LINK: ${DATA_BACKEND_URL}'), instance({ envVars: { DATA_BACKEND_URL: value } }));
    deploy({ envVars: { DATA_BACKEND_URL: value } }, { DATA_BACKEND_URL: value }, substituted);
    expect(fs.readFileSync(composePath(), 'utf-8')).toContain('pa$$s');
    await counted();
  });
  it('H1 the gateway takes the app service volumes through volumes_from', async () => {
    deploy({}, {}, withGatewayKey('    volumes_from:\n      - fullymodulardiscordbotapp\n'));
    await counted();
  });
  it('J1b another service mounts / and the gateway mounts only its own folder', async () => {
    deploy({}, {}, BOT_COMPOSE.replace('\nx-casaos:\n  architectures', () => '  worker:\n    image: alpine:3.20\n    volumes:\n      - /:/host:ro\n\nx-casaos:\n  architectures'));
    await counted();
  });
  it('J1 the gateway sets pid: host', async () => {
    deploy({}, {}, withGatewayKey('    pid: host\n'));
    await counted();
  });
  for (const parent of ['/', '/var', '/var/run', '/run']) {
    it(`J1 the gateway mounts ${parent}, a parent of the docker socket`, async () => {
      deploy({}, {}, BOT_COMPOSE.replace('        target: /data\n    labels:\n      caddy_0', () => `        target: /data\n      - ${parent}:/hostdir:ro\n    labels:\n      caddy_0`));
      await counted();
    });
  }
  it('J1 the gateway mounts /run/docker.sock', async () => {
    deploy({}, {}, BOT_COMPOSE.replace('        target: /data\n    labels:\n      caddy_0', () => '        target: /data\n      - /run/docker.sock:/var/run/docker.sock\n    labels:\n      caddy_0'));
    await counted();
  });
  it('H1 the gateway mounts the docker socket', async () => {
    deploy({}, {}, BOT_COMPOSE.replace('        target: /data\n    labels:\n      caddy_0', () => '        target: /data\n      - /var/run/docker.sock:/var/run/docker.sock\n    labels:\n      caddy_0'));
    await counted();
  });
  it('H1 the gateway shares the app pid, ipc or network namespace', async () => {
    for (const line of ['    pid: "service:fullymodulardiscordbotapp"\n', '    ipc: "container:other"\n', '    network_mode: "service:fullymodulardiscordbotapp"\n']) {
      deploy({}, {}, withGatewayKey(line));
      await counted();
    }
  });
  it('H2 a caddy label holding a stored host leaves the gateway out', async () => {
    deploy({}, { DATA_BACKEND_URL: OTHER_URL }, BOT_COMPOSE.replace('      caddy_2.reverse_proxy: "{{upstreams 80}}"\n', () => '      caddy_2.reverse_proxy: "{{upstreams 80}}"\n      caddy_9: elsewhere.invalid\n'));
    expect(JSON.stringify(YAML.parse(fs.readFileSync(composePath(), 'utf-8')).services.fullymodulardiscordbot.labels)).toContain('elsewhere.invalid');
    h.running = [gw()];
    expect(await containerManager.runningNonSidecarContainers('b1')).toEqual([]);
  });
  it('G4 the stored URL in the gateway command', async () => {
    deploy({}, { DATA_BACKEND_URL: OTHER_URL }, withGatewayKey(`    command: ["--upstream", "${OTHER_URL}"]\n`));
    await counted();
  });
  it('G3 the gateway mounts a parent of a folder the app mounts', async () => {
    deploy({}, {}, BOT_COMPOSE.replace('        source: $DATA_ROOT/AppData/fullymodulardiscordbot/appshield\n', () => '        source: $DATA_ROOT/AppData/fullymodulardiscordbot\n'));
    await counted();
  });
  it('G3 the gateway mounts the database volume the sidecar service mounts', async () => {
    deploy({ fleetDb: { containerName: SIDECAR, user: 'smdb', db: 'smdb', volume: 'pgstore' } }, {}, BOT_COMPOSE.replace('        target: /data\n    labels:\n      caddy_0', () => '        target: /data\n      - type: volume\n        source: fleet-postgres-data\n        target: /pg\n    labels:\n      caddy_0'));
    withSidecar();
    expect(YAML.parse(fs.readFileSync(composePath(), 'utf-8')).services['fleet-postgres']).toBeDefined();
    await counted();
  });
  it('T1 check: the real bot compose with its sidecar added still leaves the gateway out', async () => {
    deploy({}, { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: URL_VALUE });
    withSidecar();
    h.running = [gw(), db()];
    expect(await containerManager.runningNonSidecarContainers('b1')).toEqual([]);
  });
  it('F2 the URL with a dollar sign, written as $$ in the compose by the build substitution', async () => {
    const url = 'postgresql://smdb:pa$s@elsewhere.invalid:5432/smdb';
    const substituted = applyVariableSubstitution(withGatewayEnv('DB_LINK: ${DATA_BACKEND_URL}'), instance({ envVars: { DATA_BACKEND_URL: url } }));
    deploy({ envVars: { DATA_BACKEND_URL: url } }, { DATA_BACKEND_URL: url }, substituted);
    expect(fs.readFileSync(composePath(), 'utf-8')).toContain('pa$$s@');
    await counted();
  });
  it('F2 the URL embedded in a longer value', async () => {
    deploy({}, { DATA_BACKEND_URL: URL_VALUE }, withGatewayEnv(`DB_LINK: "jdbc:${URL_VALUE}&x=1"`));
    await counted();
  });
  it('F2 one URL of a stored list', async () => {
    const other = 'postgresql://smdb:p2@standby.invalid:5432/smdb';
    deploy({}, { DATA_BACKEND_URL: `${URL_VALUE},${other}` }, withGatewayEnv(`DB_LINK: "${other}"`));
    await counted();
  });
  it('F2 the database host alone', async () => {
    deploy({}, {}, withGatewayEnv(`DB_HOST: ${SIDECAR}`));
    await counted();
  });
  it('F2 the gateway has secrets', async () => {
    deploy({}, {}, withGatewayKey('    secrets:\n      - dbpass\n').replace('\nx-casaos:\n  architectures', '\nsecrets:\n  dbpass:\n    file: ./dbpass.txt\n\nx-casaos:\n  architectures'));
    await counted();
  });
  it('F2 the gateway has configs', async () => {
    deploy({}, {}, withGatewayKey('    configs:\n      - dbconf\n').replace('\nx-casaos:\n  architectures', '\nconfigs:\n  dbconf:\n    file: ./db.conf\n\nx-casaos:\n  architectures'));
    await counted();
  });
  it('F2 the gateway extends another service', async () => {
    deploy({}, {}, withGatewayKey('    extends:\n      file: base.yml\n      service: base\n'));
    await counted();
  });
  it('F2 the gateway mounts a folder the app service also mounts', async () => {
    deploy({}, {}, BOT_COMPOSE.replace('        target: /data\n    labels:\n      caddy_0', '        target: /data\n      - type: bind\n        source: $DATA_ROOT/AppData/fullymodulardiscordbot/data\n        target: /botdata\n    labels:\n      caddy_0'));
    await counted();
  });
  it('F5 the listing asks docker for the name, the service label and the image, in that order', async () => {
    deploy();
    h.running = [gw()];
    await containerManager.runningNonSidecarContainers('b1');
    expect(h.execs.filter(c => c.startsWith('docker ps --filter'))).toEqual([
      'docker ps --filter "label=com.docker.compose.project=mybot" --format "{{.Names}}|{{.Label \\"com.docker.compose.service\\"}}|{{.Image}}"',
    ]);
  });
});

describe('NM40 R7: no gateway, or a gateway with no container_name, leaves nothing out', () => {
  it('a compose with no gateway: its main service, named after the app and running alone, is counted', async () => {
    deploy({}, {}, NO_GATEWAY);
    const main = svc('fullymodulardiscordbot');
    expect(main.name).toBe(h.project);
    h.running = [main];
    expect(await containerManager.runningNonSidecarContainers('b1')).toEqual([main.name]);
  });
  it('a docker-mode compose that keeps the gateway: left out with its container_name, counted without one', async () => {
    deploy({ webAuth: 'public' }, {}, BOT_COMPOSE, 'docker');
    const gateway = gw();
    expect(gateway.name).toBeTruthy();
    h.running = [gateway];
    expect(await containerManager.runningNonSidecarContainers('b1')).toEqual([]);
    // No writer of this manager leaves a gateway without container_name, so this one is taken out by hand.
    const doc = YAML.parseDocument(fs.readFileSync(deployedPath, 'utf-8'));
    doc.deleteIn(['services', 'fullymodulardiscordbot', 'container_name']);
    fs.writeFileSync(deployedPath, doc.toString());
    expect(await containerManager.runningNonSidecarContainers('b1')).toEqual([gateway.name]);
  });
});

describe('NM40 part 1: Decommission after Stop on CasaOS', () => {
  it('T6 Stop takes every container down, the platform starts the gateway again, and Decommission goes ahead', async () => {
    deploy({ status: 'running' });
    h.running = [gw(), app(), db()];
    expect((await containerManager.stopBot('b1')).success).toBe(true);
    expect(stored().status).toBe('stopped');
    h.running = [gw()];
    const res = await decommissionFleetDb('b1');
    expect(res.error).toBeUndefined();
    expect(res.success).toBe(true);
    expect(h.calls).toContain('retire');
  });
  it('T7 Stop leaves the gateway, the reconciler records error, and Decommission goes ahead', async () => {
    deploy({ status: 'running' });
    h.running = [gw(), app(), db()];
    h.down = 'leaveGateway';
    const stop = await containerManager.stopBot('b1');
    expect(stop.success).toBe(false);
    expect(stored().status).toBe('running');
    expect(h.running.map(c => c.name)).toEqual([gw().name]);
    await containerManager.syncContainerStates();
    expect(stored().status).toBe('error');
    const res = await decommissionFleetDb('b1');
    expect(res.error).toBeUndefined();
    expect(res.success).toBe(true);
    expect(h.calls).toContain('retire');
  });
  it('T8 the app container running under a stopped status is refused with the new text, and nothing is touched', async () => {
    deploy();
    h.volume = 'exists';
    h.running = [gw(), app()];
    const res = await decommissionFleetDb('b1');
    expect(res).toEqual({ success: false, error: `Docker still runs ${app().name} of this instance, which can use this database: stop the instance, then decommission again. Nothing was destroyed` });
    expect(h.calls).toEqual([]);
  });
});

describe('NM40 R9: a restore reads a gateway-only instance as not running', () => {
  it('previewFleetRestore: only the gateway up reads not running, the app up reads running', async () => {
    deploy({}, { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: URL_VALUE });
    h.running = [gw(), db()];
    const quiet = await previewFleetRestore('b1');
    expect(quiet.success).toBe(true);
    if (quiet.success) expect(quiet.instances.find(i => i.id === 'b1')?.running).toBe(false);
    h.running = [gw(), app(), db()];
    const busy = await previewFleetRestore('b1');
    expect(busy.success).toBe(true);
    if (busy.success) expect(busy.instances.find(i => i.id === 'b1')?.running).toBe(true);
  });
});

const NOTE_TAIL = "What the bot runs on at its next start depends on its own settings in its data folder, which the manager can't confirm.";

describe('NM40 part 2: Decommission says which env vars it removed', () => {
  it('T10 both keys stored: the note names both, and neither is left in the store, the record or the compose', async () => {
    deploy({ envVars: { DATA_BACKEND: 'postgres' } }, { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: URL_VALUE });
    expect(fs.readFileSync(composePath(), 'utf-8')).toContain('DATA_BACKEND_URL');
    const res = await decommissionFleetDb('b1');
    expect(res.success).toBe(true);
    expect(res.envNote).toBe(`DATA_BACKEND_URL and DATA_BACKEND were removed from this instance's env vars, so the manager now reads it as a files bot and passes it no database. ${NOTE_TAIL}`);
    const vars = envManager.getEnvVars('b1');
    expect(vars.DATA_BACKEND).toBeUndefined();
    expect(vars.DATA_BACKEND_URL).toBeUndefined();
    expect(stored().envVars?.DATA_BACKEND).toBeUndefined();
    expect(fs.readFileSync(composePath(), 'utf-8')).not.toContain('DATA_BACKEND');
    expect(dataPlace(containerManager.getBot('b1')!)).toBe('json');
  });
  it('T11 only the URL stored: the note names only DATA_BACKEND_URL and leaves out the files clause', async () => {
    deploy({}, { DATA_BACKEND_URL: URL_VALUE });
    const res = await decommissionFleetDb('b1');
    expect(res.success).toBe(true);
    expect(res.envNote).toBe(`DATA_BACKEND_URL was removed from this instance's env vars, so the manager passes it no database. ${NOTE_TAIL}`);
  });
  it('T12 one delete refused: the warning names it, the note names only the removed key and claims nothing about the database', async () => {
    deploy({}, { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: URL_VALUE });
    h.refuseStoreOnce = true;
    const res = await decommissionFleetDb('b1');
    expect(res.success).toBe(true);
    expect(res.warning).toContain('The database env pins DATA_BACKEND_URL could not be removed');
    expect(res.envNote).toBe(`DATA_BACKEND was removed from this instance's env vars, so the manager now reads it as a files bot. ${NOTE_TAIL}`);
    expect(envManager.getEnvVars('b1').DATA_BACKEND_URL).toBe(URL_VALUE);
    expect(decommissionOutcome({ ok: true, value: res }).text).toBe(`Database decommissioned. ${res.warning}. ${res.envNote}`);
  });
  it('R3 a compose that cannot be rewritten: the key it still sets is not named, and the note claims nothing about the database', async () => {
    deploy({}, { DATA_BACKEND: 'postgres', DATA_BACKEND_URL: URL_VALUE });
    h.refuseCompose = true;
    const res = await decommissionFleetDb('b1');
    expect(res.success).toBe(true);
    expect(res.warning).toContain('could not be removed from');
    expect(fs.readFileSync(composePath(), 'utf-8')).toContain('DATA_BACKEND_URL');
    expect(res.envNote).toBe(`DATA_BACKEND was removed from this instance's env vars, so the manager now reads it as a files bot. ${NOTE_TAIL}`);
  });
  it('T13 nothing stored: no note', async () => {
    deploy();
    const res = await decommissionFleetDb('b1');
    expect(res.success).toBe(true);
    expect(res.envNote).toBeUndefined();
  });
});
