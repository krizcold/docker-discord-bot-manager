/**
 * Data-driven per-source INSTALL MANIFESTS for the guided config builder, keyed
 * by source repo URL (data, like TEMPLATE_MODIFIERS - never a bot name in code).
 * A manifest describes a bot's config file as a tree of sections and typed
 * fields so the wizard can render a friendly, validated form over the same body
 * the raw editor shows. Adding support for a bot is appending one record; there
 * are zero per-bot code branches and every primitive here is reusable by any
 * bot's manifest. A config file with no manifest falls back to the raw editor.
 *
 * The manifest carries STRUCTURE only. The actual values live in the config
 * body, which stays the single source of truth (see configSerializer).
 */
import * as fs from 'fs';
import * as path from 'path';
import { matchesSource, SourceMatch } from './sourceMatch';
import { parseConfig, serializeConfig, ConfigOp } from './configSerializer';
import { splitPath } from './configPath';
import { findConfigTemplate } from './configTemplates';
import { DetectedConfigFile } from '../types';
import { extractConfigKeys } from '../env/manager';

// ─── Field targets: where a value reads/writes in the underlying config ───

export type FieldTarget =
  | { kind: 'json'; path: string }    // dotted/bracket path into a JSON/JSONC body
  | { kind: 'yaml'; path: string }    // dotted/bracket path into a YAML body
  | { kind: 'env'; var: string };     // a .env var (env channel, not the config body)

// ─── Field types (all general; a manifest selects among them) ───

export type FieldType =
  | 'text'
  | 'password'
  | 'number'
  | 'boolean'
  | 'select'                          // requires `options`
  | 'color'                           // hex string, rendered with a swatch
  | 'guild-id'                        // Discord server id, validated via GET /guilds/{id}
  | 'user-id'                         // Discord user id, validated + shown as avatar/name
  | 'role-id'                         // Discord role id (needs guild context)
  | 'role-or-user-id'                 // a role OR a user (user tried first, then role)
  | 'channel-id'                      // Discord channel id (needs guild context)
  | 'list'                            // requires `element`
  | 'grid';                          // boolean matrix; requires `rows` + `columns`

export interface SelectOption {
  value: string | number | boolean;   // drives number/boolean configs too, not just strings
  label?: string;
}

/**
 * Field shape without a target. Used as a list element descriptor: a scalar list
 * element IS the value at its index (no sub-path), and an object list element's
 * properties carry their own (element-relative) targets via `objectFields`.
 */
export interface FieldDescriptorBase {
  type: FieldType;
  label: string;
  help?: string;
  required?: boolean;
  default?: string | number | boolean | unknown[];   // arrays allowed (list field seed)
  sensitive?: boolean;               // mask in UI (e.g. token)
  // This field carries the bot's own Discord token in the config body, so a
  // detected env TOKEN can be demoted to optional. Set ONLY on the real bot
  // token, never on incidental secrets (API keys, node passwords).
  isBotToken?: boolean;
  // This field may be sourced from the config body (its target.path) OR an env
  // var. The form shows an "In file / From env" switch; the env VALUE is entered
  // in the existing Environment Variables section (single source of env truth),
  // and only the switch + optional body flag live here. flagPath is the body
  // boolean the bot reads as "use env" (e.g. open-ticket's 'tokenFromENV').
  envAlt?: { var: string; flagPath?: string };
  options?: SelectOption[];          // for type 'select'
  element?: ListElement;             // for type 'list'
  // For type 'grid': a matrix of booleans, each cell at
  // `${target.path}.${row.key}.${column.key}`, with a per-column toggle-all.
  rows?: Array<{ key: string; label: string }>;
  columns?: Array<{ key: string; label: string }>;
  // For role-id/channel-id fields: an ABSOLUTE config path (from the body root)
  // to the field holding the guild id, so validation knows which server to query.
  // Users resolve with the bot token alone and need no serverIdRef.
  serverIdRef?: { kind: 'json' | 'yaml'; path: string };
  // Non-id literals that are valid for an id-typed field and bypass validation
  // (e.g. a permission of "none" / "everyone" / "admin").
  literals?: string[];
  // Shipped sentinels that mean "empty / must replace" (e.g. "DISCORD_SERVER_ID"),
  // treated as unset for required-checks and skipped by live validation.
  placeholders?: string[];
  // Conditional visibility: show this field only when another field equals a
  // value (general primitive for type-discriminated objects). `scope` selects how
  // `path` resolves: 'section' (absolute, default) or 'element' (a sibling
  // property key within the same list element). Renderer support lands with the
  // feature-file phase; defining it now keeps the schema stable.
  showWhen?: { path: string; equals?: string | number | boolean; notEquals?: string | number | boolean; in?: Array<string | number | boolean>; scope?: 'section' | 'element' };
}

export interface FieldDescriptor extends FieldDescriptorBase {
  target: FieldTarget;
}

/**
 * An object-list element property. Unlike FieldDescriptor it carries no target;
 * `key` is the property name within each array element object. The renderer
 * builds each row as { [key]: value } and the serializer writes the whole array
 * at the list field's target path. A property may itself be a list (e.g. a row
 * with a `roles` array) by setting type 'list' + element.
 */
export interface ObjectFieldDescriptor extends FieldDescriptorBase {
  key: string;
}

/**
 * A list element. Exactly one of `field` (scalar element, e.g. a list of
 * role-ids) or `objectFields` (object element, e.g. {user, category}) is set.
 * `itemLabel` is a template for the collapsed row header, e.g. "User {user}".
 */
export interface ListElement {
  field?: FieldDescriptorBase;
  objectFields?: ObjectFieldDescriptor[];
  itemLabel?: string;
}

export type DisabledBehavior = 'set-false' | 'omit';

export interface SectionToggle {
  // The underlying flag the toggle maps to (the bot's own `enabled` key), if any.
  target?: FieldTarget;
  default: boolean;                  // false => optional, opt-in, shown but off
  // How the OFF state serializes:
  //  'set-false' -> write target=false, keep field values present (restorable)
  //  'omit'      -> delete the section's block from the body (see omitPath)
  disabledBehavior: DisabledBehavior;
  // For disabledBehavior 'omit': the single path to delete when OFF (the
  // section's own object/array), so the whole block is removed in one op rather
  // than leaving dangling empty parents from per-field deletes.
  omitPath?: FieldTarget;
}

export interface SectionDescriptor {
  id: string;                        // stable key within the manifest
  title: string;
  help?: string;
  toggle?: SectionToggle;            // present => section can be enabled/disabled
  columns?: number;                  // lay the section's fields out in N columns (default 1)
  fields?: FieldDescriptor[];        // omit for a section that only groups subsections
  sections?: SectionDescriptor[];    // nested subsections
}

/** One manifest entry == one config target file for one source. */
export interface ConfigManifest {
  match: SourceMatch;                // same matcher as TEMPLATE_MODIFIERS
  target: string;                    // config file basename, e.g. "general.json"
  format: 'json' | 'yaml';
  // Declare where this config lives in the repo and where the bot reads it
  // in-container, so the manager surfaces it even when detection's dir/depth/compose
  // rules miss it. repoPath is repo-root-relative; if absent, findConfigTemplate
  // resolves an example sibling (creds.yml -> creds_example.yml).
  source?: { repoPath: string; inContainerPath: string };
  sections?: SectionDescriptor[];    // object-root config (sections of fields)
  root?: FieldDescriptor;            // array-root config: a single 'list' field over the whole file (target.path '')
}

