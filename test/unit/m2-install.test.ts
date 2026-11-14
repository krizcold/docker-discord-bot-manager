import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import * as ink from 'ink';
import { render } from 'ink-testing-library';
import { createApp } from '../../src/cli/tui/app';
import { Session } from '../../src/cli/tui/session';
import {
  botList, configSaved, created, envSaved, envVar, fake, Fake, freshSource, gitSource, imageSource, NAME_PATH, nameOk, noAnswer,
  notClonedEnvs, ok, RECOVER_PATH, refused, repoEnvs, sourceList,
} from './m2-fake';

const App = createApp(ink);
// Each row types key by key with a 30 ms pause; the longest take about 5 s beside other files.
vi.setConfig({ testTimeout: 20_000 });
const UP = '\u001B[A';
const DOWN = '\u001B[B';
const LEFT = '\u001B[D';
const ESC = '\u001B';
const ENTER = '\r';
const TAB = '\t';
const BACKSPACE = '\u007F';
const DEL = '\u001B[3~';
const CTRL = (c: string) => String.fromCharCode(c.charCodeAt(0) - 96);
const SECRET = 'a1'.repeat(32);

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

async function start(f: Fake) {
  const session = new Session(f.client, () => 0);
  await session.refresh();
  const view = render(createElement(App, {
    machine: 'box1', session, onHandOff: vi.fn(), now: () => 0, wizardOptions: { pollMs: 5, pollTries: 3, secret: () => SECRET },
  }));
  await tick();
  const frame = () => view.lastFrame() ?? '';
  const press = async (...keys: string[]) => {
    for (const k of keys) {
      view.stdin.write(k);
      await tick();
    }
  };
  const until = async (text: string) => {
    for (let i = 0; i < 100 && !flat(frame()).includes(text); i++) await tick(20);
    expect(flat(frame())).toContain(text);
  };
  const type = async (text: string) => {
    for (const ch of text) await press(ch);
  };
  return { ...view, session, frame, press, until, type };
}

const keyBar = (frame: string) => frame.split('\n').at(-2) ?? '';
// The frame's lines joined with one space, so a text wrapped at a space reads whole.
const flat = (frame: string) => frame.split('\n').map((l) => l.replace(/^\| /, '').replace(/\s*\|$/, '').trim()).join(' ').replace(/\s+/g, ' ');
const noticeLine = (frame: string) => (frame.split('\n').at(-3) ?? '').replace(/^\| /, '').replace(/\s*\|$/, '');

function base(): Fake {
  return fake()
    .on('GET', '/api/bots', botList([]))
    .on('GET', '/api/sources', sourceList([gitSource(), freshSource(), imageSource()]))
    .on('GET', '/api/sources/s1/envs', repoEnvs())
    .on('GET', NAME_PATH('coolbot'), nameOk('coolbot'));
}

async function openForm(f: Fake) {
  const v = await start(f);
  await v.press('i');
  await v.until('coolbot');
  await v.press(ENTER);
  await v.until('Install from Source: coolbot');
  await v.until('Compose name: coolbot');
  return v;
}

// From the name field: the token's key and value, the client id's key and value, the config file's line, path,
// Writable and body, Add config file, Install.
const TO_INSTALL = Array(10).fill(TAB) as string[];

