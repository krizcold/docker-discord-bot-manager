import { afterAll, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const os = require('os') as typeof import('os');
  const nodeFs = require('fs') as typeof import('fs');
  const nodePath = require('path') as typeof import('path');
  const dir = nodeFs.mkdtempSync(nodePath.join(os.tmpdir(), 'nm31-l5-i-'));
  process.env.DATA_DIR = dir;
  return { dir };
});

import * as fs from 'fs';
import { KEPT_TEXT } from '../../src/instance/keptData';

afterAll(() => { fs.rmSync(h.dir, { recursive: true, force: true }); });

const N = '; nothing was changed';
const OTHER = 'the other files of the old folder, its .env among them, stay in the kept folder.';
const boot = (certs: boolean) => `Its new data folder holds maintenance.json${certs ? ', and the join\'s certificate files,' : ''} so its next start is a maintenance boot`;

describe('NM31 L5 group i: kept-data operator texts', () => {
  it('names the json bot refusal', () => {
    expect(KEPT_TEXT.aJson).toBe(`This bot keeps its data in files and uses no database, so there is no database to start again${N}`);
  });

  it('gives the main start text with and without certificates, replication and sharers', () => {
    const base = { old: 'v-old', outDir: '/k/old', newVolume: 'v-new' };
    const lead = 'Started on a new database. The volume v-old and the data folder /k/old are kept unchanged under Kept data. The new database runs alone on the volume v-new, with data checksums on and the bot\'s login open; the Database URL is unchanged. The bot is stopped and its State is Running. ';
    expect(KEPT_TEXT.nDoneMain({ ...base, certs: false, replication: false, sharers: null })).toBe(`${lead}${boot(false)}; ${OTHER}`);
    expect(KEPT_TEXT.nDoneMain({ ...base, certs: true, replication: true, sharers: 'a and b' })).toBe(`${lead}${boot(true)}; ${OTHER}`
      + ' Copies on other machines still follow the kept database: enable replication here, then Copy join code and Add a live copy on each machine.'
      + ' a and b also use this database and still have their old data folders; run Start on a new database on each before you start it.');
  });

  it('gives the folder and copy start texts', () => {
    expect(KEPT_TEXT.nDoneFolder({ outDir: '/k/f', certs: false })).toBe(`Started on a new data folder. The data folder /k/f is kept unchanged under Kept data; the database is not changed. The bot is stopped and its State is Running. ${boot(false)}; ${OTHER}`);
    expect(KEPT_TEXT.nDoneCopy({ volume: 'v-c', outDir: '/k/c', certs: true })).toBe(`Started on a new data folder. This machine's live copy (volume v-c) and the data folder /k/c are kept unchanged under Kept data, and this machine holds no live copy now; Add a live copy makes a new one on a new volume. The main keeps this copy's slot and address until the slot is dropped there. The bot is stopped and its State is Running. ${boot(true)}.`);
  });

  it('lists at most five foreign names and gives the checksum reason', () => {
    expect(KEPT_TEXT.nNotOurs('/d', ['a', 'b', 'c', 'd', 'e', 'f'])).toBe('the data folder /d holds a, b, c, d, e that this start did not write, so the manager can\'t confirm which folder is the bot\'s');
    expect(KEPT_TEXT.nChecksums).toBe('the new database does not have data checksums on, so it was not made from an empty volume by this start');
  });

  it('lists sharer names with commas and and', () => {
    expect(KEPT_TEXT.aSharers(['a'])).toBe(`a uses this database and runs; choose Off for it first${N}`);
    expect(KEPT_TEXT.aSharers(['a', 'b', 'c'])).toBe(`a, b and c use this database and run; choose Off for each first${N}`);
  });

  it('gives the put back refusals', () => {
    expect(KEPT_TEXT.pNoSet('of 2026-11-18')).toBe(`This bot has no kept data of 2026-11-18${N}`);
    expect(KEPT_TEXT.pCross('db')).toBe(`The kept data holds a main database, and this instance holds a live copy now; remove the copy with Remove replica first${N}`);
    expect(KEPT_TEXT.pCross('copy')).toBe(`The kept data holds a live copy, and this instance holds a main database now; decommission or move the main first${N}`);
    expect(KEPT_TEXT.pUrl('c-db')).toBe(`The Database URL no longer names this bot's managed database c-db, so the bot would not use the database put back; set it back in the Env editor first${N}`);
    expect(KEPT_TEXT.pGoneVolume('v1')).toBe('The kept volume v1 is missing, so nothing was put back');
    expect(KEPT_TEXT.pGoneFolder('/f1')).toBe('The kept folder /f1 is missing, so nothing was put back');
  });

  it('gives the put back done text for a copy, an aside set and a streaming copy', () => {
    expect(KEPT_TEXT.pDone({ date: 'D', copyVolume: 'cv', folder: '/f', asideVolume: 'av', asideFolder: '/af', copy: { streams: 'main-host' }, orderText: 'O' }))
      .toBe('Put back. The kept data of D is in use again: the live copy on the volume cv and the data folder /f. What was in use (the volume av and the folder /af) is kept unchanged under Kept data. The live copy runs and streams from main-host. O');
    expect(KEPT_TEXT.pDone({ date: 'D', volume: 'v', orderText: 'O' })).toBe('Put back. The kept data of D is in use again: the volume v. O');
    expect(KEPT_TEXT.pDone({ date: 'D', folder: '/f', asideFolder: '/af', missing: '/m', orderText: 'O' }))
      .toBe('Put back. The kept data of D is in use again: the data folder /f; the data folder /m was already missing and still is. The folder /af was not brought in and stays where it was, under Kept data. O');
  });
});
