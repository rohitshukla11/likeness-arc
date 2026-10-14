import type { Metadata } from "next";
import { Poppins, Unbounded } from "next/font/google";
import { SiteFooter } from "@/components/site/SiteFooter";
import "./globals.css";
import { Providers } from "./providers";

const display = Unbounded({ subsets: ["latin"], weight: ["700", "800", "900"], variable: "--font-display-face", display: "swap" });
const body = Poppins({ subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--font-body-face", display: "swap" });

const TAGLINE = "License your face to AI. Your terms, paid per image.";
const DESCRIPTION = `${TAGLINE} Verified creators set the terms, brands pay per render from USDC escrow, and either side can revoke. Live on Arc mainnet with small amounts.`;

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_APP_URL || "https://likeness.site"),
  title: { default: `Likeness: ${TAGLINE}`, template: "%s · Likeness" },
  description: DESCRIPTION,
  openGraph: { type: "website", siteName: "Likeness", title: `Likeness: ${TAGLINE}`, description: DESCRIPTION },
  twitter: { card: "summary", title: `Likeness: ${TAGLINE}`, description: DESCRIPTION },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable}`}>
      <body className="min-h-screen bg-ink font-sans text-ink">
        {/* For screen recordings on localhost: NEXT_PUBLIC_HIDE_DEV_OVERLAY=1 hides Next's dev overlay
            (its badge and issue toasts, including errors thrown by browser extensions). Dev only. */}
        {process.env.NODE_ENV === "development" && process.env.NEXT_PUBLIC_HIDE_DEV_OVERLAY === "1" && <style>{"nextjs-portal{display:none!important}"}</style>}
        <a href="#main" className="sr-only z-50 rounded-full bg-lime px-5 py-3 font-semibold text-ink focus:not-sr-only focus:fixed focus:left-4 focus:top-4">
          Skip to content
        </a>
        <Providers>
          {children}
          <SiteFooter />
        </Providers>
      </body>
    </html>
  );
}
