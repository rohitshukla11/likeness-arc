import "server-only";
/**
 * Delegated access: the brand lets the render service send exactly one kind of transaction from its
 * wallet, LicenseEscrow.payRender on chain 5042, up to a total USDC cap the brand chose.
 *
 * Three layers enforce that, from outermost in:
 *  1. Dynamic signer policy (set by the brand's browser when delegating): chain id 5042 and an address
 *     allowlist (the protocol contracts and USDC). Dynamic's SDK states that `functionName`,
 *     `contractAbi` and `valueLimit.totalLimit` are not evaluated on signer layers, so we do not
 *     pretend they are.
 *  2. This module's guard, run before any delegated signature: destination is our escrow, chain is
 *     5042, value is 0, calldata decodes as payRender for a licence this brand holds, and the price
 *     fits under the remaining cap.
 *  3. The contract: payRender needs the licensee as sender and a render agent's signature, and pays
 *     at most the licence price from that licence's escrow.
 *
 * Signers behind one interface:
 *  - "dynamic": Dynamic delegated access (@dynamic-labs-wallet/node-evm delegatedSignTransaction),
 *    from the share the `wallet.delegation.created` webhook delivered (stored still encrypted to our
 *    RSA key, decrypted per signature);
 *  - "dev-local": a seeded test brand's key file, only with DEV_DELEGATION=1. Labelled as such.
 */
