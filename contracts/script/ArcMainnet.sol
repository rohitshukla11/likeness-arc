// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @notice Arc mainnet constants. Each is checked against the chain by test/fork/ArcMainnet.t.sol.
library ArcMainnet {
    /// @dev https://docs.arc.io/arc/references/rpc-endpoints.md ("Chain ID (Mainnet) 5042")
    uint256 internal constant CHAIN_ID = 5042;

    /// @dev Circle USDC's ERC-20 interface, 6 decimals. It shares one balance with native USDC (18
    ///      decimals, Arc's gas token). https://docs.arc.io/arc/references/contract-addresses.md
    address internal constant USDC = 0x3600000000000000000000000000000000000000;
}
