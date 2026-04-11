// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title MigrationPayment
 * @notice Payment contract for ChainClone paid migrations.
 * @dev Deployed on Base Sepolia for demo, Base mainnet for production.
 *      Customers approve USDC, then call payMigration() to pay.
 *      Backend verifies the MigrationPaid event before starting work.
 */
contract MigrationPayment {
    using SafeERC20 for IERC20;

    address public owner;
    IERC20 public immutable usdc;

    // Total USDC collected
    uint256 public totalCollected;

    event MigrationPaid(
        address indexed payer,
        string sourceChain,
        string destChain,
        uint256 contractCount,
        uint256 usdcAmount,
        bytes32 indexed jobId
    );

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event Withdrawn(address indexed to, uint256 amount);

    modifier onlyOwner() {
        require(msg.sender == owner, "MigrationPayment: not owner");
        _;
    }

    constructor(address _usdc) {
        require(_usdc != address(0), "MigrationPayment: zero address");
        owner = msg.sender;
        usdc = IERC20(_usdc);
    }

    /**
     * @notice Pay for a migration job.
     * @param sourceChain Source chain identifier (e.g., "ethereum")
     * @param destChain Destination chain identifier (e.g., "base")
     * @param contractCount Number of contracts being migrated
     * @param usdcAmount Amount of USDC (6 decimals) to pay
     * @param jobId Unique job identifier from the backend
     */
    function payMigration(
        string calldata sourceChain,
        string calldata destChain,
        uint256 contractCount,
        uint256 usdcAmount,
        bytes32 jobId
    ) external {
        require(usdcAmount > 0, "MigrationPayment: amount must be > 0");
        require(contractCount > 0, "MigrationPayment: contractCount must be > 0");
        require(bytes(sourceChain).length > 0, "MigrationPayment: empty sourceChain");
        require(bytes(destChain).length > 0, "MigrationPayment: empty destChain");

        usdc.safeTransferFrom(msg.sender, address(this), usdcAmount);
        totalCollected += usdcAmount;

        emit MigrationPaid(msg.sender, sourceChain, destChain, contractCount, usdcAmount, jobId);
    }

    /**
     * @notice Withdraw collected USDC to a specified address.
     */
    function withdrawUsdc(address to, uint256 amount) external onlyOwner {
        require(to != address(0), "MigrationPayment: zero address");
        require(amount > 0, "MigrationPayment: zero amount");
        usdc.safeTransfer(to, amount);
        emit Withdrawn(to, amount);
    }

    /**
     * @notice Transfer ownership.
     */
    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "MigrationPayment: zero address");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }
}