// ─── Manifest authoring helpers (build data concisely; no per-bot logic) ───

function j(path: string): FieldTarget {
  return { kind: 'json', path };
}
function y(path: string): FieldTarget {
  return { kind: 'yaml', path };
}
function opts(values: string[]): SelectOption[] {
  return values.map(value => ({ value }));
}
function boolField(path: string, label: string, def: boolean): FieldDescriptor {
  return { type: 'boolean', label, default: def, target: j(path) };
}
function yBool(path: string, label: string, def: boolean): FieldDescriptor {
  return { type: 'boolean', label, default: def, target: y(path) };
}

// ─── open-ticket: config/general.jsonc ───

const OT_LANGUAGES = [
  'english', 'dutch', 'german', 'french', 'spanish', 'portuguese', 'catalan', 'czech',
  'danish', 'estonian', 'finnish', 'hungarian', 'indonesian', 'italian', 'lithuanian',
  'norwegian', 'polish', 'romanian', 'russian', 'swedish', 'thai', 'turkish',
  'ukrainian', 'vietnamese',
];

const OT_LOG_ACTIONS: Array<[string, string]> = [
  ['creation', 'Creation'], ['closing', 'Closing'], ['deleting', 'Deleting'],
  ['reopening', 'Reopening'], ['claiming', 'Claiming'], ['pinning', 'Pinning'],
  ['adding', 'Adding user'], ['removing', 'Removing user'], ['renaming', 'Renaming'],
  ['moving', 'Moving'], ['blacklisting', 'Blacklisting'], ['transferring', 'Transferring'],
  ['topicChange', 'Topic change'], ['priorityChange', 'Priority change'], ['reactionRole', 'Reaction role'],
];
const otLogGrid: FieldDescriptor = {
  type: 'grid',
  label: 'Log messages',
  help: 'Which ticket events are logged, and whether to also DM the creator. Use the column buttons to toggle a whole column.',
  target: j('logs.logMessages'),
  rows: OT_LOG_ACTIONS.map(([key, label]) => ({ key, label })),
  columns: [{ key: 'dm', label: 'DM user' }, { key: 'logs', label: 'Log channel' }],
};

const OT_TICKET_BOOLEANS: Array<[string, string, boolean]> = [
  ['preferSlashOverText', 'Prefer slash over text in help', true],
  ['sendErrorOnUnknownCommand', 'Error on unknown command', true],
  ['questionFieldsInCodeBlock', 'Question answers in code blocks', true],
  ['displayFieldsWithQuestions', 'Display fields with question answers', false],
  ['showGlobalAdminsInPanelRoles', 'Include global admins in panel roles', false],
  ['disableVerifyBars', 'Disable verify bars', false],
  ['useRedErrorEmbeds', 'Always use red error embeds', true],
  ['alwaysShowReason', 'Always show reason', false],
  ['replyOnTicketCreation', 'Reply on ticket creation', true],
  ['replyOnReactionRole', 'Reply on reaction role', true],
  ['askPriorityOnTicketCreation', 'Ask priority on ticket creation', true],
  ['removeParticipantsOnClose', 'Remove participants on close', false],
  ['disableAutocloseAfterReopen', 'Disable autoclose after reopen', true],
  ['autodeleteRequiresClosedTicket', 'Autodelete requires closed ticket', true],
  ['adminOnlyDeleteWithoutTranscript', 'Admin-only delete without transcript', true],
  ['allowCloseBeforeMessage', 'Allow close before any message', false],
  ['allowCloseBeforeAdminMessage', 'Allow close before admin message', true],
  ['useTranslatedConfigChecker', 'Translate config-checker errors', true],
  ['pinFirstTicketMessage', 'Pin first ticket message', true],
  ['enableTicketClaimButtons', 'Enable claim buttons', true],
  ['enableTicketCloseButtons', 'Enable close buttons', true],
  ['enableTicketPinButtons', 'Enable pin buttons', true],
  ['enableTicketDeleteButtons', 'Enable delete buttons', true],
  ['enableTicketActionWithReason', 'Enable action-with-reason', true],
  ['enableDeleteWithoutTranscript', 'Enable delete without transcript', true],
  ['enableCreateTicketForOtherUser', 'Enable creating tickets for others', true],
];
const otTicketBooleanFields = OT_TICKET_BOOLEANS.map(([k, l, d]) => boolField(`ticketSystem.${k}`, l, d));

const OT_CHANNEL_TOPIC: Array<[string, string, boolean]> = [
  ['showOptionName', 'Show option name', true],
  ['showOptionDescription', 'Show option description', false],
  ['showOptionTopic', 'Show option topic', true],
  ['showPriority', 'Show priority', false],
  ['showClosed', 'Show closed', true],
  ['showClaimed', 'Show claimed', false],
  ['showPinned', 'Show pinned', false],
  ['showCreator', 'Show creator', false],
  ['showParticipants', 'Show participants', false],
];
const otChannelTopicFields = OT_CHANNEL_TOPIC.map(([k, l, d]) => boolField(`ticketSystem.channelTopic.${k}`, l, d));

const OT_PERMISSIONS: Array<[string, string]> = [
  ['help', 'everyone'], ['panel', 'admin'], ['ticket', 'none'], ['close', 'everyone'],
  ['delete', 'admin'], ['reopen', 'everyone'], ['claim', 'admin'], ['unclaim', 'admin'],
  ['pin', 'admin'], ['unpin', 'admin'], ['move', 'admin'], ['rename', 'admin'],
  ['add', 'admin'], ['remove', 'admin'], ['blacklist', 'admin'], ['stats', 'everyone'],
  ['clear', 'admin'], ['autoclose', 'admin'], ['autodelete', 'admin'], ['transfer', 'admin'],
  ['topic', 'admin'], ['priority', 'admin'], ['transcripts', 'admin'],
];
const otPermissionFields: FieldDescriptor[] = OT_PERMISSIONS.map(([k, def]) => ({
  type: 'role-id',
  label: k,
  default: def,
  literals: ['none', 'everyone', 'admin'],
  serverIdRef: { kind: 'json', path: 'serverId' },
  target: j(`permissions.${k}`),
}));

