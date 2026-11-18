import { describe, expect, it, vi } from 'vitest';

// NM35: in every psql argv dbLogin builds, -X comes directly after psql, so a .psqlrc never changes the output the parsers read.
vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm35-x-'));
  process.env.DATA_DIR = dir;
  process.env.DATA_ROOT = nodePath.join(dir, 'DATA');
});
vi.mock('../../src/webui/server', () => ({ broadcastToClients: () => {} }));

import { adminReadArgs, clusterPsql, loginPsql, metaPsql, receivePsql, workArgs, workPsql } from '../../src/instance/dbLogin';

const C = 'b1-fleet-postgres';
const DB = 'app';
const afterPsql = (args: string[]) => args[args.indexOf('psql') + 1];

describe('NM35 dbLogin psql argv', () => {
  it('adminReadArgs', () => {
    expect(afterPsql(adminReadArgs(C, DB))).toBe('-X');
  });

  it('clusterPsql, metaPsql, workPsql and receivePsql, with -c and on stdin', () => {
    for (const stdin of [false, true]) {
      const calls = [clusterPsql(C, 'SELECT 1', { stdin }), metaPsql(C, DB, 'SELECT 1', { stdin }), workPsql(C, DB, 'SELECT 1', { stdin, exempt: true }),
        receivePsql('smdb_receive' as any, C, DB, 'SELECT 1', { stdin })];
      expect(calls.map(c => afterPsql(c.args))).toEqual(['-X', '-X', '-X', '-X']);
    }
  });

  it('loginPsql', () => {
    expect(afterPsql(loginPsql('smdb_copy_' + 'a'.repeat(32), C, DB, 'SELECT 1').args)).toBe('-X');
  });

  it('workArgs gives psql -X and leaves pg_dump and pg_restore as they were', () => {
    expect(afterPsql(workArgs(C, DB, 'psql', ['-c', 'SELECT 1']))).toBe('-X');
    expect(workArgs(C, DB, 'pg_dump', ['-Fc'])).not.toContain('-X');
    expect(workArgs(C, DB, 'pg_restore', ['--no-owner'], { stdin: true })).not.toContain('-X');
  });
});
