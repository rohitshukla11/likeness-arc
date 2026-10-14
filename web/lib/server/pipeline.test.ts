/**
 * Render pipeline pieces without a chain: the prompt rules, the DevRenderer and the C2PA round trip
 * (sign with the test chain, read back, detect tampering).
 */
import { existsSync } from "node:fs";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { syntheticPortraits } from "@/lib/dev/seed";
import { embedManifest, readManifest, type LicenceAssertion } from "./c2pa";
import { checkPrompt, ruleCheck } from "./filter";
import { devRender } from "./render/dev";

describe("prompt rules", () => {
  it("flag each banned use", () => {
    expect(ruleCheck("a poster telling people to vote for the senator")[0]).toMatch(/Political/);
    expect(ruleCheck("topless beach photo")[0]).toMatch(/Adult/);
    expect(ruleCheck("with her 8-year-old daughter")[0]).toMatch(/minors/);
    expect(ruleCheck("pretending to be a famous actor")[0]).toMatch(/Impersonation/);
    expect(ruleCheck("a deepfake confession video still")[0]).toMatch(/Deception/);
  });

  it("let ordinary briefs through", () => {
    expect(ruleCheck("smiling in a sunlit cafe holding a ceramic coffee cup, product shot, soft light")).toEqual([]);
    expect(ruleCheck("running shoes ad on a city street at dusk")).toEqual([]);
  });

  it("report that the LLM filter is not configured, and still refuse banned prompts", async () => {
    delete process.env.GEMINI_API_KEY;
    const ok = await checkPrompt("portrait in a bright studio for a skincare ad", 1 << 8);
    expect(ok.allowed).toBe(true);
    expect(ok.layers.find((l) => !l.ran)?.note).toMatch(/LLM filter not configured/);
    const bad = await checkPrompt("nude portrait", 1 << 8);
    expect(bad.allowed).toBe(false);
  });
});

const certs = existsSync("../.secrets/c2pa/signer.pem");

describe.skipIf(!certs)("DevRenderer and C2PA", () => {
  const assertion: LicenceAssertion = {
    protocol: "likeness/1",
    chainId: 5042,
    licenceId: "7",
    renderIndex: 0,
    creator: "0x1111111111111111111111111111111111111111",
    licensee: "0x2222222222222222222222222222222222222222",
    category: "Advertising",
    licenceRegistry: "0xE33Dc788C060cb77F79A2AFF96Ca685f6C018721",
    escrow: "0x8a747D78811066F58A0dDe04E82165A02fA37725",
    receipt: { anchor: "0x38703a57c5f8eB2F8d1576A3d2B4B35A10D66FA6", key: "sha256 of this file, manifest included", lookup: "ReceiptAnchor.receiptOf(sha256(file))" },
    renderAgent: "0x3333333333333333333333333333333333333333",
    renderer: { provider: "dev", model: "likeness-dev-renderer (no model)", test: true },
    promptSha256: "00",
    createdAt: new Date().toISOString(),
  };

  it("renders a marked TEST RENDER and round-trips a signed manifest", async () => {
    const out = await devRender({ prompt: "studio portrait for a skincare ad", references: await syntheticPortraits(), licenceId: 7n, renderIndex: 0 });
    expect(out.test).toBe(true);
    const meta = await sharp(out.bytes).metadata();
    expect([meta.width, meta.height]).toEqual([1024, 1024]);

    const signed = embedManifest(out.bytes, out.mime, assertion);
    const read = await readManifest(signed, out.mime);
    expect(read.present).toBe(true);
    if (!read.present) return;
    expect(read.licence?.licenceId).toBe("7");
    expect(read.licence?.renderer.test).toBe(true);
    expect(read.signatureValid).toBe(true);
    expect(read.trustedSigner).toBe(false); // test certificate
    expect(read.signer.commonName).toMatch(/TEST/);
  });

  it("reports a tampered file", async () => {
    const out = await devRender({ prompt: "x y z", references: await syntheticPortraits(), licenceId: 7n, renderIndex: 0 });
    const signed = embedManifest(out.bytes, out.mime, assertion);
    const tampered = new Uint8Array(signed);
    tampered[tampered.length - 200] ^= 0xff; // flip a byte in the image data
    const read = await readManifest(tampered, out.mime);
    expect(read.present && read.signatureValid).toBe(false);
  });

  it("reads a file with no manifest as absent", async () => {
    const plain = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#000" } }).jpeg().toBuffer();
    expect((await readManifest(new Uint8Array(plain), "image/jpeg")).present).toBe(false);
  });
});
