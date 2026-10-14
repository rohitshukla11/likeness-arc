import { stringToHex } from "viem";
import { describe, expect, it } from "vitest";
import { DEMO_CREATOR_NAME, DEMO_TRUST_LABEL, PROVIDERS, trustOf } from "./licensing";

const b = (s: string) => stringToHex(s, { size: 32 });

describe("scripted demo creator", () => {
  it("is its own trust level, never verified", () => {
    const t = trustOf(b(PROVIDERS.demoScripted), b(PROVIDERS.demoScripted));
    expect(t.level).toBe("demo");
    expect(trustOf(b("didit:passive"), b(PROVIDERS.demoScripted)).level).toBe("demo");
  });
  it("is labelled and named for display", () => {
    expect(DEMO_TRUST_LABEL).toBe("Demo (scripted, no ID check)");
    expect(DEMO_CREATOR_NAME).toBe("Demo Creator");
  });
  it("stays out of the marketplace, which lists only Didit-verified creators", () => {
    const listed = [trustOf(b(PROVIDERS.demoScripted), b(PROVIDERS.demoScripted)), trustOf(b("didit:passive"), b("didit"))].filter((t) => t.level === "verified");
    expect(listed).toHaveLength(1);
  });
});
