// NX5's operator texts as the sheet words them (decisions 4 to 6, G7-4), with the machine names filled in.
export type To = 'Maintenance' | 'Off';

export const TX = {
  covered: (n: number, names: string) => `Every bot process the manager waited for saved what it held (${n} on ${names}).`,
  empty: (to: To) => `No bot process held a live shard claim on this database when ${to} began, so the manager waited for none.`,
  uncovered: (name: string, ago: string) => `The bot on ${name} did not confirm that it saved what it holds before its login was blocked (it last renewed its shards ${ago} ago). The manager can't confirm whether that bot still holds those changes: a bot that crashed lost them, and a bot that is only cut off keeps them until its login returns. Hand over, Push and Move by file are refused until every bot confirms: choose Running, then Maintenance again once the bot on ${name} reaches this database.`,
  update: ' If the bots run a build older than this manager, they do not answer; update them.',
  unsaved: (name: string, g: number, f: number) => `The bot on ${name} reports changes it could not save (${g} guild(s), ${f} file(s)); its log names them.`,
  unconfirmed: (name: string, u: number) => `The bot on ${name} can't confirm that every change it holds is saved (${u} save(s) the database did not answer, which may have landed).`,
  notSeen: (name: string, to: To, ago: string) => `The bot on ${name} was not waited for: its shards' claims had already expired on this database's claim clock when ${to} began (it last renewed them ${ago} ago), so other machines could already take its shards.`,
  askedBlocked: 'The login was already blocked when this order asked the bots to save, so no bot could answer. Choose Running, then Maintenance again, before a Hand over, Push or Move by file.',
  cant: (reason: string, once = '') => `The manager can't confirm which bot processes use this database (${reason}), so Hand over, Push and Move by file are refused. Choose Running, then Maintenance again${once}.`,
  noTables: 'this database has no shard claim tables',
  once: ' once the bot has served from this database',
  notWritten: (e: string) => `the save order could not be written (${e})`,
  restored: 'A whole-bot restore ran on this database during this maintenance, so changes a bot process held from before it can no longer be saved here; that loss is the restore\'s. Hand over, Push and Move by file do not need the bots\' answers to this order.',
  notAsked: "This order did not ask the bots to save: the database's save order is not the one this maintenance wrote (a switch, a restore, another order, or the database's first generation record replaced it). Choose Running, then Maintenance again, before a Hand over, Push or Move by file.",
  notAskedErr: (e: string) => `This order did not ask the bots to save: the manager could not write the save order (${e}). Choose Running, then Maintenance again, before a Hand over, Push or Move by file.`,
  unread: (e: string) => `The manager can't confirm that this order asked the bots to save: it could not read the bot's database login before writing the order (${e}). Choose Running, then Maintenance again, before a Hand over, Push or Move by file.`,
  msgWrite: (e: string) => `The manager could not write the new message to the database (${e}), so the bots that read it from there show the earlier one.`,
  msgRead: (e: string) => `The manager did not write the new message to the database, because it could not read the bot's database login (${e}), so the bots that read it from there show the earlier one.`,
  orderFail: (to: To, reason: string) => `${to} is not confirmed: the manager could not ask the bots to save (${reason}); it tries again in 30 seconds.`,
  readReason: (e: string) => `it could not read the bot's database login: ${e}`,
  finalFail: (to: To, e: string) => `${to} is not confirmed: the bot's database login is blocked with no session open, but the manager could not read whether every bot process saved what it held (${e}). It reads again every 30 seconds; Hand over, Push and Move by file are refused while this order is not confirmed.`,
  finalReason: (e: string) => `the manager could not read whether every bot process saved what it held (${e})`,
  waiting: (to: To, names: string) => new RegExp(`^${to}: waiting for the bot on ${names.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} to save what it holds \\(\\d+ of \\d+ seconds\\); this database still accepts its login\\.$`),

  // Decision 6: the lanes.
  lane: (noun: string) => `The ${noun} was refused and nothing was changed: `,
  laneUncovered: (noun: string, name: string) => `The ${noun} was refused and nothing was changed: the bot on ${name} did not confirm that it saved what it holds before its login was blocked, so a ${noun} now could drop changes it accepted. Choose Running, then Maintenance again once the bot on ${name} reaches this database.`,
  laneNoFleet: (noun: string) => `The ${noun} was refused and nothing was changed: this maintenance began before this manager asked the bots to confirm their saves. Choose Running, then Maintenance again.`,
  laneCouldNotAsk: (noun: string, e: string) => `The ${noun} was refused and nothing was changed: the manager could not ask the bots to save (${e}). Choose Running, then Maintenance again.`,
  laneUnread: (noun: string, e: string) => `The ${noun} was refused and nothing was changed: the manager can't confirm that this maintenance asked the bots to save (it could not read the bot's database login before writing the order: ${e}). Choose Running, then Maintenance again.`,
  laneReplaced: "the database's save order is not the one this maintenance wrote",
  laneOpened: (noun: string) => `The ${noun} was refused and nothing was changed: the bot's login was open after the bots confirmed (a migration ran, or the login was opened outside this manager). Choose Running, then Maintenance again.`,
  laneRead: (noun: string, e: string) => `The ${noun} was refused and nothing was changed: the manager could not read whether every bot process saved what it held (${e}). Try again.`,
  countsEnd: (name: string) => `Choose Running, then Maintenance again once the bot on ${name} can save them.`,
  cancel: (what: 'hand-over' | 'push') => `Cancel the ${what}, then choose Running, then Maintenance again`,

  // Decision 11: Running's hook answers.
  staysOrder: "the main database holds a maintenance order; it leaves when the main's state is Running.",
  staysLogin: 'the main database refuses its login; it leaves once the login is accepted and no maintenance order holds it.',
  staysFile: 'its saved maintenance state still says maintenance.',
  stays: (cause: string, db = true) => `The state is Running${db ? ", and the bot's database login is restored" : ''}, and the bot took the order, but it stays in maintenance: ${cause}`,
  unreadRunning: (why: string, db = true) => `The state is Running${db ? ", and the bot's database login is restored" : ''}, but the manager can't confirm the bot left maintenance: it could not read the main database (${why}). It leaves once a read shows nothing holds it.`,
  starting: 'The state is Running, and the bot started, but it was still starting when it took the order, so the manager can\'t confirm it runs normally: it stays in maintenance while the main database refuses its login or holds a maintenance order.',
};

/** Every character printable ASCII, so no long dash either. */
export function plain(text: string): boolean {
  return /^[\x20-\x7e]*$/.test(text);
}
