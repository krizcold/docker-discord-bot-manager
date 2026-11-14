import { ok, refused } from './m2-fake';

// Bodies of GET /api/bots/:id/fleet-replication/join-code (bots.ts:1864 to 1876), each naming the line it copies.
// "NM20:" is src/instance/fleetReplication.ts in the NM20 tree, which merges before M5.

// A join code as encodeJoinCode builds it (src/config/joinCode.ts:34): the prefix, then base64url JSON of getJoinCode's fields
// (fleetReplication.ts:988 to 997). About 400 characters, as the plan measures with NM20.
export const JOIN_CODE = 'smdbjoin1.' + Buffer.from(JSON.stringify({
  v: 1, host: 'db.example.net', port: 15432, db: 'bot_b1', fp: 'a1'.repeat(32), machine: 'db.example.net',
  repl: { user: 'smdb_repl', password: 'r'.repeat(32) }, app: { user: 'bot_b1', password: 'p'.repeat(32) },
})).toString('base64url');

// fleetReplication.ts:998 (NM20:1115).
export const joinCodeBody = (code = JOIN_CODE) => ok({ success: true, joinCode: code });

// The refusals getJoinCode answers with HTTP 200 (bots.ts:1871 sends its result as it is).
export const JOIN_REFUSALS = {
  // fleetReplication.ts:965 (NM20:1065).
  off: 'Replication is not enabled, so there is no join code.',
  // NM20:1069.
  receiving: 'This machine is receiving a bot; make the join code after the push ends (nothing was changed)',
  // NM20:1070, with a pushBroken.safetyDump.
  pushBroken: 'A push into this database did not finish; restore the dump pre-receive-2026-11-14T09-00-00-000Z.dump or receive a push again, then make the join code (nothing was changed)',
  // fleetReplication.ts:972 (NM20:1078) through dbDownText (:186) with a stopped container.
  dbDown: 'The database container is not running, so its certificate cannot be read for the join code',
  // NM20:1081.
  liveCopy: "This database is a live copy, so it makes no join code; copy the code from the main's manager",
  // NM20:1082, with the provision's error.
  roles: "The bot's database login could not be confirmed as limited to its own database (permission denied for table pg_authid), so no join code was made",
} as const;

export const joinRefused = (error: string) => ok({ success: false, error });

// The route's catch (bots.ts:1874) and its unknown bot (bots.ts:1868).
export const joinFailed500 = () => refused(500, { success: false, error: 'Error: connect ENOENT /var/run/docker.sock' });
export const joinNotFound = () => refused(404, { success: false, error: 'Bot not found' });

// A proxy's page instead of the route's JSON: no answer (M2 ruling A2).
export const joinNotJson = () => refused(502, '<html>Bad Gateway</html>');

// POST /api/bots/:id/fleet-replication (bots.ts:1919 to 1950): the lane's result plus addressesText (bots.ts:1942 to 1944).
// Enable's success (fleetReplication.ts:567) and its notes.
export const enabledBody = (over: Record<string, unknown> = {}) => ok({ success: true, restartRequired: true, certRotated: false, ...over });
// fleetReplication.ts:294 and :295.
export const URL_KEPT_E = "The Database URL was kept as it is: it changed while Enable ran, and Enable writes the managed database's address only over the value it read when it started.";
export const URL_KEPT_D = 'The Database URL was kept as it is: it changed while Disable ran, and Disable sets back only the value it read when it started.';
// addressesText (fleetJoin.ts:484), an applied list.
export const ADDRESSES_APPLIED = ' The running bot took the new database list.';
// Refusals: fleetReplication.ts:436 and :445.
export const INVALID_PORT = 'Invalid port';
export const PORT_TAKEN = 'Host port 15432 is already used by "otherbot" - pick another';
// Disable's success (fleetReplication.ts:709) and its refusal while a copy streams (:628).
export const disabledBody = (over: Record<string, unknown> = {}) => ok({ success: true, restartRequired: true, ...over });
export const STILL_STREAMING = 'Standbys are still streaming on slot(s) smdb_copy_a; stop or remove them first (nothing was disabled)';
export const replRefused = (error: string) => ok({ success: false, error });

