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
import { matchesSource, SourceMatch } from './sourceMatch';
import { parseConfig, serializeConfig, ConfigOp } from './configSerializer';
import { splitPath } from './configPath';

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
  sections?: SectionDescriptor[];    // object-root config (sections of fields)
  root?: FieldDescriptor;            // array-root config: a single 'list' field over the whole file (target.path '')
}

// ─── Manifest authoring helpers (build data concisely; no per-bot logic) ───

function j(path: string): FieldTarget {
  return { kind: 'json', path };
}
function opts(values: string[]): SelectOption[] {
  return values.map(value => ({ value }));
}
function boolField(path: string, label: string, def: boolean): FieldDescriptor {
  return { type: 'boolean', label, default: def, target: j(path) };
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
        { type: 'password', label: 'Bot Token', required: true, sensitive: true, placeholders: ['INSERT_BOT_TOKEN'], help: 'Your Discord bot token. Or enable "Read token from .env" below to use the TOKEN env var instead.', target: j('token') },
        { type: 'boolean', label: 'Read token from .env (TOKEN)', default: false, target: j('tokenFromENV') },
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

export const INSTALL_MANIFESTS: ConfigManifest[] = [
  openTicketGeneral,
  openTicketTranscripts,
  openTicketPanels,
  openTicketQuestions,
  openTicketOptions,
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

/** True when the manifest configures the bot token via an in-file field (a
 * password field), so callers can avoid also demanding it as a required env var. */
export function manifestHasInFileToken(manifest: ConfigManifest): boolean {
  let has = false;
  eachField(manifest.sections || [], f => { if (f.type === 'password') has = true; });
  return has;
}
