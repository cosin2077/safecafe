import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { privateKeyToAccount } from "viem/accounts"
import { planStake } from "../src/protocol/txPlan.ts"
import {
  readSigningKeyring,
  readSigningPrivateKey,
  selectEoaSigningKey,
  selectSafeSigningKey,
  sendSafePlanTransactions,
} from "../src/shared/cli.ts"

const safeAddress = "0x1111111111111111111111111111111111111111"
const pk1 = `0x${"11".repeat(32)}`
const pk2 = `0x${"22".repeat(32)}`
const owner1 = privateKeyToAccount(pk1).address
const owner2 = privateKeyToAccount(pk2).address
const enoughAllowance = 10n * 10n ** 18n

const plan = {
  ...planStake({
    account: safeAddress,
    allowance: enoughAllowance,
    amount: "10",
    validator: "0xCc00DE0eA14c08669b26DcBFE365dBD9890B04D9",
  }),
  account: safeAddress,
}

const txState = {
  confirmations: new Map(),
  executed: 0,
  nonce: 0n,
  transactionHash: `0x${"ab".repeat(32)}`,
}

const safePublicClient = {
  async getChainId() {
    return 1
  },
  async readContract({ functionName }) {
    if (functionName === "getOwners") return [owner1, owner2]
    if (functionName === "getThreshold") return 2n
    if (functionName === "nonce") return txState.nonce
    if (functionName === "getTransactionHash") return txState.transactionHash
    throw new Error(`Unexpected Safe read: ${functionName}`)
  },
}

function createTxService() {
  return {
    async confirmTransaction(safeTxHash, signature) {
      assert.equal(safeTxHash, txState.transactionHash)
      const owner = signature === signatureFor(owner1) ? owner1 : owner2
      txState.confirmations.set(owner, signature)
      return { signature }
    },
    async getTransactionConfirmations(safeTxHash) {
      assert.equal(safeTxHash, txState.transactionHash)
      if (!txState.confirmations.size) {
        const error = new Error("Not found")
        error.code = "safe_tx_service_not_found"
        throw error
      }
      return {
        results: [...txState.confirmations.entries()].map(([owner, signature]) => ({ owner, signature })),
      }
    },
    async proposeTransaction({ safeTxHash, senderAddress, senderSignature }) {
      assert.equal(safeTxHash, txState.transactionHash)
      txState.confirmations.set(senderAddress, senderSignature)
    },
  }
}

function signatureFor(owner) {
  const seed = owner.slice(2).padEnd(128, "0").slice(0, 128)
  return `0x${seed}1f`
}

function safeInfoReader({ signerAddress }) {
  return Promise.resolve({
    isOwner:
      signerAddress.toLowerCase() === owner1.toLowerCase() || signerAddress.toLowerCase() === owner2.toLowerCase(),
    threshold: 2,
  })
}

const txService = createTxService()

const first = await sendSafePlanTransactions(plan, {
  createSafeTxService() {
    return txService
  },
  privateKey: pk1,
  safePublicClient,
  signSafeHash: () => Promise.resolve(signatureFor(owner1)),
})

assert.deepEqual(first, {
  confirmations: 1,
  mode: "safe-proposed",
  safeTxHash: txState.transactionHash,
  threshold: 2,
})
assert.equal(txState.executed, 0)

const submitted = []
const confirmed = []
const second = await sendSafePlanTransactions(plan, {
  createSafeTxService() {
    return txService
  },
  privateKey: pk2,
  safePublicClient,
  sendSafeTransaction: async (_transaction, tx) => {
    txState.executed += 1
    submitted.push(tx.label)
    return `0x${"ee".repeat(32)}`
  },
  signSafeHash: () => Promise.resolve(signatureFor(owner2)),
  waitForSafeReceipt: async (_hash, tx) => {
    txState.nonce += 1n
    confirmed.push(tx.label)
    return { blockNumber: 123n, status: "success" }
  },
})

assert.deepEqual(second, {
  mode: "safe-executed",
  safeTxHash: txState.transactionHash,
  threshold: 2,
})
assert.equal(txState.executed, 1)
assert.deepEqual(submitted, ["Stake SAFE to validator"])
assert.deepEqual(confirmed, ["Stake SAFE to validator"])

let directTxServiceCalls = 0
let directSignCount = 0
let directSubmitted = 0
let directConfirmed = 0
const directResult = await sendSafePlanTransactions(plan, {
  createSafeTxService() {
    return {
      async confirmTransaction() {
        directTxServiceCalls += 1
      },
      async getTransactionConfirmations() {
        directTxServiceCalls += 1
        return { results: [] }
      },
      async proposeTransaction() {
        directTxServiceCalls += 1
      },
    }
  },
  privateKey: pk1,
  safePublicClient: {
    async getChainId() {
      return 1
    },
    async readContract({ functionName }) {
      if (functionName === "getOwners") return [owner1]
      if (functionName === "getThreshold") return 1n
      if (functionName === "nonce") return 5n
      if (functionName === "getTransactionHash") return txState.transactionHash
      throw new Error(`Unexpected direct Safe read: ${functionName}`)
    },
  },
  sendSafeTransaction: async () => {
    directSubmitted += 1
    return `0x${"ed".repeat(32)}`
  },
  signSafeHash: async () => {
    directSignCount += 1
    return signatureFor(owner1)
  },
  waitForSafeReceipt: async () => {
    directConfirmed += 1
    return { blockNumber: 124n, status: "success" }
  },
})

assert.deepEqual(directResult, {
  mode: "safe-executed",
  safeTxHash: txState.transactionHash,
  threshold: 1,
})
assert.equal(directTxServiceCalls, 0)
assert.equal(directSignCount, 0)
assert.equal(directSubmitted, 1)
assert.equal(directConfirmed, 1)

const tempDir = mkdtempSync(join(tmpdir(), "safecafe-cli-key-"))
const keyFile = join(tempDir, "safe.key")
writeFileSync(keyFile, `${pk1}\n`)

try {
  assert.equal(await readSigningPrivateKey({}, { SAFECAFE_CLI_PRIVATE_KEY: pk2 }), pk2)
  assert.equal(await readSigningPrivateKey({}, { SAFECAFE_CLI_PRIVATE_KEY_FILE: keyFile }), pk1)
  const keyring = await readSigningKeyring(
    {},
    {
      SAFECAFE_CLI_PRIVATE_KEYS: `${pk1},${pk2}`,
      SAFECAFE_CLI_SIGNER_ADDRESS: owner2,
    },
  )
  assert.deepEqual(
    keyring.map((key) => key.address),
    [owner1, owner2],
  )
  assert.equal(selectEoaSigningKey(keyring, owner2).privateKey, pk2)
  assert.equal(selectEoaSigningKey(keyring, owner2, owner2).privateKey, pk2)

  const ownerKey = await selectSafeSigningKey(keyring, {
    createSafeInfoReader: safeInfoReader,
    preferredSigner: owner1,
    safeAddress,
  })
  assert.equal(ownerKey.privateKey, pk1)

  await assert.rejects(
    () =>
      selectSafeSigningKey(keyring, {
        createSafeInfoReader: safeInfoReader,
        safeAddress,
      }),
    /Multiple configured signers can operate Safe/,
  )

  await assert.rejects(
    () =>
      selectSafeSigningKey(keyring, {
        createSafeInfoReader: safeInfoReader,
        preferredSigner: "0x3333333333333333333333333333333333333333",
        safeAddress,
      }),
    /is not present in the configured keyring/,
  )
} finally {
  rmSync(tempDir, { force: true, recursive: true })
}

console.log("CLI Safe flow tests passed")
