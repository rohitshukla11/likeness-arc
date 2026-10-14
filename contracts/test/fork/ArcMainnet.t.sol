// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Base} from "../utils/Base.t.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {CreatorRegistry} from "../../src/CreatorRegistry.sol";
import {LicenseRegistry} from "../../src/LicenseRegistry.sol";
import {LicenseEscrow} from "../../src/LicenseEscrow.sol";
import {ReceiptAnchor} from "../../src/ReceiptAnchor.sol";
import {ArcMainnet} from "../../script/ArcMainnet.sol";
import {MockUSDC} from "../utils/MockUSDC.sol";

/// @notice Runs against an Arc mainnet fork with Circle's real USDC ERC-20 interface. Needs Arc Foundry
///         (`arc-forge`), which models Arc's native USDC; skipped unless ARC_RPC_URL is set.
contract ArcMainnetForkTest is Base {
    /// @dev Native USDC has 18 decimals, the ERC-20 interface 6: one ERC-20 unit is 10^12 native units.
    uint256 internal constant NATIVE_PER_UNIT = 1e12;

    function setUp() public override {
        string memory rpc = vm.envOr("ARC_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(rpc);
        super.setUp();
        // Swap the mock for Circle's token. setEscrow is once-only, so the licence registry and
        // receipt anchor are redeployed alongside the new escrow.
        usdc = MockUSDC(ArcMainnet.USDC);
        licences = new LicenseRegistry(platform, creators);
        receipts = new ReceiptAnchor(platform);
        escrow = new LicenseEscrow(platform, usdc, licences, receipts, treasury, FEE_BPS);
        vm.startPrank(platform);
        licences.setEscrow(address(escrow));
        receipts.setEscrow(address(escrow));
        escrow.setRenderAgent(agent, true);
        vm.stopPrank();
    }

    function test_chainAndUsdc() public view {
        assertEq(block.chainid, ArcMainnet.CHAIN_ID);
        IERC20Metadata t = IERC20Metadata(ArcMainnet.USDC);
        assertGt(ArcMainnet.USDC.code.length, 0);
        assertEq(t.decimals(), 6);
        assertEq(t.symbol(), "USDC");
    }

    /// @dev On Arc the ERC-20 balance is the native balance seen in 6 decimals.
    function test_erc20ViewOfNativeBalance() public {
        address who = makeAddr("holder");
        vm.deal(who, 2 * NATIVE_PER_UNIT * 1e6); // 2 USDC native
        assertEq(IERC20Metadata(ArcMainnet.USDC).balanceOf(who), 2e6);
    }

    function test_renderAndRefund_withCircleUsdc() public {
        _register(creator);
        uint256 id = _license(brand, 3);
        // Fund the brand: deposit plus gas, in native units.
        vm.deal(brand, (3 * uint256(PRICE) + 1e6) * NATIVE_PER_UNIT);
        uint256 brandStart = usdc.balanceOf(brand);
        uint256 payoutStart = usdc.balanceOf(payout);
        uint256 treasuryStart = usdc.balanceOf(treasury);
        vm.startPrank(brand);
        usdc.approve(address(escrow), 3 * PRICE);
        escrow.deposit(id, 3 * PRICE);
        vm.stopPrank();
        assertEq(usdc.balanceOf(address(escrow)), 3 * uint256(PRICE));

        _render(id, brand, keccak256("fork-file"));
        uint256 fee = uint256(PRICE) * FEE_BPS / 10_000;
        assertEq(usdc.balanceOf(payout) - payoutStart, PRICE - fee);
        assertEq(usdc.balanceOf(treasury) - treasuryStart, fee);

        vm.prank(creator);
        licences.revoke(id);
        escrow.refund(id);
        assertEq(brandStart - usdc.balanceOf(brand), uint256(PRICE));
        assertEq(usdc.balanceOf(address(escrow)), 0);
    }
}
