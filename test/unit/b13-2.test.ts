import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { coveredOverRefusal } from '../../src/instance/fleetReplica';

const pageHtml = fs.readFileSync(path.resolve(__dirname, '../../src/webui/public/index.html'), 'utf8');

describe('B13-2 setup block names the real intake', () => {
  it('points at the Database button, its Database Replica section and Provision, and the roles that show it', () => {
    expect(pageHtml).not.toContain('"Add a database replica"');
    expect(pageHtml).toContain("open the standby instance's Database button, paste both into its Database Replica section and press Provision");
    expect(pageHtml).toContain('Fleet Role is Backup Master or Co-worker');
  });
});

describe('B13-2 covered-copy refusal names a remedy the demoted node can finish', () => {
  it('a co-worker is pointed at remove-and-provision or the backup role first', () => {
    for (const facts of [{ backupMaster: false, copyBlockCurrent: null }, null]) {
      const msg = coveredOverRefusal(facts);
      expect(msg).toContain('a co-worker is not sent the current primary\'s copy block');
      expect(msg).toContain('Remove the replica and provision it again');
      expect(msg).toContain('BOT_NODE_ROLE=backup-master');
    }
  });
  it('a designated backup keeps demote, then Re-seed now once the block reaches it', () => {
    const msg = coveredOverRefusal({ backupMaster: true, copyBlockCurrent: false });
    expect(msg).toContain('demote the node from its Fleet tab to release the copy, then Re-seed now once the current primary\'s copy block reaches this node');
    expect(msg).not.toContain('Remove the replica');
  });
  it('a node already holding the current block is told to demote and re-seed', () => {
    expect(coveredOverRefusal({ backupMaster: false, copyBlockCurrent: true })).toMatch(/then Re-seed now$/);
  });
  it('no message carries a long dash', () => {
    for (const f of [null, { backupMaster: true, copyBlockCurrent: null }, { backupMaster: false, copyBlockCurrent: true }]) expect(coveredOverRefusal(f)).not.toMatch(/[\u2013\u2014]/);
  });
});

describe('B13-2 page note for a returning copy that follows a stale primary', () => {
  it('tells a co-worker to remove and provision again, and keeps demote then Re-seed now for a backup or a current block', () => {
    expect(pageHtml).not.toContain('demote the node from its Fleet tab to stay a co-worker, then Re-seed now repoints this copy at the current primary');
    expect(pageHtml).toContain("(facts && facts.copyBlockCurrent === true) || (facts && facts.backupMaster === true) ? `Demote the node from its Fleet tab to release the copy, then Re-seed now repoints it at the current primary");
    expect(pageHtml).toContain("so Re-seed now would have nothing to follow. Remove the replica and provision it again from the copy block on the current primary's Database modal, or set BOT_NODE_ROLE=backup-master on this node and restart it first, then demote it from its Fleet tab and Re-seed now once the block reaches it.`}");
  });
});
