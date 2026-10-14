"use client";

/**
 * Brand → render service delegation. With Dynamic configured and a Dynamic wallet, the brand delegates
 * its embedded wallet's key share (delegateWaasKeyShares) with a signer rule pinned to chain 5042 and
 * the protocol's addresses; the server adds the payRender-only and total-cap checks Dynamic's signer
 * layer does not evaluate. A seeded DEV brand can use dev delegation instead (labelled as such).
 */
import { delegateWaasKeyShares, revokeWaasDelegation, buildAllowPolicyRule } from "@dynamic-labs-sdk/client/waas";
import { useGetWalletAccounts } from "@dynamic-labs-sdk/react-hooks";
import { useCallback, useEffect, useState } from "react";
import { actionMessage } from "@/lib/auth";
import { api, reason } from "@/lib/client/tx";
import { deployment } from "@/lib/deployment";
import { usdc } from "@/lib/licensing";
import { useDynamicState } from "@/app/providers";
import { Badge, Button, Card, Field, H2, Note, inputClass } from "@/components/ui";
import { useWallet, type ActiveWallet } from "@/components/wallet/WalletProvider";

type Grant = { provider: "dynamic" | "dev-local"; capUsdc: string; spentUsdc: string; revokedAt?: number; dynamic?: { walletId: string } };
type Info = { grant: Grant | null; rule: { name: string; chain: "EVM"; chainIds: number[]; addresses: string[] }; available: { dynamic: boolean; devLocal: boolean } };

async function signed(wallet: ActiveWallet, action: string, fields: Record<string, string>) {
  const message = actionMessage(action, fields);
  return { message, signature: await wallet.client.signMessage({ account: wallet.client.account, message }) };
}

export function Delegation() {
  const { wallet } = useWallet();
  const dynamic = useDynamicState();
  const [info, setInfo] = useState<Info | null>(null);
  const [cap, setCap] = useState("20.00");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (wallet) setInfo(await api<Info>(`/api/delegation?licensee=${wallet.address}`));
  }, [wallet]);
  useEffect(() => {
    load().catch((e) => setMsg(reason(e)));
  }, [load]);
  if (!wallet || !info) return null;

  const provider: Grant["provider"] | null = wallet.kind === "dynamic" && info.available.dynamic ? "dynamic" : wallet.kind === "dev" && info.available.devLocal ? "dev-local" : null;
  const g = info.grant && !info.grant.revokedAt ? info.grant : null;

  async function grant(afterSign?: () => Promise<void>) {
    setBusy(true);
    try {
      const auth = await signed(wallet!, "delegate render payments", {
        wallet: wallet!.address.toLowerCase(),
        contract: deployment.LicenseEscrow!,
        function: "payRender",
        chain: String(deployment.chainId),
        "total cap (USDC units)": usdc.parse(cap).toString(),
        provider: provider!,
      });
      await api("/api/delegation", { method: "POST", body: JSON.stringify({ licensee: wallet!.address, auth }) });
      await afterSign?.();
      setMsg(provider === "dynamic" ? "Delegated. Dynamic sends the share to our webhook; renders become one click once it lands." : "Dev delegation on.");
      await load();
    } catch (e) {
      setMsg(reason(e));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(afterSign?: () => Promise<void>) {
    setBusy(true);
    try {
      await afterSign?.();
      const auth = await signed(wallet!, "revoke delegation", { wallet: wallet!.address.toLowerCase() });
      await api("/api/delegation", { method: "DELETE", body: JSON.stringify({ licensee: wallet!.address, auth }) });
      setMsg("Delegation revoked.");
      await load();
    } catch (e) {
      setMsg(reason(e));
    } finally {
      setBusy(false);
    }
  }

  // Nothing to offer: no delegation provider on this server and no grant to show or revoke. Brands then
  // confirm each render's payment in their wallet, which the Generate page explains.
  if (!provider && !g) return null;

  return (
    <Card className="space-y-4">
      <div className="flex items-center justify-between">
        <H2>One-click renders (delegated payments)</H2>
        {g ? <Badge tone={g.provider === "dev-local" ? "warn" : "up"}>{g.provider === "dev-local" ? "DEV delegation (local key, not Dynamic)" : g.dynamic ? "Dynamic delegated access" : "Waiting for Dynamic's webhook"}</Badge> : <Badge tone="dim">Off</Badge>}
      </div>
      <p className="max-w-3xl text-muted">
        Lets the render service send exactly one transaction type from your wallet: <span className="font-mono">payRender</span> on the Likeness escrow, chain{" "}
        {deployment.chainId}, up to a total you choose. Without it, you confirm each render's payment in your wallet.
      </p>
      {g && (
        <p className="tnum">
          Spent {usdc.format(BigInt(g.spentUsdc))} of {usdc.format(BigInt(g.capUsdc))} USDC cap.
        </p>
      )}
      {!provider && (
        <Note>
          {wallet.kind === "dynamic"
            ? "Dynamic delegated access is not configured on this server (DYNAMIC_API_KEY, DYNAMIC_WEBHOOK_SECRET, DYNAMIC_DELEGATION_PRIVATE_KEY_FILE)."
            : dynamic === "off"
              ? "Dynamic is not configured, and dev delegation is off (DEV_DELEGATION=1)."
              : "Dev delegation is off on this server (DEV_DELEGATION=1)."}
        </Note>
      )}
      {provider && (
        <div className="flex items-end gap-4">
          <Field label="Total cap (USDC)">
            <input className={inputClass} value={cap} onChange={(e) => setCap(e.target.value)} />
          </Field>
          {provider === "dynamic" ? (
            <DynamicButtons busy={busy} active={!!g} rule={info.rule} onGrant={grant} onRevoke={revoke} />
          ) : (
            <>
              <Button disabled={busy} onClick={() => grant()}>
                {g ? "Update cap" : "Turn on dev delegation"}
              </Button>
              {g && (
                <Button kind="ghost" disabled={busy} onClick={() => revoke()}>
                  Revoke
                </Button>
              )}
            </>
          )}
        </div>
      )}
      {msg && <Note tone="dim">{msg}</Note>}
    </Card>
  );
}

function DynamicButtons({
  busy,
  active,
  rule,
  onGrant,
  onRevoke,
}: {
  busy: boolean;
  active: boolean;
  rule: Info["rule"];
  onGrant: (after: () => Promise<void>) => void;
  onRevoke: (before: () => Promise<void>) => void;
}) {
  const accounts = useGetWalletAccounts();
  const account = accounts.data?.find((a) => a.chain === "EVM");
  if (!account) return null;
  return (
    <>
      <Button
        disabled={busy}
        onClick={() =>
          onGrant(() =>
            delegateWaasKeyShares({
              walletAccount: account,
              // Only fields Dynamic's signer layer enforces: chain id and the touched addresses.
              initialSignerRules: [buildAllowPolicyRule({ name: rule.name, chain: rule.chain as never, chainIds: rule.chainIds, addresses: rule.addresses })],
            }),
          )
        }
      >
        {active ? "Re-delegate with new cap" : "Delegate with Dynamic"}
      </Button>
      {active && (
        <Button kind="ghost" disabled={busy} onClick={() => onRevoke(() => revokeWaasDelegation({ walletAccount: account }))}>
          Revoke
        </Button>
      )}
    </>
  );
}
