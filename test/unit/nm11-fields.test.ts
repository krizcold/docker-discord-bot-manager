import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vm from 'vm';
import { describe, expect, it } from 'vitest';
import { findAppCapabilities } from '../../src/config/appCapabilities';
import { buildWizardEnvList } from '../../src/env/envList';

const URL = 'https://github.com/krizcold/fully-modular-discord-bot';
const PG = { key: 'DATA_BACKEND', equals: 'postgres' };
const fields = () => findAppCapabilities(URL)?.wizardFields ?? [];
const row = (k: string) => fields().find(f => f.key === k);

describe('NM11: the fleet shard fields', () => {
  it('lists the keys in order', () => {
    expect(fields().map(f => f.key)).toEqual(['FLEET_SHARD_COUNT', 'FLEET_SHARD_CAPACITY', 'FLEET_TAKEOVER_SECONDS', 'FLEET_SHARD_RETURN', 'FLEET_RESHARD_OVERLAP', 'NODE_NAME', 'DATA_BACKEND', 'DATA_BACKEND_URL', 'DATA_NOTICE_CHECK']);
  });
  it('FLEET_SHARD_COUNT label and type', () => {
    expect(row('FLEET_SHARD_COUNT')).toMatchObject({ displayLabel: 'Fleet Shard Count', inputType: 'number', advanced: true, defaultValue: '' });
    expect(row('FLEET_SHARD_COUNT')?.showWhen).toBeUndefined();
  });
  it('FLEET_SHARD_COUNT says a change reshards', () => {
    expect(row('FLEET_SHARD_COUNT')?.description).toBe("Total shards across all machines. Blank = Discord's recommended count. Changing it reshards the whole bot; on a database bot, machines whose value did not change follow the database.");
  });
  it('FLEET_SHARD_CAPACITY', () => {
    expect(row('FLEET_SHARD_CAPACITY')).toMatchObject({
      displayLabel: 'Fleet Shard Capacity', inputType: 'number', advanced: true, defaultValue: '', showWhen: PG,
      description: 'How many shards this machine takes before others do; default 1, 0 for none. A machine takes more when no other machine has room.',
    });
  });
  it('FLEET_TAKEOVER_SECONDS', () => {
    expect(row('FLEET_TAKEOVER_SECONDS')).toMatchObject({
      displayLabel: 'Fleet Takeover Seconds', inputType: 'number', advanced: true, defaultValue: '', showWhen: PG,
      description: 'Seconds another machine waits before it takes a shard this machine stopped renewing; a whole number from 15 to 3600, default 30. This machine leaves Discord when it has not renewed for two thirds of it.',
    });
  });
  it('FLEET_SHARD_RETURN', () => {
    expect(row('FLEET_SHARD_RETURN')).toMatchObject({
      displayLabel: 'Fleet Shard Return', options: [{ value: 'true' }, { value: 'false' }], advanced: true, defaultValue: 'true', showWhen: PG,
      description: "true: once a machine with room has been healthy for 5 minutes, this machine gives it back the shards it first held and moves to it the shards above this machine's target. false: this machine does neither. Default true.",
    });
  });
  it('FLEET_RESHARD_OVERLAP', () => {
    expect(row('FLEET_RESHARD_OVERLAP')).toMatchObject({
      displayLabel: 'Fleet Reshard Overlap', options: [{ value: 'true' }, { value: 'false' }], advanced: true, defaultValue: 'true',
      description: 'Reshard beside the running shards when every machine has room. false: the bot reshards only when FLEET_SHARD_COUNT changes, by stopping and starting every machine. Default true.',
    });
    expect(row('FLEET_RESHARD_OVERLAP')?.showWhen).toBeUndefined();
  });
  it('PIN_TEST_GUILD_SHARD is gone', () => {
    expect(row('PIN_TEST_GUILD_SHARD')).toBeUndefined();
  });
  it('the five rows reach the wizard list in the Fleet group', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nm11-'));
    try {
      const vars = buildWizardEnvList(dir, { sourceUrl: URL }).vars;
      for (const k of ['FLEET_SHARD_COUNT', 'FLEET_SHARD_CAPACITY', 'FLEET_TAKEOVER_SECONDS', 'FLEET_SHARD_RETURN', 'FLEET_RESHARD_OVERLAP']) {
        expect(vars.find(v => v.key === k), k).toMatchObject({ group: 'Fleet' });
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

const BOUNDS: Record<string, { min?: number; max?: number; step?: number }> = {
  FLEET_SHARD_COUNT: { min: 1, step: 1 },
  FLEET_SHARD_CAPACITY: { min: 0, step: 1 },
  FLEET_TAKEOVER_SECONDS: { min: 15, max: 3600, step: 1 },
};

describe('NM11 fix 1: number bounds', () => {
  it('the record carries each field\'s bounds', () => {
    for (const [k, b] of Object.entries(BOUNDS)) expect({ min: row(k)?.min, max: row(k)?.max, step: row(k)?.step }, k).toEqual({ max: undefined, ...b });
  });
  it('the editor list carries the bounds through envFieldMeta', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nm11-ed-'));
    const prev = { d: process.env.DATA_DIR, r: process.env.DATA_ROOT };
    process.env.DATA_DIR = dir;
    process.env.DATA_ROOT = path.join(dir, 'DATA');
    try {
      const { buildBotEnvList } = await import('../../src/env/envList');
      const rows = buildBotEnvList(dir, 'nm11bot', 'DISCORD_TOKEN', URL);
      for (const [k, b] of Object.entries(BOUNDS)) {
        const r = rows.find(v => v.key === k);
        expect({ min: r?.min, max: r?.max, step: r?.step }, k).toEqual({ max: undefined, ...b });
      }
    } finally {
      process.env.DATA_DIR = prev.d;
      process.env.DATA_ROOT = prev.r;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

const pageHtml = fs.readFileSync(path.resolve(__dirname, '../../src/webui/public/index.html'), 'utf8');
const pageFunction = (name: string): string => {
  let start = pageHtml.indexOf(`function ${name}(`);
  if (start < 0) return '';
  if (pageHtml.slice(start - 6, start) === 'async ') start -= 6;
  let i = pageHtml.indexOf('(', start);
  for (let depth = 0; ; i++) {
    if (pageHtml[i] === '(') depth++;
    else if (pageHtml[i] === ')' && --depth === 0) break;
  }
  i = pageHtml.indexOf('{', i);
  for (let depth = 0; ; i++) {
    if (pageHtml[i] === '{') depth++;
    else if (pageHtml[i] === '}' && --depth === 0) return pageHtml.slice(start, i + 1);
  }
};
const runPage = (names: string[], globals: Record<string, unknown>): any => {
  const ctx = vm.createContext({ ...globals });
  vm.runInContext(names.map(pageFunction).join('\n'), ctx);
  return ctx;
};
const escapeHtml = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

describe('NM11 fix 1: the editor input', () => {
  const html = (meta: any) => runPage(['buildEnvRowHtml'], { escapeHtml, jsArg: (s: string) => JSON.stringify(s) })
    .buildEnvRowHtml('K', '', 'Label', false, '', '', false, meta) as string;
  it('renders min, max and step on a number input', () => {
    const h = html({ inputType: 'number', min: 15, max: 3600, step: 1 });
    expect(h).toMatch(/<input type="number"[^>]* min="15"/);
    expect(h).toMatch(/<input type="number"[^>]* max="3600"/);
    expect(h).toMatch(/<input type="number"[^>]* step="1"/);
  });
  it('renders no max when the field has none', () => {
    const h = html({ inputType: 'number', min: 1, step: 1 });
    expect(h).toMatch(/ min="1"/);
    expect(h).not.toMatch(/ max="/);
  });
});

describe('NM11 fix 1: the save refuses a value outside the bounds', () => {
  const el = (extra: Record<string, any> = {}): any => ({
    textContent: '', disabled: false, isConnected: true, dataset: {}, value: '',
    classList: { contains: () => false }, querySelector: () => null, querySelectorAll: () => [], ...extra,
  });
  const save = async (value: string, bounds: Record<string, string>, hidden = false) => {
    const sent: any[] = []; const messages: string[][] = [];
    const input = { value, dataset: { label: 'Fleet Takeover Seconds', ...bounds }, validity: { badInput: false }, closest: (s: string) => (s === '[data-show-key]' ? { style: { display: hidden ? 'none' : '' } } : null) };
    const row = el({
      querySelector: (s: string) => (s === '.env-key' ? { value: 'K', dataset: { originalKey: 'K' } } : s === '.env-value' ? input : null),
    });
    const ctx = runPage(['botLabel', 'envEditorRemovedKeys', 'numberBoundsError', 'saveEnvEditor', 'hideEnvEditor'], {
      bots: [{ id: 'b1', displayName: 'Bot 1' }], envEditorBotId: 'b1', envEditorSeq: 0, envEditorInitial: {}, envEditorStored: ['K'],
      document: {
        querySelectorAll: (s: string) => (s === '#env-editor-rows .env-row' ? [row] : []),
        querySelector: (s: string) => (s === '#env-editor-content .btn-primary' ? el() : null),
        getElementById: (id: string) => ({ 'env-modal': el(), 'env-editor-rows': el(), 'env-editor-cancel': el() } as any)[id] || null,
      },
      semanticEnvKey: () => null,
      confirm: () => true,
      api: async (method: string, url: string, body: any) => { sent.push({ method, url, body }); return { success: true }; },
      showMessage: (t: string, m: string) => messages.push([t, m]),
      loadBots: () => {},
    });
    await ctx.saveEnvEditor();
    return { sent, messages };
  };
  const T = { min: '15', max: '3600', step: '1' };
  for (const v of ['10', '5000', '30.5', '1e2', '20.0']) {
    it(`refuses ${v} for 15 to 3600`, async () => {
      const { sent, messages } = await save(v, T);
      expect(sent).toEqual([]);
      expect(messages).toEqual([['error', 'Fleet Takeover Seconds takes a whole number from 15 to 3600. Nothing was saved.']]);
    });
  }
  it('says "from <min>" alone when there is no max', async () => {
    const { sent, messages } = await save('0', { min: '1', step: '1' });
    expect(sent).toEqual([]);
    expect(messages).toEqual([['error', 'Fleet Takeover Seconds takes a whole number from 1. Nothing was saved.']]);
  });
  for (const v of ['', '15', '3600']) {
    it(`saves ${JSON.stringify(v)}`, async () => {
      const { sent } = await save(v, T);
      expect(sent.map(s => s.body.vars)).toEqual([{ K: v }]);
    });
  }
});

describe('NM11 fix 2: hidden rows and the install wizard', () => {
  it('a row hidden by showWhen is not checked', async () => {
    const input = { value: '5', dataset: { label: 'L', min: '15', max: '3600', step: '1' }, closest: () => ({ style: { display: 'none' } }) };
    const ctx = runPage(['numberBoundsError'], {});
    expect(ctx.numberBoundsError(input, 'K')).toBeNull();
  });
  const install = async (value: string) => {
    const sent: any[] = []; const messages: string[][] = [];
    const input = { value, dataset: { label: 'Fleet Shard Capacity', min: '0', step: '1' }, closest: () => ({ style: { display: '' } }) };
    const envRow = { classList: { contains: () => false }, querySelector: (s: string) => (s === '.env-key' ? { value: 'FLEET_SHARD_CAPACITY' } : input) };
    const btn = { disabled: false, textContent: '', isConnected: true, dataset: {}, classList: { contains: () => false }, querySelector: () => null };
    const ctx = runPage(['botLabel', 'guidedReadyToSave', 'semanticWrapper', 'semanticEnvValue', 'configFileReadOnly', 'numberBoundsError', 'doInstall'], {
      document: {
        getElementById: (x: string) => (x === 'install-name' ? { value: 'Bot' } : btn),
        querySelectorAll: (s: string) => (s.includes('env-row') ? [envRow] : []),
        querySelector: () => btn,
      },
      window: { guidedFlushAll: true, guidedPendingErasures: true },
      guidedFlushAll: async () => true,
      guidedPendingErasures: () => [],
      confirm: () => true,
      api: async (method: string, url: string) => { sent.push({ method, url }); return url === '/bots' ? { success: true, bot: { id: 'b1' } } : { success: true }; },
      showMessage: (t: string, m: string) => messages.push([t, m]),
      hideInstallModal: () => {}, loadBots: () => {},
      installSourceId: 's1', installBotId: null, installSeq: 0, bots: [],
    });
    await ctx.doInstall();
    return { sent, messages };
  };
  it('the install refuses a capacity of -1', async () => {
    const { sent, messages } = await install('-1');
    expect(sent).toEqual([]);
    expect(messages).toEqual([['error', 'Fleet Shard Capacity takes a whole number from 0. Nothing was created.']]);
  });
  it('the install accepts a capacity of 2', async () => {
    const { sent } = await install('2');
    expect(sent.some(s => s.url === '/bots')).toBe(true);
  });
});
