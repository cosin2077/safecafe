import { parseAbi } from "viem"

export const erc20Abi = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
])

export const stakingAbi = parseAbi([
  "function totalStakedAmount() view returns (uint256)",
  "function totalPendingWithdrawals() view returns (uint256)",
  "function withdrawDelay() view returns (uint128)",
  "function totalValidatorStakes(address validator) view returns (uint256)",
  "function stakes(address staker, address validator) view returns (uint256)",
  "function totalStakerStakes(address staker) view returns (uint256)",
  "function getPendingWithdrawals(address staker) view returns ((uint256 amount, uint256 claimableAt)[])",
  "function getNextClaimableWithdrawal(address staker) view returns (uint256 amount, uint256 claimableAt)",
  "function stake(address validator, uint256 amount)",
  "function initiateWithdrawal(address validator, uint256 amount)",
  "function claimWithdrawal()",
])

export const merkleDropAbi = parseAbi([
  "function merkleRoot() view returns (bytes32)",
  "function cumulativeClaimed(address account) view returns (uint256)",
  "function claim(address account, uint256 cumulativeAmount, bytes32 expectedMerkleRoot, bytes32[] merkleProof)",
])

export const safeAccountAbi = parseAbi([
  "function getOwners() view returns (address[])",
  "function isOwner(address owner) view returns (bool)",
])

export const erc1271Abi = parseAbi(["function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)"])
