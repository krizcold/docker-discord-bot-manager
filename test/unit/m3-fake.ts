import { ok, refused } from './m2-fake';

// Bodies shaped as src/webui/routes/bots.ts and vault.ts send them.

// GET /api/bots (bots.ts:153), publicBot fields the frame reads.
export const botRow = (over: Record<string, unknown> = {}) => ({
  id: 'b1', displayName: 'mybot', status: 'stopped', sourceType: 'git', activeOp: null, fleetDb: null, fleetDbReplica: null,
  fleetBackup: null, updateAvailable: false, behindBy: 0, cutOp: null, ...over,
});

// One row of buildBotEnvList (src/env/envList.ts:307): envFieldMeta, then key, displayLabel, description, required,
// sensitive, value (blank for a secret) and isSet. JSON drops the meta fields left undefined.
export const editorVar = (over: Record<string, unknown>) => ({
  displayLabel: '', description: '', required: false, sensitive: false, value: '', isSet: false, ...over,
});

// GET /api/bots/:id/env (bots.ts:1122).
export const envBody = (vars: unknown[], over: Record<string, unknown> = {}) => ok({
  success: true, vars, tokenVarName: 'DISCORD_TOKEN', valid: true, missing: [], undecryptable: [], storeBroken: false,
  corruptCopies: [], secretKeyProblem: null, ...over,
});

export const TOKEN = 'Stored.Token.Never.Shown';

// A bot whose repo declares a token, a select, a conditional row, a list, a bounded number, a generated secret, a
// grouped row with help, an advanced row, an inactive row and a database URL; LOG_LEVEL is a stored key the repo
// no longer declares.
export const richVars = () => [
  editorVar({ key: 'DISCORD_TOKEN', displayLabel: 'Discord Bot Token', required: true, sensitive: true, isSet: true }),
  editorVar({
    key: 'STORAGE', displayLabel: 'Storage backend', description: 'Where the bot keeps its data.', value: 'json', isSet: true,
    options: [{ value: 'json', label: 'JSON files' }, { value: 'postgres', label: 'Postgres' }],
  }),
  editorVar({
    key: 'DATABASE_URL', displayLabel: 'Database URL', semantic: 'db-dsn', value: 'postgres://db:5432/bot', isSet: true,
    showWhen: { key: 'STORAGE', equals: 'postgres' }, requiredWhen: { key: 'STORAGE', equals: 'postgres' },
  }),
  editorVar({ key: 'DEVS', displayLabel: 'Developer ids', list: true, value: '111,222', isSet: true, placeholder: 'User id' }),
  editorVar({ key: 'SHARDS', displayLabel: 'Shards', inputType: 'number', min: 1, max: 16, step: 1, value: '2', isSet: true }),
  editorVar({ key: 'SESSION_SECRET', displayLabel: 'Session secret', generate: true, sensitive: true }),
  editorVar({ key: 'WEBUI_USER', displayLabel: 'Web login user', group: 'Web login', groupHelp: 'The login of the bot web page.', value: 'admin', isSet: true }),
  editorVar({ key: 'CACHE_TTL', displayLabel: 'Cache lifetime', advanced: true, value: '60' }),
  editorVar({ key: 'GATEWAY_PASS', displayLabel: 'Gateway password', inactive: 'Not used: this deployment removes the bot\'s own login gateway (Auth: Auto).' }),
  editorVar({ key: 'LOG_LEVEL', value: 'info', isSet: true }),
];

// PUT /api/bots/:id/env (bots.ts:1158).
export const saved = (over: Record<string, unknown> = {}) => ok({ success: true, removed: [], valid: true, missing: [], ...over });
export const renameTaken = () => refused(409, {
  success: false,
  error: 'NEW_TOKEN is already stored, so a rename onto it would overwrite a stored value; nothing was saved. Pick another name, or remove the stored key first.',
});
// The removal left a key stored (bots.ts:1256).
export const partlyRemoved = () => refused(500, {
  success: false, removed: ['LOG_LEVEL'], stillStored: ['CACHE_TTL'], valid: true, missing: [],
  error: 'Saved and removed LOG_LEVEL, but could not edit docker-compose.yml, so CACHE_TTL is still stored; save again to retry the removal',
});

// POST /api/bots/:id/validate-db (bots.ts:1347).
export const dbOk = () => ok({ success: true, ok: true });
export const dbFailed = () => ok({ success: true, ok: false, error: 'connection refused', hint: 'Check the host and port.' });

// GET /api/vault/all-values (vault.ts:218): standalone entries, then deleted bots, then each bot's own env.
export const VAULT_TOKEN = 'Vault.Token.Secret.Value';
export const vaultBody = (values: unknown[]) => ok({ success: true, values, vaultBroken: false });
export const vaultValues = () => vaultBody([
  { key: 'DISCORD_TOKEN', value: VAULT_TOKEN, source: 'Standalone' },
  { key: 'DISCORD_TOKEN', value: VAULT_TOKEN, source: 'Deleted: oldbot' },
  { key: 'OTHER_KEY', value: 'Other.Secret.Value', source: 'Standalone' },
  { key: 'EMPTY_KEY', value: '', source: 'Standalone' },
]);