const openTicketGeneral: ConfigManifest = {
  match: { urlContains: 'open-ticket' },
  target: 'general.jsonc',
  format: 'json',
  sections: [
    {
      id: 'identity',
      title: 'Identity & Connection',
      fields: [
        { type: 'password', label: 'Bot Token', required: true, sensitive: true, isBotToken: true, placeholders: ['INSERT_BOT_TOKEN'], envAlt: { var: 'TOKEN', flagPath: 'tokenFromENV' }, help: 'Your Discord bot token, or switch to "From env" to read the TOKEN env var instead.', target: j('token') },
        { type: 'guild-id', label: 'Server (Guild) ID', required: true, placeholders: ['DISCORD_SERVER_ID'], help: 'The Discord server this bot runs in.', target: j('serverId') },
        { type: 'list', label: 'Global Admins', help: 'Roles or users with access to all commands.', default: [], target: j('globalAdmins'), element: { field: { type: 'role-or-user-id', label: 'Role or User', placeholders: ['DISCORD_ROLE_ID'], serverIdRef: { kind: 'json', path: 'serverId' } } } },
        { type: 'color', label: 'Main Color', default: '#f8ba00', target: j('mainColor') },
        { type: 'select', label: 'Language', default: 'english', options: opts(OT_LANGUAGES), target: j('language') },
        { type: 'text', label: 'Text Command Prefix', default: '!ticket ', target: j('prefix') },
        { type: 'boolean', label: 'Enable Slash Commands', default: true, target: j('slashCommands') },
        { type: 'boolean', label: 'Enable Text Commands', default: true, target: j('textCommands') },
      ],
    },
    {
      id: 'status',
      title: 'Status / Presence',
      toggle: { target: j('status.enabled'), default: true, disabledBehavior: 'set-false' },
      fields: [
        { type: 'select', label: 'Activity Type', default: 'listening', options: opts(['listening', 'watching', 'playing', 'custom']), target: j('status.type') },
        { type: 'select', label: 'Presence', default: 'online', options: opts(['online', 'invisible', 'idle', 'dnd']), target: j('status.mode') },
        { type: 'text', label: 'Status Text', default: '/help', target: j('status.text') },
        { type: 'text', label: 'Custom State (optional)', default: '', target: j('status.state') },
      ],
    },
    {
      id: 'logs',
      title: 'Logs',
      help: 'Send ticket logs to a channel and optionally DM the ticket creator.',
      toggle: { target: j('logs.enabled'), default: false, disabledBehavior: 'set-false' },
      fields: [
        { type: 'channel-id', label: 'Log Channel', placeholders: ['DISCORD_CHANNEL_ID'], serverIdRef: { kind: 'json', path: 'serverId' }, target: j('logs.channel') },
        otLogGrid,
      ],
    },
    {
      id: 'ticketSystem',
      title: 'Ticket System',
      fields: [
        ...otTicketBooleanFields,
        { type: 'select', label: 'Emoji Style', default: 'before', options: opts(['before', 'after', 'double', 'disabled']), target: j('ticketSystem.emojiStyle') },
        { type: 'text', label: 'Pin Emoji', default: '📌', target: j('ticketSystem.pinEmoji') },
        { type: 'text', label: 'Close Emoji (empty to disable)', default: '', target: j('ticketSystem.closeEmoji') },
      ],
      sections: [
        {
          id: 'limits', title: 'Ticket Limits',
          toggle: { target: j('ticketSystem.limits.enabled'), default: true, disabledBehavior: 'set-false' },
          fields: [
            { type: 'number', label: 'Global Maximum', default: 50, target: j('ticketSystem.limits.globalMaximum') },
            { type: 'number', label: 'Per-User Maximum', default: 3, target: j('ticketSystem.limits.userMaximum') },
          ],
        },
        { id: 'channelTopic', title: 'Channel Topic', help: 'What the ticket channel topic shows.', fields: otChannelTopicFields },
        {
          id: 'closedCategory', title: 'Closed Category', help: 'Move closed tickets to a separate category.',
          toggle: { target: j('ticketSystem.closedCategory.enabled'), default: false, disabledBehavior: 'set-false' },
          fields: [
            { type: 'channel-id', label: 'Category', placeholders: ['DISCORD_CATEGORY_ID'], serverIdRef: { kind: 'json', path: 'serverId' }, target: j('ticketSystem.closedCategory.categoryId') },
          ],
        },
        {
          id: 'backupCategory', title: 'Backup Category', help: 'Overflow category used when the main one exceeds 50 channels.',
          toggle: { target: j('ticketSystem.backupCategory.enabled'), default: false, disabledBehavior: 'set-false' },
          fields: [
            { type: 'channel-id', label: 'Category', placeholders: ['DISCORD_CATEGORY_ID'], serverIdRef: { kind: 'json', path: 'serverId' }, target: j('ticketSystem.backupCategory.categoryId') },
          ],
        },
        {
          id: 'claimedCategories', title: 'Claimed Categories', help: 'Move claimed tickets to a per-admin category. Leave empty to disable.',
          fields: [
            {
              type: 'list', label: 'Claimed categories', default: [], target: j('ticketSystem.claimedCategories'),
              element: {
                itemLabel: 'User {user}',
                objectFields: [
                  { key: 'user', type: 'user-id', label: 'User', placeholders: ['DISCORD_USER_ID'] },
                  { key: 'category', type: 'channel-id', label: 'Category', placeholders: ['DISCORD_CATEGORY_ID'], serverIdRef: { kind: 'json', path: 'serverId' } },
                ],
              },
            },
          ],
        },
      ],
    },
    {
      id: 'permissions',
      title: 'Permissions',
      help: 'Per-command access. Each is none, everyone, admin, or a specific role ID.',
      columns: 2,
      fields: otPermissionFields,
    },
  ],
};

// ─── helpers for array-root element forms ───

function ofield(key: string, type: FieldType, label: string, extra: Partial<ObjectFieldDescriptor> = {}): ObjectFieldDescriptor {
  return { key, type, label, ...extra };
}

type ShowWhen = FieldDescriptorBase['showWhen'];

// A Discord-embed object flattened to element fields under `prefix`. Panel embeds
// carry url + footer; option embeds do not. `when` gates every field via showWhen.
function embedFields(prefix: string, withUrlFooter: boolean, when?: ShowWhen): ObjectFieldDescriptor[] {
  const w = when ? { showWhen: when } : {};
  const out: ObjectFieldDescriptor[] = [
    { key: `${prefix}.enabled`, type: 'boolean', label: 'Embed enabled', ...w },
    { key: `${prefix}.title`, type: 'text', label: 'Embed title', ...w },
    { key: `${prefix}.description`, type: 'text', label: 'Embed description', ...w },
    { key: `${prefix}.customColor`, type: 'color', label: 'Embed color', ...w },
  ];
  if (withUrlFooter) out.push({ key: `${prefix}.url`, type: 'text', label: 'Embed URL', ...w });
  out.push({ key: `${prefix}.image`, type: 'text', label: 'Embed image URL', ...w });
  out.push({ key: `${prefix}.thumbnail`, type: 'text', label: 'Embed thumbnail URL', ...w });
  if (withUrlFooter) out.push({ key: `${prefix}.footer`, type: 'text', label: 'Embed footer', ...w });
  out.push({
    key: `${prefix}.fields`, type: 'list', label: 'Embed fields', ...w,
    element: {
      itemLabel: '{name}',
      objectFields: [
        { key: 'name', type: 'text', label: 'Name' },
        { key: 'value', type: 'text', label: 'Value' },
        { key: 'inline', type: 'boolean', label: 'Inline' },
      ],
    },
  });
  out.push({ key: `${prefix}.timestamp`, type: 'boolean', label: 'Embed timestamp', ...w });
  return out;
}

const roleListEl = { field: { type: 'role-id' as FieldType, label: 'Role', placeholders: ['DISCORD_ROLE_ID'] } };

// ─── open-ticket: config/transcripts.jsonc (object root) ───

