import { Bot, botName, deleteBot, DeleteAnswer, DeleteDone, DeleteFlag } from './api';
import { Dialog, DialogKey } from './dialog';
import { wrap } from './install';
import type { Session } from './session';

/** `shared`: the notice goes to the Session, where the outcome that lands later replaces it. */
export type DeleteExit = { quit: true } | { leave: true; notice?: string; shared?: true } | undefined;

type DeleteKey = DialogKey & { escape?: boolean; tab?: boolean; leftArrow?: boolean; rightArrow?: boolean };

/** showNoAnswer('delete') (index.html:1401). */
export const DELETE_NO_ANSWER = 'No answer from the manager; the delete may still be running. Check its state before trying again.';

const TRANSIENT = ['building', 'starting', 'stopping'];

/** The mode line and the uninstall step of the delete modal, by deployment mode (index.html:2032 to :2040). */
export function modeTexts(mode: string | null | undefined): { desc: string; step: string } {
  if (mode === 'casaos') return { desc: 'This will uninstall the app from CasaOS and remove the bot.', step: 'Application will be uninstalled from CasaOS' };
  if (mode === 'docker') return { desc: "This will remove the bot's containers and the bot.", step: "The bot's containers will be removed" };
  return { desc: 'This will uninstall the app and remove the bot.', step: 'Application will be uninstalled' };
}

/** updateDataWarning (index.html:2047 to :2062): three texts with the data toggle on, two with it off. */
export function dataWarning(bot: Bot | undefined, mode: string | null | undefined, deleteData: boolean): string {
  if (deleteData) {
    if (bot?.fleetDb) return 'This instance hosts the fleet database. While its volume exists the manager refuses to delete the data: decommission it on the Database modal first, which takes a safety dump';
    if (bot?.fleetDbReplica) return 'This instance holds a copy of the fleet database. While its volume exists the manager refuses to delete the data: remove the replica on the Database modal first, which keeps that volume';
    return 'All settings and user data will be permanently deleted';
  }
  return mode === 'docker'
    ? "Without data deletion, all settings and user data will be preserved in this bot's own folder on the host; a new install does not reuse that folder"
    : 'Without data deletion, all settings and user data will be preserved';
}

export interface DeleteChoice {
  deleteData: boolean;
  deleteEnv: boolean;
  /** 0: the data toggle has focus; 1: the environment toggle. */
  focus: 0 | 1;
}

/** The delete modal (index.html:767 to :806) as lines of a width. */
export function deleteLines(name: string, bot: Bot | undefined, mode: string | null | undefined, choice: DeleteChoice, width: number): string[] {
  const { desc, step } = modeTexts(mode);
  const toggle = (on: boolean, focused: boolean, label: string, help: string): string[] => [
    ...wrap(`${focused ? '>' : ' '} [${on ? 'x' : ' '}] ${label}`, width),
    ...wrap(help, width, '      '),
  ];
  return [
    ...wrap(`Are you sure you want to remove ${name}?`, width),
    ...wrap(desc, width),
    '',
    ...toggle(choice.deleteData, choice.focus === 0, 'Also delete application data', 'By default, data will be preserved. Check this to delete it permanently.'),
    ...toggle(choice.deleteEnv, choice.focus === 1, 'Also remove environment variables', 'By default, a copy goes to the Credentials Vault for recovery. Check this to delete them, even when data is preserved.'),
    '',
    'This action cannot be undone:',
    ...['Bot configuration will be permanently removed', step, dataWarning(bot, mode, choice.deleteData)].flatMap((l) => wrap(`- ${l}`, width, '  ').map((x, i) => (i === 0 ? x.slice(2) : x))),
  ];
}

/** The success text of confirmDeleteBot (index.html:2089 to :2096). */
export function deleteDoneText(done: DeleteDone, keepData: boolean, keepEnv: boolean): string {
  let msg = !keepData ? 'Bot removed'
    : done.keptDataDir ? `Bot removed; its data stays in ${done.keptDataDir}, and a new install does not reuse that folder`
      : 'Bot removed (data preserved)';
  if (done.keptReplicaVolume) msg += `; the replica volume ${done.keptReplicaVolume} that Remove replica kept was not deleted`;
  if (done.dbDumpsKept) msg += `; its ${done.dbDumpsKept.count} database ${done.dbDumpsKept.count === 1 ? 'dump stays' : 'dumps stay'} in the manager's ${done.dbDumpsKept.folder} folder`;
  if (!keepEnv) msg += done.envDeleted ? '; environment values deleted' : '; deleting the environment values could not be confirmed';
  else if (done.vaulted) msg += '; environment values copied to the vault';
  return msg;
}

/** Why the page's confirmDeleteBot would send nothing now (index.html:2072), or null. */
export function deleteBlocked(bot: Bot | undefined, frameBusy: boolean): string | null {
  if (!bot) return null;
  if (bot.activeOp) return `the operation '${bot.activeOp}' is running`;
  if (TRANSIENT.includes(bot.status ?? '')) return `it is ${bot.status}`;
  if (frameBusy) return 'an action on it is running';
  return null;
}

type Stage = 'ask' | 'sending' | 'question' | 'ended';

/**
 * The delete of one bot: the modal, its toggles, the questions the route asks and the call. It acts only on the bot it
 * was opened for; its outcome reaches the Session, so it lands even after the operator left this screen.
 */
export class DeleteScreen {
  stage: Stage = 'ask';
  readonly choice: DeleteChoice = { deleteData: false, deleteEnv: false, focus: 0 };
  private dialog: Dialog | null = null;
  private flags: DeleteFlag[] = [];
  private sent: { keepData: boolean; keepEnv: boolean } = { keepData: true, keepEnv: true };
  private left = false;
  private notice: string | null = null;
  readonly name: string;

