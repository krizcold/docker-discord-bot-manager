import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseDocument } from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateImageCompose } from '../../src/templates/compose';
import * as pcs from '../../src/templates/pcsProcessing';
import {
  addConfigFileBinds,
  createVolumeDirectories,
  prepareDockerBotFiles,
  processComposeForCasaOS,
  redeliverDockerConfigFiles,
} from '../../src/templates/pcsProcessing';

const SEED = 'server:\n  port: 2333\n';
const OVERRIDE = 'server:\n  port: 9999\n';

let tmp: string;
let repo: string;
let logs: string[];
const savedDataRoot = process.env.DATA_ROOT;
const fwd = (p: string) => p.replace(/\\/g, '/');
const svcs = (content: string): Record<string, any> => (parseDocument(content).toJSON() as any).services;
const hash = (body: string): string => (pcs as any).bodyHash ? (pcs as any).bodyHash(body) : 'no-hash-function';

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'b17-1-'));
  repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  fs.writeFileSync(path.join(repo, 'application.yml'), SEED);
  process.env.DATA_ROOT = fwd(path.join(tmp, 'DATA'));
  logs = [];
});

afterEach(() => {
  if (savedDataRoot === undefined) delete process.env.DATA_ROOT; else process.env.DATA_ROOT = savedDataRoot;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('B17-1 env values reach the container literally', () => {
  const bot = { id: 'b1', displayName: 'Bot', sanitizedName: 'bot1', imageRef: 'example/bot:1', envVars: { DB_PASSWORD: 'pa$word' } } as any;

  for (const mode of ['casaos', 'docker'] as const) {
    it(`${mode} mode: a '$' in an env value is written as '$$' so compose does not interpolate it`, () => {
      const out = processComposeForCasaOS(generateImageCompose(bot, '/x'), 'bot1', bot, { mode, hostBotDir: '/srv/b1' }).content;
      expect(svcs(out).bot.environment.DB_PASSWORD).toBe('pa$$word');
    });
  }

  it('a .env value with a $ is single-quoted, so compose reads it literally', () => {
    const fmt = (pcs as any).formatDotenvValue as ((v: string) => string) | undefined;
    expect(typeof fmt).toBe('function');
    expect(fmt!('pa$word')).toBe("'pa$word'");
    expect(fmt!("it's $5")).toBe('"it\'s \\$5"');
    expect(fmt!('plain')).toBe('plain');
  });
});

describe('B17-1 config binds land on the app service', () => {
  it('a docker-image compose with the status page as main gets the bind on bot, not status-page', () => {
    const compose = [
      'services:',
      '  bot:',
      '    image: example/bot:1',
      '  status-page:',
      '    image: nginx',
      'x-casaos:',
      '  main: status-page',
      '',
    ].join('\n');
    const out = svcs(addConfigFileBinds(compose, 'bot1', [{ path: '/app/config.json' }], (m) => logs.push(m)));
    expect((out.bot.volumes || []).some((v: any) => v.target === '/app/config.json')).toBe(true);
    expect(out['status-page'].volumes).toBeUndefined();
    expect(logs.some((l) => l.includes('/app/config.json') && l.includes('bot'))).toBe(true);
  });

  it('refuses to bind onto the status page and reports the path as not delivered', () => {
    const compose = 'services:\n  status-page:\n    image: nginx\n';
    const report = { failed: [] as string[], delivered: {}, unbound: [] as string[] };
    const out = addConfigFileBinds(compose, 'bot1', [{ path: '/app/config.json' }], (m) => logs.push(m), report as any);
    expect(svcs(out)['status-page'].volumes).toBeUndefined();
    expect(report.failed).toEqual(['/app/config.json']);
  });
});

describe('B17-1 a disabled or removed override gets the repo template back at the next build', () => {
  const casaosSrc = () => `${process.env.DATA_ROOT}/AppData/app1/application.yml`;
  const casaosCompose = () => `services:\n  app:\n    image: x\n    volumes:\n      - type: bind\n        source: ${casaosSrc()}\n        target: /app/application.yml\n`;

  it('platform mode: a file still holding the delivered override is restored to the template', async () => {
    fs.mkdirSync(path.dirname(casaosSrc()), { recursive: true });
    fs.writeFileSync(casaosSrc(), OVERRIDE);
    await (createVolumeDirectories as any)(casaosCompose(), 'app1', repo, (m: string) => logs.push(m), undefined, { [casaosSrc()]: hash(OVERRIDE) });
    expect(fs.readFileSync(casaosSrc(), 'utf8')).toBe(SEED);
    expect(logs.some((l) => l.includes('Restored the repo template'))).toBe(true);
  });

  it('platform mode: a file the bot changed since the override is kept and the log says so', async () => {
    fs.mkdirSync(path.dirname(casaosSrc()), { recursive: true });
    fs.writeFileSync(casaosSrc(), 'bot wrote this\n');
    await (createVolumeDirectories as any)(casaosCompose(), 'app1', repo, (m: string) => logs.push(m), undefined, { [casaosSrc()]: hash(OVERRIDE) });
    expect(fs.readFileSync(casaosSrc(), 'utf8')).toBe('bot wrote this\n');
    expect(logs.some((l) => l.includes('Kept existing file'))).toBe(true);
  });

  it('docker mode: a file still holding the delivered override is restored to the template', () => {
    const local = path.join(tmp, 'bot', 'application.yml');
    fs.mkdirSync(path.dirname(local), { recursive: true });
    fs.writeFileSync(local, OVERRIDE);
    const compose = 'services:\n  app:\n    image: x\n    volumes:\n      - /host/bot/application.yml:/app/application.yml\n';
    (prepareDockerBotFiles as any)(compose, path.join(tmp, 'bot'), '/host/bot', repo, [], (m: string) => logs.push(m), undefined, { [local]: hash(OVERRIDE) });
    expect(fs.readFileSync(local, 'utf8')).toBe(SEED);
  });

  it('docker mode: the build records the override it delivered', () => {
    const compose = 'services:\n  app:\n    image: x\n    volumes:\n      - /host/bot/application.yml:/app/application.yml\n';
    const report = { failed: [] as string[], delivered: {} as Record<string, string> };
    (prepareDockerBotFiles as any)(compose, path.join(tmp, 'bot'), '/host/bot', repo, [{ path: '/app/application.yml', body: OVERRIDE }], () => {}, report);
    expect(report.delivered[path.join(tmp, 'bot', 'application.yml')]).toBe(hash(OVERRIDE));
    expect(report.failed).toEqual([]);
  });
});

describe('B17-1 the Writable choice is the mode the repo-declared bind gets', () => {
  it('docker mode: Writable strips :ro from a string bind, read-only sets read_only on an object bind', () => {
    const compose = [
      'services:',
      '  app:',
      '    image: x',
      '    volumes:',
      '      - /host/bot/application.yml:/app/application.yml:ro',
      '      - type: bind',
      '        source: /host/bot/other.yml',
      '        target: /app/other.yml',
      '',
    ].join('\n');
    const out = svcs(prepareDockerBotFiles(compose, path.join(tmp, 'bot'), '/host/bot', null, [
      { path: '/app/application.yml', body: OVERRIDE, readOnly: false },
      { path: '/app/other.yml', body: OVERRIDE, readOnly: true },
    ], () => {}));
    expect(out.app.volumes[0]).toBe('/host/bot/application.yml:/app/application.yml');
    expect(out.app.volumes[1].read_only).toBe(true);
  });

  it('platform mode: setDeclaredBindModes adds :ro to a string bind', () => {
    const set = (pcs as any).setDeclaredBindModes as ((c: string, f: unknown[]) => string) | undefined;
    expect(typeof set).toBe('function');
    const out = svcs(set!('services:\n  app:\n    image: x\n    volumes:\n      - /DATA/AppData/a/x.yml:/app/x.yml\n', [{ path: '/app/x.yml', readOnly: true }]));
    expect(out.app.volumes[0]).toBe('/DATA/AppData/a/x.yml:/app/x.yml:ro');
  });
});

describe('B17-1 delivery helpers report what they did not deliver', () => {
  it('redeliverDockerConfigFiles reports a config with no bind in the deployed compose as not mounted, apart from write failures', () => {
    const report = (redeliverDockerConfigFiles as any)('services:\n  app:\n    image: x\n', path.join(tmp, 'bot'), '/host/bot', [{ path: '/app/new.json', body: '{}' }]);
    expect(report?.unbound).toEqual(['/app/new.json']);
    expect(report?.failed).toEqual([]);
  });

  it('prepareDockerBotFiles names a bind it could not prepare', () => {
    const local = path.join(tmp, 'bot', 'application.yml');
    fs.mkdirSync(local, { recursive: true });
    fs.writeFileSync(path.join(local, 'keep.txt'), 'data');
    const report = { failed: [] as string[], delivered: {}, unbound: [] as string[] };
    const compose = 'services:\n  app:\n    image: x\n    volumes:\n      - /host/bot/application.yml:/app/application.yml\n';
    (prepareDockerBotFiles as any)(compose, path.join(tmp, 'bot'), '/host/bot', repo, [], () => {}, report);
    expect(report.failed).toEqual([local]);
    expect(fs.readFileSync(path.join(local, 'keep.txt'), 'utf8')).toBe('data');
  });
});

const dockerRuns = (() => {
  try {
    return (require('child_process') as typeof import('child_process')).spawnSync('docker', ['version'], { stdio: 'ignore', timeout: 10000 }).status === 0;
  } catch {
    return false;
  }
})();

describe.skipIf(process.platform === 'win32' || !dockerRuns)('B17-1 docker compose reads the escaped values literally (Linux with docker)', () => {
  it("the container receives pa$word from 'pa$$word' in the compose and from a single-quoted .env value", () => {
    const { execFileSync } = require('child_process') as typeof import('child_process');
    const dir = fs.mkdtempSync(path.join(tmp, 'cfg-'));
    fs.writeFileSync(path.join(dir, '.env'), "FROM_ENV='pa$word'\n");
    fs.writeFileSync(path.join(dir, 'docker-compose.yml'),
      'services:\n  bot:\n    image: busybox\n    environment:\n      A: pa$$word\n      B: ${FROM_ENV}\n      C: pa$word\n');
    const out = execFileSync('docker', ['compose', '--project-directory', dir, 'run', '--rm', '-T', 'bot', 'printenv', 'A', 'B', 'C'], { encoding: 'utf-8' }) as string;
    // C is the unescaped form: compose reads $word as an unset variable.
    expect(out.split('\n').slice(0, 3)).toEqual(['pa$word', 'pa$word', 'pa']);
  }, 120000);
});

describe('B17-1 build args go to docker build without the compose escape', () => {
  it("a substituted 'ab$$cd' build arg reaches docker build as ab$cd", async () => {
    const { extractComposeBuildArgs } = await import('../../src/templates/compose');
    const c = 'services:\n  bot:\n    build:\n      context: .\n      args:\n        NPM_TOKEN: ab$$cd\n        LEAD: $$x\n        REF: ${UNSET}\n';
    expect(extractComposeBuildArgs(c, 'bot')).toEqual({ NPM_TOKEN: 'ab$cd', LEAD: '$x' });
  });
});

describe('B17-1 substitution writes values compose reads literally', () => {
  it("a repo compose's ${KEY} and $KEY get '$$' for a '$' in the value", async () => {
    const { applyVariableSubstitution } = await import('../../src/templates/variableSubstitution');
    const out = applyVariableSubstitution('a: ${DB_PASSWORD}\nb: postgres://u:$DB_PASSWORD@db\n', { envVars: { DB_PASSWORD: 'pa$word' } } as any);
    expect(out).toBe('a: pa$$word\nb: postgres://u:pa$$word@db\n');
  });
});