// DELETE /api/bots/:id/fleet-replication/slots/:slot (bots.ts:1900 to 1911), dropFleetSlot (fleetReplication.ts:915).
export const droppedBody = () => ok({ success: true });
// :927 through :935, and NM20:1033 for a slot dropped whose address row stayed.
export const SLOT_STREAMING = 'a standby is streaming on smdb_copy_b; stop or remove it first';
export const SLOT_ROW_KEPT = 'the slot smdb_copy_b was dropped, but its row in the address list could not be removed (could not obtain lock on relation "addresses")';

// GET /api/bots/:id/fleet-replica with a seed in flight or stopped (fleetReplica.ts:447; SeedView of seedView).
export const seedRunning = (over: Record<string, unknown> = {}) => ({
  present: false, provisioning: { startedAt: 1_700_000_000_000, phase: 'copying', purpose: 'provision', auto: false, forSeconds: 40, cancelable: true, cancelRequested: false, ...over },
});
export const seedParked = (over: Record<string, unknown> = {}) => ({
  present: false, parkedSeed: { startedAt: 1_700_000_100_000, phase: 'copying', purpose: 'provision', auto: false, lastError: 'pg_basebackup exited with code 1', ...over },
});

// DELETE /api/bots/:id/fleet-replica/seed (bots.ts:2226 to 2245), cancelReplicaSeed (fleetReplica.ts:2086 to 2187).
export const seedQuestion = (error: string, seed: { startedAt: number; parked: boolean; committed: boolean }) => ok({
  success: false, needsConfirm: true, error, seed: { ...seed, purpose: 'provision' },
});
export const seedCancelled = () => ok({ success: true });
export const seedDismissed = () => ok({ success: true, dismissed: true });
// fleetReplica.ts:2117 and :2111.
export const TOO_LATE = 'Too late to cancel: the copy is complete and the standby is starting; remove the replica afterwards instead';
export const DIFFERENT_RUN = 'A different seed run is on this instance since this view loaded; look again before cancelling or dismissing it';

// Part 3. GET /api/bots/:id/fleet-replica on a copy (fleetReplica.ts:417 to :446): no record, a recorded copy streaming, promoted.
export const copyNoRecord = (over: Record<string, unknown> = {}) => ({ present: false, ...over });
export const copyRecorded = (live: Record<string, unknown> | null = { running: true, inRecovery: true, receiverStatus: 'streaming', caughtUp: true, replayLagSeconds: 0.2 }, over: Record<string, unknown> = {}) => ({
  present: true, record: { containerName: 'smdb-replica-b1', publicHost: 'copy.example.net', hostPort: 15433, primaryHost: 'db.example.net', primaryPort: 15432 },
  ...(live ? { live } : { probeError: 'Error response from daemon: No such container: smdb-replica-b1' }), ...over,
});
// fleetReplica.ts:456 and :457: the seed note and the seed it belongs to.
export const SEED_NOTE = 'The standby was provisioned; its seed record could not be cleared (EACCES: permission denied). The manager tries the clear again every minute, and Dismiss clears it now';

// POST /api/bots/:id/fleet-join (bots.ts:1878 to 1897), joinFleet (fleetJoin.ts:722; NM20 has the same texts).
// fleetJoin.ts:711, an applied address list (addressesText :484).
export const JOINED = 'Joined the main at db.example.net:15432. The bot uses the 2 database address(es) now. The running bot took the new database list.';
export const joinedBody = () => ok({ success: true, message: JOINED, addressCount: 2 });
// fleetJoin.ts:725 with joinCode.ts:63, and :155 through probeFailureText (:327).
export const NOT_A_CODE = 'This is not a join code: it is damaged (it does not decode)';
export const UNREACHABLE = "Can't reach the main at db.example.net:15432 (connection refused); nothing was changed. The main's machine must accept connections on that port. A machine that cannot open a port can be the main only when it runs alone.";
export const copyRefused = (error: string) => ok({ success: false, error });

