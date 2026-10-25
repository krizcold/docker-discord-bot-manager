import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { parseDocument } from 'yaml';
const calls = vi.hoisted(() => [] as string[][]);
const tmpData = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'b02-1-'));
  process.env.DATA_DIR = dir;
  return { dir };
});
vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const execFile = (_cmd: string, args: string[], opts: any, cb?: any) => {
    const done = typeof opts === 'function' ? opts : cb;
    calls.push(args);
    if (args[0] === 'volume' && args[1] === 'inspect') return done(null, '[]', '');
    done(new Error('fake'), '', args[0] === 'inspect' ? `Error: No such object: ${args[args.length - 1]}` : 'fake');
  };
  return { ...real, execFile };
});
import { LOG_CAP_RUN_ARGS } from '../../src/templates/logCaps';
import { ensureRsyncDaemon } from '../../src/instance/recoveryControl';
import { generateImageCompose } from '../../src/templates/compose';
import { addFleetPostgresReplicaService, addFleetPostgresService, processComposeForCasaOS } from '../../src/templates/pcsProcessing';

const bot = { id: 'b1', displayName: 'Bot One', sanitizedName: 'bot1', imageRef: 'example/bot:1' } as any;

function services(content: string): Record<string, Record<string, any>> {
  return (parseDocument(content).toJSON() as any).services;
}

function capped(service: Record<string, any>): boolean {
  return service.logging?.driver === 'json-file' && typeof service.logging?.options?.['max-size'] === 'string';
}

const authored = `services:
  app:
    image: example/app:1
  worker:
    image: example/worker:1
    logging:
      driver: json-file
      options:
        max-file: "2"
  journald:
    image: example/j:1
    logging:
      driver: journald
  sized:
    image: example/s:1
    logging:
      options:
        max-size: "1m"
`;

describe('every compose the manager writes caps its container logs', () => {
  for (const mode of ['docker', 'casaos'] as const) {
    it(`${mode} mode: services without a cap get one, an author's own driver or size is kept`, () => {
      const out = services(processComposeForCasaOS(authored, 'bot-b1', bot, { mode, hostBotDir: '/srv/b1' }).content);
      expect(capped(out.app)).toBe(true);
      expect(out.worker.logging).toEqual({ driver: 'json-file', options: { 'max-file': '2', 'max-size': '10m' } });
      expect(out.journald.logging).toEqual({ driver: 'journald' });
      expect(out.sized.logging.options['max-size']).toBe('1m');
      for (const service of Object.values(out)) {
        if (service.logging?.driver === 'journald') continue;
        expect(service.logging?.options?.['max-size']).toBeTruthy();
      }
    });
  }

  it('an image compose caps its service', () => {
    const out = services(generateImageCompose(bot, '/srv/b1'));
    expect(capped(out.bot)).toBe(true);
  });

  it('the fleet database sidecars are capped', () => {
    const base = 'services:\n  app:\n    image: example/app:1\n';
    const db = services(addFleetPostgresService(base, bot, { containerName: 'pg', volume: 'v', password: 'p', user: 'u', db: 'd' }));
    expect(capped(db['fleet-postgres'])).toBe(true);
    const rep = services(addFleetPostgresReplicaService(base, bot, { containerName: 'pgr', volume: 'vr', hostPort: 15432 }));
    expect(capped(rep['fleet-postgres-replica'])).toBe(true);
  });

  it('the shipped compose files cap every service', () => {
    for (const name of ['docker-compose.yml', 'docker-compose.remote.yml', 'docker-compose.standalone.yml']) {
      const out = services(fs.readFileSync(path.join(__dirname, '../..', name), 'utf8'));
      for (const [svc, service] of Object.entries(out)) expect(capped(service), `${name} ${svc}`).toBe(true);
    }
  });

  it('the docker run cap flags name the json-file driver with a size and file cap', () => {
    const at = (flag: string) => LOG_CAP_RUN_ARGS[LOG_CAP_RUN_ARGS.indexOf(flag) + 1];
    expect(at('--log-driver')).toBe('json-file');
    const opts = LOG_CAP_RUN_ARGS.filter((_, i) => LOG_CAP_RUN_ARGS[i - 1] === '--log-opt');
    expect(opts.some(o => /^max-size=\d+[kmg]$/.test(o))).toBe(true);
    expect(opts.some(o => /^max-file=\d+$/.test(o))).toBe(true);
  });

  it('the rsync daemon run passes the log cap as docker options, before the image', async () => {
    calls.length = 0;
    await ensureRsyncDaemon({ id: 'i1', fleetDb: { volume: 'v1' } } as any, 'example/rsync:1', 'net1');
    const run = calls.find(c => c[0] === 'run');
    expect(run).toBeTruthy();
    const image = run!.indexOf('example/rsync:1');
    const size = run!.findIndex((v, i) => run![i - 1] === '--log-opt' && v.startsWith('max-size='));
    expect(size).toBeGreaterThan(0);
    expect(size).toBeLessThan(image);
    expect(run![run!.indexOf('--log-driver') + 1]).toBe('json-file');
  });

  it('every long-lived docker run the manager starts spreads the log cap', () => {
    for (const file of ['instance/recoveryChannel.ts', 'instance/recoveryControl.ts', 'instance/recoveryRescue.ts', 'manager/selfUpdate.ts']) {
      const src = fs.readFileSync(path.join(__dirname, '../../src', file), 'utf8');
      const runs = src.match(/'run',\s*'-d'[\s\S]*?\]/g) ?? [];
      expect(runs.length, file).toBeGreaterThan(0);
      for (const call of runs) expect(call, file).toContain('...LOG_CAP_RUN_ARGS');
    }
  });
});

describe('a start caps the logs of a bot installed before the caps', () => {
  it('syncComposeEnvVars adds max-size to every json-file service and keeps journald', async () => {
    const { syncComposeEnvVars } = await import('../../src/docker/containerManager');
    const dir = path.join(tmpData.dir, 'bots', 'old');
    fs.mkdirSync(dir, { recursive: true });
    const composePath = path.join(dir, 'docker-compose.yml');
    fs.writeFileSync(composePath, `services:
  app:
    image: example/app:1
  redis:
    image: redis:7
  side:
    image: example/side:1
    logging:
      driver: journald
`);
    syncComposeEnvVars({ id: 'old', displayName: 'old', envVars: { TOKEN: 'x' } } as any, composePath, true);
    const after = services(fs.readFileSync(composePath, 'utf-8'));
    expect(capped(after.app)).toBe(true);
    expect(capped(after.redis)).toBe(true);
    expect(after.side.logging).toEqual({ driver: 'journald' });
  });

  it('the CasaOS docker-image start caps the platform compose before deploying', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../src/docker/containerManager.ts'), 'utf-8');
    const start = src.slice(src.indexOf('async function startDockerImageBot'));
    const casaos = start.slice(start.indexOf("if (deploymentMode === 'casaos')"), start.indexOf('casaosApi.deployApp'));
    expect(casaos).toMatch(/capComposeFileLogs\(composePath\)/);
  });
});
