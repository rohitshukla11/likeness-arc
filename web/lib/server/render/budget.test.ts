import { describe, expect, it } from "vitest";
import { RenderBudgetError, reserveRender, utcDay, type CountStore } from "./budget";

const memory = (): CountStore & { m: Map<string, number> } => {
  const m = new Map<string, number>();
  return { m, get: async (d) => m.get(d) ?? 0, set: async (d, c) => void m.set(d, c) };
};

describe("daily render budget", () => {
  it("allows the limit, then refuses until the next UTC day", async () => {
    const s = memory();
    const t = Date.UTC(2026, 9, 14, 23, 0);
    for (let i = 1; i <= 20; i++) expect(await reserveRender(s, 20, t)).toEqual({ used: i, limit: 20 });
    await expect(reserveRender(s, 20, t)).rejects.toBeInstanceOf(RenderBudgetError);
    await expect(reserveRender(s, 20, t)).rejects.toThrow(/20 per UTC day/);
    expect(await reserveRender(s, 20, Date.UTC(2026, 9, 15, 0, 1))).toEqual({ used: 1, limit: 20 });
  });
  it("keys the count by UTC date", () => {
    expect(utcDay(Date.UTC(2026, 9, 14, 23, 59))).toBe("2026-10-14");
    expect(utcDay(Date.UTC(2026, 9, 15, 0, 0))).toBe("2026-10-15");
  });
});
