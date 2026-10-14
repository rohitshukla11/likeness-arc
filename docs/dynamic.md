# How Likeness uses Dynamic (Arc mainnet)

[Back to the README](../README.md)

## Status on the Arc mainnet deployment

- **On:** every person signs in with email through Dynamic and gets a Dynamic embedded wallet (WaaS,
  EVM). Arc mainnet is supplied to Dynamic as a custom EVM network and is the only network.
- **Off:** delegated access (one-click renders paid from the brand's wallet by the render service). It is
  sandbox-only without a Dynamic Enterprise plan, so this deployment keeps it off: the app requires
  `DYNAMIC_DELEGATION_ENABLED=1` on top of the credentials, and it isn't set. Brands confirm each
  `payRender` in their own wallet.
- **Not used:** the Dynamic server wallet as render agent (the render agent is a local key, registered on
  the escrow), and Fireblocks Flow.

## Arc as a custom network

[`providers.tsx`](../web/app/providers.tsx) passes Arc to Dynamic through `transformers.networksData`,
from [`lib/chain.ts`](../web/lib/chain.ts). The same values go into the Dynamic dashboard:

| Field | Value |
|---|---|
| Chain ID / network ID | `5042` |
| Name | `Arc` |
| Native currency | `USDC`, symbol `USDC`, **18 decimals** (Arc's native gas token) |
| RPC | `https://rpc.mainnet.arc.io` |
| Block explorer | `https://explorer.arc.io` |

USDC's ERC-20 interface (`0x3600…0000`, 6 decimals) is the same balance seen in 6 decimals; the app
reads and moves licence money through it, and pays gas from the native side.

## The delegated-access code (off here)

The code for delegated access stays in the repo, behind the switch above:
[`Delegation.tsx`](../web/components/dashboard/Delegation.tsx) (`delegateWaasKeyShares` with a signer rule
pinned to the chain and the protocol's addresses), the webhook
[`api/dynamic/webhook`](../web/app/api/dynamic/webhook/route.ts) (HMAC-checked, share stored still
encrypted), and [`delegation.ts`](../web/lib/server/delegation.ts) (a payRender-only guard with a total
cap before any delegated signature). None of it runs on this deployment.
