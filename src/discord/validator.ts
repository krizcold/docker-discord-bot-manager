/**
 * Validate Discord IDs entered in the guided config form, using the bot's own
 * token over the Discord REST API (no gateway connection). What is resolvable
 * depends on the bot's membership:
 *   - user:    GET /users/{id}      - resolvable with the token alone.
 *   - guild:   GET /guilds/{id}     - 200 only once the bot is a member, so it
 *              doubles as an "is the bot in this server yet?" check.
 *   - role:    from GET /guilds/{g}/roles    - needs the bot in the guild.
 *   - channel: from GET /guilds/{g}/channels - needs the bot in the guild.
 * Roles/channels therefore report 'bot_not_in_guild' until the bot joins (there
 * is no global role/channel lookup).
 *
 * Rate-limit safety: results are cached by token-hash, a single in-flight
 * guild-list fetch is shared across concurrent field validations, and a token
 * that returns 401 is remembered briefly so a wrong token does not fan out one
 * live request per field (which could get the manager IP banned).
 */
import * as crypto from 'crypto';

// 'member' resolves a role-OR-user id (e.g. open-ticket globalAdmins): a user is
// tried first (token-only), then a role (needs the guild).
export type ValidateKind = 'user' | 'role' | 'channel' | 'guild' | 'member';
export type ValidateStatus = 'ok' | 'invalid' | 'cannot_access' | 'bot_not_in_guild' | 'cannot_validate';

export interface ValidateResult {
  status: ValidateStatus;
  name?: string;
  avatarUrl?: string;
  resolvedKind?: 'user' | 'role' | 'channel' | 'guild';   // what it actually resolved as (for 'member')
  extra?: { color?: string; channelType?: number };
  reason?: 'token' | 'rate_limit' | 'network' | 'missing_guild';
}

const API = 'https://discord.com/api/v10';
const CDN = 'https://cdn.discordapp.com';
const ID_RE = /^\d{5,25}$/;

const TTL_OK = 10 * 60 * 1000;       // resolved users / guilds
const TTL_NEG = 30 * 1000;           // 404s, bot-not-in-guild, bad token
const TTL_GUILD = 60 * 1000;         // per-guild role/channel lists

interface CacheEntry<T> { at: number; value: T; }
interface GuildLists { roles: Map<string, any>; channels: Map<string, any>; }

const userCache = new Map<string, CacheEntry<ValidateResult>>();
const guildIdCache = new Map<string, CacheEntry<ValidateResult>>();
const guildListCache = new Map<string, CacheEntry<GuildLists | ValidateResult>>();
const guildListInflight = new Map<string, Promise<GuildLists | ValidateResult>>();
const badToken = new Map<string, number>();   // tokenHash -> time a 401 was seen

function tokenKey(token: string): string {
  return crypto.createHash('sha1').update(token).digest('hex').slice(0, 16);
}
function isBadToken(token: string): boolean {
  const t = badToken.get(tokenKey(token));
  return t !== undefined && Date.now() - t < TTL_NEG;
}

async function discordGet(token: string, p: string): Promise<{ status: number; json: any }> {
  try {
    const r = await fetch(`${API}${p}`, { headers: { Authorization: `Bot ${token}` } });
    if (r.status === 401) badToken.set(tokenKey(token), Date.now());
    let json: any = null;
    try { json = await r.json(); } catch { /* no/invalid body */ }
    return { status: r.status, json };
  } catch {
    return { status: 0, json: null };   // network error
  }
}

function httpErr(status: number): ValidateResult {
  if (status === 401) return { status: 'cannot_validate', reason: 'token' };
  if (status === 429) return { status: 'cannot_validate', reason: 'rate_limit' };
  if (status === 0) return { status: 'cannot_validate', reason: 'network' };
  return { status: 'cannot_validate' };
}

function userAvatarUrl(u: any): string {
  if (u.avatar) {
    const ext = String(u.avatar).startsWith('a_') ? 'gif' : 'png';
    return `${CDN}/avatars/${u.id}/${u.avatar}.${ext}?size=64`;
  }
  let index = 0;
  if (u.discriminator && u.discriminator !== '0') index = parseInt(u.discriminator, 10) % 5;
  else { try { index = Number((BigInt(u.id) >> 22n) % 6n); } catch { index = 0; } }
  return `${CDN}/embed/avatars/${index}.png`;
}

async function validateUser(token: string, id: string): Promise<ValidateResult> {
  const key = `${tokenKey(token)}:u:${id}`;
  const c = userCache.get(key);
  if (c && Date.now() - c.at < (c.value.status === 'ok' ? TTL_OK : TTL_NEG)) return c.value;

  const { status, json } = await discordGet(token, `/users/${id}`);
  let result: ValidateResult;
  if (status === 200 && json) result = { status: 'ok', name: json.global_name || json.username, avatarUrl: userAvatarUrl(json), resolvedKind: 'user' };
  else if (status === 404) result = { status: 'invalid' };
  else return httpErr(status);   // transient: do not cache
  userCache.set(key, { at: Date.now(), value: result });
  return result;
}

