import { describe, expect, it, vi } from 'vitest';

vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  execFile: () => { throw new Error('no child process in these rows'); },
  execFileSync: () => { throw new Error('no child process in these rows'); },
}));
vi.mock('../../src/docker/dockerClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/docker/dockerClient')>()),
  volumeState: () => 'absent',
  listBotContainersAsync: async () => [],
}));
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import { KEPT_TEXT } from '../../src/instance/keptData';

const base = { date: '2026-11-01', orderText: 'Order.' };

describe('NM31 L5 j: Put back texts', () => {
  it('says the copy cannot be confirmed', () => {
    expect(KEPT_TEXT.pDone({ ...base, copyVolume: 'cv', copy: { unknown: 'probe failed' } }))
      .toBe("Put back. The kept data of 2026-11-01 is in use again: the live copy on the volume cv. The manager can't confirm that the live copy runs: probe failed. Order.");
  });

  it('says the copy runs without streaming', () => {
    expect(KEPT_TEXT.pDone({ ...base, copyVolume: 'cv', copy: { down: 'no sender' } }))
      .toBe('Put back. The kept data of 2026-11-01 is in use again: the live copy on the volume cv. The live copy runs but does not stream: no sender. Order.');
  });

  it('joins volume and folder, names what was aside, with no copy', () => {
    expect(KEPT_TEXT.pDone({ ...base, volume: 'v1', folder: 'f1', asideVolume: 'v2', asideFolder: 'f2' }))
      .toBe('Put back. The kept data of 2026-11-01 is in use again: the volume v1 and the data folder f1. What was in use (the volume v2 and the folder f2) is kept unchanged under Kept data. Order.');
  });

  it('puts nothing aside when nothing was in use', () => {
    expect(KEPT_TEXT.pDone({ ...base, volume: 'v1' }))
      .toBe('Put back. The kept data of 2026-11-01 is in use again: the volume v1. Order.');
  });

  it('joins with the missing folder clause and leaves the aside folder', () => {
    expect(KEPT_TEXT.pDone({ ...base, volume: 'v1', copyVolume: undefined, folder: 'f1', missing: 'dd', asideVolume: 'v2', asideFolder: 'f2' }))
      .toBe('Put back. The kept data of 2026-11-01 is in use again: the volume v1 and the data folder f1; the data folder dd was already missing and still is. What was in use (the volume v2) is kept unchanged under Kept data. The folder f2 was not brought in and stays where it was, under Kept data. Order.');
  });

  it('says nothing of a folder not brought in when no folder was missing', () => {
    expect(KEPT_TEXT.pDone({ ...base, volume: 'v1', asideFolder: 'f2' }))
      .toBe('Put back. The kept data of 2026-11-01 is in use again: the volume v1. What was in use (the folder f2) is kept unchanged under Kept data. Order.');
  });

  it('says nothing of a folder not brought in when there was none aside', () => {
    expect(KEPT_TEXT.pDone({ ...base, volume: 'v1', missing: 'dd' }))
      .toBe('Put back. The kept data of 2026-11-01 is in use again: the volume v1; the data folder dd was already missing and still is. Order.');
  });

  it('gives the refusals and the reverse text', () => {
    expect(KEPT_TEXT.uNothing('Order.')).toBe('Put back before the earlier data was set aside: the earlier database and data folder stay in use. Order.');
    expect(KEPT_TEXT.pOff).toBe('Put back needs the bot Off: choose Off in its State window first; nothing was changed');
    expect(KEPT_TEXT.pEmpty('s1')).toBe('The kept data s1 holds no database, live copy or data folder, so there is nothing to put back; nothing was changed');
    expect(KEPT_TEXT.pNamesSet('s1')).toBe('The kept data s1 already exists, so that name is taken; nothing was changed; try again');
    expect(KEPT_TEXT.pOrderRefused('busy')).toBe('The Off order was refused: busy');
  });
});

describe('NM31 L5 j: Delete texts', () => {
  it('says what a dropped volume leaves', () => {
    expect(KEPT_TEXT.xDropped('v', 'f')).toBe(' The kept volume v no longer exists (docker says no such volume), so the set now holds only the folder f.');
    expect(KEPT_TEXT.xDropped('v', null)).toBe(' The kept volume v no longer exists (docker says no such volume), so the set now holds only nothing.');
  });

  it('says the database has no work login', () => {
    expect(KEPT_TEXT.xNoWork('dbv-kept')).toBe(" The database has no dbm_work login: it was made before the manager's own logins existed, so the manager cannot dump it, and it stays under Kept data. To remove it by hand without changing it: choose Keep it, copy the volume dbv-kept to a new volume (mounting dbv-kept read-only), start Postgres on the copy only, dump the copy as the database's own superuser and check that dump, then remove the volume with docker volume rm dbv-kept; Delete then removes the rest of this kept data after its own checks.");
  });

  it('names the dump and the archive that stay', () => {
    expect(KEPT_TEXT.xPartial({ volume: 'v', err: 'busy', dump: 'd.sql', archive: 'a.tar' }))
      .toBe('Delete stopped while it removed the kept data: the volume v could not be removed (busy). Run Delete again to finish; the dump d.sql and the archive a.tar stay.');
  });

  it('names one dump that stays', () => {
    expect(KEPT_TEXT.xPartial({ volume: 'v', err: 'busy', dump: 'd.sql' }))
      .toBe('Delete stopped while it removed the kept data: the volume v could not be removed (busy). Run Delete again to finish; the dump d.sql stays.');
  });

  it('names one archive that stays', () => {
    expect(KEPT_TEXT.xPartial({ folder: 'f', err: 'busy', archive: 'a.tar' }))
      .toBe('Delete stopped while it removed the kept data: the folder f could not be removed (busy). Run Delete again to finish; the archive a.tar stays.');
  });

  it('ends plainly when nothing stays', () => {
    expect(KEPT_TEXT.xPartial({ folder: 'f', err: 'busy' }))
      .toBe('Delete stopped while it removed the kept data: the folder f could not be removed (busy). Run Delete again to finish.');
  });
});
