import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseDocument } from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newDeliveryReport, prepareDockerBotFiles } from '../../src/templates/pcsProcessing';

const BODY = '{"token":"x"}\n';

let tmp: string;
let botDir: string;
let logs: string[];
const svcs = (content: string): Record<string, any> => (parseDocument(content).toJSON() as any).services;
const listAll = (dir: string): string[] => {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { recursive: true }).map(String);
};

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'b17-3o-'));
  botDir = path.join(tmp, 'bot');
  logs = [];
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const compose = (...binds: string[]) => ['services:', '  app:', '    image: x', '    volumes:', ...binds.map(b => `      - ${b}`), ''].join('\n');

function build(content: string, hostBotDir = '/host/bot') {
  const report = newDeliveryReport();
  const out = prepareDockerBotFiles(content, botDir, hostBotDir, null, [{ path: '/app/config.json', body: BODY }], (m) => logs.push(m), report);
  return { report, out: svcs(out) };
}

describe('B17-3o docker mode refuses a config bind under a folder the compose already binds', () => {
  const refusedCases: Array<[string, string]> = [
    ['the bot folder itself', '/host/bot:/app/data'],
    ['the bot folder with a trailing slash', '/host/bot/:/app/data'],
    ['a parent of the bot folder', '/host:/app/data'],
    ['the root folder', '/:/hostroot'],
  ];
  for (const [name, bind] of refusedCases) {
    it(`a bind of ${name}: the config is refused, nothing is written and the report names it`, () => {
      const { report, out } = build(compose(bind));
      expect(report.failed).toEqual(['/app/config.json']);
      expect(out.app.volumes.some((v: any) => typeof v === 'object' && v.target === '/app/config.json')).toBe(false);
      expect(listAll(botDir).filter(p => p.includes('.smdb-config'))).toEqual([]);
      expect(logs.some(l => l.includes('/app/config.json') && l.includes('already binds') && l.includes('the whole bot folder'))).toBe(true);
    });
  }

  const unnormalizedCases: Array<[string, string]> = [
    ['a dot (the rewrite of ./.)', '/host/bot/.:/srv'],
    ['an absolute parent with ..', '/host/bot/..:/shared'],
    ['a doubled slash', '/host//bot:/app/data'],
    ['backslashes', '\\host\\bot:/app/data'],
  ];
  for (const [name, bind] of unnormalizedCases) {
    it(`a bind source written with ${name} that covers the bot folder: the config is refused`, () => {
      const { report } = build(compose(bind));
      expect(report.failed).toEqual(['/app/config.json']);
      expect(listAll(botDir).filter(p => p.includes('.smdb-config'))).toEqual([]);
    });
  }

  it('a Windows drive bind with backslashes that covers the bot folder: the config is refused', () => {
    const { report } = build(compose('C:\\dbm\\data:/app/data'), 'C:/dbm/data/bots/b1');
    expect(report.failed).toEqual(['/app/config.json']);
    expect(listAll(botDir).filter(p => p.includes('.smdb-config'))).toEqual([]);
  });

  it('an object bind of the bot folder is refused the same way', () => {
    const { report } = build(compose('type: bind\n        source: /host/bot\n        target: /app/data'));
    expect(report.failed).toEqual(['/app/config.json']);
    expect(listAll(botDir).filter(p => p.includes('.smdb-config'))).toEqual([]);
  });

  it('two services binding the same target from different sources: the one over the config folder still refuses', () => {
    const content = [
      'services:',
      '  app:',
      '    image: x',
      '    volumes:',
      '      - /host/bot/.smdb-config:/data',
      '  side:',
      '    image: y',
      '    volumes:',
      '      - /host/bot/other:/data',
      '',
    ].join('\n');
    const { report } = build(content);
    expect(report.failed).toEqual(['/app/config.json']);
    expect(fs.existsSync(path.join(botDir, '.smdb-config', 'app', 'config.json'))).toBe(false);
    expect(logs.some(l => l.includes('already binds (.smdb-config)'))).toBe(true);
  });

  it('a bind of a sibling folder still lets the config through', () => {
    const { report, out } = build(compose('/host/bot-other:/app/data', '/host/botx/data:/app/more'));
    expect(report.failed).toEqual([]);
    expect(out.app.volumes.some((v: any) => typeof v === 'object' && v.target === '/app/config.json' && v.source === '/host/bot/.smdb-config/app/config.json')).toBe(true);
    expect(fs.readFileSync(path.join(botDir, '.smdb-config', 'app', 'config.json'), 'utf8')).toBe(BODY);
  });

  it('a bind of a folder under the bot folder that does not overlap still lets the config through', () => {
    const { report } = build(compose('/host/bot/data:/app/data'));
    expect(report.failed).toEqual([]);
    expect(fs.readFileSync(path.join(botDir, '.smdb-config', 'app', 'config.json'), 'utf8')).toBe(BODY);
  });
});