const openTicketTranscripts: ConfigManifest = {
  match: { urlContains: 'open-ticket' },
  target: 'transcripts.jsonc',
  format: 'json',
  sections: [
    {
      id: 'general', title: 'General',
      toggle: { target: j('general.enabled'), default: false, disabledBehavior: 'set-false' },
      fields: [
        boolField('general.enableChannel', 'Send to a channel', false),
        boolField('general.enableCreatorDM', 'DM the ticket creator', false),
        boolField('general.enableParticipantDM', 'DM participants', false),
        boolField('general.enableActiveAdminDM', 'DM the active admin', false),
        boolField('general.enableEveryAdminDM', 'DM every admin', false),
        { type: 'channel-id', label: 'Transcript Channel', placeholders: ['DISCORD_CHANNEL_ID'], target: j('general.channel') },
        { type: 'select', label: 'Transcript Type', default: 'html', options: opts(['html', 'text']), target: j('general.mode') },
      ],
    },
    {
      id: 'embedSettings', title: 'Embed Settings',
      fields: [
        { type: 'color', label: 'Embed Color', default: '#f8ab00', target: j('embedSettings.customColor') },
        boolField('embedSettings.listAllParticipants', 'List all participants', false),
        boolField('embedSettings.includeTicketStats', 'Include ticket stats', false),
      ],
    },
    {
      id: 'textTranscriptStyle', title: 'Text Transcript Style',
      fields: [
        { type: 'select', label: 'Layout', default: 'normal', options: opts(['simple', 'normal', 'detailed']), target: j('textTranscriptStyle.layout') },
        boolField('textTranscriptStyle.includeStats', 'Include stats', true),
        boolField('textTranscriptStyle.includeIds', 'Include IDs', false),
        boolField('textTranscriptStyle.includeEmbeds', 'Include embeds', true),
        boolField('textTranscriptStyle.includeFiles', 'Include files', true),
        boolField('textTranscriptStyle.includeBotMessages', 'Include bot messages', true),
        { type: 'select', label: 'File Naming', default: 'custom', options: opts(['custom', 'channel-name', 'channel-id', 'user-name', 'user-id']), target: j('textTranscriptStyle.fileMode') },
        { type: 'text', label: 'Custom File Name', default: 'transcript', target: j('textTranscriptStyle.customFileName') },
      ],
    },
    {
      id: 'htmlTranscriptStyle', title: 'HTML Transcript Style',
      sections: [
        {
          id: 'htmlBackground', title: 'Background',
          toggle: { target: j('htmlTranscriptStyle.background.enableCustomBackground'), default: false, disabledBehavior: 'set-false' },
          fields: [
            { type: 'color', label: 'Background Color', default: '#f8ba00', target: j('htmlTranscriptStyle.background.backgroundColor') },
            { type: 'text', label: 'Background Image URL', default: '', target: j('htmlTranscriptStyle.background.backgroundImage') },
          ],
        },
        {
          id: 'htmlHeader', title: 'Header',
          toggle: { target: j('htmlTranscriptStyle.header.enableCustomHeader'), default: false, disabledBehavior: 'set-false' },
          fields: [
            { type: 'color', label: 'Background Color', default: '#202225', target: j('htmlTranscriptStyle.header.backgroundColor') },
            { type: 'color', label: 'Decoration Color', default: '#f8ba00', target: j('htmlTranscriptStyle.header.decoColor') },
            { type: 'color', label: 'Text Color', default: '#ffffff', target: j('htmlTranscriptStyle.header.textColor') },
          ],
        },
        {
          id: 'htmlStats', title: 'Stats',
          toggle: { target: j('htmlTranscriptStyle.stats.enableCustomStats'), default: false, disabledBehavior: 'set-false' },
          fields: [
            { type: 'color', label: 'Background Color', default: '#202225', target: j('htmlTranscriptStyle.stats.backgroundColor') },
            { type: 'color', label: 'Key Text Color', default: '#737373', target: j('htmlTranscriptStyle.stats.keyTextColor') },
            { type: 'color', label: 'Value Text Color', default: '#ffffff', target: j('htmlTranscriptStyle.stats.valueTextColor') },
            { type: 'color', label: 'Hide Background Color', default: '#40444a', target: j('htmlTranscriptStyle.stats.hideBackgroundColor') },
            { type: 'color', label: 'Hide Text Color', default: '#ffffff', target: j('htmlTranscriptStyle.stats.hideTextColor') },
          ],
        },
        {
          id: 'htmlFavicon', title: 'Favicon',
          toggle: { target: j('htmlTranscriptStyle.favicon.enableCustomFavicon'), default: false, disabledBehavior: 'set-false' },
          fields: [
            { type: 'text', label: 'Favicon Image URL', default: 'https://t.dj-dj.be/favicon.png', target: j('htmlTranscriptStyle.favicon.imageUrl') },
          ],
        },
      ],
    },
  ],
};

// ─── open-ticket: config/panels.jsonc (array root) ───

const openTicketPanels: ConfigManifest = {
  match: { urlContains: 'open-ticket' },
  target: 'panels.jsonc',
  format: 'json',
  root: {
    type: 'list', label: 'Panels', target: j(''),
    help: 'Each panel is a message with buttons or a dropdown of ticket options.',
    element: {
      itemLabel: '{name}',
      objectFields: [
        ofield('id', 'text', 'Panel ID', { required: true }),
        ofield('name', 'text', 'Name', { required: true }),
        ofield('dropdown', 'boolean', 'Use dropdown (instead of buttons)'),
        { key: 'options', type: 'list', label: 'Option IDs', required: true, help: 'IDs from options.jsonc.', element: { field: { type: 'text', label: 'Option ID' } } },
        ofield('text', 'text', 'Message text (empty to disable)'),
        ...embedFields('embed', true),
        ofield('settings.dropdownPlaceholder', 'text', 'Dropdown placeholder'),
        ofield('settings.maximumButtonsPerRow', 'number', 'Max buttons per row'),
        ofield('settings.enableMaxTicketsWarningInText', 'boolean', 'Max-tickets warning in text'),
        ofield('settings.enableMaxTicketsWarningInEmbed', 'boolean', 'Max-tickets warning in embed'),
        ofield('settings.describeOptionsLayout', 'select', 'Describe options layout', { options: opts(['simple', 'normal', 'detailed']) }),
        ofield('settings.describeOptionsCustomTitle', 'text', 'Describe options title'),
        ofield('settings.describeOptionsInText', 'boolean', 'Describe options in text'),
        ofield('settings.describeOptionsInEmbedFields', 'boolean', 'Describe options in embed fields'),
        ofield('settings.describeOptionsInEmbedDescription', 'boolean', 'Describe options in embed description'),
      ],
    },
  },
};

// ─── open-ticket: config/questions.jsonc (array root, type-discriminated) ───

const notTextDisplay: ShowWhen = { path: 'type', notEquals: 'text-display' };
const inTextTypes: ShowWhen = { path: 'type', in: ['short', 'paragraph'] };

