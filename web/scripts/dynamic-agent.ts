/**
 * Create the render agent as a Dynamic server wallet (@dynamic-labs-wallet/node-evm 1.1.28):
 *
 *   pnpm agent:dynamic
 *
 * Needs NEXT_PUBLIC_DYNAMIC_ENV_ID and DYNAMIC_API_KEY (an environment API token) in .env.local.
 * Writes the wallet metadata and its external server key shares to DYNAMIC_AGENT_FILE (default
 * ../.secrets/dynamic-agent.json, mode 0600; the SDK is stateless, so this file is the wallet's half).
 * Then registers the address with LicenseEscrow.setRenderAgent from the owner key (../.secrets/deployer.key).
 * From then on lib/server/agent.ts signs Render attestations with this wallet instead of the local key.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { LicenseEscrowAbi } from "@/lib/abi/LicenseEscrow";
import { arcMainnet } from "@/lib/chain";
import { deployment } from "@/lib/deployment";

function env(name: string): string {
  if (process.env[name]) return process.env[name]!;
  for (const line of existsSync(".env.local") ? readFileSync(".env.local", "utf8").split("\n") : []) {
    const m = new RegExp(`^\\s*${name}\\s*=\\s*(.+?)\\s*$`).exec(line);
    if (m) return m[1];
  }
  throw new Error(`${name} is not set (.env.local)`);
}

async function main() {
  const environmentId = env("NEXT_PUBLIC_DYNAMIC_ENV_ID");
  const apiKey = env("DYNAMIC_API_KEY");
  const file = process.env.DYNAMIC_AGENT_FILE ?? "../.secrets/dynamic-agent.json";
  let saved = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;

  if (!saved) {
    const { DynamicEvmWalletClient } = await import("@dynamic-labs-wallet/node-evm");
    const { ThresholdSignatureScheme } = await import("@dynamic-labs-wallet/node");
    const client = new DynamicEvmWalletClient({ environmentId });
    await client.authenticateApiToken(apiKey);
    const w = await client.createWalletAccount({ thresholdSignatureScheme: ThresholdSignatureScheme.TWO_OF_TWO });
    saved = { createdAt: new Date().toISOString(), walletMetadata: w.walletMetadata, externalServerKeyShares: w.externalServerKeyShares };
    writeFileSync(file, JSON.stringify(saved, null, 2), { mode: 0o600 });
    console.log(`Created Dynamic server wallet ${w.walletMetadata.accountAddress}; shares saved to ${file}`);
  }
  const agent = saved.walletMetadata.accountAddress as Address;
  const pub = createPublicClient({ chain: arcMainnet, transport: http() });
  if (await pub.readContract({ address: deployment.LicenseEscrow!, abi: LicenseEscrowAbi, functionName: "isRenderAgent", args: [agent] })) {
    console.log(`${agent} is already a registered render agent.`);
    return;
  }
  const ownerKey = readFileSync("../.secrets/deployer.key", "utf8").trim() as Hex;
  const owner = createWalletClient({ chain: arcMainnet, transport: http(), account: privateKeyToAccount(ownerKey) });
  const hash = await owner.writeContract({ address: deployment.LicenseEscrow!, abi: LicenseEscrowAbi, functionName: "setRenderAgent", args: [agent, true], gas: 90_000n });
  await pub.waitForTransactionReceipt({ hash });
  console.log(`Registered ${agent} as render agent: https://explorer.arc.io/tx/${hash}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