// POST /api/bots/:id/fleet-replica (bots.ts:1978 to 2003), provisionFleetReplica (fleetReplica.ts:825 to 879).
export const provisionStarted = (joinMessage?: string) => ok({ success: true, started: true, ...(joinMessage ? { joinMessage } : {}) });
// A request with a join code is joined first, and every answer after that join carries its message (bots.ts:1987 to :1998).
const joinedBy = (body?: unknown) => {
  const code = (body as { joinCode?: unknown } | undefined)?.joinCode;
  return typeof code === 'string' && code.trim() ? { joinMessage: JOINED } : {};
};
export const provisionRefused = (error: string, body?: unknown) => ok({ success: false, error, ...joinedBy(body) });
// :872, the main on this machine.
export const SAME_HOST = 'That primary ("otherbot") lives on THIS machine, so a standby here survives that database\'s container dying but not this machine dying. That shape is allowed. Check the standby reports streaming once it finishes: a container that shares a docker network with the primary\'s sidecar cannot always reach its published port, and the copy can seed over a path the running standby does not have';
export const sameHostQuestion = (body?: unknown) => ok({ success: false, needsConfirm: true, error: SAME_HOST, ...joinedBy(body) });
// :974 through keptVolumeQuestion (:957 to :965) with nothing on record.
export const VOLUME = 'smdb-replica-b1-data';
export const VOLUME_QUESTION = `The replica volume ${VOLUME} already exists, and provisioning clears everything in it for good. Nothing on record says what it holds; a volume left by Remove replica can be a promoted copy with writes no other database has`;
export const volumeQuestion = (body?: unknown) => ok({ success: false, needsConfirm: true, confirmVolume: VOLUME, error: VOLUME_QUESTION, ...joinedBy(body) });
// :575 and :833.
export const NOT_JOINED = "This instance has not joined a main yet: paste the main's join code first.";
export const PROVISION_RUNNING = 'Provisioning is already running';

// DELETE /api/bots/:id/fleet-replica (bots.ts:2198 to 2216): success always carries the slot warning (:2210).
export const REMOVED_WARNING = 'The primary keeps replication slot smdb_copy_b1, which retains WAL until it is dropped there: its Database modal lists the slot with a Drop action once nothing streams on it';
export const removedBody = () => ok({ success: true, warning: REMOVED_WARNING });
// fleetReplica.ts:1230, a promoted copy; :1218, a seed running.
export const PROMOTED = "This copy no longer follows a primary: it was promoted, so the fleet may be serving from it now, and it may hold writes no other database has. Adopt it below to keep it as this machine's database. Removing it takes its container down at once; the volume is kept, and a later Provision here asks before clearing it";
export const promotedQuestion = () => ok({ success: false, needsConfirm: true, error: PROMOTED });
export const SEED_RUNNING_REMOVE = 'Provisioning is running; wait for it to finish';

// POST /api/bots/:id/fleet-replica/reseed (bots.ts:2270 to 2290), reseedStandby (fleetReplica.ts:2314 to 2385).
export const reseedStarted = () => ok({ success: true, started: true });
// :2357 with a timeline difference.
export const TIMELINE = 'The main in the join code is on timeline 3 and this copy on timeline 2, so this copy may hold changes the main lacks. Re-seed takes a dump of the copy first (kept with the backups), then replaces the copy with a fresh copy of the main.';
export const timelineQuestion = () => ok({ success: false, needsConfirm: true, error: TIMELINE });
// :2317.
export const RESEED_RUNNING = 'A seed is already running on this instance';

