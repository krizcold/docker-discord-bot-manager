/**
 * The daily test restore and the backup alerts. A test restores a dump into a throwaway Postgres container (no
 * network, 1 GB, 1 CPU, its own volume, all named smdb-testrestore-<id>) and compares its table counts with the
 * counts recorded when the dump was taken. A failed test, or dumps that stopped, stand as an alert on the instance
 * record and go to the bot's notify-owner hook once.
 */
import * as fs from 'fs';
import * as path from 'path';
import { execFile, spawn } from 'child_process';
import * as containerManager from '../docker/containerManager';
import { BackupFamily, FleetBackupAlert, FleetBackupTestRecord, FleetBackupTests, InstanceConfig } from '../types';
import { callAppHook, hasAppHooks } from './appHookClient';
import { alertStep, backupDir, DumpMeta, compareCounts, COUNTS_SQL, hourSlot, parseCountLines, parseDfFreeKb, validateDumpMeta } from './backupFiles';

export const testTiming = { readyDeadlineMs: 90_000, readyGapMs: 1_000, restoreSec: 600, backstopMs: 630_000 };
export const alertTiming = { hookTimeoutMs: 30_000 };

const DOCKER_MS = 30_000;
const RUN_MS = 300_000;
const COUNT_MS = 300_000;
const GIB = 1024 * 1024 * 1024;
const MIB = 1024 * 1024;
const LABEL = 'smdb.testrestore';
const THROWAWAY_RE = /^smdb-testrestore-[A-Za-z0-9_-]+$/;

export const throwawayName = (botId: string): string => `smdb-testrestore-${botId}`;

export function roleText(family: BackupFamily): string {
  return family === 'main' ? 'main database' : 'live copy';
}

/** `<bot>'s <role>` as the logs and the DMs name a family. */
export function familyText(instance: InstanceConfig, family: BackupFamily): string {
  return `${instance.displayName}'s ${roleText(family)}`;
}

/** ` on <publicHost>` of the family's database, or ''. */
export function whereText(instance: InstanceConfig, family: BackupFamily): string {
  const host = family === 'main' ? instance.fleetDb?.replication?.publicHost : instance.fleetDbReplica?.publicHost;
  return host ? ` on ${host}` : '';
}

type DockerOut = { ok: boolean; stdout: string; stderr: string };

function execDocker(args: string[], timeout: number): Promise<DockerOut> {
  return new Promise(resolve => {
    try {
      execFile('docker', args, { maxBuffer: 16 * 1024 * 1024, timeout }, (err, stdout, stderr) => {
        resolve({ ok: !err, stdout: String(stdout ?? ''), stderr: String(stderr || (err?.killed ? `docker did not answer within ${timeout / 1000} s` : err?.message ?? '')) });
      });
    } catch (err: any) {
      resolve({ ok: false, stdout: '', stderr: `Failed to run docker exec: ${err?.message || err}` });
    }
  });
}

const lastLine = (text: string): string => text.trim().split('\n').map(l => l.trim()).filter(Boolean).pop() || 'docker gave no reason';
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

// Records the registry refused, read before the stored ones; a restart drops them.
const unsavedTests: Map<string, FleetBackupTests> = new Map();
const unsavedAlerts: Map<string, FleetBackupAlert | null> = new Map();
// The hour slot in which a test's running record could not be saved: no second try in that slot.
const skippedSlots: Map<string, number> = new Map();

const testKey = (botId: string, family: BackupFamily) => `${botId}:${family}`;

export function currentTests(instance: InstanceConfig, family: BackupFamily): FleetBackupTests {
  return unsavedTests.get(testKey(instance.id, family)) ?? instance.fleetBackupTests?.[family] ?? {};
}

/** Saves a family's test record; the error text when the registry refused it, which then holds it in memory. */
function saveTests(botId: string, family: BackupFamily, tests: FleetBackupTests | null): string | null {
  try {
    containerManager.updateInstanceFleetBackupTest(botId, family, tests);
    unsavedTests.delete(testKey(botId, family));
    return null;
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    if (tests) unsavedTests.set(testKey(botId, family), tests);
    else unsavedTests.delete(testKey(botId, family));
    return text;
  }
}

// The hour slot in which a refused clear of a family's last test was logged.
const clearLoggedSlots: Map<string, number> = new Map();

/** Clears a family's last test, for a family the instance does not back up now; lastGood stays while the instance exists. */
export function clearLastTest(instance: InstanceConfig, family: BackupFamily, now: number): void {
  const key = testKey(instance.id, family);
  const held = unsavedTests.get(key);
  const stored = instance.fleetBackupTests?.[family];
  if (!stored?.last && !held?.last) return;
  const lastGood = held?.lastGood ?? stored?.lastGood;
  const error = saveTests(instance.id, family, lastGood ? { lastGood } : null);
  if (!error || clearLoggedSlots.get(key) === hourSlot(now)) return;
  clearLoggedSlots.set(key, hourSlot(now));
  console.error(`[FleetBackup] The last test restore of ${familyText(instance, family)} could not be cleared from its record (${error})`);
}

