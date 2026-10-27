import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import YAML from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractVariables } from '../../src/templates/variableSubstitution';
import { generateCompose, generateImageCompose } from '../../src/templates/compose';
import { processComposeForCasaOS, composeEnvLiteral } from '../../src/templates/pcsProcessing';

let tmp: string;
let savedDataRoot: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fu-2-'));
  savedDataRoot = process.env.DATA_ROOT;
  process.env.DATA_ROOT = path.join(tmp, 'DATA').replace(/\\/g, '/');
});

afterEach(() => {
  if (savedDataRoot === undefined) delete process.env.DATA_ROOT; else process.env.DATA_ROOT = savedDataRoot;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const NAME = 'Bot $HOME ${TOKEN} $$x';
const ESCAPED = 'Bot $$HOME $${TOKEN} $$$$x';

const bot = (over: Record<string, unknown> = {}): any => ({
  id: 'b1', displayName: NAME, sanitizedName: 'bot1', imageRef: 'example/bot:1',
  envVars: { TOKEN: 's3cret', HOME: '/root' }, ...over,
});

const generated: Array<[string, () => string]> = [
  ['generateImageCompose', () => generateImageCompose(bot(), '/x')],
  ['generateCompose', () => generateCompose(bot(), { type: 'node', databases: [], needsLavalink: false } as any, '/x', 'img')],
];

function expectNameFields(doc: any, withTagline = true): void {
  expect(doc.services.bot.labels['bot-name']).toBe(ESCAPED);
  expect(composeEnvLiteral(doc.services.bot.labels['bot-name'])).toBe(NAME);
  expect(doc['x-casaos'].title.en_us).toBe(ESCAPED);
  if (withTagline) {
    expect(doc['x-casaos'].tagline.en_us).toBe(`Discord Bot: ${ESCAPED}`);
    expect(doc['x-casaos'].description.en_us).toBe(`Managed Discord bot: ${ESCAPED}`);
  }
}

describe('FU-2 T-ENVQl the display name reaches compose as a literal', () => {
  for (const [name, make] of generated) {
    it(`${name}: label, title, tagline and description hold the name with every $ escaped`, () => {
      const out = make();
      expect(out.split('\n').filter(l => l.includes('Bot ')).some(l => l.includes('s3cret') || l.includes('/root'))).toBe(false);
      expectNameFields(YAML.parse(out));
    });

    for (const mode of ['casaos', 'docker'] as const) {
      it(`${name}, ${mode} mode: the deploy processing keeps the escaped label and title`, () => {
        const out = processComposeForCasaOS(make(), 'bot1', bot(), { mode, hostBotDir: '/srv/b1' }).content;
        const doc = YAML.parse(out);
        expect(doc.services.bot.labels['bot-name']).toBe(ESCAPED);
        if (mode === 'casaos') expect(doc['x-casaos'].title.en_us).toBe(ESCAPED);
      });
    }
  }

  it('casaos mode: a repo compose with no x-casaos gets the escaped name in label, title and tagline', () => {
    const repo = 'services:\n  bot:\n    image: example/bot:1\n    ports:\n      - "3000:3000"\n';
    const doc = YAML.parse(processComposeForCasaOS(repo, 'bot1', bot(), { mode: 'casaos' }).content);
    expectNameFields(doc);
  });

  it('casaos mode: a repo x-casaos with no title gets the escaped name as title', () => {
    const repo = 'services:\n  bot:\n    image: example/bot:1\n    ports:\n      - "3000:3000"\nx-casaos:\n  main: bot\n';
    const doc = YAML.parse(processComposeForCasaOS(repo, 'bot1', bot(), { mode: 'casaos' }).content);
    expect(doc['x-casaos'].title.en_us).toBe(ESCAPED);
  });
});

describe('FU-2 T-ENVQu the update token reaches compose as a literal', () => {
  it('generateImageCompose writes BOT_MANAGER_UPDATE_TOKEN with $ escaped', () => {
    const doc = YAML.parse(generateImageCompose(bot({ displayName: 'b', envVars: {}, updateToken: 'tok$HOME${TOKEN}' }), '/x'));
    expect(doc.services.bot.environment.BOT_MANAGER_UPDATE_TOKEN).toBe('tok$$HOME$${TOKEN}');
    expect(composeEnvLiteral(doc.services.bot.environment.BOT_MANAGER_UPDATE_TOKEN)).toBe('tok$HOME${TOKEN}');
  });
});

describe('FU-2 T-ENVQx extractVariables agrees with the substitution on $$', () => {
  it('$$TOKEN and $${TOKEN} report nothing', () => {
    expect(extractVariables('a: $$TOKEN\nb: $${TOKEN}\nc: x$$$$TOKEN\n')).toEqual([]);
  });

  it('a name after an escaped $ is still reported, and plain names are', () => {
    expect(extractVariables('a: $$$TOKEN\nb: ${ONE}\nc: $TWO\nd: $$\n')).toEqual(['ONE', 'TOKEN', 'TWO']);
  });
});
