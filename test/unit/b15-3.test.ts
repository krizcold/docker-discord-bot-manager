import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import YAML from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { substituteComposeNames } from '../../src/compose/nameSubstitution';
import { generateCompose, generateImageCompose } from '../../src/templates/compose';
import { buildSubstitutionVariables, applyVariableSubstitution } from '../../src/templates/variableSubstitution';
import { validateName, makeUniqueName, checkFolderReuse } from '../../src/naming';

// The substitution answers a string before this job and an object after it.
const substitute = (compose: string, from: string, to: string): { content: string; notes: string[] } => {
  const out: any = (substituteComposeNames as any)(compose, from, to);
  return typeof out === 'string' ? { content: out, notes: [] } : out;
};

const bot = (over: Record<string, unknown> = {}): any => ({
  id: 'b1', displayName: 'My Bot', sanitizedName: 'mybot', titleName: 'My Bot', envVars: {}, ...over,
});

describe('R2-19: the name substitution is applied or the build is refused', () => {
  it('a compose the parser rejects throws, naming the error, instead of keeping the original names', () => {
    const compose = 'name: coolbot\nservices:\n  coolbot:\n    image: x\n---\n';
    expect(() => substitute(compose, 'coolbot', 'second')).toThrow(/cannot be parsed.*coolbot/);
  });

  it('a duplicate key throws too', () => {
    const compose = 'name: coolbot\nservices:\n  coolbot:\n    image: x\n    image: y\n';
    expect(() => substitute(compose, 'coolbot', 'second')).toThrow(/cannot be parsed/);
  });
});

describe('R10-5 and the carried note: the substitution keeps paths and references consistent', () => {
  const compose = [
    'name: coolbot',
    'services:',
    '  app:',
    '    image: x',
    '    working_dir: /coolbot',
    '    command: ["node", "/coolbot/index.js"]',
    '    environment:',
    '      CONFIG_DIR: /coolbot/config',
    '    volumes:',
    '      - ./config:/coolbot/config',
    '      - coolbot-db:/var/lib/db',
    '      - type: volume',
    '        source: coolbot-cache',
    '        target: /coolbot/cache',
    '    networks: [coolbot-ext]',
    'volumes:',
    '  coolbot-db: {}',
    '  coolbot-cache: {}',
    'networks:',
    '  coolbot-ext:',
    '    external: true',
    '',
  ].join('\n');

  it('a container path renamed in env is renamed in the bind target, working_dir and command', () => {
    const doc = YAML.parse(substitute(compose, 'coolbot', 'second').content);
    const app = doc.services.app;
    expect(app.environment.CONFIG_DIR).toBe('/second/config');
    expect(app.volumes[0]).toBe('./config:/second/config');
    expect(app.working_dir).toBe('/second');
    expect(app.command).toEqual(['node', '/second/index.js']);
    expect(app.volumes[2].target).toBe('/second/cache');
  });

  it('a renamed volume key is renamed where services use it', () => {
    const doc = YAML.parse(substitute(compose, 'coolbot', 'second').content);
    expect(Object.keys(doc.volumes)).toEqual(['second-db', 'second-cache']);
    expect(doc.services.app.volumes[1]).toBe('second-db:/var/lib/db');
    expect(doc.services.app.volumes[2].source).toBe('second-cache');
  });

  it('an external network keeps the docker network it names', () => {
    const doc = YAML.parse(substitute(compose, 'coolbot', 'second').content);
    expect(doc.networks['second-ext']).toEqual({ external: true, name: 'coolbot-ext' });
    expect(doc.services.app.networks).toEqual(['second-ext']);
  });

  it('each env value it changed is named for the build log', () => {
    const { notes } = substitute(compose, 'coolbot', 'second');
    expect(notes.some((n) => n.includes('CONFIG_DIR'))).toBe(true);
  });
});