import { readFileSync } from "node:fs";
import { secretText } from "./secret";
import path from "node:path";
import { decodeFunctionData, encodeFunctionData, isAddress, toFunctionSelector, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { LicenseEscrowAbi } from "@/lib/abi/LicenseEscrow";
import { USDC } from "@/lib/chain";
import { deployment, requireAddress } from "@/lib/deployment";
import { pub, serverChain, singleton, withMargin } from "./chain";
import { dbGet, dbPut } from "./db";
import { readLicence } from "./protocol";

export type Grant = {
  licensee: Address;
  provider: "dynamic" | "dev-local";
  capUsdc: string; // total, 6 decimals
  spentUsdc: string;
  createdAt: number;
  revokedAt?: number;
  dynamic?: {
    walletId: string;
    shareSetId?: string;
    encryptedDelegatedShare: unknown; // still encrypted to DYNAMIC_DELEGATION_PRIVATE_KEY
    encryptedWalletApiKey: unknown;
  };
};

export type TxRequest = { to: Address; data: Hex; value: bigint; chainId: number };

export const PAY_RENDER_SELECTOR = toFunctionSelector("payRender(uint256,bytes32,address,uint64,bytes)");

/** Addresses a payRender transaction touches, for the Dynamic address allowlist. */
export async function policyAddresses(): Promise<Address[]> {
  // USDC is a proxy; Dynamic evaluates every address a transaction touches, implementation included.
  const slot = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
  const raw = await pub().getStorageAt({ address: USDC, slot });
  const impl = raw && raw !== "0x" && BigInt(raw) !== 0n ? (`0x${raw.slice(-40)}` as Address) : undefined;
  return [
    requireAddress("LicenseEscrow"),
    requireAddress("LicenseRegistry"),
    requireAddress("ReceiptAnchor"),
    requireAddress("CreatorRegistry"),
    USDC,
    ...(impl ? [impl] : []),
  ];
}

/** The rule the brand's browser installs with delegateWaasKeyShares (only fields Dynamic enforces). */
export async function dynamicSignerRule() {
  return { name: "Likeness: payRender only", chain: "EVM" as const, chainIds: [deployment.chainId], addresses: await policyAddresses() };
}

const locks = singleton("delegation-locks", () => new Map<string, Promise<unknown>>());

/** Serialise spends per brand so two renders can't both fit under the same remaining cap. */
async function withLock<T>(key: string, f: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.then(f, f);
  locks.set(key, next.catch(() => {}));
  return next;
}

export class PolicyError extends Error {
  constructor(readonly reason: string) {
    super(`delegation policy refused: ${reason}`);
  }
}

/** Layer 2. Pure apart from reading the licence; returns the price this transaction may spend. */
export async function checkPolicy(tx: TxRequest, grant: Grant): Promise<bigint> {
  if (grant.revokedAt) throw new PolicyError("delegation revoked");
  if (tx.chainId !== deployment.chainId) throw new PolicyError(`chain ${tx.chainId} is not ${deployment.chainId}`);
  if (tx.to.toLowerCase() !== requireAddress("LicenseEscrow").toLowerCase()) throw new PolicyError("destination is not the Likeness escrow");
  if (tx.value !== 0n) throw new PolicyError("transaction carries value");
  if (tx.data.slice(0, 10).toLowerCase() !== PAY_RENDER_SELECTOR) throw new PolicyError("function is not payRender");
  let licenceId: bigint;
  try {
    const d = decodeFunctionData({ abi: LicenseEscrowAbi, data: tx.data });
    if (d.functionName !== "payRender") throw new Error();
    licenceId = d.args[0];
  } catch {
    throw new PolicyError("calldata does not decode as payRender");
  }
  const l = await readLicence(licenceId);
  if (!l) throw new PolicyError("unknown licence");
  if (l.licensee !== grant.licensee.toLowerCase()) throw new PolicyError("licence belongs to another brand");
  const remaining = BigInt(grant.capUsdc) - BigInt(grant.spentUsdc);
  if (l.pricePerRender > remaining) throw new PolicyError(`total cap reached (${remaining} of ${grant.capUsdc} USDC units left)`);
  return l.pricePerRender;
}

export const getGrant = (licensee: string) => dbGet<Grant>("delegations", licensee.toLowerCase());
export const saveGrant = (g: Grant) => dbPut("delegations", g.licensee.toLowerCase(), g);

// ---------------------------------------------------------------- signers

type Signed = { hash: Hex; from: Address; provider: Grant["provider"] };

function devKeyFor(licensee: Address): Hex {
  if (process.env.DEV_DELEGATION !== "1") throw new PolicyError("dev delegation is off (DEV_DELEGATION=1 enables it for seeded test brands)");
  const dir = path.resolve(/*turbopackIgnore: true*/ process.cwd(), process.env.DEV_KEYS_DIR ?? "../.secrets/dev");
  let key: string;
  try {
    key = readFileSync(path.join(dir, `${licensee.toLowerCase()}.key`), "utf8").trim();
  } catch {
    throw new PolicyError("no dev key for this brand; only seeded test brands can use dev delegation");
  }
  if (privateKeyToAccount(key as Hex).address.toLowerCase() !== licensee.toLowerCase()) throw new PolicyError("dev key does not match the brand");
  return key as Hex;
}

async function dynamicSign(grant: Grant, tx: Required<Pick<TxRequest, "to" | "data" | "chainId">> & { gas: bigint; nonce: number; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }): Promise<Hex> {
  const environmentId = process.env.NEXT_PUBLIC_DYNAMIC_ENV_ID;
  const apiKey = process.env.DYNAMIC_API_KEY;
  const pem = secretText("DYNAMIC_DELEGATION_PRIVATE_KEY_PEM", "DYNAMIC_DELEGATION_PRIVATE_KEY_FILE");
  if (!environmentId || !apiKey || !pem || !grant.dynamic) throw new PolicyError("Dynamic delegated access is not configured");
  const { decryptDelegatedWebhookData } = await import("@dynamic-labs-wallet/node");
  const { createDelegatedEvmWalletClient, delegatedSignTransaction } = await import("@dynamic-labs-wallet/node-evm");
  const { decryptedDelegatedShare, decryptedWalletApiKey } = decryptDelegatedWebhookData({
    privateKeyPem: pem,
    encryptedDelegatedKeyShare: grant.dynamic.encryptedDelegatedShare as never,
    encryptedWalletApiKey: grant.dynamic.encryptedWalletApiKey as never,
  });
  const client = createDelegatedEvmWalletClient({ environmentId, apiKey });
  const signed = await delegatedSignTransaction(client, {
    walletId: grant.dynamic.walletId,
    shareSetId: grant.dynamic.shareSetId,
    walletApiKey: decryptedWalletApiKey,
    keyShare: decryptedDelegatedShare,
    transaction: { type: "eip1559", ...tx, value: 0n },
  });
  return signed as Hex;
}

/**
 * Send payRender from the brand's wallet under its delegation. Every call passes the policy guard
 * first and is serialised per brand; the cap is only charged once the transaction succeeds.
 */
export async function sendDelegatedPayRender(
  licensee: Address,
  args: { licenceId: bigint; assetHash: Hex; agent: Address; deadline: bigint; agentSig: Hex },
): Promise<Signed & { gasUsed: bigint; blockNumber: bigint; confirmMs: number }> {
  if (!isAddress(licensee)) throw new PolicyError("bad licensee");
  return withLock(licensee.toLowerCase(), async () => {
    const grant = await getGrant(licensee);
    if (!grant) throw new PolicyError("this brand has not delegated render payments");
    const data = encodeFunctionData({
      abi: LicenseEscrowAbi,
      functionName: "payRender",
      args: [args.licenceId, args.assetHash, args.agent, args.deadline, args.agentSig],
    });
    const chain = serverChain();
    const tx: TxRequest = { to: requireAddress("LicenseEscrow"), data, value: 0n, chainId: chain.id };
    const price = await checkPolicy(tx, grant);

    const client = pub();
    const [gas, nonce, fees] = await Promise.all([
      client.estimateGas({ account: licensee, to: tx.to, data }),
      client.getTransactionCount({ address: licensee, blockTag: "pending" }),
      client.estimateFeesPerGas(),
    ]);
    const full = { to: tx.to, data, chainId: chain.id, gas: withMargin(gas), nonce, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas };

    let raw: Hex;
    if (grant.provider === "dynamic") {
      raw = await dynamicSign(grant, full);
    } else {
      const account = privateKeyToAccount(devKeyFor(licensee));
      raw = await account.signTransaction({ type: "eip1559", ...full, value: 0n });
    }
    const sent = Date.now();
    const hash = await client.sendRawTransaction({ serializedTransaction: raw });
    const receipt = await client.waitForTransactionReceipt({ hash });
    const confirmMs = Date.now() - sent;
    if (receipt.status !== "success") throw new Error(`payRender reverted: ${hash}`);
    grant.spentUsdc = (BigInt(grant.spentUsdc) + price).toString();
    await saveGrant(grant);
    return { hash, from: licensee, provider: grant.provider, gasUsed: receipt.gasUsed, blockNumber: receipt.blockNumber, confirmMs };
  });
}