// POST /api/bots/:id/fleet-replica/finish-retire (bots.ts:2249 to 2263), finishPinsRetire (fleetReplica.ts:1358 to 1385).
export const retiredBody = () => ok({ success: true });
// :1365 through uneditedPinsWarning (:1395).
export const PINS_WARNING = 'The database env pins could not be removed from docker-compose.override.yml, which still set them: every start passes them to the bot, pointing it at the retired database, until those files are edited or rewritten';
// :1361 and :1369.
export const NOTHING_TO_RETIRE = 'No re-seed on this instance is waiting for its env pins to be removed (nothing was changed)';
export const PINS_LEFT = 'DATABASE_URL could still not be removed (EACCES: permission denied); the others are removed. Finish retire again once the store can be written';

// Part 4. The lane routes answer through laneRoute (bots.ts:2046 to :2064): accepted with an opId, done in the request,
// a question (409 with needsConfirm and maybe confirmFlag) or a refusal with the outcome's status.
export const laneAccepted = (opId: string) => ok({ success: true, opId });
export const laneDone = (text: string) => ok({ success: true, text });
export const laneQuestion = (error: string, confirmFlag?: string) => refused(409, { success: false, error, needsConfirm: true, ...(confirmFlag ? { confirmFlag } : {}) });
export const laneRefused = (error: string, status = 409) => refused(status, { success: false, error });
// switchDone (bots.ts:2040 to :2043): the bot row, then id, opId, success and text.
export const switchFrame = (opId: string, success: boolean, text: string, id = 'b1') => ({ displayName: 'mybot', status: 'stopped', id, opId, success, text });

// GET /api/bots/:id/fleet-switch with streamingCopies (fleetSwitch.ts:1774).
export const copyOf = (machine: string, streaming = true, slot = `smdb_copy_${machine.replace(/[^a-z0-9]/g, '_').slice(0, 40)}`) => ({ slot, machine, streaming });

// busyText (fleetSwitch.ts:386) through startLane (:396).
export const LANE_BUSY = "Operation 'backup' is running on this bot; wait for it to finish; nothing was changed";
// Hand-over. heldVerdict's question (fleetSwitch.ts:234) through provenMaintenance (:491).
export const HELD_QUESTION = 'The bot was stopped without confirming that it saved what it held. Whatever it had not saved was lost at that stop, not by this hand-over, which loses nothing more. Hand over anyway?';
// :597, before admit.
export const NOT_STREAMING = 'The copy yundera is not streaming from this database now (not connected), so it cannot prove it holds every change; start it on its machine and try again; nothing was changed';
// :701, the frame's success text.
export const HANDED_OVER = "The main database on this machine is stopped, and the live copy on yundera holds every change it had. Open yundera's manager and press Take over in the bot's Database window. This machine rejoins as a copy of yundera by itself once yundera is the main; until then its database stays stopped, unless you Cancel the hand-over.";
// :683 with SWITCH_TIMING.catchUpMs (:33), a frame's failure after admit.
export const CATCH_UP_FAILED = "The copy yundera did not reach this database's position within 60 seconds (12345 bytes behind, streaming); the hand-over was undone, and the database and the bot are as they were. Check the copy's link and try again.";

