// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CreatorRegistry} from "../src/CreatorRegistry.sol";
import {LicenseRegistry} from "../src/LicenseRegistry.sol";
import {LicenseEscrow} from "../src/LicenseEscrow.sol";
import {ReceiptAnchor} from "../src/ReceiptAnchor.sol";
import {ArcMainnet} from "./ArcMainnet.sol";

/// @notice Deploys and wires the four contracts on Arc mainnet.
///
///   forge script script/Deploy.s.sol --rpc-url arc_mainnet --account <keystore> --broadcast
///
/// The key comes from an encrypted Foundry keystore (`cast wallet import`), never from an env var.
/// Optional env: ATTESTER, RENDER_AGENT, TREASURY (each defaults to the deployer, and can be rotated
/// later with setAttester / setRenderAgent / setTreasury) and FEE_BPS (default 1000 = 10%).
contract Deploy is Script {
    function run() external {
        require(block.chainid == ArcMainnet.CHAIN_ID, "not Arc mainnet");
        address deployer = msg.sender;
        address attester = vm.envOr("ATTESTER", deployer);
        address agent = vm.envOr("RENDER_AGENT", deployer);
        address treasury = vm.envOr("TREASURY", deployer);
        uint16 feeBps = uint16(vm.envOr("FEE_BPS", uint256(1_000)));

        vm.startBroadcast();
        CreatorRegistry creators = new CreatorRegistry(deployer, attester);
        LicenseRegistry licences = new LicenseRegistry(deployer, creators);
        ReceiptAnchor receipts = new ReceiptAnchor(deployer);
        LicenseEscrow escrow =
            new LicenseEscrow(deployer, IERC20(ArcMainnet.USDC), licences, receipts, treasury, feeBps);
        licences.setEscrow(address(escrow));
        receipts.setEscrow(address(escrow));
        escrow.setRenderAgent(agent, true);
        vm.stopBroadcast();

        console.log("CreatorRegistry", address(creators));
        console.log("LicenseRegistry", address(licences));
        console.log("ReceiptAnchor  ", address(receipts));
        console.log("LicenseEscrow  ", address(escrow));

        string memory j = "deployment";
        vm.serializeUint(j, "chainId", block.chainid);
        // The block the script simulated against; the first contract lands a few blocks later, so
        // deployments/arc-mainnet.json is corrected to CreatorRegistry's creation block.
        vm.serializeUint(j, "startBlock", block.number);
        vm.serializeAddress(j, "usdc", ArcMainnet.USDC);
        vm.serializeAddress(j, "owner", deployer);
        vm.serializeAddress(j, "attester", attester);
        vm.serializeAddress(j, "renderAgent", agent);
        vm.serializeAddress(j, "treasury", treasury);
        vm.serializeUint(j, "feeBps", feeBps);
        vm.serializeAddress(j, "CreatorRegistry", address(creators));
        vm.serializeAddress(j, "LicenseRegistry", address(licences));
        vm.serializeAddress(j, "ReceiptAnchor", address(receipts));
        string memory out = vm.serializeAddress(j, "LicenseEscrow", address(escrow));
        if (vm.envOr("WRITE_DEPLOYMENT", false)) vm.writeJson(out, "../deployments/arc-mainnet.json");
    }
}
