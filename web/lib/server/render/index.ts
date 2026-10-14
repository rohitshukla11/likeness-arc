import "server-only";
/**
 * Renderers behind one interface:
 *  - Gemini image generation (lib/server/render/gemini) when GEMINI_API_KEY is set;
 *  - only when it is not: the DevRenderer, a clearly marked TEST RENDER (reference composite plus
 *    text overlay) so receipts, payment and verification can run end to end.
 * A configured provider that fails never falls through to the DevRenderer: the render fails instead,
 * with the provider's own error (quota, billing, safety block).
 */
import { dbGet, dbPut } from "../db";
import { geminiModels } from "../gemini";
import { reserveRender } from "./budget";
import { devRender } from "./dev";
import { geminiRender } from "./gemini";
import type { RenderInput, RenderOutput } from "./types";

export type { RenderInput, RenderOutput } from "./types";

export function rendererPlan(): { primary: string; test: boolean } {
  if (process.env.GEMINI_API_KEY) return { primary: `Gemini (${geminiModels.image()})`, test: false };
  return { primary: "DevRenderer (TEST RENDER)", test: true };
}

export async function render(input: RenderInput): Promise<RenderOutput & { attempts: string[] }> {
  if (!process.env.GEMINI_API_KEY) return { ...(await devRender(input)), attempts: ["dev"] };
  // Site-wide daily cap on Gemini renders (lib/server/render/budget); refused before any payment.
  await reserveRender({
    get: async (day) => (await dbGet<{ count: number }>("render-budget", day))?.count ?? 0,
    set: (day, count) => dbPut("render-budget", day, { count }),
  });
  try {
    return { ...(await geminiRender(input)), attempts: [`${geminiModels.image()}: ok`] };
  } catch (e) {
    throw new Error(`render failed: ${(e as Error).message}`);
  }
}
