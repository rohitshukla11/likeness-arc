/**
 * DEV/TEST ONLY: a local arc-anvil fork of Arc mainnet (Arc Foundry, which models Arc's native USDC),
 * with the real deployed contracts and Circle's USDC. The protocol owner is impersonated to point the
 * attester and render agent at throwaway test keys, and USDC is given by setting native balances (18
 * decimals), which the ERC-20 interface reads in 6 decimals. Nothing here touches the public chain.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  defineChain,
  erc20Abi,
  http,
  parseEther,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CreatorRegistryAbi } from "@/lib/abi/CreatorRegistry";
import { LicenseEscrowAbi } from "@/lib/abi/LicenseEscrow";
import { arcMainnet, USDC } from "@/lib/chain";
import { deployment } from "@/lib/deployment";

export const anvilBin = process.env.ANVIL_BIN ?? `${homedir()}/.local/bin/arc-anvil`;
export const hasAnvil = () => existsSync(anvilBin);

export type Fork = {
  url: string;
  chain: ReturnType<typeof defineChain>;
  pub: ReturnType<typeof createPublicClient>;
  test: ReturnType<typeof createTestClient>;
  forkBlock: bigint;
  stop(): void;
};

export async function startFork(port: number, upstream = process.env.FORK_UPSTREAM_RPC ?? "https://rpc.mainnet.arc.io"): Promise<Fork> {
  const proc: ChildProcess = spawn(anvilBin, ["--network", "arc", "--fork-url", upstream, "--port", String(port), "--silent", "--no-rate-limit"], { stdio: "ignore" });
  const url = `http://127.0.0.1:${port}`;
  const chain = defineChain({ ...arcMainnet, rpcUrls: { default: { http: [url] } } });
  const pub = createPublicClient({ chain, transport: http(url) });
  const test = createTestClient({ chain, transport: http(url), mode: "anvil" });
  for (let i = 0; i < 150; i++) {
    try {
      const forkBlock = await pub.getBlockNumber();
      return { url, chain, pub, test, forkBlock, stop: () => proc.kill() };
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  proc.kill();
  throw new Error("anvil fork did not start");
}

/** Point the deployed contracts' attester and render agent at test keys (owner impersonated). */
export async function takeOverRoles(fork: Fork, roles: { attester: Address; agent: Address }) {
  const owner = (await fork.pub.readContract({ address: deployment.CreatorRegistry!, abi: CreatorRegistryAbi, functionName: "owner" })) as Address;
  await fork.test.impersonateAccount({ address: owner });
  await fork.test.setBalance({ address: owner, value: parseEther("10") });
  const ownerWallet = createWalletClient({ chain: fork.chain, transport: http(fork.url), account: owner });
  for (const call of [
    { address: deployment.CreatorRegistry!, abi: CreatorRegistryAbi, functionName: "setAttester", args: [roles.attester] },
    { address: deployment.LicenseEscrow!, abi: LicenseEscrowAbi, functionName: "setRenderAgent", args: [roles.agent, true] },
  ] as const) {
    const hash = await ownerWallet.writeContract(call as never);
    await fork.pub.waitForTransactionReceipt({ hash });
  }
  await fork.test.stopImpersonatingAccount({ address: owner });
}

/** Give `to` exactly `amount` USDC (6 decimals): on Arc the ERC-20 balance is the native balance. */
export async function dealUsdc(fork: Fork, to: Address, amount: bigint) {
  await fork.test.setBalance({ address: to, value: amount * 10n ** 12n });
  const bal = await fork.pub.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [to] });
  if (bal !== amount) throw new Error(`USDC balance is ${bal}, expected ${amount}`);
}

export function wallet(fork: Fork, key: Hex) {
  return createWalletClient({ chain: fork.chain, transport: http(fork.url), account: privateKeyToAccount(key) });
}