// Cancel (cancelMove, fleetSwitch.ts:715). The questions: a push (:723), a move by file (:729), a stream whose target was
// not confirmed (:742), a cancel the copy has not received (:757).
export const CANCEL_PUSH_Q = "The push to yundera did not finish here. Cancel only if yundera's manager does not show the database as received: cancelling keeps this machine's database as the main. Cancel the push?";
export const CANCEL_FILE_Q = 'Cancel the move only if the backup pre-move-2026-11-14T09-00-00-000Z.dump was not restored on another machine: if it was, two machines would each run the bot as the main. Cancel the move?';
export const CANCEL_STREAM_Q = "The manager can't confirm whether yundera took over (connect ETIMEDOUT). Cancel only if yundera's manager shows its copy still following this database. If yundera does not receive the cancel, this database gets generation 4, the one a take-over there writes; if yundera took over or takes over later, both databases then hold that generation, and each manager blocks the bot's login on its side once it finds the other, until you choose one. Cancel the hand-over?";
export const CANCEL_PROOF_Q = "This database runs again and the hand-over row is deleted here, but the copy yundera has not received that within 60 seconds (2048 bytes behind, catchup), so the hand-over is still recorded and the bot's login stays blocked. If yundera's manager presses Take over before its copy receives the cancel, it takes over as if it held every change. If you cancel anyway, this database gets generation 4, the one that take-over would write, so both databases would hold it, and each manager blocks the bot's login on its side once it finds the other, until you choose one. Cancel the hand-over?";
// :769 and :732, done in the request; :738, a refusal.
export const CANCELLED_HANDOVER = "The hand-over is cancelled: this database runs again as the main, with the bot's login still blocked. Choose Running in the State window to start the bot here.";
export const CANCELLED_MOVE = 'The move is cancelled; choose Running in the State window to start the bot here.';
export const TOOK_OVER_ALREADY = 'yundera took over as the main on 2026-11-14 09:00 UTC, so the hand-over can no longer be cancelled; this machine rejoins it as a copy.';

// Take over (takeOver, fleetSwitch.ts:807). W-UNPLANNED (switchWarning :838 to :840) with " Take over now?" (:957).
export const W_UNPLANNED = "The main at db.example.net:15432 did not answer (connect ECONNREFUSED 10.0.0.4:15432). Taking over now makes this copy the main without the main's last changes: the last change this copy received is from 2026-11-14 09:58 UTC. If the main can come back, waiting for it loses nothing; then hand over from its manager. If you take over, power the old main's machine off in its provider's panel if you can, so it cannot run as a second main.";
export const UNPLANNED_Q = `${W_UNPLANNED} Take over now?`;
// TK_PUSHED (:830) + the warning + W_UNCHECKED_Q (:831) with confirmFlag 'confirmUnchecked' (:956), about 2400 characters.
const TK_PUSHED = "When this copy last received a change, the main still held the mark of a Receive, and its database had been replaced since that Receive (by a push or a restore) with no record that a push finished, so a take-over could run the bot on data no one checked; nothing was changed. If the main's machine still runs, its Database window says what stands there: let the push finish, or restore the dump it names with the bot in Maintenance or Off. If that window names no unfinished push and no receive, the mark was left over: start that database if it is stopped, and its manager removes the mark within a minute; then hand over from there. If that machine is gone, the machine that pushed keeps its own database until its push finishes or is cancelled: Cancel the push in its manager to keep that database as the main, then remove this copy and join that main. If no machine pushed, keep this copy, which may hold the bot's only database: when the manager cannot check the old main, Take over asks whether to take over anyway.";
const W_UNCHECKED_Q = " The manager could not check the old main (the warning above says why), so it cannot tell whether a push into it finished; you can take over anyway. Do so only if you know that no machine was pushing into the old main, or that the machine that pushed holds no newer database than this copy. If that is wrong, this copy becomes the main with a database a push may have emptied or only partly filled; the machine that pushed keeps its own database and the pre-push- dump it made, and the data is recovered from there by a restore. Take over anyway?";
export const UNCHECKED_Q = `${TK_PUSHED} ${W_UNPLANNED}${W_UNCHECKED_Q}`;
// :946, before admit.
export const MAIN_UP = 'The main at db.example.net:15432 still answers as the main, so this copy was not promoted. Hand it over from its own manager (that loses nothing), or stop it first; nothing was changed';
// finishTakeover (:1054 to :1085), the frame's success text with the bot not started.
export const TAKEN_OVER = "This machine is the main now (generation 5, 2026-11-14 10:00 UTC). The old main's changes after 2026-11-14 09:58 UTC are not here. The bot was not started; choose Running in the State window when ready.";
// The shard cap refusal after admit: rowSecurityRefusal (NM20 fleetSwitch.ts:133 to :137) through :1032; this tree's
// :1002 raises the cap with the generation and has no such text.
export const SHARD_CAP = "The copy is promoted, but its shard claims could not be capped: row-level security is forced on smdb_data.guild_shards, so Take over fails the same way until it is lifted. The generation was not raised, so bots may not choose this copy over the old main, and the bot's login to it stays blocked. The manager has no SQL console; on this machine, run docker exec -it smdb-replica-b1 psql -U dbm_work -d bot_b1 -c 'SET ROLE \"bot_b1\"; ALTER TABLE smdb_data.guild_shards NO FORCE ROW LEVEL SECURITY'. Then press Take over again.";