const openTicketQuestions: ConfigManifest = {
  match: { urlContains: 'open-ticket' },
  target: 'questions.jsonc',
  format: 'json',
  root: {
    type: 'list', label: 'Questions', target: j(''),
    help: 'Modal questions a ticket can ask. Up to 5 per ticket option.',
    element: {
      itemLabel: '{name}',
      objectFields: [
        ofield('id', 'text', 'Question ID', { required: true }),
        ofield('type', 'select', 'Type', { required: true, default: 'short', options: opts(['short', 'paragraph', 'dropdown', 'radio-select', 'checkbox-select', 'text-display']) }),
        ofield('name', 'text', 'Name', { required: true, showWhen: notTextDisplay }),
        ofield('description', 'text', 'Description', { showWhen: notTextDisplay }),
        ofield('required', 'boolean', 'Required', { showWhen: notTextDisplay }),
        // short / paragraph
        ofield('placeholder', 'text', 'Placeholder', { showWhen: inTextTypes }),
        ofield('length.enabled', 'boolean', 'Limit length', { showWhen: inTextTypes }),
        ofield('length.min', 'number', 'Min length', { showWhen: inTextTypes }),
        ofield('length.max', 'number', 'Max length', { showWhen: inTextTypes }),
        // dropdown
        ofield('placeholder', 'text', 'Dropdown placeholder', { showWhen: { path: 'type', equals: 'dropdown' } }),
        {
          key: 'choices', type: 'list', label: 'Choices', required: true, showWhen: { path: 'type', equals: 'dropdown' },
          element: { itemLabel: '{title}', objectFields: [
            { key: 'title', type: 'text', label: 'Title' },
            { key: 'description', type: 'text', label: 'Description' },
            { key: 'emoji', type: 'text', label: 'Emoji' },
          ] },
        },
        // radio-select
        {
          key: 'choices', type: 'list', label: 'Choices', required: true, showWhen: { path: 'type', equals: 'radio-select' },
          element: { itemLabel: '{title}', objectFields: [
            { key: 'title', type: 'text', label: 'Title' },
            { key: 'description', type: 'text', label: 'Description' },
            { key: 'selectedByDefault', type: 'boolean', label: 'Selected by default' },
          ] },
        },
        // checkbox-select
        ofield('limits.enabled', 'boolean', 'Limit selections', { showWhen: { path: 'type', equals: 'checkbox-select' } }),
        ofield('limits.min', 'number', 'Min selections', { showWhen: { path: 'type', equals: 'checkbox-select' } }),
        ofield('limits.max', 'number', 'Max selections', { showWhen: { path: 'type', equals: 'checkbox-select' } }),
        {
          key: 'choices', type: 'list', label: 'Choices', required: true, showWhen: { path: 'type', equals: 'checkbox-select' },
          element: { itemLabel: '{title}', objectFields: [
            { key: 'title', type: 'text', label: 'Title' },
            { key: 'description', type: 'text', label: 'Description' },
            { key: 'selectedByDefault', type: 'boolean', label: 'Selected by default' },
          ] },
        },
        // text-display
        ofield('textContents', 'text', 'Text contents', { required: true, showWhen: { path: 'type', equals: 'text-display' } }),
      ],
    },
  },
};

// ─── open-ticket: config/options.jsonc (array root, type-discriminated) ───

const WT: ShowWhen = { path: 'type', equals: 'ticket' };

const openTicketOptions: ConfigManifest = {
  match: { urlContains: 'open-ticket' },
  target: 'options.jsonc',
  format: 'json',
  root: {
    type: 'list', label: 'Options', target: j(''),
    help: 'Ticket buttons/dropdown entries. Type chooses what the option does.',
    element: {
      itemLabel: '{name} ({type})',
      objectFields: [
        // common
        ofield('id', 'text', 'Option ID', { required: true }),
        ofield('name', 'text', 'Name', { required: true }),
        ofield('description', 'text', 'Description'),
        ofield('type', 'select', 'Type', { required: true, default: 'ticket', options: opts(['ticket', 'website', 'role', 'sub-panel']) }),
        ofield('button.emoji', 'text', 'Button emoji'),
        ofield('button.label', 'text', 'Button label'),
        ofield('button.color', 'select', 'Button color', { options: opts(['gray', 'red', 'green', 'blue']), showWhen: { path: 'type', notEquals: 'website' } }),
        // website
        ofield('url', 'text', 'Website URL', { required: true, showWhen: { path: 'type', equals: 'website' } }),
        // sub-panel
        ofield('subPanelId', 'text', 'Sub-panel ID', { required: true, showWhen: { path: 'type', equals: 'sub-panel' } }),
        // role
        { key: 'roles', type: 'list', label: 'Roles', required: true, showWhen: { path: 'type', equals: 'role' }, element: roleListEl },
        ofield('mode', 'select', 'Mode', { options: opts(['add&remove', 'add', 'remove']), showWhen: { path: 'type', equals: 'role' } }),
        { key: 'removeRolesOnAdd', type: 'list', label: 'Remove roles on add', showWhen: { path: 'type', equals: 'role' }, element: roleListEl },
        ofield('addOnMemberJoin', 'boolean', 'Add roles on member join', { showWhen: { path: 'type', equals: 'role' } }),
        // ticket
        { key: 'questions', type: 'list', label: 'Questions', showWhen: WT, element: { field: { type: 'text', label: 'Question ID' } } },
        { key: 'ticketAdmins', type: 'list', label: 'Ticket admins', showWhen: WT, element: roleListEl },
        { key: 'readonlyAdmins', type: 'list', label: 'Read-only admins', showWhen: WT, element: roleListEl },
        ofield('allowCreationByBlacklistedUsers', 'boolean', 'Allow blacklisted users', { showWhen: WT }),
        ofield('channel.prefix', 'text', 'Channel prefix', { showWhen: WT }),
        ofield('channel.suffix', 'select', 'Channel suffix', { options: opts(['user-name', 'user-id', 'random-number', 'random-hex', 'counter-dynamic', 'counter-fixed']), showWhen: WT }),
        ofield('channel.category', 'channel-id', 'Channel category', { placeholders: ['DISCORD_CATEGORY_ID'], showWhen: WT }),
        ofield('channel.topic', 'text', 'Channel topic', { showWhen: WT }),
        ofield('dmMessage.enabled', 'boolean', 'DM message enabled', { showWhen: WT }),
        ofield('dmMessage.text', 'text', 'DM message text', { showWhen: WT }),
        ...embedFields('dmMessage.embed', false, WT),
        ofield('ticketMessage.enabled', 'boolean', 'Ticket message enabled', { showWhen: WT }),
        ofield('ticketMessage.text', 'text', 'Ticket message text', { showWhen: WT }),
        ...embedFields('ticketMessage.embed', false, WT),
        ofield('ticketMessage.ping.@here', 'boolean', 'Ping @here', { showWhen: WT }),
        ofield('ticketMessage.ping.@everyone', 'boolean', 'Ping @everyone', { showWhen: WT }),
        { key: 'ticketMessage.ping.custom', type: 'list', label: 'Ping roles', showWhen: WT, element: roleListEl },
        ofield('autoclose.enableInactiveHours', 'boolean', 'Autoclose on inactivity', { showWhen: WT }),
        ofield('autoclose.inactiveHours', 'number', 'Autoclose inactive hours', { showWhen: WT }),
        ofield('autoclose.enableUserLeave', 'boolean', 'Autoclose on user leave', { showWhen: WT }),
        ofield('autoclose.disableOnClaim', 'boolean', 'Autoclose disabled on claim', { showWhen: WT }),
        ofield('autodelete.enableInactiveDays', 'boolean', 'Autodelete on inactivity', { showWhen: WT }),
        ofield('autodelete.inactiveDays', 'number', 'Autodelete inactive days', { showWhen: WT }),
        ofield('autodelete.enableUserLeave', 'boolean', 'Autodelete on user leave', { showWhen: WT }),
        ofield('autodelete.disableOnClaim', 'boolean', 'Autodelete disabled on claim', { showWhen: WT }),
        ofield('cooldown.enabled', 'boolean', 'Cooldown enabled', { showWhen: WT }),
        ofield('cooldown.cooldownMinutes', 'number', 'Cooldown minutes', { showWhen: WT }),
        ofield('limits.enabled', 'boolean', 'Limits enabled', { showWhen: WT }),
        ofield('limits.globalMaximum', 'number', 'Global maximum', { showWhen: WT }),
        ofield('limits.userMaximum', 'number', 'User maximum', { showWhen: WT }),
        ofield('slowMode.enabled', 'boolean', 'Slow mode enabled', { showWhen: WT }),
        ofield('slowMode.slowModeSeconds', 'number', 'Slow mode seconds', { showWhen: WT }),
      ],
    },
  },
};

