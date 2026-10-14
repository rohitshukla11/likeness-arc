/**
 * Site-wide cap on Gemini renders: every licensed or sample render costs Gemini credit, so this mainnet
 * deployment allows at most RENDERS_PER_DAY (default 20) per UTC day across the whole site. The count
 * lives in the app's record store, so every server instance shares it; two renders racing for the last
 * slot can overshoot by one. A slot is used when the Gemini call starts, even if it then fails.
 */
export type CountStore = {
  get(day: string): Promise<number>;
  set(day: string, count: number): Promise<void>;
};

export class RenderBudgetError extends Error {
  constructor(readonly limit: number) {
    super(`the site's daily render limit (${limit} per UTC day) has been reached; try again after 00:00 UTC`);
  }
}

export const dailyRenderLimit = () => Number(process.env.RENDERS_PER_DAY ?? 20);
export const utcDay = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

/** Take one render slot for today, or throw RenderBudgetError when the day's limit is used up. */
export async function reserveRender(store: CountStore, limit = dailyRenderLimit(), now = Date.now()): Promise<{ used: number; limit: number }> {
  const day = utcDay(now);
  const used = await store.get(day);
  if (used >= limit) throw new RenderBudgetError(limit);
  await store.set(day, used + 1);
  return { used: used + 1, limit };
}