// Keep main (keepMain, fleetSwitch.ts:1137): done in the request (:1180), and a refusal (:1142).
export const KEPT = "This machine is the main now (generation 6), and the bot's login is open here again. The manager can't confirm when yundera's manager reads this generation: it checks every 5 minutes while it can reach this machine, then blocks its bot's login there and puts the bot in Off once it holds nothing it could not save. Rejoin yundera as a copy in its manager afterwards; that keeps a dump of its database first.";
export const NO_SECOND_MAIN = 'No second main is recorded';

// Rejoin (POST fleet-reseed, bots.ts:2010). rejoinComposed (fleetSwitch.ts:1498 to :1507) answers reseedStalePrimary's
// start (fleetReplica.ts:1602) or its refusals; :1502.
export const rejoinStarted = () => ok({ success: true, started: true });
export const NO_MAIN_RECORDED = 'No main is recorded to rejoin; paste its join code instead';
// reseedStalePrimary (fleetReplica.ts:1426): :1446 and :1483.
export const STOP_FIRST = 'Stop the instance first: re-seeding deletes the database it is currently running on';
export const OWN_CODE = "That join code is this instance's own database, which is the stale one. Paste the join code from the machine that now serves the fleet";
// :1487 with the main on this machine, and the volume question (keptVolumeQuestion :957 through provisionVolumeRefusal :974).
export const staleSameHost = () => ok({ success: false, needsConfirm: true, error: SAME_HOST });
export const staleVolume = () => ok({ success: false, needsConfirm: true, confirmVolume: VOLUME, error: VOLUME_QUESTION });

// Part 5. "fleetMove.ts" is src/instance/fleetMove.ts here; "NM20:" is the same file in the NM20 tree, which merges before M5.

// A move code as encodeMoveCode builds it (src/config/joinCode.ts:90) with NM20's second receive login (fleetMove.ts
// NM20:370): about 660 characters.
export const MOVE_CODE = 'smdbmove1.' + Buffer.from(JSON.stringify({
  v: 1, host: 'db.example.net', port: 15432, db: 'bot_b1', fp: 'a1'.repeat(32), machine: 'db.example.net',
  repl: { user: 'smdb_repl', password: 'r'.repeat(32) }, app: { user: 'bot_b1', password: 'p'.repeat(32) },
  recv: { user: 'smdb_receive', password: 'q'.repeat(32), id: 'c'.repeat(24) }, recvMeta: { user: 'smdb_receive_meta', password: 'm'.repeat(32) },
})).toString('base64url');
export const MOVE_CODE_2 = MOVE_CODE.slice(0, -8) + 'Zm9vYmFy';

export const SAFETY = 'pre-receive-2026-11-14T10-00-00-000Z.dump';
export const BROKEN_DUMP = 'pre-receive-2026-11-13T08-00-00-000Z.dump';
// receiveMain's success (fleetMove.ts:262 to :265; NM20:371 to :374, the same texts).
export const RECEIVE_TEXT = `Paste this move code into Push the main in the other machine's manager within 24 hours. It replaces this machine's database with the pushed one; a dump of this one is kept with the backups (${SAFETY}). The code holds passwords: paste it only into your own managers.`;
export const RECEIVE_BROKEN_TEXT = `Paste this move code into Push the main in the other machine's manager within 24 hours. It replaces this machine's database with the pushed one. This database holds a push that did not finish, so no new dump was taken; the dump ${BROKEN_DUMP}, taken before that push, stays with the backups. The code holds passwords: paste it only into your own managers.`;
// laneRoute's done answer (bots.ts:2059) with the move code.
export const receivedBody = (code = MOVE_CODE, text = RECEIVE_TEXT) => ok({ success: true, text, moveCode: code });
// fleetMove.ts:193: a push that already finished; no new move code.
export const ALREADY_PUSHED = 'The push from contabo had already finished (generation 4), so this database is the main now; receiving ended and no new move code was made.';
// fleetMove.ts:177 (NM20 the same).
export const RECEIVE_NOT_OFF = "Receiving replaces this machine's database, so the bot must be Off first (its state is Maintenance); choose Off in the State window; nothing was changed";
// fleetMove.ts:209 (NM20:317).
export const RECEIVE_DUMP_FAILED = 'The dump of this database failed (pg_dump: error: connection to server failed), so nothing was changed';