describe('m2 sources screen', () => {
  it('I opens Install from the bot list, the bar shows it, and Esc comes back', async () => {
    const v = await start(base());
    expect(keyBar(v.frame())).toMatch(/^\| I Install {2}V Vault {2}Q Quit\s+\|$/);
    await v.press('i');
    await v.until('Sources');
    const f = v.frame();
    expect(f).toMatch(/> coolbot\s+main/);
    expect(f).toMatch(/otherbot\s+main, not cloned/);
    expect(f).toMatch(/ghcr.io\/acme\/imgbot:1\s+image ghcr.io\/acme\/imgbot:1/);
    expect(keyBar(f)).toContain('Enter Install  A Add  F Fetch');
    await v.press(ESC);
    await v.until('No bots on this manager.');
    v.unmount();
  });

  it('does not offer Install while the bot list read fails', async () => {
    const f = base().on('GET', '/api/bots', noAnswer());
    const v = await start(f);
    expect(v.frame()).toContain("can't read the bot list");
    expect(keyBar(v.frame())).not.toContain('Install');
    await v.press('i');
    expect(f.paths()).not.toContain('GET /api/sources');
    v.unmount();
  });

  it('says when the source list cannot be read: the route refused or did not answer', async () => {
    const f = base().on('GET', '/api/sources', refused(503, { success: false, broken: true, error: 'sources.json cannot be read' }));
    const v = await start(f);
    await v.press('i');
    await v.until("can't read the sources: sources.json cannot be read");
    f.on('GET', '/api/sources', noAnswer());
    await v.press('r');
    await v.until("can't read the sources: connect ECONNREFUSED");
    v.unmount();
  });

  it('adds a source with the body of dbm sources add and lists it', async () => {
    const f = base();
    f.on('POST', '/api/sources', () => {
      f.on('GET', '/api/sources', sourceList([gitSource(), gitSource({ id: 's4', url: 'https://github.com/acme/newbot' })]));
      return ok({ success: true, source: gitSource({ id: 's4', url: 'https://github.com/acme/newbot' }) });
    });
    const v = await start(f);
    await v.press('i');
    await v.until('Sources');
    await v.press('a');
    await v.until('Add a source');
    await v.press('https://github.com/acme/newbot');
    await v.press(ENTER);
    await v.until('Source added.');
    expect(f.calls.find((c) => c.method === 'POST')!.body).toEqual({ url: 'https://github.com/acme/newbot', branch: 'main' });
    expect(v.frame()).toContain('newbot');
    v.unmount();
  });

  it("gives the route's refusal, refuses a blank URL, and after a lost answer watches the list", async () => {
    const f = base().on('POST', '/api/sources', refused(409, { success: false, error: 'A source with this URL already exists' }));
    const v = await start(f);
    await v.press('i');
    await v.until('Sources');
    await v.press('a', ENTER);
    expect(noticeLine(v.frame())).toBe('URL is required.');
    expect(f.paths()).not.toContain('POST /api/sources');
    await v.press('https://github.com/acme/coolbot.git', ENTER);
    await v.until('Could not add the source: A source with this URL already exists');

    f.on('POST', '/api/sources', noAnswer());
    await v.press(BACKSPACE, BACKSPACE, BACKSPACE, BACKSPACE, 'x', ENTER);
    await v.until("can't confirm the source was added: the manager did not answer (connect ECONNREFUSED 127.0.0.1:8080)");
    expect(f.paths().filter((p) => p === 'GET /api/sources').length).toBeGreaterThanOrEqual(4);

    f.on('POST', '/api/sources', () => {
      f.on('GET', '/api/sources', sourceList([gitSource(), gitSource({ id: 's5', url: 'https://github.com/acme/coolbotx' })]));
      return noAnswer();
    });
    await v.press(ENTER);
    await v.until('Source added.');
    v.unmount();
  });

  it('fetches the picked source and says what the route answered, refused or that it did not answer', async () => {
    const f = base().on('POST', '/api/sources/s1/fetch', ok({ success: true, hasUpdates: true, newCommit: 'f00' }));
    const v = await start(f);
    await v.press('i');
    await v.until('Sources');
    await v.press('f');
    await v.until('coolbot: source updated with new commits.');
    f.on('POST', '/api/sources/s1/fetch', refused(500, { success: false, error: 'Error: git fetch failed' }));
    await v.press('f');
    await v.until('Could not fetch coolbot: Error: git fetch failed');
    f.on('POST', '/api/sources/s1/fetch', noAnswer());
    await v.press('f');
    await v.until('No answer from the manager; the fetch of coolbot may still be running');
    v.unmount();
  });
});

