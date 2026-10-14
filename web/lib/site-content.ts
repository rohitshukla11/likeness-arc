/**
 * Marketing copy that is data, not code. Every number here is a real measurement with its source;
 * testimonials are real quotes only. An empty list hides the section entirely.
 */

export const MEASUREMENTS = {
  /**
   * CreatorRegistry.register on Arc mainnet, send to receipt over the public RPC. Null until it has been
   * measured on this deployment: the card is not shown without a real number.
   */
  registerMs: {
    value: null as number | null,
    source: "CreatorRegistry.register on Arc mainnet, send to receipt over the public RPC (not measured yet)",
  },
  /** By construction: payRender anchors the receipt in the same transaction, and files are released only after it. */
  rendersWithReceipt: {
    value: 100,
    source: "LicenseEscrow.payRender anchors the receipt in the same transaction that pays the creator",
  },
} as const;

export type Testimonial = { quote: string; name: string; role: string };

/** Real, attributed quotes only. Leave empty until there are some: the section is then not rendered. */
export const TESTIMONIALS: Testimonial[] = [];

export const BUILT_ON = ["Arc", "Circle USDC", "Dynamic", "Didit", "Mera", "Gemini", "C2PA"];