export function testSkippedThisSlot(botId: string, family: BackupFamily, now: number): boolean {
  return skippedSlots.get(testKey(botId, family)) === hourSlot(now);
}

/** Removes the throwaway container and volume by exact name; the failing docker line, or null. "No such" counts as removed. */
async function removeThrowaway(name: string): Promise<string | null> {
  for (const args of [['rm', '-f', name], ['volume', 'rm', name]]) {
    const r = await execDocker(args, DOCKER_MS);
    if (!r.ok && !/no such/i.test(r.stderr)) return lastLine(r.stderr);
  }
  return null;
}

type Verdict = { passed: true; tables: number; rows: number } | { passed: false; reason: string };

function restoreInto(name: string, dumpPath: string): Promise<string | null> {
  return new Promise(resolve => {
    const started = performance.now();
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('docker', ['exec', '-i', name, 'timeout', '-s', 'KILL', String(testTiming.restoreSec),
        'pg_restore', '-U', 'postgres', '--no-owner', '--no-privileges', '--exit-on-error', '-d', 'restorecheck']);
    } catch (err: any) {
      return resolve(`Failed to run docker exec: ${err?.message || err}`);
    }
    const input = fs.createReadStream(dumpPath);
    let stderr = '';
    let killed = false;
    let settled = false;
    const timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, testTiming.backstopMs);
    const finish = (reason: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.destroy();
      resolve(reason);
    };
    // A spawn that fails early (EMFILE) has no stdio, and its 'error' follows.
    if (child.stdin) input.pipe(child.stdin);
    input.on('error', err => {
      child.kill('SIGKILL');
      finish(`Failed to read dump file: ${err.message}`);
    });
    child.stdin?.on('error', () => { /* EPIPE when the child dies first; close answers */ });
    child.stderr?.on('data', d => { if (stderr.length < 4000) stderr += d.toString(); });
    child.on('error', err => finish(`Failed to run docker exec: ${err.message}`));
    child.on('close', code => {
      if (killed || (code === 137 && performance.now() - started >= testTiming.restoreSec * 1000)) return finish('pg_restore did not finish within 10 minutes');
      if (code !== 0) return finish(`pg_restore exited with code ${code}: ${stderr.trim().slice(0, 500)}`);
      finish(null);
    });
  });
}

async function testInThrowaway(botId: string, dumpPath: string, dbBytes: number, recorded: Record<string, number>): Promise<Verdict> {
  const name = throwawayName(botId);
  const leftover = await removeThrowaway(name);
  if (leftover) return { passed: false, reason: `the throwaway container or volume ${name} from an earlier test could not be removed (${leftover})` };
  const volume = await execDocker(['volume', 'create', '--label', `${LABEL}=${botId}`, name], DOCKER_MS);
  if (!volume.ok) return { passed: false, reason: `the throwaway database could not be started (${lastLine(volume.stderr)})` };
  const run = await execDocker(['run', '-d', '--name', name, '--label', `${LABEL}=${botId}`, '--network', 'none', '--memory', '1g', '--cpus', '1',
    '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', '-e', 'POSTGRES_DB=restorecheck', '-e', 'POSTGRES_INITDB_ARGS=--data-checksums',
    '-v', `${name}:/var/lib/postgresql/data`, 'postgres:16-alpine'], RUN_MS);
  if (!run.ok) return { passed: false, reason: `the throwaway database could not be started (${lastLine(run.stderr)})` };
  // Over TCP: the image's initdb runs a temporary server on the socket only.
  const deadline = performance.now() + testTiming.readyDeadlineMs;
  for (;;) {
    if ((await execDocker(['exec', name, 'pg_isready', '-h', '127.0.0.1', '-q'], DOCKER_MS)).ok) break;
    if (performance.now() >= deadline) return { passed: false, reason: 'the throwaway database did not accept connections within 90 s' };
    await pause(testTiming.readyGapMs);
  }
  const df = await execDocker(['exec', name, 'df', '-Pk', '/var/lib/postgresql/data'], DOCKER_MS);
  const freeKb = df.ok ? parseDfFreeKb(df.stdout) : null;
  if (freeKb === null) return { passed: false, reason: `the free space of the disk that holds Docker's volumes could not be read (${lastLine(df.ok ? df.stdout || 'empty output' : df.stderr)})` };
  const need = 2 * dbBytes + GIB;
  if (freeKb * 1024 < need) {
    return { passed: false, reason: `the disk that holds Docker's volumes has ${Math.floor(freeKb / 1024)} MB free, and the test needs ${Math.ceil(need / MIB)} MB (twice the database's size, plus 1 GB kept free for the live database)` };
  }
  const restored = await restoreInto(name, dumpPath);
  if (restored) return { passed: false, reason: restored };
  const counted = await execDocker(['exec', name, 'psql', '-U', 'postgres', '-d', 'restorecheck', '-X', '-tA', '-v', 'ON_ERROR_STOP=1', '-c', COUNTS_SQL], COUNT_MS);
  if (!counted.ok) return { passed: false, reason: `the restored tables could not be counted (${lastLine(counted.stderr)})` };
  const parsed = parseCountLines(counted.stdout);
  if (!parsed.ok) return { passed: false, reason: `the restored tables could not be counted (${parsed.error})` };
  const compared = compareCounts(recorded, parsed.counts);
  if (!compared.ok) return { passed: false, reason: compared.text };
  return { passed: true, tables: Object.keys(recorded).length, rows: Object.values(recorded).reduce((a, b) => a + b, 0) };
}