// ─── lavamusic: Lavalink/application.yml (audio server config) ───
//
// The bot itself is env-configured (TOKEN, PREFIX, ...); this YAML is the bundled
// Lavalink audio server, surfaced because lavamusic's compose bind-mounts it. The
// form covers the parts users actually touch (node password, sources + their
// credentials, lyrics, logging), not every Lavalink tuning knob.

const LAVA_LOG_LEVELS = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'OFF'];

const LAVASRC_SOURCES: Array<[string, string]> = [
  ['spotify', 'Spotify'], ['applemusic', 'Apple Music'], ['deezer', 'Deezer'],
  ['tidal', 'Tidal'], ['qobuz', 'Qobuz'], ['yandexmusic', 'Yandex Music'],
  ['vkmusic', 'VK Music'], ['jiosaavn', 'JioSaavn'], ['pandora', 'Pandora'],
  ['flowerytts', 'FloweryTTS'], ['youtube', 'YouTube (LavaSrc)'], ['ytdlp', 'yt-dlp'],
];
const lavaSrcSourceFields = LAVASRC_SOURCES.map(([k, l]) => yBool(`plugins.lavasrc.sources.${k}`, l, true));

const lavamusicLavalink: ConfigManifest = {
  match: { urlContains: 'lavamusic' },
  target: 'application.yml',
  format: 'yaml',
  sections: [
    {
      id: 'node',
      title: 'Lavalink Node',
      help: 'The bundled Lavalink audio server. The password must match the node authorization the bot connects with (its NODES env var, default "youshallnotpass").',
      fields: [
        { type: 'text', label: 'Node Password', default: 'youshallnotpass', help: 'Shared secret between the bot and Lavalink. If you change it here, update the NODES authorization to match or playback breaks.', target: y('lavalink.server.password') },
        { type: 'number', label: 'Port', default: 2333, help: 'Leave at 2333 unless you also change the bot\'s NODES port.', target: y('server.port') },
        { type: 'text', label: 'Bind Address', default: '0.0.0.0', target: y('server.address') },
      ],
    },
    {
      id: 'builtinSources',
      title: 'Built-in Sources',
      help: 'Lavalink\'s native sources and search. Lavamusic plays YouTube through the YouTube plugin below, so the built-in YouTube source is usually left off.',
      columns: 2,
      fields: [
        yBool('lavalink.server.sources.youtube', 'Built-in YouTube source', false),
        yBool('lavalink.server.youtubeSearchEnabled', 'YouTube search', true),
        yBool('lavalink.server.soundcloudSearchEnabled', 'SoundCloud search', true),
      ],
    },
    {
      id: 'quality',
      title: 'Audio Quality',
      columns: 2,
      fields: [
        { type: 'number', label: 'Opus Encoding Quality (0-10)', default: 5, target: y('lavalink.server.opusEncodingQuality') },
        { type: 'select', label: 'Resampling Quality', default: 'MEDIUM', options: opts(['HIGH', 'MEDIUM', 'LOW', 'NONE']), target: y('lavalink.server.resamplingQuality') },
      ],
    },
    {
      id: 'youtubePlugin',
      title: 'YouTube Plugin',
      help: 'The YouTube source plugin lavamusic uses for playback and search.',
      toggle: { target: y('plugins.youtube.enabled'), default: true, disabledBehavior: 'set-false' },
      columns: 2,
      fields: [
        yBool('plugins.youtube.allowSearch', 'Allow search', true),
        yBool('plugins.youtube.allowDirectVideoIds', 'Allow direct video IDs', true),
        yBool('plugins.youtube.allowDirectPlaylistIds', 'Allow direct playlist IDs', true),
      ],
    },
    {
      id: 'extraSources',
      title: 'Extra Sources (LavaSrc)',
      help: 'Enable extra music sources. Most need the credentials in their sub-section to actually resolve tracks.',
      sections: [
        { id: 'lavasrcEnabled', title: 'Enabled Sources', columns: 2, fields: lavaSrcSourceFields },
        {
          id: 'lavasrcSpotify', title: 'Spotify',
          help: 'Spotify resolves via a custom token endpoint.',
          fields: [
            { type: 'text', label: 'Country Code', default: 'US', target: y('plugins.lavasrc.spotify.countryCode') },
            { type: 'text', label: 'Custom Token Endpoint', default: '', target: y('plugins.lavasrc.spotify.customTokenEndpoint') },
            { type: 'number', label: 'Playlist Load Limit', default: 6, target: y('plugins.lavasrc.spotify.playlistLoadLimit') },
            { type: 'number', label: 'Album Load Limit', default: 6, target: y('plugins.lavasrc.spotify.albumLoadLimit') },
          ],
        },
        {
          id: 'lavasrcApple', title: 'Apple Music',
          fields: [
            { type: 'text', label: 'Country Code', default: 'US', target: y('plugins.lavasrc.applemusic.countryCode') },
            { type: 'password', label: 'Media API Token', sensitive: true, target: y('plugins.lavasrc.applemusic.mediaAPIToken') },
          ],
        },
        {
          id: 'lavasrcDeezer', title: 'Deezer',
          fields: [
            { type: 'password', label: 'Master Decryption Key', sensitive: true, target: y('plugins.lavasrc.deezer.masterDecryptionKey') },
            { type: 'password', label: 'ARL', sensitive: true, target: y('plugins.lavasrc.deezer.arl') },
          ],
        },
        {
          id: 'lavasrcTidal', title: 'Tidal',
          fields: [
            { type: 'text', label: 'Country Code', default: 'US', target: y('plugins.lavasrc.tidal.countryCode') },
            { type: 'password', label: 'Token', sensitive: true, target: y('plugins.lavasrc.tidal.token') },
            { type: 'number', label: 'Search Limit', default: 6, target: y('plugins.lavasrc.tidal.searchLimit') },
          ],
        },
      ],
    },
    {
      id: 'lyrics',
      title: 'Lyrics',
      help: 'Lyrics sources and the Genius API key (Genius improves match quality).',
      fields: [
        { type: 'text', label: 'Country Code', default: 'en-AU', target: y('plugins.lyrics.countryCode') },
        { type: 'password', label: 'Genius API Key', sensitive: true, target: y('plugins.lyrics.geniusApiKey') },
        {
          type: 'list', label: 'Lyrics Sources (in order)', default: [], target: y('plugins.lavalyrics.sources'),
          element: { field: { type: 'select', label: 'Source', options: opts(['genius', 'spotify', 'youtube', 'deezer', 'yandexMusic']) } },
        },
      ],
    },
    {
      id: 'logging',
      title: 'Logging',
      columns: 2,
      fields: [
        { type: 'select', label: 'Root Log Level', default: 'INFO', options: opts(LAVA_LOG_LEVELS), target: y('logging.level.root') },
        { type: 'select', label: 'Lavalink Log Level', default: 'INFO', options: opts(LAVA_LOG_LEVELS), target: y('logging.level.lavalink') },
      ],
    },
  ],
};

