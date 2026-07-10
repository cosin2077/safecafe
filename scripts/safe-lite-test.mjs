import assert from "node:assert/strict"
import {
  buildApprovedHashSignature,
  normalizePersonalSafeSignature,
  packSafeSignatures,
  submitSafeLitePlan,
} from "../packages/safe-lite/src/index.ts"

const ownerOne = "0x0000000000000000000000000000000000000001"
const ownerTwo = "0x0000000000000000000000000000000000000002"
const safeAddress = "0x1000000000000000000000000000000000000000"
const targetAddress = "0x2000000000000000000000000000000000000000"
const safeTxHash = `0x${"ab".repeat(32)}`
const signatureOne = fixedSignature("11", "1f")
const signatureTwo = fixedSignature("22", "20")

assert.equal(normalizePersonalSafeSignature(fixedSignature("aa", "00")), fixedSignature("aa", "1f"))
assert.equal(normalizePersonalSafeSignature(fixedSignature("aa", "01")), fixedSignature("aa", "20"))
assert.equal(normalizePersonalSafeSignature(fixedSignature("aa", "1b")), fixedSignature("aa", "1f"))
assert.equal(normalizePersonalSafeSignature(fixedSignature("aa", "1c")), fixedSignature("aa", "20"))
assert.equal(normalizePersonalSafeSignature(fixedSignature("aa", "1f")), fixedSignature("aa", "1f"))
assert.equal(normalizePersonalSafeSignature(fixedSignature("aa", "20")), fixedSignature("aa", "20"))
assert.throws(() => normalizePersonalSafeSignature(fixedSignature("aa", "02")), /Unsupported Safe EOA signature/)
assert.throws(() => normalizePersonalSafeSignature("0x1234"), /Only fixed 65-byte/)

assert.equal(buildApprovedHashSignature(ownerOne), `0x${"0".repeat(63)}1${"0".repeat(64)}01`)
assert.equal(
  packSafeSignatures(
    [
      { owner: ownerTwo, signature: signatureTwo },
      { owner: ownerOne, signature: signatureOne },
    ],
    2,
  ),
  `0x${signatureOne.slice(2)}${signatureTwo.slice(2)}`,
)
assert.equal(
  packSafeSignatures(
    [
      { owner: ownerOne, signature: signatureOne },
      { owner: ownerOne, signature: signatureTwo },
    ],
    1,
  ),
  signatureTwo,
)
assert.throws(() => packSafeSignatures([{ owner: ownerOne, signature: "0x1234" }], 1), /Only fixed 65-byte/)
assert.throws(() => packSafeSignatures([{ owner: ownerOne, signature: signatureOne }], 2), /needs 2 confirmations/)

let signCount = 0
let confirmCount = 0
let proposeCount = 0
let sendCount = 0
const enoughConfirmationsResult = await submitSafeLitePlan({
  client: createSafeClient(),
  safeAddress,
  signerAddress: ownerOne,
  txService: {
    async confirmTransaction() {
      confirmCount += 1
    },
    async getTransactionConfirmations() {
      return {
        results: [
          { owner: ownerTwo, signature: signatureTwo },
          { owner: ownerOne, signature: signatureOne },
        ],
      }
    },
    async proposeTransaction() {
      proposeCount += 1
    },
  },
  txs: [plannedTx()],
  signHash: async () => {
    signCount += 1
    return signatureOne
  },
  sendTransaction: async () => {
    sendCount += 1
    return `0x${"ee".repeat(32)}`
  },
})
assert.equal(enoughConfirmationsResult.mode, "executed")
assert.equal(signCount, 0)
assert.equal(confirmCount, 0)
assert.equal(proposeCount, 0)
assert.equal(sendCount, 1)

signCount = 0
confirmCount = 0
sendCount = 0
const missingSignerResult = await submitSafeLitePlan({
  client: createSafeClient(),
  safeAddress,
  signerAddress: ownerOne,
  txService: {
    async confirmTransaction(_safeTxHash, signature) {
      confirmCount += 1
      assert.equal(signature, signatureOne)
    },
    async getTransactionConfirmations() {
      return { results: [{ owner: ownerTwo, signature: signatureTwo }] }
    },
    async proposeTransaction() {
      throw new Error("proposal should not be recreated")
    },
  },
  txs: [plannedTx()],
  signHash: async () => {
    signCount += 1
    return signatureOne
  },
  sendTransaction: async () => {
    sendCount += 1
    return `0x${"ef".repeat(32)}`
  },
})
assert.equal(missingSignerResult.mode, "executed")
assert.equal(signCount, 1)
assert.equal(confirmCount, 1)
assert.equal(sendCount, 1)

proposeCount = 0
signCount = 0
const proposedResult = await submitSafeLitePlan({
  client: createSafeClient(),
  safeAddress,
  signerAddress: ownerOne,
  txService: {
    async confirmTransaction() {
      throw new Error("confirmation should not run before proposal exists")
    },
    async getTransactionConfirmations() {
      const error = new Error("not found")
      error.code = "safe_tx_service_not_found"
      throw error
    },
    async proposeTransaction({ senderSignature }) {
      proposeCount += 1
      assert.equal(senderSignature, signatureOne)
    },
  },
  txs: [plannedTx()],
  signHash: async () => {
    signCount += 1
    return signatureOne
  },
  sendTransaction: async () => {
    throw new Error("transaction should wait for another owner")
  },
})
assert.deepEqual(proposedResult, {
  completedTxs: 0,
  confirmations: 1,
  mode: "proposed",
  safeTxHash,
  threshold: 2,
  txIndex: 0,
  txLabel: "Test tx",
})
assert.equal(proposeCount, 1)
assert.equal(signCount, 1)

let directServiceCalls = 0
let directSignCount = 0
let directSendCount = 0
const directResult = await submitSafeLitePlan({
  client: createSingleOwnerSafeClient(),
  safeAddress,
  signerAddress: ownerOne,
  txService: {
    async confirmTransaction() {
      directServiceCalls += 1
    },
    async getTransactionConfirmations() {
      directServiceCalls += 1
      return { results: [] }
    },
    async proposeTransaction() {
      directServiceCalls += 1
    },
  },
  txs: [plannedTx()],
  signHash: async () => {
    directSignCount += 1
    return signatureOne
  },
  sendTransaction: async () => {
    directSendCount += 1
    return `0x${"dd".repeat(32)}`
  },
})
assert.equal(directResult.mode, "executed")
assert.equal(directServiceCalls, 0)
assert.equal(directSignCount, 0)
assert.equal(directSendCount, 1)

console.log("Safe lite tests passed")

function fixedSignature(byte, v) {
  return `0x${byte.repeat(64)}${v}`
}

function plannedTx() {
  return {
    data: "0x1234",
    label: "Test tx",
    to: targetAddress,
    value: 0n,
  }
}

function createSafeClient() {
  return {
    async getChainId() {
      return 1
    },
    async readContract({ functionName }) {
      if (functionName === "getOwners") return [ownerOne, ownerTwo]
      if (functionName === "getThreshold") return 2n
      if (functionName === "nonce") return 7n
      if (functionName === "getTransactionHash") return safeTxHash
      throw new Error(`Unexpected read: ${functionName}`)
    },
  }
}

function createSingleOwnerSafeClient() {
  return {
    async getChainId() {
      return 1
    },
    async readContract({ functionName }) {
      if (functionName === "getOwners") return [ownerOne]
      if (functionName === "getThreshold") return 1n
      if (functionName === "nonce") return 3n
      if (functionName === "getTransactionHash") return safeTxHash
      throw new Error(`Unexpected read: ${functionName}`)
    },
  }
}
