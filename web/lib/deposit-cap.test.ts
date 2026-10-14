import { describe, expect, it } from "vitest";
import { checkDeposit, MAX_DEPOSIT_PER_LICENCE, suggestedDeposit } from "./licensing";

describe("per-licence deposit cap (2 USDC)", () => {
  it("is 2 USDC in 6-decimal units", () => {
    expect(MAX_DEPOSIT_PER_LICENCE).toBe(2_000_000n);
  });
  it("allows up to the cap, in one or several deposits", () => {
    expect(checkDeposit(0n, 2_000_000n)).toBeNull();
    expect(checkDeposit(1_000_000n, 1_000_000n)).toBeNull();
  });
  it("refuses anything over the cap, zero, or after the cap is used", () => {
    expect(checkDeposit(0n, 2_000_001n)).toMatch(/capped at 2.00 USDC per licence.*2.00 USDC left/);
    expect(checkDeposit(1_500_000n, 600_000n)).toMatch(/0.50 USDC left/);
    expect(checkDeposit(2_000_000n, 1n)).toMatch(/0.00 USDC left/);
    expect(checkDeposit(0n, 0n)).toMatch(/above zero/);
  });
  it("suggests the remaining renders' cost, capped by the room left", () => {
    expect(suggestedDeposit(100_000n, 10, 0n)).toBe(1_000_000n); // 10 × 0.10
    expect(suggestedDeposit(500_000n, 10, 0n)).toBe(2_000_000n); // capped
    expect(suggestedDeposit(100_000n, 10, 1_500_000n)).toBe(500_000n);
    expect(suggestedDeposit(100_000n, 0, 0n)).toBe(0n);
  });
});