// ─── nadeko: src/NadekoBot/data/creds_example.yml -> /app/data/creds.yml ───
//
// File-configured bot (reads creds.yml, not env). Surfaced via the manifest's
// `source` declaration; the example sibling uses an underscore infix so repoPath
// points at it directly. Token lives in-file (isBotToken). `version` is
// deliberately not surfaced (the file marks it "DO NOT CHANGE").

const nadekoCreds: ConfigManifest = {
  match: { urlContains: 'nadeko' },
  target: 'creds.yml',
  format: 'yaml',
  source: { repoPath: 'src/NadekoBot/data/creds_example.yml', inContainerPath: '/app/data/creds.yml' },
  sections: [
    {
      id: 'identity', title: 'Identity & Connection',
      fields: [
        { type: 'password', label: 'Bot Token', required: true, sensitive: true, isBotToken: true, help: 'Your Discord bot token from the Developer Portal.', target: y('token') },
        { type: 'list', label: 'Owner IDs', help: 'Users with full bot-owner permissions. Do not add people you do not trust.', default: [], target: y('ownerIds'), element: { field: { type: 'user-id', label: 'Owner' } } },
        yBool('usePrivilegedIntents', 'Use privileged intents', true),
        { type: 'number', label: 'Total Shards', default: 1, target: y('totalShards') },
      ],
    },
    {
      id: 'database', title: 'Database',
      fields: [
        { type: 'select', label: 'Type', default: 'sqlite', options: opts(['sqlite']), help: 'Only sqlite is supported.', target: y('db.type') },
        { type: 'text', label: 'Connection String', default: 'Data Source=data/NadekoBot.db', target: y('db.connectionString') },
      ],
    },
    {
      id: 'cache', title: 'Caching',
      fields: [
        { type: 'select', label: 'Bot Cache', default: 'Memory', options: opts(['Memory', 'Redis']), help: 'Memory = in-process (resets on restart). Redis = persistent (set the connection below).', target: y('botCache') },
        { type: 'text', label: 'Redis Connection', default: 'localhost:6379,syncTimeout=30000,responseTimeout=30000,allowAdmin=true,password=', help: 'Only used when Bot Cache is Redis.', target: y('redisOptions') },
      ],
    },
    {
      id: 'google', title: 'Google APIs',
      fields: [
        { type: 'password', label: 'Google API Key', sensitive: true, help: 'YouTube Data API key.', target: y('googleApiKey') },
        { type: 'text', label: 'Search Engine ID', target: y('google.searchId') },
        { type: 'text', label: 'Image Search Engine ID', target: y('google.imageSearchId') },
      ],
    },
    {
      id: 'ai', title: 'AI',
      fields: [
        { type: 'password', label: 'Nadeko AI Token', sensitive: true, target: y('nadekoAiToken') },
        { type: 'password', label: 'AI API Key', sensitive: true, help: 'OpenAI-compatible API key for the AI agent.', target: y('aiApiKey') },
      ],
    },
    {
      id: 'votes', title: 'Bot Lists & Votes',
      fields: [
        { type: 'password', label: 'DiscordBotList Token', sensitive: true, target: y('botListToken') },
        { type: 'text', label: 'Top.gg Service URL', target: y('votes.topggServiceUrl') },
        { type: 'password', label: 'Top.gg Key', sensitive: true, target: y('votes.topggKey') },
        { type: 'text', label: 'Discords Service URL', target: y('votes.discordsServiceUrl') },
        { type: 'password', label: 'Discords Key', sensitive: true, target: y('votes.discordsKey') },
      ],
    },
    {
      id: 'patreon', title: 'Patreon',
      fields: [
        { type: 'text', label: 'Client ID', target: y('patreon.clientId') },
        { type: 'password', label: 'Access Token', sensitive: true, target: y('patreon.accessToken') },
        { type: 'password', label: 'Refresh Token', sensitive: true, target: y('patreon.refreshToken') },
        { type: 'password', label: 'Client Secret', sensitive: true, target: y('patreon.clientSecret') },
        { type: 'text', label: 'Campaign ID', target: y('patreon.campaignId') },
      ],
    },
    {
      id: 'apikeys', title: 'Other API Keys',
      columns: 2,
      fields: [
        { type: 'password', label: 'RapidAPI Key', sensitive: true, target: y('rapidApiKey') },
        { type: 'password', label: 'osu! API Key', sensitive: true, target: y('osuApiKey') },
        { type: 'password', label: 'Steam API Key', sensitive: true, target: y('steamApiKey') },
        { type: 'text', label: 'Trovo Client ID', target: y('trovoClientId') },
        { type: 'text', label: 'Twitch Client ID', target: y('twitchClientId') },
        { type: 'password', label: 'Twitch Client Secret', sensitive: true, target: y('twitchClientSecret') },
        { type: 'password', label: 'LocationIQ API Key', sensitive: true, target: y('locationIqApiKey') },
        { type: 'password', label: 'TimezoneDB API Key', sensitive: true, target: y('timezoneDbApiKey') },
        { type: 'password', label: 'CoinMarketCap API Key', sensitive: true, target: y('coinmarketcapApiKey') },
      ],
    },
    {
      id: 'advanced', title: 'Advanced',
      fields: [
        { type: 'text', label: 'Coordinator URL', default: 'http://localhost:3442', target: y('coordinatorUrl') },
        { type: 'text', label: 'Restart Command', target: y('restartCommand.cmd') },
        { type: 'text', label: 'Restart Args', target: y('restartCommand.args') },
        { type: 'text', label: 'Seq URL', target: y('seq.url') },
        { type: 'password', label: 'Seq API Key', sensitive: true, target: y('seq.apiKey') },
      ],
    },
  ],
};

// ─── discord-tickets: src/user/config.yml -> /home/container/user/config.yml ───
//
// The bot token + DB + secrets are ENV vars (DISCORD_TOKEN, ...), surfaced by the
// env rows, so this file's manifest has NO in-file token (no isBotToken).

