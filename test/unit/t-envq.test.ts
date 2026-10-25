import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import YAML from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyVariableSubstitution } from '../../src/templates/variableSubstitution';
import { generateCompose, generateImageCompose } from '../../src/templates/compose';
import { processComposeForCasaOS, composeEnvLiteral } from '../../src/templates/pcsProcessing';

let tmp: string;
let savedDataRoot: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 't-envq-'));
  savedDataRoot = process.env.DATA_ROOT;
  process.env.DATA_ROOT = path.join(tmp, 'DATA').replace(/\\/g, '/');
});

afterEach(() => {
  if (savedDataRoot === undefined) delete process.env.DATA_ROOT; else process.env.DATA_ROOT = savedDataRoot;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('T-ENVQ substitution is one pass over the original text', () => {
  it("a repo's $$TOKEN and $${TOKEN} stay literal when TOKEN is a key", () => {
    const text = 'a: $$TOKEN\nb: $${TOKEN}\nc: x$$$$TOKEN\n';
    expect(applyVariableSubstitution(text, { envVars: { TOKEN: 'secret' } } as any)).toBe(text);
  });

  it("a value 'pa$OTHER' does not take OTHER's value", () => {
    const bot = { envVars: { A_PASS: 'pa$OTHER', OTHER: 'zz' } } as any;
    expect(applyVariableSubstitution('a: ${A_PASS}\nb: $A_PASS\nc: $OTHER\n', bot)).toBe('a: pa$$OTHER\nb: pa$$OTHER\nc: zz\n');
  });

  it("a value '${OTHER}' is not scanned again", () => {
    const bot = { envVars: { A_PASS: '${OTHER}', OTHER: 'zz' } } as any;
    expect(applyVariableSubstitution('a: ${A_PASS}\n', bot)).toBe('a: $${OTHER}\n');
  });

  it('a name that is not a key, a default form and an inherited property name stay as written', () => {
    const text = 'a: ${NOT_A_KEY}\nb: $NOT_A_KEY\nc: ${TOKEN:-x}\nd: ${constructor}\ne: $toString\nf: $TOKENX\n';
    expect(applyVariableSubstitution(text, { envVars: { TOKEN: 'secret' } } as any)).toBe(text);
  });

  it('a $ followed by no name is copied through', () => {
    const text = 'a: 5$ and $ and ${ and $}\n';
    expect(applyVariableSubstitution(text, { envVars: { TOKEN: 'secret' } } as any)).toBe(text);
  });
});

const VALUES: Record<string, string> = {
  BACKSLASH_N: 'a\\nb',
  WIN_PATH: 'C:\\temp',
  NEWLINE: 'line1\nline2',
  CRLF: 'line1\r\nline2',
  TAB: 'a\tb',
  QUOTES: `say "hi" and 'bye'`,
  HASH_COLON: 'x # not a comment: ok',
  SPACES: '  lead and trail  ',
  EMPTY: '',
  ZERO_LEAD: '0123',
  BOOLISH: 'true',
  NULLISH: 'null',
  TILDE: '~',
  DOLLAR: 'pa$word',
  BRACES: '{a: [1, 2]}',
  AMP_STAR: '&anchor *alias !tag |>',
  UNICODE: 'caf\u00e9 \u2028 \u0085 \u007f end',
};

const bot = (over: Record<string, unknown> = {}): any => ({
  id: 'b1', displayName: 'Bot "one" \\ C:\\x # y', sanitizedName: 'bot1', imageRef: 'example/bot:1', envVars: { ...VALUES }, ...over,
});

const generated: Array<[string, () => string]> = [
  ['generateImageCompose', () => generateImageCompose(bot(), '/x')],
  ['generateCompose', () => generateCompose(bot(), { type: 'node', databases: [], needsLavalink: false } as any, '/x', 'img')],
];

describe('T-ENVQ the generated compose holds each env value byte for byte', () => {
  for (const [name, make] of generated) {
    it(`${name}: every env value parses back to what compose delivers as the input`, () => {
      const env = YAML.parse(make()).services.bot.environment;
      for (const [k, v] of Object.entries(VALUES)) {
        expect(typeof env[k], k).toBe('string');
        expect(composeEnvLiteral(env[k]), k).toBe(v);
      }
    });

    it(`${name}: the label and title keep the display name`, () => {
      const doc = YAML.parse(make());
      expect(doc.services.bot.labels['bot-name']).toBe(bot().displayName);
      expect(doc['x-casaos'].title.en_us).toBe(bot().displayName);
    });

    for (const mode of ['casaos', 'docker'] as const) {
      it(`${name}, ${mode} mode: the values survive the deploy processing`, () => {
        const out = processComposeForCasaOS(make(), 'bot1', bot(), { mode, hostBotDir: '/srv/b1' }).content;
        const env = YAML.parse(out).services.bot.environment;
        for (const [k, v] of Object.entries(VALUES)) {
          expect(composeEnvLiteral(env[k]), k).toBe(v);
        }
      });
    }
  }
});

describe('T-ENVQ values the deploy processing does not rewrite keep their bytes', () => {
  const pw = 'C:\t"e\nmp #x $y';
  const detect = { type: 'node', databases: ['postgres', 'redis'], needsLavalink: false } as any;

  for (const mode of ['casaos', 'docker'] as const) {
    it(`${mode} mode: a backing service password and its command reach the services unchanged`, () => {
      const out = processComposeForCasaOS(generateCompose(bot({ envVars: {} }), detect, '/x', 'img', { postgres: pw, redis: pw }), 'bot1', bot({ envVars: {} }), { mode, hostBotDir: '/srv/b1' }).content;
      const doc = YAML.parse(out);
      expect(composeEnvLiteral(doc.services.postgres.environment.POSTGRES_PASSWORD)).toBe(pw);
      expect(composeEnvLiteral(doc.services.redis.command[2])).toBe(pw);
    });
  }
});
