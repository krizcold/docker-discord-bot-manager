import { describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const h = vi.hoisted(() => ({ logs: '' }));

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const execFileSync = (_f: string, args: string[]) => (args[0] === 'logs' ? h.logs : '');
  const mod = { ...real, execFileSync };
  return { ...mod, default: mod };
});

import * as dockerClient from '../../src/docker/dockerClient';
import * as health from '../../src/instance/fleetReplicationHealth';
import type { StandInPosture } from '../../src/instance/appLifecycle';

const src = (p: string): string => fs.readFileSync(path.join(__dirname, '../../src', p), 'utf8');

describe('FU-11 B10-1t a log line docker did not stamp carries no time', () => {
  it('getContainerLogs leaves an unstamped line without a time and keeps docker\'s time on a stamped one', async () => {
    h.logs = '2026-10-22T00:00:00.000000000Z hello\na continued line';
    const entries = await dockerClient.getContainerLogs('c-app');
    expect(entries).toEqual([
      { timestamp: '2026-10-22T00:00:00.000000000Z', message: 'hello', stream: 'stdout' },
      { timestamp: null, message: 'a continued line', stream: 'stdout' },
    ]);
  });
});

describe('FU-11 B11-3t the stopped covered-primary text follows holdReason', () => {
  const posture = (over: Partial<StandInPosture>): StandInPosture => ({
    role: 'covered', live: true, standInNodeId: 'abcdef123456', coveringNodeId: null, holdsWrites: true, since: null,
    gate: null, disarmReason: null, holdReason: 'behind', namesThisNode: true, followsDelivered: true, ...over,
  } as StandInPosture);
  const cases: Partial<StandInPosture>[] = [
    { namesThisNode: false },
    { namesThisNode: true, followsDelivered: false },
    { namesThisNode: null },
    { namesThisNode: true, followsDelivered: true },
  ];

  it.each(cases)('a copy in recovery is never called the copy that is behind (%o)', (over) => {
    const text = health.stoppedCoveredText(posture({ ...over, holdReason: 'copy' }));
    expect(text).toMatch(/^Instance is stopped/);
    expect(text).toContain("this database is a copy of that node's");
    expect(text).not.toContain('the copy that is behind');
    expect(text).not.toContain('re-seed');
  });

  it.each(cases)('a database that is behind still says so and asks for the re-seed (%o)', (over) => {
    const text = health.stoppedCoveredText(posture({ ...over, holdReason: 'behind' }));
    expect(text).toContain('this database is the copy that is behind');
    expect(text).toContain('re-seed it as a standby of that node');
  });
});

describe('FU-11 B22-1x the seed Dismiss texts say what Dismiss does', () => {
  const replica = src('instance/fleetReplica.ts');

  it('a whole re-seed copy is not said to come from the stand-in', () => {
    expect(replica).not.toContain('The copy from the stand-in is complete');
    expect(replica).toContain('The copy from the node now holding the fleet is complete.');
  });

  it('a committed provision park does not claim the partial copy is discarded: the volume keeps it', () => {
    expect(replica).not.toContain('partial copy is discarded');
    expect(replica).toContain('The partial copy stays in the replica volume, unused');
  });

  it('the unused page helper seedAfterRetire and its comment are gone from index.html', () => {
    const page = src('webui/public/index.html');
    expect(page).not.toContain('seedAfterRetire');
    expect(page).not.toContain("a plain provision here is the run's retry seed");
  });
});

describe('FU-11 B16-1j and B23-1c doc comments sit on their own functions', () => {
  it('the seed comment documents seedRunning, not runHold', () => {
    const replica = src('instance/fleetReplica.ts');
    expect(replica).toContain('/** A seed a runner owns right now; a parked one blocks nothing. */\nfunction seedRunning(');
    expect(replica).not.toMatch(/blocks nothing\. \*\/\n\/\*\*/);
  });

  it('runningInstanceContainers carries only its own comment', () => {
    expect(src('docker/containerManager.ts')).not.toContain("True when the instance's APP service container is running");
  });
});
