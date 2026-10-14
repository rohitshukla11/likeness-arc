import { afterEach, describe, expect, it, vi } from "vitest";
import { integrations } from "./integrations";

describe("status: gas top-up", () => {
  afterEach(() => vi.unstubAllEnvs());
  const drip = () => integrations().find((i) => i.key === "gas-drip")!;

  it("is listed, and configured when the drip key is set", () => {
    vi.stubEnv("DRIP_KEY_FILE", "/nonexistent");
    vi.stubEnv("DRIP_PRIVATE_KEY", "0x" + "11".repeat(32));
    expect(drip()).toMatchObject({ configured: true });
  });

  it("is not configured without a key", () => {
    vi.stubEnv("DRIP_PRIVATE_KEY", "");
    vi.stubEnv("DRIP_KEY_FILE", "/nonexistent");
    expect(drip().configured).toBe(false);
  });
});

describe("status: Dynamic delegated access on Arc mainnet", () => {
  afterEach(() => vi.unstubAllEnvs());
  const delegation = () => integrations().find((i) => i.key === "dynamic-delegation")!;

  it("stays off without DYNAMIC_DELEGATION_ENABLED=1, even with every credential set", () => {
    vi.stubEnv("NEXT_PUBLIC_DYNAMIC_ENV_ID", "env");
    vi.stubEnv("DYNAMIC_API_KEY", "k");
    vi.stubEnv("DYNAMIC_WEBHOOK_SECRET", "w");
    vi.stubEnv("DYNAMIC_DELEGATION_PRIVATE_KEY_PEM", "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----");
    vi.stubEnv("DYNAMIC_DELEGATION_ENABLED", "");
    expect(delegation().configured).toBe(false);
    vi.stubEnv("DYNAMIC_DELEGATION_ENABLED", "1");
    expect(delegation().configured).toBe(true);
  });
});