describe('R9-21: both generators write the instance name as the compose name', () => {
  it('generateCompose', () => {
    const doc = YAML.parse(generateCompose(bot(), { type: 'node', databases: [], needsLavalink: false } as any, '/tmp/x', 'img'));
    expect(doc.name).toBe('mybot');
  });

  it('generateImageCompose', () => {
    const doc = YAML.parse(generateImageCompose(bot({ imageRef: 'repo/img:1' }), '/tmp/x'));
    expect(doc.name).toBe('mybot');
  });
});

describe('R10-4: $AppID is the instance name, as CasaOS means it', () => {
  it('AppID resolves to the sanitized name and APP_ID keeps the instance id', () => {
    const vars = buildSubstitutionVariables(bot());
    expect(vars.AppID).toBe('mybot');
    expect(vars.APP_ID).toBe('bot-b1');
    expect(applyVariableSubstitution('- /DATA/AppData/$AppID/data:/data\n- /DATA/AppData/${AppID}/x:/x\n', bot()))
      .toBe('- /DATA/AppData/mybot/data:/data\n- /DATA/AppData/mybot/x:/x\n');
  });
});

describe('R9-19 and R9-20: a name is checked against docker projects and kept folders', () => {
  let root: string;
  const prev = process.env.DATA_ROOT;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'b15-3-'));
    process.env.DATA_ROOT = root;
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.DATA_ROOT; else process.env.DATA_ROOT = prev;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const keep = (name: string, marker: Record<string, unknown>): void => {
    fs.mkdirSync(path.join(root, 'AppData', name), { recursive: true });
    fs.writeFileSync(path.join(root, 'AppData', name, '.botmanager'), JSON.stringify(marker));
  };
  const v = validateName as any;
  const u = makeUniqueName as any;

  it('a name docker shows as a foreign project is refused, naming its containers', () => {
    const foreignProjects = new Map([['coolbot', ['coolbot-db-1']]]);
    const out = v('Cool Bot', [], undefined, { foreignProjects });
    expect(out.valid).toBe(false);
    expect(out.errors.join(' ')).toMatch(/docker project named "coolbot".*coolbot-db-1/);
    expect(u('Cool Bot', [], undefined, { foreignProjects })).toBe('Cool Bot 2');
  });

  it('a folder kept from another source is refused, naming the folder and its source', () => {
    keep('coolbot', { instanceId: 'old', sourceUrl: 'https://example.com/a.git', sourceType: 'git' });
    const out = v('Cool Bot', [], undefined, { source: { sourceUrl: 'https://example.com/b.git', sourceType: 'git' } });
    expect(out.valid).toBe(false);
    expect(out.errors.join(' ')).toMatch(/AppData\/coolbot.*https:\/\/example\.com\/a\.git/);
  });

  it('a folder kept from the same source stays reusable', () => {
    keep('coolbot', { instanceId: 'old', sourceUrl: 'https://example.com/a.git', sourceType: 'git' });
    const out = v('Cool Bot', [], undefined, { source: { sourceUrl: 'https://example.com/a.git', sourceType: 'git' } });
    expect(out.valid).toBe(true);
  });

  it('a folder whose marker cannot be read is refused when a source is given', () => {
    fs.mkdirSync(path.join(root, 'AppData', 'coolbot'), { recursive: true });
    fs.writeFileSync(path.join(root, 'AppData', 'coolbot', '.botmanager'), '{torn');
    const out = v('Cool Bot', [], undefined, { source: { sourceUrl: 'https://example.com/a.git', sourceType: 'git' } });
    expect(out.valid).toBe(false);
  });

  it('the reuse check reports the kept source and whether it matches', () => {
    keep('coolbot', { instanceId: 'old', sourceUrl: 'https://example.com/a.git', sourceType: 'git' });
    const out: any = (checkFolderReuse as any)('coolbot', [], { sourceUrl: 'https://example.com/b.git', sourceType: 'git' });
    expect(out.reuseAvailable).toBe(true);
    expect(out.sourceMatches).toBe(false);
    expect(out.keptSource).toBe('https://example.com/a.git');
  });
});
