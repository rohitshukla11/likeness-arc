"use client";

/**
 * The one wallet the app acts with. Either:
 *  - "dynamic": the signed-in user's Dynamic embedded wallet (needs NEXT_PUBLIC_DYNAMIC_ENV_ID), or
 *  - "dev": a seeded test wallet (the unverified test creator or the test brand), offered only when the
 *    local server runs with DEV_WALLETS=1. Always badged DEV in the header.
 * Pages ask for `useWallet()` and never care which it is; signing goes through viem either way.
 */
import { isEvmWalletAccount } from "@dynamic-labs-sdk/evm";
import { createWalletClientForWalletAccount } from "@dynamic-labs-sdk/evm/viem";
import { useGetWalletAccounts } from "@dynamic-labs-sdk/react-hooks";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { createWalletClient, http, type Account, type Address, type Chain, type Transport, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcMainnet } from "@/lib/chain";
import { useDynamicState } from "@/app/providers";

export type ActiveWallet = {
  kind: "dynamic" | "dev";
  address: Address;
  label: string;
  client: WalletClient<Transport, Chain, Account>;
  /** Dev creator only: the secret its namespace keys derive from (lib/crypto/devkeys). */
  devSecret?: string;
};

/** `key` absent: a read-only view of that address (screenshots, demos); anything that signs fails. */
export type DevWallet = { role: "creator" | "brand"; label: string; address: Address; key?: `0x${string}`; devSecret?: string };

type Ctx = {
  wallet: ActiveWallet | null;
  devWallets: DevWallet[];
  useDev(address: Address | null): void;
};

const WalletCtx = createContext<Ctx>({ wallet: null, devWallets: [], useDev: () => {} });
export const useWallet = () => useContext(WalletCtx);

const DEV_CHOICE = "likeness:dev-wallet";

function devClient(w: DevWallet): ActiveWallet {
  const client = createWalletClient({ account: w.key ? privateKeyToAccount(w.key) : w.address, chain: arcMainnet, transport: http() }) as WalletClient<Transport, Chain, Account>;
  return { kind: "dev", address: w.address, label: w.label, client, devSecret: w.devSecret };
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const dynamicState = useDynamicState();
  const [devWallets, setDevWallets] = useState<DevWallet[]>([]);
  const [devChoice, setDevChoice] = useState<Address | null>(null);
  const [dynamicWallet, setDynamicWallet] = useState<ActiveWallet | null>(null);

  useEffect(() => {
    fetch("/api/dev/wallets")
      .then((r) => (r.ok ? r.json() : { wallets: [] }))
      .then((j: { wallets: DevWallet[] }) => setDevWallets(j.wallets))
      .catch(() => {});
    try {
      // Per tab (sessionStorage), so one tab can act as the DEV brand while another uses your own wallet.
      setDevChoice((sessionStorage.getItem(DEV_CHOICE) as Address | null) ?? null);
    } catch {}
  }, []);

  const useDev = useCallback((address: Address | null) => {
    setDevChoice(address);
    try {
      if (address) sessionStorage.setItem(DEV_CHOICE, address);
      else sessionStorage.removeItem(DEV_CHOICE);
    } catch {}
  }, []);

  const dev = devWallets.find((w) => w.address.toLowerCase() === devChoice?.toLowerCase());
  const wallet = dev ? devClient(dev) : dynamicWallet;

  return (
    <WalletCtx.Provider value={{ wallet, devWallets, useDev }}>
      {dynamicState === "ready" && <DynamicBridge onWallet={setDynamicWallet} />}
      {children}
    </WalletCtx.Provider>
  );
}

/** Mounted only inside DynamicProvider: turns the signed-in embedded wallet into an ActiveWallet. */
function DynamicBridge({ onWallet }: { onWallet: (w: ActiveWallet | null) => void }) {
  const accounts = useGetWalletAccounts();
  const account = accounts.data?.find((a) => a.chain === "EVM");
  useEffect(() => {
    let cancelled = false;
    if (!account || !isEvmWalletAccount(account)) {
      onWallet(null);
      return;
    }
    createWalletClientForWalletAccount({ walletAccount: account }).then((client) => {
      if (cancelled) return;
      onWallet({
        kind: "dynamic",
        address: account.address as Address,
        label: "Dynamic embedded wallet",
        client: client as unknown as WalletClient<Transport, Chain, Account>,
      });
    }).catch((e: unknown) => {
      // Dynamic could not hand over a signer for this account: act as signed out, and say why in the console.
      console.warn("Dynamic wallet client unavailable:", e instanceof Error ? e.message : e);
      if (!cancelled) onWallet(null);
    });
    return () => {
      cancelled = true;
    };
  }, [account, onWallet]);
  return null;
}