const discordTicketsConfig: ConfigManifest = {
  match: { urlContains: 'discord-tickets' },
  target: 'config.yml',
  format: 'yaml',
  source: { repoPath: 'src/user/config.yml', inContainerPath: '/home/container/user/config.yml' },
  sections: [
    {
      id: 'logging', title: 'Logging',
      fields: [
        { type: 'select', label: 'Log Level', default: 'info', options: opts(['debug', 'info', 'notice', 'warn', 'error']), target: y('logs.level') },
      ],
      sections: [
        {
          id: 'logFiles', title: 'Log Files',
          toggle: { target: y('logs.files.enabled'), default: true, disabledBehavior: 'set-false' },
          fields: [
            { type: 'text', label: 'Directory', default: './logs', target: y('logs.files.directory') },
            { type: 'number', label: 'Keep For (days)', default: 30, target: y('logs.files.keepFor') },
          ],
        },
      ],
    },
    {
      id: 'presence', title: 'Presence',
      help: 'Bot status and rotating activities. Activity text supports {totalTickets}, {openTickets}, {avgResponseTime}, {avgRating}.',
      fields: [
        { type: 'select', label: 'Status', default: 'online', options: opts(['online', 'idle', 'dnd', 'invisible']), target: y('presence.status') },
        { type: 'number', label: 'Rotation Interval (seconds)', default: 20, target: y('presence.interval') },
        {
          type: 'list', label: 'Activities', default: [], target: y('presence.activities'),
          element: {
            itemLabel: '{name}',
            objectFields: [
              ofield('name', 'text', 'Text', { required: true }),
              ofield('type', 'number', 'Type', { help: '0 Playing, 1 Streaming, 2 Listening, 3 Watching, 5 Competing' }),
            ],
          },
        },
      ],
    },
    {
      id: 'general', title: 'General',
      fields: [
        { type: 'text', label: 'Transcript Template', default: 'transcript.md', target: y('templates.transcript') },
        yBool('stats', 'Send anonymous stats', true),
        yBool('updates', 'Check for updates', true),
      ],
    },
  ],
};

export const INSTALL_MANIFESTS: ConfigManifest[] = [
  openTicketGeneral,
  openTicketTranscripts,
  openTicketPanels,
  openTicketQuestions,
  openTicketOptions,
  lavamusicLavalink,
  nadekoCreds,
  discordTicketsConfig,
];

/**
 * Find the manifest for a given source URL + config file basename, if any.
 */
export function findManifest(url: string, targetName: string): ConfigManifest | undefined {
  const target = (targetName || '').toLowerCase();
  return INSTALL_MANIFESTS.find(
    m => matchesSource(m.match, url) && m.target.toLowerCase() === target,
  );
}

function readFileSafe(p: string): string {
  try { return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : ''; } catch { return ''; }
}

/**
 * Config files a manifest explicitly declares via `source` (repoPath +
 * in-container path), for a given source URL + cloned repo. Surfaces a bot's
 * config the detector misses (too deep, no compose bind, or named-volume
 * delivery) with ZERO noise: only declared files appear. The repo file is read
 * directly, or via findConfigTemplate when shipped as an example sibling. Any
 * file the detector already surfaced is skipped (dedupe by in-container path or
 * target name) so detection output always wins.
 */
export function manifestDeclaredConfigFiles(
  url: string,
  repoPath: string,
  existing: DetectedConfigFile[],
): DetectedConfigFile[] {
  const out: DetectedConfigFile[] = [];
  const taken = (p: string, t: string) =>
    existing.some(e => e.inContainerPath === p || e.targetName.toLowerCase() === t.toLowerCase()) ||
    out.some(e => e.inContainerPath === p || e.targetName.toLowerCase() === t.toLowerCase());
  for (const m of INSTALL_MANIFESTS) {
    if (!m.source || !matchesSource(m.match, url)) continue;
    const direct = path.join(repoPath, m.source.repoPath);
    let repoFile: string | null = null;
    try {
      if (fs.existsSync(direct) && fs.statSync(direct).isFile()) repoFile = direct;
      else repoFile = findConfigTemplate(direct);
    } catch {
      repoFile = null;
    }
    if (!repoFile) continue;
    const rawBody = readFileSafe(repoFile).slice(0, 65536);
    if (!rawBody.trim()) continue;
    if (taken(m.source.inContainerPath, m.target)) continue;
    out.push({
      exampleName: path.relative(repoPath, repoFile).split(path.sep).join('/'),
      targetName: m.target,
      format: m.format,
      inContainerPath: m.source.inContainerPath,
      keys: extractConfigKeys(rawBody, m.format),
      rawBody,
    });
  }
  return out;
}

// ─── body helpers used by the install/config routes ───

function eachField(sections: SectionDescriptor[], fn: (f: FieldDescriptor) => void): void {
  for (const sec of sections) {
    for (const f of (sec.fields || [])) fn(f);
    if (sec.sections) eachField(sec.sections, fn);
  }
}

function getAtPath(obj: unknown, path: string): unknown {
  let cur: any = obj;
  for (const seg of splitPath(path)) { if (cur == null) return undefined; cur = cur[seg]; }
  return cur;
}

function isSeedScalar(field: FieldDescriptorBase | undefined, val: unknown): boolean {
  return typeof val === 'string' && !!field && Array.isArray(field.placeholders) && field.placeholders.includes(val);
}

function isSeedElement(element: ListElement, item: unknown): boolean {
  if (element.field) return isSeedScalar(element.field, item);
  if (element.objectFields) {
    if (item == null || typeof item !== 'object') return false;
    const o = item as Record<string, unknown>;
    return element.objectFields.every(of => isSeedScalar(of, o[of.key]));
  }
  return false;
}

/**
 * Drop list rows that are still the shipped placeholder sentinel (e.g. a
 * globalAdmins seeded with "DISCORD_ROLE_ID"), since a bot's config checker
 * rejects sentinel IDs and refuses to boot. General over any manifest: a list
 * element whose value (scalar) or whose every object field equals a declared
 * placeholder is a seed row and is removed from the delivered body.
 */
export function sanitizeSeedRows(manifest: ConfigManifest, body: string): string {
  const parsed = parseConfig(manifest.format, body);
  if (!parsed.ok) return body;
  const ops: ConfigOp[] = [];
  eachField(manifest.sections || [], f => {
    if (f.type !== 'list' || !f.element || f.target.kind === 'env') return;
    const arr = getAtPath(parsed.data, f.target.path);
    if (!Array.isArray(arr)) return;
    const cleaned = arr.filter(item => !isSeedElement(f.element as ListElement, item));
    if (cleaned.length !== arr.length) ops.push({ path: f.target.path, value: cleaned });
  });
  return ops.length ? serializeConfig(manifest.format, body, ops) : body;
}

/** True when the manifest configures the BOT token via an in-file field (marked
 * isBotToken), so callers can avoid also demanding it as a required env var.
 * Incidental secrets (API keys, node passwords) are NOT bot tokens and must not
 * trip this, or a bot whose real token IS an env var would lose its required
 * field. */
export function manifestHasInFileToken(manifest: ConfigManifest): boolean {
  let has = false;
  eachField(manifest.sections || [], f => { if (f.isBotToken) has = true; });
  return has;
}
