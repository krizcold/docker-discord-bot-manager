import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm31-l5-k-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
});

vi.mock('child_process', async (importOriginal) => (await import('./nm31-run')).childProcessMock(await importOriginal(), require('fs')));
vi.mock('fs', async (importOriginal) => (await import('./nm31-run')).fsMock(await importOriginal()));
vi.mock('../../src/docker/dockerClient', async (importOriginal) => {
  const { run } = await import('./nm31-run');
  return {
    ...(await importOriginal<typeof import('../../src/docker/dockerClient')>()),
    volumeState: (name: string) => run.volumes[name] ?? 'absent',
    removeVolume: () => false,
    listBotContainersAsync: async () => [],
  };
});

import { KEPT_TEXT } from '../../src/instance/keptData';

describe('NM31 L5 k: the Delete done text', () => {
  it('names the volume and the folder, and both checks', () => {
    expect(KEPT_TEXT.xDone({ date: '2026-11-01 10:00', volume: 'v1', folder: '/d/f1', dump: 'd1.dump', archive: 'a1.tar' })).toBe(
      'Deleted the kept data of 2026-11-01 10:00: the volume v1 and the folder /d/f1 were removed after the dump d1.dump of a copy of it restored cleanly and the archive a1.tar matched the folder; both stay in this manager\'s backups folder.');
  });

  it('names only the volume and its dump', () => {
    expect(KEPT_TEXT.xDone({ date: '2026-11-01 10:00', volume: 'v1', dump: 'd1.dump' })).toBe(
      'Deleted the kept data of 2026-11-01 10:00: the volume v1 was removed after the dump d1.dump of a copy of it restored cleanly; it stays in this manager\'s backups folder.');
  });

  it('names only the folder and its archive', () => {
    expect(KEPT_TEXT.xDone({ date: '2026-11-01 10:00', folder: '/d/f1', archive: 'a1.tar' })).toBe(
      'Deleted the kept data of 2026-11-01 10:00: the folder /d/f1 was removed after the archive a1.tar matched the folder; it stays in this manager\'s backups folder.');
  });
});
