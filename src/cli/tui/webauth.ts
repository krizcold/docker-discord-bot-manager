import { Bot, botName, setWebAuth, WebAuthMode } from './api';
import { Dialog, DialogKey } from './dialog';
import { wrap } from './install';
import type { Session } from './session';

/** `shared`: the notice goes to the Session, where the outcome that lands later replaces it. */
export type WebAuthExit = { quit: true } | { leave: true; notice?: string; shared?: true } | undefined;

type WebAuthKey = DialogKey & { escape?: boolean; return?: boolean };

/** The options of the page's web auth select (index.html:1671 to :1673). */
export const WEB_AUTH_MODES: Array<{ mode: WebAuthMode; label: string }> = [
  { mode: 'auto', label: 'Auto' },
  { mode: 'managed', label: 'Managed' },
  { mode: 'public', label: 'Public' },
];

/** The select's title text (index.html:1670). */
export const WEB_AUTH_TITLE = "Public URL access: Auto detects self-authenticating bots, Managed puts the bot behind the stack's Authelia SSO login (optional MFA), Public disables auth. Applies on the bot's next Update or Build.";

/** setBotWebAuth's texts (index.html:1971, :1972) and showNoAnswer('web auth change', true) (:1400). */
export const WEB_AUTH_SAVED = 'Web auth mode saved: applies on the next Update or Build';
export const WEB_AUTH_NO_ANSWER = "No answer from the manager, so the web auth change can't be confirmed. Check whether it took effect before trying again.";

const label = (mode: WebAuthMode): string => WEB_AUTH_MODES.find((m) => m.mode === mode)?.label ?? mode;

/** The mode the page's select shows (index.html:1668): the bot's webAuth, Auto when it has none. */
export function webAuthOf(bot: Bot | undefined): WebAuthMode {
  const m = bot?.webAuth;
  return m === 'managed' || m === 'public' ? m : 'auto';
}

type Stage = 'pick' | 'ask' | 'sending' | 'ended';

/** The web login picker of one bot; the mark follows the newest list read, and a change asks Y before it is sent. */
export class WebAuthScreen {
  stage: Stage = 'pick';
  pick = 0;
  private dialog: Dialog | null = null;
  private left = false;
  readonly name: string;
  private readonly opened: Bot;

  constructor(private readonly session: Session, readonly botId: string, opened: Bot) {
    this.opened = opened;
    this.name = botName(opened);
  }

  private current(): WebAuthMode {
    return webAuthOf(this.session.bot(this.botId) ?? this.opened);
  }

  open(): void {
    this.pick = Math.max(WEB_AUTH_MODES.findIndex((m) => m.mode === this.current()), 0);
  }

  close(): void {
    this.left = true;
    this.dialog = null;
  }

  private leave(notice?: string): WebAuthExit {
    this.left = true;
    this.dialog = null;
    if (this.session.held.webAuth === this) this.session.held.webAuth = undefined;
    return { leave: true, ...(notice ? { notice, shared: true as const } : {}) };
  }

  private async send(mode: WebAuthMode): Promise<void> {
    const s = this.session;
    if (s.webAuthBusy.has(this.botId)) return;
    const block = s.sendBlock(this.botId);
    if (block) {
      this.stage = 'ended';
      this.dialog = null;
      if (s.held.webAuth === this) s.held.webAuth = undefined;
      s.notice = block;
      s.changed();
      return;
    }
    s.webAuthBusy.set(this.botId, this.name);
    this.stage = 'sending';
    this.dialog = null;
    s.changed();
    let text: string;
    try {
      const r = await setWebAuth(s.client, this.botId, mode);
      text = r.ok === true ? WEB_AUTH_SAVED : r.ok === null ? WEB_AUTH_NO_ANSWER : r.text;
    } finally {
      s.webAuthBusy.delete(this.botId);
    }
    this.stage = 'ended';
    if (s.held.webAuth === this) s.held.webAuth = undefined;
    s.report(this.name, text);
  }

  key(input: string, key: WebAuthKey): WebAuthExit {
    if (this.stage === 'sending') {
      if (!key.escape) return undefined;
      return this.leave(`The web login change of ${this.name} goes on; its outcome shows here when the manager answers.`);
    }
    if (this.stage === 'ended') return this.leave();
    if (this.stage === 'ask' && this.dialog) {
      const d = this.dialog;
      const out = d.key(input, key);
      if (out === null) {
        this.session.changed();
        return undefined;
      }
      if (out === 'yes') {
        d.run();
        return undefined;
      }
      this.dialog = null;
      this.stage = 'pick';
      this.session.changed();
      return undefined;
    }
    if (key.escape) return this.leave();
    if (input.toLowerCase() === 'q') return { quit: true };
    if (key.upArrow || key.downArrow) {
      const n = WEB_AUTH_MODES.length;
      this.pick = key.upArrow ? (this.pick + n - 1) % n : (this.pick + 1) % n;
      this.session.changed();
      return undefined;
    }
    if (!key.return) return undefined;
    if (this.session.webAuthBusy.has(this.botId)) return undefined;
    const next = WEB_AUTH_MODES[this.pick].mode;
    const old = this.current();
    if (next === old) return undefined;
    this.stage = 'ask';
    this.dialog = new Dialog(
      [`Web login of ${this.name}`, ''],
      (width) => [
        ...wrap(`Change the public URL login of ${this.name} from ${label(old)} to ${label(next)}? It applies on the bot's next Update or Build.`, width),
        '',
        ...wrap(WEB_AUTH_TITLE, width),
      ],
      `Y Set ${label(next)}`,
      () => void this.send(next),
    );
    this.session.changed();
    return undefined;
  }

  view(width: number, room: number): { body: string[]; highlight?: number; keys: string } {
    if (this.stage === 'sending') {
      return { body: [`Web login of ${this.name}`, '', ...wrap(`Asked the manager to change the web login of ${this.name}; waiting for the answer.`, width)], keys: 'Esc Back' };
    }
    if (this.stage === 'ask' && this.dialog) return this.dialog.view(width, room);
    const cur = this.current();
    const head = [`Web login of ${this.name}`, ''];
    const rows = WEB_AUTH_MODES.map((m, i) => `${i === this.pick ? '>' : ' '} ${m.label}${m.mode === cur ? '  (current)' : ''}`);
    const picked = WEB_AUTH_MODES[this.pick].mode;
    return {
      body: [...head, ...rows, '', ...wrap(WEB_AUTH_TITLE, width)],
      highlight: head.length + this.pick,
      keys: [...(picked !== cur ? ['Enter Change'] : []), 'Up/Down Pick', 'Esc Back', 'Q Quit'].join('  '),
    };
  }
}