  constructor(private readonly session: Session, readonly botId: string, opened: Bot) {
    this.name = botName(opened);
    this.opened = opened;
  }

  private readonly opened: Bot;

  /** The newest list read's bot, else the one the dialog opened for. */
  private bot(): Bot {
    return this.session.bot(this.botId) ?? this.opened;
  }

  open(): void {
    this.choice.deleteData = false;
    this.choice.deleteEnv = false;
    this.choice.focus = 0;
    this.dialog = new Dialog(
      [`Remove bot ${this.name}`, ''],
      (width) => deleteLines(this.name, this.bot(), this.session.deploymentMode, this.choice, width),
      'Y Remove bot',
      () => this.confirm(),
      { label: 'Tab Next  Space On/off', press: () => this.flip() },
    );
  }

  private flip(): void {
    if (this.choice.focus === 0) this.choice.deleteData = !this.choice.deleteData;
    else this.choice.deleteEnv = !this.choice.deleteEnv;
    this.session.changed();
  }

  close(): void {
    this.left = true;
    this.dialog = null;
  }

  private end(text: string): void {
    this.stage = 'ended';
    this.dialog = null;
    if (this.session.held.delete === this) this.session.held.delete = undefined;
    this.session.endDelete(this.botId, this.name, text);
  }

  // confirmDeleteBot (index.html:2070): the toggles as they stand at this Y.
  private confirm(): void {
    const why = deleteBlocked(this.session.bot(this.botId), this.session.busy(this.botId));
    if (why) {
      this.notice = `${this.name} is busy (${why}), so the delete was not sent.`;
      this.stage = 'ended';
      this.dialog = null;
      return;
    }
    this.sent = { keepData: !this.choice.deleteData, keepEnv: !this.choice.deleteEnv };
    this.flags = [];
    void this.send();
  }

  private async send(): Promise<void> {
    const s = this.session;
    if (s.deleting.has(this.botId)) return;
    s.deleting.set(this.botId, this.name);
    this.stage = 'sending';
    this.dialog = null;
    s.changed();
    let r: DeleteAnswer;
    try {
      r = await deleteBot(s.client, this.botId, this.sent.keepData, this.sent.keepEnv, [...this.flags]);
    } finally {
      s.deleting.delete(this.botId);
    }
    // Each question is answered by its own flag, at most two rounds (index.html:2083).
    if (r.ok === 'question' && this.flags.length < 2) {
      if (this.left) {
        this.end(`${/[.!?]$/.test(r.text) ? r.text : `${r.text}.`} Nothing was removed: the manager asked this after the delete screen closed; press X to delete again and answer it.`);
        return;
      }
      this.ask(r.text, r.flag);
      return;
    }
    if (r.ok === true) this.end(deleteDoneText(r.value, this.sent.keepData, this.sent.keepEnv));
    else if (r.ok === null) this.end(DELETE_NO_ANSWER);
    else this.end(r.text);
  }

  private ask(text: string, flag: DeleteFlag): void {
    const promoted = flag === 'confirmPromoted';
    this.stage = 'question';
    this.dialog = new Dialog(
      [`Remove bot ${this.name}`, ''],
      (width) => [...text.split('\n').flatMap((l) => (l ? wrap(l, width) : [''])), '', promoted ? 'Remove it anyway?' : 'Delete this data anyway?'],
      promoted ? 'Y Remove anyway' : 'Y Delete anyway',
      () => {
        this.flags.push(flag);
        void this.send();
      },
    );
    this.session.changed();
  }

  key(input: string, key: DeleteKey): DeleteExit {
    if (this.stage === 'sending') {
      if (!key.escape) return undefined;
      this.left = true;
      if (this.session.held.delete === this) this.session.held.delete = undefined;
      return { leave: true, notice: `The delete of ${this.name} goes on; its outcome shows here when the manager answers.`, shared: true };
    }
    if (this.stage === 'ended' || !this.dialog) return { leave: true, notice: this.notice ?? undefined };
    if (this.stage === 'ask' && (key.tab || key.leftArrow || key.rightArrow)) {
      this.choice.focus = this.choice.focus === 0 ? 1 : 0;
      this.session.changed();
      return undefined;
    }
    const d = this.dialog;
    const out = d.key(input, key);
    if (out === null) {
      this.session.changed();
      return undefined;
    }
    if (out === 'yes') {
      d.run();
      // run() may end the screen without a send (a bot that turned busy).
      if ((this.stage as Stage) === 'ended' && this.notice) {
        this.left = true;
        if (this.session.held.delete === this) this.session.held.delete = undefined;
        return { leave: true, notice: this.notice };
      }
      return undefined;
    }
    if (this.stage === 'question') {
      this.end('Nothing was removed');
      return { leave: true };
    }
    this.left = true;
    this.dialog = null;
    if (this.session.held.delete === this) this.session.held.delete = undefined;
    return { leave: true, notice: `Cancelled: ${this.name} was not removed.` };
  }

  view(width: number, room: number): { body: string[]; keys: string } {
    if (this.stage === 'sending') {
      return {
        body: [`Remove bot ${this.name}`, '', ...wrap(`Asked the manager to remove ${this.name}; waiting for the answer. Esc leaves this screen and the delete goes on.`, width)],
        keys: 'Esc Back',
      };
    }
    if (this.dialog) return this.dialog.view(width, room);
    return { body: [`Remove bot ${this.name}`], keys: 'Esc Back' };
  }
}
