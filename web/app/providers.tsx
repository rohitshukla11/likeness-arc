"use client";

/**
 * Dynamic JS SDK (https://www.dynamic.xyz/docs/javascript/reference/react-quickstart.md):
 * one client, the WaaS EVM extension for embedded wallets, and Arc mainnet as the only network.
 * Arc is not in Dynamic's default list, so it is supplied through `transformers.networksData`
 * (documented on DynamicClientConfig in @dynamic-labs-sdk/client 1.38.0).
 */
import { createDynamicClient, type DynamicClient } from "@dynamic-labs-sdk/client";
import { addWaasEvmExtension } from "@dynamic-labs-sdk/evm/waas";
import { DynamicProvider } from "@dynamic-labs-sdk/react-hooks";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { WalletProvider } from "@/components/wallet/WalletProvider";
import { arcMainnet } from "@/lib/chain";

const environmentId = process.env.NEXT_PUBLIC_DYNAMIC_ENV_ID;

type DynamicState = "off" | "loading" | "ready";
const DynamicReady = createContext<DynamicState>("loading");
/** "off" when NEXT_PUBLIC_DYNAMIC_ENV_ID is unset; wallet UI then says so instead of failing. */
export const useDynamicState = () => useContext(DynamicReady);

let client: DynamicClient | undefined;
function getClient(): DynamicClient | undefined {
  if (!environmentId) return undefined;
  if (!client) {
    client = createDynamicClient({
      environmentId,
      metadata: { name: "Likeness" },
      transformers: {
        networksData: (networks) => [
          {
            ...(networks.find((n) => n.chain === "EVM") ?? networks[0]),
            chain: "EVM",
            networkId: String(arcMainnet.id),
            name: arcMainnet.name,
            displayName: arcMainnet.name,
            nativeCurrency: arcMainnet.nativeCurrency,
            rpcUrls: { http: [...arcMainnet.rpcUrls.default.http] },
            blockExplorerUrls: [arcMainnet.blockExplorers.default.url],
          },
        ],
      },
    });
    addWaasEvmExtension(client);
  }
  return client;
}

/** Dynamic's signed session token (JWT) for the signed-in user, if any: proves the sign-in email to our server. */
export function dynamicSessionToken(): string | null {
  return client?.token ?? null;
}

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  // Created after mount: the client needs `window`, and the server render must match the first
  // client render.
  const [dynamic, setDynamic] = useState<DynamicClient>();
  useEffect(() => setDynamic(getClient()), []);
  const state: DynamicState = !environmentId ? "off" : dynamic ? "ready" : "loading";
  const inner = (
    <QueryClientProvider client={queryClient}>
      <WalletProvider>{children}</WalletProvider>
    </QueryClientProvider>
  );
  return (
    <DynamicReady.Provider value={state}>
      {dynamic ? <DynamicProvider client={dynamic}>{inner}</DynamicProvider> : inner}
    </DynamicReady.Provider>
  );
}