// stopReceiving (fleetMove.ts:292; NM20 the same) and its refusal (:272).
export const STOPPED_RECEIVING = 'Receiving stopped; the move code no longer works.';
export const NOT_RECEIVING = 'This database is not waiting to receive a main';

// pushMain's success (fleetMove.ts:496 to :498; NM20 the same sentences), sent in the bot:switch frame.
export const PUSHED = "The database was pushed to yundera and checked: 12 tables and 3400 rows, with the same counts and checksums on both. yundera is the main now (generation 5); choose Running in its State window to start the bot there. This machine now rebuilds itself as a copy of yundera; a dump of its database from before the push is kept with the backups (pre-push-2026-11-14T10-00-00-000Z.dump).";
// pushLocked's failure that names the next step (fleetMove.ts:454; NM20:661).
export const PUSH_FAILED = "The push to yundera failed (connection reset by peer). This machine's database is unchanged; yundera's database is incomplete, and its bot stays Off. Press Push again with the same code, or Cancel the push.";
// NM20:663, sent at NM20:689, :696, :706 and :713.
export const RECVLOGIN = "The push to yundera stopped: yundera refused the move code's login after the data was sent (code in the pushed database may have changed its password, or the code expired, or receiving was stopped or restarted there). yundera's database is incomplete, and its bot stays Off. On yundera, press Receive for a new move code and push with it, or Cancel the push.";
// decodeMoveCode's refusal of a code made before NM20 (src/config/joinCode.ts NM20:110), sent whole by pushMain (fleetMove.ts NM20:510) with 400.
export const OLD_MOVE_CODE = 'This move code was made before the receive logins had a second login; make a new one with Receive.';
// fleetMove.ts:216 (NM20:510 without old).
export const NOT_A_MOVE_CODE = 'This is not a move code: it is damaged (it does not decode)';
// heldVerdict's question for the push and the move-out (fleetSwitch.ts:235), asked through provenMaintenance (:491).
export const HELD_PUSH_Q = 'The bot was stopped without confirming that it saved what it held. Whatever it had not saved was lost at that stop, not by this push, which loses nothing more. Push anyway?';
export const HELD_MOVE_Q = 'The bot was stopped without confirming that it saved what it held. Whatever it had not saved was lost at that stop, not by this move, which loses nothing more. Make the backup anyway?';

// moveOut's done answer (fleetMove.ts:551 to :556; NM20 the same) with its file.
export const MOVE_FILE = 'pre-move-2026-11-14T10-00-00-000Z.dump';
export const MOVE_TEXT = `The backup ${MOVE_FILE} is ready and is downloading. Upload it in the other machine's manager (Upload a backup in the bot's Database window), then restore it there with the bot in Maintenance or Off. This bot stays stopped here, with its database login blocked, until you Cancel the move.`;
export const movedBody = (text = MOVE_TEXT, file: string | null = MOVE_FILE) => ok({ success: true, text, ...(file ? { file } : {}) });
// fleetMove.ts:544 (NM20:770).
export const MOVE_DUMP_FAILED = 'The dump failed (pg_dump: error: out of disk space), so nothing was changed';