function readMeta(botId: string, file: string): { ok: true; meta: DumpMeta } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(backupDir(botId), `${file}.json`), 'utf-8'));
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const checked = validateDumpMeta(raw);
  if (!checked.ok) return checked;
  if (checked.meta.file !== file) return { ok: false, error: `the counts file names ${checked.meta.file}` };
  return checked;
}

/**
 * Tests one dump: its counts file, a running record, the throwaway, the restore and the count comparison, the
 * throwaway removed whatever happened, and the result saved. Null when the running record could not be saved, so
 * no test ran.
 */
export async function runTestRestore(instance: InstanceConfig, family: BackupFamily, file: string): Promise<FleetBackupTestRecord | null> {
  const now = Date.now();
  const prior = currentTests(instance, family);
  const cutShort = prior.last?.result === 'interrupted' ? prior.last.cutShort : undefined;
  const base: FleetBackupTestRecord = { file, startedAt: now, result: 'running', ...(cutShort !== undefined ? { cutShort } : {}) };
  const meta = readMeta(instance.id, file);
  let record: FleetBackupTestRecord;
  if (!meta.ok) {
    record = { ...base, finishedAt: Date.now(), result: 'failed', text: `the counts recorded with this backup could not be read (${meta.error})` };
  } else {
    const startError = saveTests(instance.id, family, { ...prior, last: base });
    if (startError) {
      unsavedTests.delete(testKey(instance.id, family));
      skippedSlots.set(testKey(instance.id, family), hourSlot(now));
      console.error(`[FleetBackup] The test restore of ${familyText(instance, family)} did not start: its record could not be saved (${startError})`);
      return null;
    }
    let verdict: Verdict;
    let note = '';
    try {
      verdict = await testInThrowaway(instance.id, path.join(backupDir(instance.id), file), meta.meta.dbBytes, meta.meta.counts);
    } catch (err: any) {
      verdict = { passed: false, reason: `the test stopped on an error: ${err?.message || err}` };
    } finally {
      const cleanup = await removeThrowaway(throwawayName(instance.id));
      if (cleanup) note = `; the throwaway container or volume ${throwawayName(instance.id)} could not be removed (${cleanup}), and the next test removes it first`;
    }
    record = verdict.passed
      ? { ...base, finishedAt: Date.now(), result: 'passed', tables: verdict.tables, rows: verdict.rows, ...(note ? { text: note } : {}) }
      : { ...base, finishedAt: Date.now(), result: 'failed', text: `${verdict.reason}${note}` };
  }
  const lastGood = record.result === 'passed' ? file : currentTests(containerManager.getBot(instance.id) ?? instance, family).lastGood;
  const tests: FleetBackupTests = { last: record, ...(lastGood ? { lastGood } : {}) };
  const saveError = saveTests(instance.id, family, tests);
  if (saveError) {
    const held = { ...record, text: `${record.text ?? ''} (this result is not saved, and a manager restart drops it)` };
    unsavedTests.set(testKey(instance.id, family), { ...tests, last: held });
    console.error(`[FleetBackup] The result of the test restore of ${familyText(instance, family)} could not be saved (${saveError})`);
    return held;
  }
  console.log(`[FleetBackup] Test restore of ${file} (${familyText(instance, family)}) ${record.result}${record.result === 'failed' ? `: ${record.text}` : ''}`);
  return record;
}