async function validateGuild(token: string, id: string): Promise<ValidateResult> {
  const key = `${tokenKey(token)}:gi:${id}`;
  const c = guildIdCache.get(key);
  if (c && Date.now() - c.at < (c.value.status === 'ok' ? TTL_OK : TTL_NEG)) return c.value;

  const { status, json } = await discordGet(token, `/guilds/${id}`);
  let result: ValidateResult;
  if (status === 200 && json) {
    const icon = json.icon ? `${CDN}/icons/${id}/${json.icon}.png?size=64` : undefined;
    result = { status: 'ok', name: json.name, avatarUrl: icon, resolvedKind: 'guild' };
  } else if (status === 404) {
    result = { status: 'bot_not_in_guild' };
  } else return httpErr(status);   // transient: do not cache
  guildIdCache.set(key, { at: Date.now(), value: result });
  return result;
}

async function fetchGuildLists(token: string, guildId: string): Promise<GuildLists | ValidateResult> {
  const key = `${tokenKey(token)}:g:${guildId}`;
  const c = guildListCache.get(key);
  if (c) { const ttl = 'status' in c.value ? TTL_NEG : TTL_GUILD; if (Date.now() - c.at < ttl) return c.value; }
  const existing = guildListInflight.get(key);
  if (existing) return existing;   // share one in-flight fetch across concurrent fields

  const p = (async (): Promise<GuildLists | ValidateResult> => {
    const rolesResp = await discordGet(token, `/guilds/${guildId}/roles`);
    if (rolesResp.status === 403 || rolesResp.status === 404) {
      const v: ValidateResult = { status: 'bot_not_in_guild' };
      guildListCache.set(key, { at: Date.now(), value: v });
      return v;
    }
    if (rolesResp.status !== 200 || !Array.isArray(rolesResp.json)) return httpErr(rolesResp.status);   // transient: uncached
    const channelsResp = await discordGet(token, `/guilds/${guildId}/channels`);
    const roles = new Map<string, any>();
    for (const r of rolesResp.json) roles.set(r.id, r);
    const channels = new Map<string, any>();
    if (Array.isArray(channelsResp.json)) for (const ch of channelsResp.json) channels.set(ch.id, ch);
    const value: GuildLists = { roles, channels };
    guildListCache.set(key, { at: Date.now(), value });
    return value;
  })().finally(() => guildListInflight.delete(key));

  guildListInflight.set(key, p);
  return p;
}

async function validateRole(token: string, guildId: string, id: string): Promise<ValidateResult> {
  const lists = await fetchGuildLists(token, guildId);
  if ('status' in lists) return lists;
  const role = lists.roles.get(id);
  if (!role) return { status: 'invalid' };
  const color = role.color ? '#' + Number(role.color).toString(16).padStart(6, '0') : undefined;
  return { status: 'ok', name: role.name, resolvedKind: 'role', extra: { color } };
}

async function validateChannel(token: string, guildId: string, id: string): Promise<ValidateResult> {
  const lists = await fetchGuildLists(token, guildId);
  if ('status' in lists) return lists;
  const ch = lists.channels.get(id);
  if (!ch) return { status: 'invalid' };
  return { status: 'ok', name: ch.name, resolvedKind: 'channel', extra: { channelType: ch.type } };
}

export async function validateDiscordId(
  token: string,
  kind: ValidateKind,
  id: string,
  guildId?: string,
): Promise<ValidateResult> {
  if (!token) return { status: 'cannot_validate', reason: 'token' };
  if (isBadToken(token)) return { status: 'cannot_validate', reason: 'token' };
  if (!ID_RE.test(id)) return { status: 'invalid' };

  if (kind === 'user') return validateUser(token, id);
  if (kind === 'guild') return validateGuild(token, id);

  // member: a role OR a user. Try user first (token-only); if it is not a user,
  // fall back to a role (which needs the guild).
  if (kind === 'member') {
    const u = await validateUser(token, id);
    if (u.status === 'ok' || u.status === 'cannot_validate') return u;
    if (guildId && ID_RE.test(guildId)) return validateRole(token, guildId, id);
    return { status: 'cannot_validate', reason: 'missing_guild' };
  }

  // role / channel need a guild the bot belongs to
  if (!guildId || !ID_RE.test(guildId)) return { status: 'cannot_validate', reason: 'missing_guild' };
  if (kind === 'role') return validateRole(token, guildId, id);
  return validateChannel(token, guildId, id);
}
