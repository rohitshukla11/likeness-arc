/**
 * Handlers against Envio's in-memory test indexer (no Docker, no network): a licence's whole life,
 * from registration to refund, lands in the event tables and the aggregates.
 */
import { createTestIndexer } from "envio";
import { describe, expect, it } from "vitest";

const creator = "0x1111111111111111111111111111111111111111";
const brand = "0x2222222222222222222222222222222222222222";
const payout = "0x3333333333333333333333333333333333333333";
const agent = "0x4444444444444444444444444444444444444444";
const asset = `0x${"ab".repeat(32)}`;
const zero32 = `0x${"00".repeat(32)}`;

let n = 0;
const ev = (contract: string, event: string, params: Record<string, unknown>, block = 100) => ({
  contract,
  event,
  params,
  // Far above config.yaml's start_block (which moves with each deployment), or the indexer filters the
  // event out before any handler.
  block: { number: 1_000_000_000 + block, timestamp: 1_790_000_000 + block },
  transaction: { hash: `0x${(++n).toString(16).padStart(64, "0")}` },
}) as never;

describe("Likeness indexer", () => {
  it("indexes a licence from registration to refund", async () => {
    const indexer = createTestIndexer();
    await indexer.process({
      chains: {
        5042: {
          simulate: [
            ev("CreatorRegistry", "CreatorRegistered", { creator, payout, referenceSetHash: zero32 }, 100),
            ev("CreatorRegistry", "TermsSet", { creator, terms: { categories: 768n, regions: 63n, maxDuration: 2_592_000n, maxRenders: 100n, pricePerRender: 2_000_000n, autoApprove: true } }, 100),
            ev("LicenseRegistry", "LicenceIssued", { id: 1n, creator, licensee: brand, category: 256n, regions: 1n, end: 1_800_000_000n, renderCap: 3n, pricePerRender: 2_000_000n, purposeHash: zero32, autoApproved: true }, 101),
            ev("LicenseEscrow", "Deposited", { licenceId: 1n, licensee: brand, amount: 6_000_000n }, 102),
            ev("LicenseRegistry", "RenderRecorded", { id: 1n, renderIndex: 0n }, 103),
            ev("ReceiptAnchor", "ReceiptAnchored", { assetHash: asset, licenceId: 1n, creator, licensee: brand, renderIndex: 0n, timestamp: 1_790_000_103n }, 103),
            ev("LicenseEscrow", "RenderPaid", { licenceId: 1n, renderIndex: 0n, assetHash: asset, agent, payout, creatorAmount: 1_800_000n, fee: 200_000n }, 103),
            ev("LicenseRegistry", "LicenceRevoked", { id: 1n, creator }, 104),
            ev("LicenseEscrow", "Refunded", { licenceId: 1n, licensee: brand, amount: 4_000_000n }, 105),
          ],
        },
      },
    });

    const c = await indexer.Creator.getOrThrow(creator);
    expect(c.pricePerRender).toBe(2_000_000n);
    expect(c.autoApprove).toBe(true);
    expect(c.licenceCount).toBe(1);
    expect(c.renderCount).toBe(1);
    expect(c.earned).toBe(1_800_000n);

    const l = await indexer.Licence.getOrThrow("1");
    expect(l.renderCount).toBe(1);
    expect(l.deposited).toBe(6_000_000n);
    expect(l.paidToCreator + l.fees + l.refunded).toBe(l.deposited);
    expect(l.revokedAt).toBe(1_790_000_104);

    const r = await indexer.Receipt.getOrThrow(asset);
    expect(r.licence_id).toBe("1");
    const b = await indexer.Brand.getOrThrow(brand);
    expect([b.deposited, b.spent, b.refunded]).toEqual([6_000_000n, 2_000_000n, 4_000_000n]);

    // Event tables carry the app's History row fields.
    const issued = await indexer.LicenceIssued.getAll();
    expect(issued[0]).toMatchObject({ licenceId: 1n, creator, licensee: brand, block: 1_000_000_101, autoApproved: true });
    expect((await indexer.RenderPaid.getAll())[0].assetHash).toBe(asset);
  });

  it("tracks revoke-all and suspension through the creator's epoch", async () => {
    const indexer = createTestIndexer();
    await indexer.process({
      chains: {
        5042: {
          simulate: [
            ev("CreatorRegistry", "CreatorRegistered", { creator, payout, referenceSetHash: zero32 }, 200),
            ev("CreatorRegistry", "AttestationUpdated", { creator, referenceSetHash: zero32, verifiedAt: 1_790_000_200n }, 200),
            ev("CreatorRegistry", "AllRevoked", { creator, epoch: 1n }, 201),
            ev("CreatorRegistry", "Suspended", { creator, suspended: true, epoch: 2n }, 202),
          ],
        },
      },
    });
    const c = await indexer.Creator.getOrThrow(creator);
    expect([c.epoch, c.suspended]).toEqual([2, true]);
    expect(c.attestationUpdatedAt).toBe(1_790_000_200);
    expect((await indexer.AttestationUpdated.getAll())[0].verifiedAt).toBe(1_790_000_200);
    expect((await indexer.AllRevoked.getAll()).length).toBe(1);
  });
});