/** At start: a test a restart cut short reads interrupted, and one cut short twice reads failed. */
export function recoverInterruptedTests(): void {
  for (const instance of containerManager.getAllBots()) {
    for (const family of ['main', 'copy'] as const) {
      const tests = instance.fleetBackupTests?.[family];
      const last = tests?.last;
      if (!tests || last?.result !== 'running') continue;
      const cut = (last.cutShort ?? 0) + 1;
      const next: FleetBackupTestRecord = cut >= 2
        ? { ...last, result: 'failed', finishedAt: Date.now(), cutShort: cut, text: 'the test was cut short twice by a manager restart' }
        : { ...last, result: 'interrupted', cutShort: cut };
      const error = saveTests(instance.id, family, { ...tests, last: next });
      if (error) console.error(`[FleetBackup] The cut-short test restore of ${familyText(instance, family)} could not be recorded (${error})`);
    }
  }
}

/** At start: every container and volume carrying the throwaway's label goes, by exact name. */
export async function removeOrphanThrowaways(): Promise<void> {
  const lists: Array<{ list: string[]; remove: (n: string) => string[]; what: string }> = [
    { list: ['ps', '-a', '--filter', `label=${LABEL}`, '--format', '{{.Names}}'], remove: n => ['rm', '-f', n], what: 'containers' },
    { list: ['volume', 'ls', '--filter', `label=${LABEL}`, '--format', '{{.Name}}'], remove: n => ['volume', 'rm', n], what: 'volumes' },
  ];
  for (const { list, remove, what } of lists) {
    const listed = await execDocker(list, DOCKER_MS);
    if (!listed.ok) {
      console.error(`[FleetBackup] The test-restore ${what} left by an earlier run could not be listed (${lastLine(listed.stderr)})`);
      continue;
    }
    for (const name of listed.stdout.split('\n').map(l => l.trim()).filter(n => THROWAWAY_RE.test(n))) {
      const r = await execDocker(remove(name), DOCKER_MS);
      if (!r.ok && !/no such/i.test(r.stderr)) console.error(`[FleetBackup] Could not remove the test-restore leftover ${name} (${lastLine(r.stderr)})`);
    }
  }
}

const alertKey = (botId: string, key: string) => `${botId}|${key}`;

export function currentAlerts(botId: string): Record<string, FleetBackupAlert> {
  const out: Record<string, FleetBackupAlert> = { ...(containerManager.getBot(botId)?.fleetBackupAlerts ?? {}) };
  for (const [k, alert] of unsavedAlerts) {
    const [id, key] = k.split('|');
    if (id !== botId) continue;
    if (alert) out[key] = alert;
    else delete out[key];
  }
  return out;
}

function saveAlert(instance: InstanceConfig, key: string, alert: FleetBackupAlert | null): void {
  try {
    containerManager.updateInstanceFleetBackupAlert(instance.id, key, alert);
    unsavedAlerts.delete(alertKey(instance.id, key));
  } catch (err) {
    unsavedAlerts.set(alertKey(instance.id, key), alert);
    console.error(`[FleetBackup] The backup alert ${key} of ${instance.displayName} could not be saved, so a manager restart may send its DM again (${err instanceof Error ? err.message : String(err)})`);
  }
}

export async function notifyOwner(instance: InstanceConfig, text: string): Promise<{ dm: FleetBackupAlert['dm']; dmError?: string }> {
  if (!hasAppHooks(instance)) return { dm: 'unsupported' };
  const r = await callAppHook(instance, 'notify-owner', 'POST', { text: text.slice(0, 1500) }, alertTiming.hookTimeoutMs);
  if (r.ok) return { dm: 'sent' };
  if (r.unknown) return { dm: 'unknown' };
  return { dm: 'failed', dmError: r.error || 'notify-owner failed' };
}

export type AlertCondition = { family: BackupFamily; kind: FleetBackupAlert['kind']; on: boolean; text: string };

/** One step of every alert of the instance; an alert whose key no condition names (a family no longer held) is removed. */
export async function stepAlerts(instance: InstanceConfig, conditions: AlertCondition[], now: number): Promise<void> {
  const current = currentAlerts(instance.id);
  const named = new Set(conditions.map(c => `${c.family}:${c.kind}`));
  for (const key of Object.keys(current)) if (!named.has(key)) saveAlert(instance, key, null);
  for (const c of conditions) {
    const key = `${c.family}:${c.kind}`;
    const prev = current[key];
    const { next, send } = alertStep(prev, c.on, c.kind, c.text, now);
    if (!next) {
      if (prev) saveAlert(instance, key, null);
      continue;
    }
    if (!prev || prev.text !== next.text) saveAlert(instance, key, next);
    if (!send) continue;
    const result = await notifyOwner(instance, next.text);
    const { dmError: _old, ...rest } = next;
    const done: FleetBackupAlert = { ...rest, dm: result.dm, dmAt: now, ...(result.dmError ? { dmError: result.dmError } : {}) };
    saveAlert(instance, key, done);
    console.log(`[FleetBackup] DM to the owner of ${instance.displayName} about ${key}: ${result.dm}${result.dmError ? ` (${result.dmError})` : ''}`);
  }
}
