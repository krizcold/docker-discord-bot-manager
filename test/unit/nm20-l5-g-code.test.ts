import { describe, expect, it } from 'vitest';
import { decodeMoveCode } from '../../src/config/joinCode';
import { fakeJoin } from './join-fake';

describe('decodeMoveCode with recvMeta null (L5 writer g)', () => {
  it('a null recvMeta is the old code text, not a malformed login', () => {
    const recv = { user: 'smdb_receive', password: 'p', id: '0123456789abcdef01234567' };
    const code = `smdbmove1.${Buffer.from(JSON.stringify({ ...fakeJoin(), recv, recvMeta: null })).toString('base64url')}`;
    expect(decodeMoveCode(code)).toEqual({ ok: false, old: true, why: 'This move code was made before the receive logins had a second login; make a new one with Receive.' });
  });
});