describe('m2 source details', () => {
  it('clones a source that is not cloned before reading its details, and says when the clone fails or gets no answer', async () => {
    const f = base()
      .on('POST', '/api/sources/s2/fetch', refused(500, { success: false, error: 'Error: repository not found' }))
      .on('GET', '/api/sources/s2/envs', repoEnvs())
      .on('GET', NAME_PATH('otherbot', 's2'), nameOk('otherbot'));
    const v = await start(f);
    await v.press('i');
    await v.until('Sources');
    await v.press(DOWN, ENTER);
    await v.until('Could not clone otherbot: Error: repository not found');
    expect(f.paths()).not.toContain('GET /api/sources/s2/envs');
    f.on('POST', '/api/sources/s2/fetch', noAnswer());
    await v.press(ENTER);
    await v.until('No answer from the manager; the clone of otherbot may still be running');
    f.on('POST', '/api/sources/s2/fetch', ok({ success: true, hasUpdates: true }));
    await v.press(ENTER);
    await v.until('Install from Source: otherbot');
    const order = f.paths().filter((p) => p.includes('/s2/'));
    expect(order.slice(-2)).toEqual(['POST /api/sources/s2/fetch', 'GET /api/sources/s2/envs']);
    v.unmount();
  });

  it("shows the detect error with the route's text, retries, and continues manually with the page's token row", async () => {
    const f = base().on('GET', '/api/sources/s1/envs', notClonedEnvs());
    const v = await start(f);
    await v.press('i');
    await v.until('Sources');
    await v.press(ENTER);
    await v.until("Could not read this source's variables and config files:");
    expect(v.frame()).toContain('the last clone failed (exit 128)');
    expect(keyBar(v.frame())).toContain('R Retry  C Continue manually  Esc Back');
    expect(f.paths()).not.toContain(`GET ${NAME_PATH('coolbot')}`);
    await v.press('r');
    await tick(60);
    expect(f.paths().filter((p) => p === 'GET /api/sources/s1/envs').length).toBe(2);
    await v.press('c');
    await v.until('Install from Source: coolbot');
    expect(v.frame()).toContain('Discord Bot Token (required)');
    expect(v.frame()).toMatch(/\[DISCORD_TOKEN\s*\]/);
    await v.until('Compose name: coolbot');
    v.unmount();
  });

  it('says the source could not be reached when the details read gets no answer, and an image source shows the inspect note', async () => {
    const f = base()
      .on('GET', '/api/sources/s1/envs', noAnswer())
      .on('GET', '/api/sources/s3/envs', noAnswer())
      .on('GET', NAME_PATH('My Bot', 's3'), nameOk('My Bot'));
    const v = await start(f);
    await v.press('i');
    await v.until('Sources');
    await v.press(ENTER);
    await v.until('the source could not be reached (connect ECONNREFUSED 127.0.0.1:8080)');
    await v.press(ESC);
    await v.until('Sources');
    await v.press(DOWN, DOWN, ENTER);
    await v.until('the source could not be reached');
    await v.press('c');
    await v.until('Prebuilt image: add the environment variables');
    expect(v.frame()).not.toContain('DISCORD_TOKEN');
    expect(v.frame()).toMatch(/Name\s+\[My Bot/);
    v.unmount();
  });
});

describe('m2 interactive setup', () => {
  it("shows the route's interactive-setup reason and advice above the form", async () => {
    const f = base().on('GET', '/api/sources/s1/envs', repoEnvs({
      // detectManualSetup's answer (src/detection/index.ts:686).
      interactiveSetup: {
        reason: 'This bot is configured by a file rather than environment variables, so it may need a complete config (or a manual first-run step) to start.',
        advice: "Fill in the Config Files section below with a complete config. If it needs an interactive setup, run it from the Console after installing, or add the project's prebuilt Docker image as a Docker-image source.",
      },
    }));
    const v = await openForm(f);
    expect(flat(v.frame())).toContain('Heads up: This bot is configured by a file rather than environment variables, so it may need a complete config (or a manual first-run step) to start. Fill in the Config Files');
    v.unmount();
  });
});

describe('m2 name check', () => {
  it('checks the default name on open and a typed name only when the cursor leaves the field', async () => {
    const f = base().on('GET', NAME_PATH('coolbot2'), nameOk('coolbot2'));
    const v = await openForm(f);
    expect(f.paths()).toContain(`GET ${NAME_PATH('coolbot')}`);
    await v.type('2');
    expect(v.frame()).toContain('Compose name: coolbot2');
    expect(f.paths()).not.toContain(`GET ${NAME_PATH('coolbot2')}`);
    await v.press(TAB);
    await tick(60);
    expect(f.paths()).toContain(`GET ${NAME_PATH('coolbot2')}`);
    await v.press(UP, TAB);
    expect(f.paths().filter((p) => p === `GET ${NAME_PATH('coolbot2')}`).length).toBe(1);
    v.unmount();
  });

  it('shows each answer: adjusted, refused names, an error body and no answer', async () => {
    const f = base()
      .on('GET', NAME_PATH('coolbot'), nameOk('coolbot 2', { sanitizedName: 'coolbot2', adjusted: true, conflicts: ['A bot named coolbot already exists'], requestedName: 'coolbot' }))
      .on('GET', NAME_PATH('manager'), ok({ valid: false, errors: ['"manager" is a reserved name'] }))
      .on('GET', NAME_PATH('x'), refused(500, { success: false, error: 'Error: instances.json cannot be read' }))
      .on('GET', NAME_PATH('y'), noAnswer());
    const v = await openForm(f);
    await v.until('Compose name: coolbot2 (saved as "coolbot 2": A bot named coolbot already exists)');
    const rename = async (name: string) => {
      await v.press(UP, UP, UP, UP, UP, UP, UP, UP);
      await v.press(...Array(10).fill(BACKSPACE));
      await v.press(name, TAB);
      await tick(60);
    };
    await rename('manager');
    await v.until('"manager" is a reserved name');
    expect(v.frame()).not.toContain('Compose name: manager');
    await rename('x');
    await v.until("can't check the name: Error: instances.json cannot be read");
    await rename('y');
    await v.until("can't check the name: the manager did not answer (connect ECONNREFUSED 127.0.0.1:8080).");
    v.unmount();
  }, 20000);

  it('turns the template files off over a kept data folder and loads the earlier envs, masked when sensitive', async () => {
    const f = base()
      .on('GET', NAME_PATH('coolbot'), nameOk('coolbot', { reuseAvailable: true, keptSource: 'acme/coolbot', envsAvailable: true }))
      .on('GET', RECOVER_PATH('coolbot'), ok({
        success: true, name: 'coolbot', sources: { vault: 2, compose: 0 }, vaultBroken: false,
        envs: [
          { key: 'DISCORD_TOKEN', value: 'Recovered.Token.Value', sensitive: true, source: 'vault' },
          { key: 'PREFIX', value: '?', sensitive: false, source: 'vault' },
        ],
      }));
    const v = await openForm(f);
    await v.until('A data folder kept from an earlier install of acme/coolbot exists under this name');
    expect(keyBar(v.frame())).toContain('Ctrl+L Load envs');
    await v.press(CTRL('l'));
    await v.until('Loaded 2 env(s) into the form (2 from vault). Review before saving.');
    expect(v.frame()).toMatch(/\[PREFIX\s*\] \[\?/);
    expect(v.frames.join('\n')).not.toContain('Recovered.Token.Value');
    await v.press(...Array(7).fill(TAB));
    expect(v.frame()).toContain('[ ] /app/config.json');
    expect(flat(v.frame())).toContain('A data folder kept under this name may hold edited copies of these files, so they start off');
    await v.press(' ');
    expect(v.frame()).toContain('[x] /app/config.json');
    v.unmount();
  });
});

describe('m2 env rows', () => {
  it('edits, adds and removes rows as the page does', async () => {
    const f = base();
    const v = await openForm(f);
    await v.press(TAB, TAB, TAB, TAB);
    await v.type('1234');
    await v.press(LEFT, LEFT, BACKSPACE, DEL);
    expect(v.frame()).toMatch(/\[CLIENT_ID\s*\] \[14 /);
    await v.press(CTRL('n'));
    await v.press('EXTRA', TAB, 'v1');
    expect(v.frame()).toMatch(/\[EXTRA\s*\] \[v1/);
    await v.press(CTRL('d'));
    expect(v.frame()).not.toContain('EXTRA');
    expect(v.frame()).toContain('Auto-configured');
    v.unmount();
  });

  it('never shows a hidden value: the typed token, the default the route sends, or a generated secret', async () => {
    const f = base().on('GET', '/api/sources/s1/envs', repoEnvs({
      vars: [
        envVar({ key: 'DISCORD_TOKEN', displayLabel: 'Discord Bot Token', required: true, sensitive: true, defaultValue: 'example-default-token' }),
        envVar({ key: 'WEBUI_PASSWORD', displayLabel: 'Web UI Password', sensitive: true, generate: true }),
      ],
    }));
    const v = await openForm(f);
    await v.press(TAB, TAB);
    await v.type('S3cret');
    await v.press('Value.Pasted');
    await v.press(TAB, TAB, CTRL('g'));
    const all = v.frames.join('\n');
    expect(all).not.toContain('S3cret');
    expect(all).not.toContain('Pasted');
    expect(all).not.toContain('example-default-token');
    expect(all).not.toContain(SECRET);
    expect(v.frame()).toMatch(/\[DISCORD_TOKEN\s*\] \[\*{18}/);
    v.unmount();
  });

  it('scans the source for more variables and says when the scan fails', async () => {
    const f = base().on('GET', '/api/sources/s1/envs?scan=true', repoEnvs({
      vars: [envVar({ key: 'CLIENT_ID' }), envVar({ key: 'OWNER_ID', defaultValue: '42', source: 'source-scan' })],
      sourceScan: { scanned: 200, total: 250 },
    }));
    const v = await openForm(f);
    await v.press(TAB, CTRL('f'));
    await v.until('Found 1 additional variable(s). Scanned 200 of 250 source files');
    expect(v.frame()).toMatch(/\[OWNER_ID\s*\] \[42/);
    f.on('GET', '/api/sources/s1/envs?scan=true', noAnswer());
    await v.press(CTRL('f'));
    await v.until('Scan failed: the manager did not answer');
    v.unmount();
  });
});

describe('m2 install', () => {
  function installRoutes(f: Fake) {
    return f.on('POST', '/api/bots', created()).on('PUT', '/api/bots/b9/env', envSaved()).on('PUT', '/api/bots/b9/config', configSaved());
  }

  it("makes doInstall's calls in its order with its bodies, and only then says the bot was created", async () => {
    const f = installRoutes(base());
    const v = await openForm(f);
    await v.press(TAB, TAB, 'tok.en', TAB, TAB, '1234');
    await v.press(...TO_INSTALL);
    expect(keyBar(v.frame())).toContain('Enter Install');
    await v.press(ENTER);
    await v.until('Bot instance coolbot (b9) created. Open it in the bot list and press S to install and run it.');
    const writes = f.calls.filter((c) => c.method !== 'GET');
    expect(writes.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /api/bots', 'PUT /api/bots/b9/env', 'PUT /api/bots/b9/config']);
    expect(writes[0].body).toEqual({ sourceId: 's1', displayName: 'coolbot' });
    expect(writes[1].body).toEqual({ vars: { DISCORD_TOKEN: 'tok.en', CLIENT_ID: '1234' } });
    expect(writes[2].body).toEqual({ files: [{ path: '/app/config.json', body: '{\n  "prefix": "!"\n}\n', enabled: true }] });
    expect(v.frame()).toContain('I Install');
    v.unmount();
  });

  it('leaves a blank secret out and skips the env call when no value is set', async () => {
    const f = installRoutes(base());
    const v = await openForm(f);
    await v.press(...TO_INSTALL, ENTER);
    await v.until('Bot instance coolbot (b9) created.');
    expect(f.paths().filter((p) => !p.startsWith('GET'))).toEqual(['POST /api/bots', 'PUT /api/bots/b9/config']);
    v.unmount();
  });

  const failures: Array<[string, (f: Fake) => void, string]> = [
    ['create refused', (f) => f.on('POST', '/api/bots', refused(500, { success: false, error: 'Error: the source is not cloned' })), 'Could not create the bot: Error: the source is not cloned. Nothing was created.'],
    ['create without answer', (f) => f.on('POST', '/api/bots', noAnswer()), "can't confirm the bot was created: the manager did not answer (connect ECONNREFUSED 127.0.0.1:8080). Check the bot list before trying again."],
    ['env refused', (f) => f.on('PUT', '/api/bots/b9/env', refused(409, { success: false, error: 'Bot operation in progress (build); nothing was saved, retry when it completes' })), 'The bot coolbot (b9) was created; its environment variables were not saved: Bot operation in progress (build); nothing was saved, retry when it completes.'],
    ['env without answer', (f) => f.on('PUT', '/api/bots/b9/env', noAnswer()), "The bot coolbot (b9) was created, but can't confirm its environment variables were saved: the manager did not answer (connect ECONNREFUSED 127.0.0.1:8080)."],
    ['config refused', (f) => f.on('PUT', '/api/bots/b9/config', refused(409, { success: false, error: 'mybot is migrating its data; files cannot change until it ends' })), 'The bot coolbot (b9) was created; its config files were not saved: mybot is migrating its data; files cannot change until it ends.'],
    ['config without answer', (f) => f.on('PUT', '/api/bots/b9/config', noAnswer()), "The bot coolbot (b9) was created, but can't confirm its config files were saved: the manager did not answer (connect ECONNREFUSED 127.0.0.1:8080)."],
  ];

  for (const [name, breakIt, text] of failures) {
    it(`names what was done when the install stops: ${name}`, async () => {
      const f = installRoutes(base());
      breakIt(f);
      const v = await openForm(f);
      await v.press(TAB, TAB, 'tok', ...TO_INSTALL.slice(2), ENTER);
      await v.until(text);
      expect(v.frames.map(flat).join(' ')).not.toContain('Bot instance coolbot (b9) created');
      expect(keyBar(v.frame())).toContain('Enter Install');
      await v.press(...Array(12).fill(UP));
      expect(v.frame()).toMatch(/Name\s+\[coolbot/);
      v.unmount();
    });
  }

  it('retries after a failed env save without creating a second bot', async () => {
    const f = installRoutes(base()).on('PUT', '/api/bots/b9/env', refused(500, { success: false, error: 'Error: EACCES' }));
    const v = await openForm(f);
    await v.press(TAB, TAB, 'tok', ...TO_INSTALL.slice(2), ENTER);
    await v.until('its environment variables were not saved: Error: EACCES');
    f.on('PUT', '/api/bots/b9/env', envSaved());
    await v.press(ENTER);
    await v.until('Bot instance coolbot (b9) created.');
    expect(f.paths().filter((p) => p === 'POST /api/bots').length).toBe(1);
    expect(f.paths().filter((p) => p === 'PUT /api/bots/b9/env').length).toBe(2);
    v.unmount();
  });

  it("refuses an empty name and a bad number with the page's text and sends nothing", async () => {
    const f = installRoutes(base()).on('GET', '/api/sources/s1/envs', repoEnvs({
      vars: [envVar({ key: 'SHARDS', inputType: 'number', min: 1, max: 16, step: 1, displayLabel: 'Shard count' })],
      configFiles: [],
    }));
    const v = await openForm(f);
    await v.press(TAB, TAB, '40', TAB, TAB, ENTER);
    await v.until('Shard count takes a whole number from 1 to 16. Nothing was created.');
    await v.press(UP, UP, BACKSPACE, BACKSPACE, 'many', TAB, TAB, ENTER);
    await v.until('Not a number: SHARDS. Fix the value, then create. Nothing was created.');
    await v.press(UP, UP, UP, UP, ...Array(8).fill(BACKSPACE), TAB, TAB, TAB, TAB, ENTER);
    await v.until('Name is required.');
    expect(f.paths().filter((p) => !p.startsWith('GET'))).toEqual([]);
    v.unmount();
  });

  it('Esc goes back one screen at a time, and after a partial install says what stays created', async () => {
    const f = installRoutes(base()).on('PUT', '/api/bots/b9/config', refused(500, { success: false, error: 'Error: EROFS' }));
    const v = await openForm(f);
    await v.press(...TO_INSTALL, ENTER);
    await v.until('its config files were not saved: Error: EROFS');
    await v.press(ESC);
    await v.until('Sources');
    expect(flat(v.frame())).toContain('The bot coolbot (b9) was created; its config files were not saved: Error: EROFS.');
    await v.press(ESC);
    await v.until('I Install');
    v.unmount();
  });
});
