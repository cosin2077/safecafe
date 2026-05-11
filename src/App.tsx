import {
  ArrowDownToLine,
  ArrowUpRight,
  CheckCircle2,
  Clock3,
  Copy,
  Database,
  ExternalLink,
  Gift,
  Globe2,
  LayoutDashboard,
  LineChart,
  ListFilter,
  Menu,
  MoreHorizontal,
  ShieldCheck,
  TerminalSquare,
  Upload,
  Wallet,
  X,
} from "lucide-react"
import { type ReactNode, useEffect, useMemo, useState } from "react"
import { createWalletClient, custom, keccak256, toHex, type Address, type Hex } from "viem"
import { mainnet } from "viem/chains"
import {
  CHAIN_ID,
  CONTRACTS,
  EXPLORER_BASE_URL,
  compactAddress,
  createSafenetPublicClient,
  fetchRewardProof,
  fetchSafeUsdPrice,
  fetchValidators,
  findValidator,
  formatSafe,
  formatUsdFromSafe,
  mockSummary,
  mockValidators,
  parseSafeAmount,
  planClaimRewards,
  planClaimWithdrawal,
  planStake,
  planUnstake,
  readAccountSnapshot,
  readHealth,
  readValidatorPositions,
  readValidatorTotals,
  SAFE_PRICE_CACHE_MS,
  SAFE_PRICE_SOURCE,
  toSafeTransactionPayload,
  type AccountSnapshot,
  type TxPlan,
  type TxPlanAction,
  type ValidatorInfo,
} from "./protocol"
import {
  createPathMap,
  navFromPath as resolveNavFromPath,
  readCachedSafePrice as readStoredSafePrice,
  writeCachedSafePrice as writeStoredSafePrice,
} from "./shared"
import { messages, type Locale, type MessageBundle } from "./i18n"

const navItems = ["dashboard", "validators", "withdrawals", "rewards", "cli", "docs"] as const
type NavItem = (typeof navItems)[number]
type Action = TxPlanAction
const navPaths = createPathMap(navItems)
const emptySummary = {
  safeBalance: 0n,
  totalStaked: 0n,
  pendingWithdrawals: 0n,
  claimableWithdrawals: 0n,
  claimableRewards: 0n,
  withdrawDelay: 0n,
}
const defaultValidator: ValidatorInfo = {
  address: "0xCc00DE0eA14c08669b26DcBFE365dBD9890B04D9",
  label: "Core Contributors",
  status: "active",
  commission: 0,
  participationRate: 0,
  totalStake: 0n,
  userStake: 0n,
}
const testMode = import.meta.env.DEV && import.meta.env.VITE_SAFECAFE_TEST_MODE === "true"
const testAddress = import.meta.env.VITE_SAFECAFE_TEST_ADDRESS as Address | undefined
const testMerkleRoot = `0x${"0".repeat(64)}` as Hex
const safePriceCacheKey = "safecafe.safeUsdPrice.v1"

type Toast = { id: number; message: string; tone?: "success" | "warning" | "info" }
type AccountSummary = typeof emptySummary
type SafePriceState = {
  usd: number | null
  source: string
  fetchedAt: number | null
  stale: boolean
  error: string
}
type DataStatus = {
  chainId: number | null
  isLive: boolean
  liveBlock: bigint | null
  liveError: string
  merkleRootMatched: boolean | null
  proofFound: boolean
  rewardsSource: string
  validatorCount: number
  validatorStakeOk: boolean
  validatorStakeStatus: string
}
type Modal =
  | { type: "readiness" }
  | { type: "validator"; validator: ValidatorInfo }
  | { type: "data" }
  | { type: "network" }
  | { type: "wallet" }
  | null

const navFromPath = (pathname: string): NavItem => resolveNavFromPath(pathname, navItems, navPaths, "dashboard")

export function App() {
  const [locale, setLocale] = useState<Locale>("en")
  const [activeNav, setActiveNav] = useState<NavItem>(() => navFromPath(window.location.pathname))
  const [isMenuOpen, setIsMenuOpen] = useState(false)
  const [account, setAccount] = useState<Address | null>(null)
  const [action, setAction] = useState<Action>("stake")
  const [validator, setValidator] = useState<Address>(defaultValidator.address)
  const [amount, setAmount] = useState("100")
  const [txPlan, setTxPlan] = useState<TxPlan | null>(null)
  const [modal, setModal] = useState<Modal>(null)
  const [showOnlyActive, setShowOnlyActive] = useState(false)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [liveSnapshot, setLiveSnapshot] = useState<AccountSnapshot | null>(null)
  const [liveRewards, setLiveRewards] = useState<bigint | null>(null)
  const [liveBlock, setLiveBlock] = useState<bigint | null>(null)
  const [liveError, setLiveError] = useState("")
  const [isReadingLive, setIsReadingLive] = useState(false)
  const [validators, setValidators] = useState<ValidatorInfo[]>([])
  const [rewardProof, setRewardProof] = useState<Awaited<ReturnType<typeof fetchRewardProof>> | null>(null)
  const [liveMerkleRoot, setLiveMerkleRoot] = useState<string | null>(null)
  const [chainId, setChainId] = useState<number | null>(null)
  const [txProgress, setTxProgress] = useState("")
  const [validatorStakeError, setValidatorStakeError] = useState("")
  const [safePrice, setSafePrice] = useState<SafePriceState>(() => readCachedSafePrice())

  const t = messages[locale]
  const connectedAccount = account
  const selectedValidator = useMemo(
    () => findValidator(validators, validator) ?? validators[0] ?? defaultValidator,
    [validator, validators],
  )
  const visibleValidators = showOnlyActive
    ? validators.filter((item) => item.status === "active")
    : validators
  const validatorPoolTotal = useMemo(
    () => validators.reduce((sum, item) => sum + item.totalStake, 0n),
    [validators],
  )
  const summary = useMemo(() => {
    if (!liveSnapshot) return emptySummary
    const pendingWithdrawals = liveSnapshot.pendingWithdrawals.reduce((sum, item) => sum + item.amount, 0n)
    const now = BigInt(Math.floor(Date.now() / 1000))
    const [nextAmount, nextClaimableAt] = liveSnapshot.nextClaimableWithdrawal
    return {
      safeBalance: liveSnapshot.safeBalance,
      totalStaked: liveSnapshot.totalStaked,
      pendingWithdrawals,
      claimableWithdrawals: nextClaimableAt <= now ? nextAmount : 0n,
      claimableRewards: liveRewards ?? 0n,
      withdrawDelay: liveSnapshot.withdrawDelay,
    }
  }, [liveRewards, liveSnapshot])
  const dataStatus: DataStatus = useMemo(() => {
    const merkleRootMatched =
      rewardProof && liveMerkleRoot
        ? rewardProof.merkleRoot.toLowerCase() === liveMerkleRoot.toLowerCase()
        : null
    return {
      chainId,
      isLive: Boolean(liveSnapshot),
      liveBlock,
      liveError,
      merkleRootMatched,
      proofFound: Boolean(rewardProof),
      rewardsSource: rewardProof ? t.proofLoaded : liveSnapshot ? t.proofMissing : t.notChecked,
      validatorCount: validators.length,
      validatorStakeOk: validators.length > 0 && validatorPoolTotal > 0n && !validatorStakeError,
      validatorStakeStatus: validatorStakeError || (validators.length === 0 ? t.notChecked : validatorPoolTotal > 0n ? t.ready : t.validatorStakeUnavailable),
    }
  }, [chainId, liveBlock, liveError, liveMerkleRoot, liveSnapshot, rewardProof, t, validatorPoolTotal, validatorStakeError, validators.length])

  useEffect(() => {
    const handlePopState = () => setActiveNav(navFromPath(window.location.pathname))
    window.addEventListener("popstate", handlePopState)
    return () => window.removeEventListener("popstate", handlePopState)
  }, [])

  useEffect(() => {
    let cancelled = false
    const cached = readCachedSafePrice()
    if (cached.usd !== null && cached.fetchedAt && Date.now() - cached.fetchedAt < SAFE_PRICE_CACHE_MS) {
      setSafePrice(cached)
      return
    }

    fetchSafeUsdPrice().then((price) => {
      if (cancelled) return
      const nextPrice: SafePriceState = {
        usd: price.usd,
        source: price.source,
        fetchedAt: price.fetchedAt,
        stale: false,
        error: "",
      }
      writeCachedSafePrice(nextPrice)
      setSafePrice(nextPrice)
    }).catch((error) => {
      if (cancelled) return
      setSafePrice({
        ...cached,
        stale: cached.usd !== null,
        error: error instanceof Error ? error.message : t.priceUnavailable,
      })
    })

    return () => {
      cancelled = true
    }
  }, [t.priceUnavailable])

  useEffect(() => {
    setTxPlan(null)
  }, [amount, validator])

  useEffect(() => {
    if (testMode) {
      setValidators(mockValidators)
      setValidator((current) => findValidator(mockValidators, current)?.address ?? mockValidators[0]?.address ?? current)
      return
    }
    fetchValidators().then(async (items) => {
      const client = createSafenetPublicClient(import.meta.env.VITE_RPC_URL)
      setValidatorStakeError("")
      const validatorsWithTotals = await readValidatorTotals(client, items).catch((error) => {
        setValidatorStakeError(error instanceof Error ? error.message : t.validatorStakeUnavailable)
        return items
      })
      setValidators(validatorsWithTotals)
      setValidator((current) => findValidator(validatorsWithTotals, current)?.address ?? validatorsWithTotals[0]?.address ?? current)
    }).catch((error) => {
      toast(error instanceof Error ? error.message : t.validatorInfoFailed, "warning")
    })
  }, [t.validatorInfoFailed])

  useEffect(() => {
    if (!window.ethereum) return
    window.ethereum.request({ method: "eth_chainId" })
      .then((value) => setChainId(Number.parseInt(value as string, 16)))
      .catch(() => undefined)
    window.ethereum.request({ method: "eth_accounts" })
      .then(async (accounts) => {
        const [first] = accounts as Address[]
        if (!first) return
        setAccount(first)
        await refreshLiveReads(first)
      })
      .catch(() => undefined)

    const handleAccountsChanged = (accounts: unknown) => {
      const [first] = accounts as Address[]
      setAccount(first ?? null)
      setTxPlan(null)
      setLiveSnapshot(null)
      setRewardProof(null)
      setLiveRewards(null)
      if (first) void refreshLiveReads(first)
    }
    const handleChainChanged = (value: unknown) => {
      setChainId(Number.parseInt(value as string, 16))
      window.ethereum?.request({ method: "eth_accounts" })
        .then((accounts) => {
          const [first] = accounts as Address[]
          if (first) void refreshLiveReads(first)
        })
        .catch(() => undefined)
    }
    window.ethereum.on?.("accountsChanged", handleAccountsChanged)
    window.ethereum.on?.("chainChanged", handleChainChanged)
    return () => {
      window.ethereum?.removeListener?.("accountsChanged", handleAccountsChanged)
      window.ethereum?.removeListener?.("chainChanged", handleChainChanged)
    }
  }, [])

  function toast(message: string, tone: Toast["tone"] = "info") {
    const id = Date.now()
    setToasts((current) => [...current, { id, message, tone }])
    window.setTimeout(() => {
      setToasts((current) => current.filter((item) => item.id !== id))
    }, 2600)
  }

  function navigate(nextNav: NavItem) {
    setActiveNav(nextNav)
    setIsMenuOpen(false)
    const nextPath = navPaths[nextNav]
    if (window.location.pathname !== nextPath) {
      window.history.pushState(null, "", nextPath)
    }
  }

  async function connectWallet() {
    if (canUseTestWallet()) {
      await connectTestWallet()
      return
    }
    if (!window.ethereum) {
      toast(t.noWallet, "warning")
      return
    }
    try {
      const accounts = (await window.ethereum.request({ method: "eth_requestAccounts" })) as Address[]
      setAccount(accounts[0])
      await ensureMainnet()
      toast(t.walletReady, "success")
      await refreshLiveReads(accounts[0])
    } catch (error) {
      toast(error instanceof Error ? error.message : t.wrongNetwork, "warning")
    }
  }

  async function connectTestWallet() {
    if (!testAddress) return
    setAccount(testAddress)
    setChainId(CHAIN_ID)
    toast(t.testWalletConnected, "success")
    await refreshLiveReads(testAddress)
  }

  function disconnectWallet() {
    setAccount(null)
    setLiveSnapshot(null)
    setLiveRewards(null)
    setRewardProof(null)
    setTxPlan(null)
    setTxProgress("")
    toast(t.walletDisconnected, "info")
  }

  async function ensureMainnet() {
    if (canUseTestWallet()) {
      setChainId(CHAIN_ID)
      return
    }
    if (!window.ethereum) throw new Error(t.noWallet)
    const rawChainId = (await window.ethereum.request({ method: "eth_chainId" })) as string
    const currentChainId = Number.parseInt(rawChainId, 16)
    setChainId(currentChainId)
    if (currentChainId === CHAIN_ID) return

    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: `0x${CHAIN_ID.toString(16)}` }],
    })
    setChainId(CHAIN_ID)
    toast(t.mainnetReady, "success")
  }

  async function handleNetworkClick() {
    try {
      if (!window.ethereum) {
        setModal({ type: "network" })
        return
      }
      await ensureMainnet()
      if (account) await refreshLiveReads(account)
    } catch (error) {
      toast(error instanceof Error ? error.message : t.wrongNetwork, "warning")
    }
  }

  async function refreshOrConnect() {
    if (!account) {
      await connectWallet()
      return
    }
    await refreshLiveReads(account)
  }

  async function refreshLiveReads(target = account) {
    if (!target) {
      toast(t.connectToLoad, "warning")
      return
    }
    setIsReadingLive(true)
    setLiveError("")
    try {
      if (isTestAccount(target)) {
        setLiveSnapshot(createTestSnapshot())
        setLiveBlock(19_999_999n)
        setLiveMerkleRoot(testMerkleRoot)
        setValidators(mockValidators)
        setRewardProof({
          cumulativeAmount: mockSummary.claimableRewards.toString(),
          merkleRoot: testMerkleRoot,
          proof: [],
        })
        setLiveRewards(mockSummary.claimableRewards)
        toast(t.liveLoaded, "success")
        return
      }
      const client = createSafenetPublicClient(import.meta.env.VITE_RPC_URL)
      const [snapshot, health, validatorMetadata] = await Promise.all([
        readAccountSnapshot(client, target),
        readHealth(client),
        fetchValidators(),
      ])
      setLiveSnapshot(snapshot)
      setLiveBlock(health.blockNumber)
      setLiveMerkleRoot(health.merkleRoot)
      setValidators(await readValidatorPositions(client, target, validatorMetadata))

      try {
        const proof = await fetchRewardProof(target)
        setRewardProof(proof)
        const cumulativeAmount = proof ? BigInt(proof.cumulativeAmount) : 0n
        setLiveRewards(cumulativeAmount > snapshot.cumulativeClaimed ? cumulativeAmount - snapshot.cumulativeClaimed : 0n)
      } catch {
        setRewardProof(null)
        setLiveRewards(0n)
      }

      toast(t.liveLoaded, "success")
    } catch (error) {
      const message = error instanceof Error ? error.message : t.liveDataFailed
      setLiveError(message)
      toast(message, "warning")
    } finally {
      setIsReadingLive(false)
    }
  }

  async function buildPlan(nextAction = action) {
    if (!account || !liveSnapshot) {
      setTxPlan(null)
      toast(t.connectToPlan, "warning")
      return
    }
    const validation = validateAction(nextAction)
    if (validation) {
      setTxPlan(null)
      toast(validation, "warning")
      return
    }
    try {
      let nextPlan: TxPlan | null = null
      if (nextAction === "stake") {
        nextPlan = planStake({ validator, amount, account, allowance: liveSnapshot.stakingAllowance })
      }
      if (nextAction === "unstake") {
        nextPlan = planUnstake({ validator, amount, account })
      }
      if (nextAction === "claim-withdrawal") {
        nextPlan = planClaimWithdrawal(account)
      }
      if (nextAction === "claim-rewards") {
        if (!rewardProof?.proof) throw new Error(t.noProof)
        if (liveMerkleRoot && rewardProof.merkleRoot.toLowerCase() !== liveMerkleRoot.toLowerCase()) {
          throw new Error(t.merkleMismatch)
        }
        if ((liveRewards ?? 0n) <= 0n) throw new Error(t.noProof)
        nextPlan = planClaimRewards({
          account,
          cumulativeAmount: BigInt(rewardProof.cumulativeAmount),
          merkleRoot: rewardProof.merkleRoot,
          proof: rewardProof.proof,
        })
      }
      if (!nextPlan) return
      const simulatedPlan = await simulateTxPlan(nextPlan)
      setTxPlan(simulatedPlan)
      if (simulatedPlan.simulation?.status === "failed") {
        toast(simulatedPlan.simulation.message, "warning")
        return
      }
      toast(t.planReady, "success")
    } catch (error) {
      toast(error instanceof Error ? error.message : t.buildPlanFailed, "warning")
    }
  }

  async function simulateTxPlan(plan: TxPlan): Promise<TxPlan> {
    if (isTestAccount(account)) {
      return {
        ...plan,
        simulation: {
          status: "passed",
          simulatedTxs: plan.txs.length,
          message: t.testPreflightPassed,
        },
      }
    }
    if (!account) return plan
    const client = createSafenetPublicClient(import.meta.env.VITE_RPC_URL)
    const txsToSimulate = plan.action === "stake" && plan.txs.length > 1 ? plan.txs.slice(0, 1) : plan.txs
    try {
      for (const tx of txsToSimulate) {
        await client.call({
          account,
          to: tx.to,
          data: tx.data,
          value: tx.value,
        })
      }
      return {
        ...plan,
        simulation: {
          status: txsToSimulate.length === plan.txs.length ? "passed" : "partial",
          simulatedTxs: txsToSimulate.length,
          message: txsToSimulate.length === plan.txs.length ? t.simulationPassed : t.simulationPartial,
        },
      }
    } catch (error) {
      return {
        ...plan,
        simulation: {
          status: "failed",
          simulatedTxs: 0,
          message: readableSimulationError(error, t.simulationFailed),
        },
      }
    }
  }

  async function submitPlan() {
    if (!txPlan) return
    if (isTestAccount(account)) {
      await submitTestPlan(txPlan)
      return
    }
    if (!window.ethereum) {
      toast(t.noWallet, "warning")
      return
    }
    if (!account) {
      await connectWallet()
      return
    }
    setIsSubmitting(true)
    setTxProgress("")
    try {
      await ensureMainnet()
      const validation = validateAction(txPlan.action)
      if (validation) throw new Error(validation)
      if (!txPlan.simulation) throw new Error(t.connectToPlan)
      if (txPlan.simulation.status === "failed") throw new Error(txPlan.simulation.message)
      const client = createWalletClient({
        account,
        chain: mainnet,
        transport: custom(window.ethereum),
      })
      const publicClient = createSafenetPublicClient(import.meta.env.VITE_RPC_URL)
      for (const tx of txPlan.txs) {
        setTxProgress(`${t.simulationStatus}: ${translateTxLabel(tx.label, t)}`)
        try {
          await publicClient.call({
            account,
            to: tx.to,
            data: tx.data,
            value: tx.value,
          })
        } catch (error) {
          throw new Error(readableSimulationError(error, t.simulationFailed))
        }
        setTxProgress(translateTxLabel(tx.label, t))
        const hash = await client.sendTransaction({
          account,
          to: tx.to,
          data: tx.data,
          value: tx.value,
        })
        toast(`${t.submittedTx} ${translateTxLabel(tx.label, t)}: ${compactAddress(hash, 10, 8)}`, "success")
        await publicClient.waitForTransactionReceipt({ hash })
      }
      await refreshLiveReads(account)
    } catch (error) {
      toast(error instanceof Error ? error.message : t.transactionFailed, "warning")
    } finally {
      setIsSubmitting(false)
      setTxProgress("")
    }
  }

  async function submitTestPlan(plan: TxPlan) {
    if (!testAddress) {
      toast(t.noWallet, "warning")
      return
    }
    setIsSubmitting(true)
    setTxProgress("")
    try {
      for (const tx of plan.txs) {
        setTxProgress(`${t.simulationStatus}: ${translateTxLabel(tx.label, t)}`)
        await wait(180)
        setTxProgress(translateTxLabel(tx.label, t))
        const authorization = keccak256(toHex(`Safecafe test authorization:${testAddress}:${plan.action}:${tx.to}:${tx.data}`))
        const hash = keccak256(toHex(`${authorization}:${tx.to}:${tx.data}:${Date.now()}`))
        toast(`${t.testAuthorizedTx} ${translateTxLabel(tx.label, t)}: ${compactAddress(hash, 10, 8)}`, "success")
        await wait(220)
      }
      applyTestPlan(plan.action)
      setTxPlan(null)
    } catch (error) {
      toast(error instanceof Error ? error.message : t.transactionFailed, "warning")
    } finally {
      setIsSubmitting(false)
      setTxProgress("")
    }
  }

  function applyTestPlan(planAction: Action) {
    const parsedAmount = safeParsedAmount(amount) ?? 0n
    setLiveSnapshot((current) => {
      if (!current) return current
      if (planAction === "stake") {
        return {
          ...current,
          safeBalance: current.safeBalance - parsedAmount,
          totalStaked: current.totalStaked + parsedAmount,
          stakingAllowance: current.stakingAllowance > parsedAmount ? current.stakingAllowance - parsedAmount : 0n,
        }
      }
      if (planAction === "unstake") {
        const claimableAt = BigInt(Math.floor(Date.now() / 1000)) + current.withdrawDelay
        return {
          ...current,
          totalStaked: current.totalStaked - parsedAmount,
          pendingWithdrawals: [...current.pendingWithdrawals, { amount: parsedAmount, claimableAt }],
          nextClaimableWithdrawal: current.nextClaimableWithdrawal[0] > 0n ? current.nextClaimableWithdrawal : [parsedAmount, claimableAt],
        }
      }
      if (planAction === "claim-withdrawal") {
        const claimable = current.nextClaimableWithdrawal[0]
        const claimableAt = current.nextClaimableWithdrawal[1]
        let removedClaimedWithdrawal = false
        const remainingWithdrawals = current.pendingWithdrawals.filter((item) => {
          if (!removedClaimedWithdrawal && item.amount === claimable && item.claimableAt === claimableAt) {
            removedClaimedWithdrawal = true
            return false
          }
          return true
        })
        const nextWithdrawal = remainingWithdrawals[0]
        return {
          ...current,
          safeBalance: current.safeBalance + claimable,
          pendingWithdrawals: remainingWithdrawals,
          nextClaimableWithdrawal: nextWithdrawal ? [nextWithdrawal.amount, nextWithdrawal.claimableAt] : [0n, 0n],
        }
      }
      if (planAction === "claim-rewards") {
        const rewards = liveRewards ?? 0n
        setLiveRewards(0n)
        return {
          ...current,
          safeBalance: current.safeBalance + rewards,
          cumulativeClaimed: current.cumulativeClaimed + rewards,
        }
      }
      return current
    })
    if (planAction === "stake" || planAction === "unstake") {
      const direction = planAction === "stake" ? 1n : -1n
      setValidators((current) => current.map((item) => {
        if (item.address.toLowerCase() !== validator.toLowerCase()) return item
        return {
          ...item,
          userStake: item.userStake + direction * parsedAmount,
          totalStake: item.totalStake + direction * parsedAmount,
        }
      }))
    }
  }

  function validateAction(targetAction = action): string | null {
    if (!account || !liveSnapshot) return t.connectToPlan
    if (chainId !== null && chainId !== CHAIN_ID) return t.wrongNetwork
    if (targetAction === "stake" || targetAction === "unstake") {
      const parsedAmount = safeParsedAmount(amount)
      if (parsedAmount === null) return t.invalidAmount
      if (selectedValidator.status !== "active") return t.inactiveValidator
      if (targetAction === "stake" && liveSnapshot.safeBalance < parsedAmount) return t.insufficientSafeBalance
      if (targetAction === "unstake" && selectedValidator.userStake < parsedAmount) return t.insufficientValidatorStake
    }
    if (targetAction === "claim-withdrawal" && summary.claimableWithdrawals <= 0n) return t.noClaimableWithdrawal
    if (targetAction === "claim-rewards") {
      if (!rewardProof?.proof || (liveRewards ?? 0n) <= 0n) return t.noProof
      if (liveMerkleRoot && rewardProof.merkleRoot.toLowerCase() !== liveMerkleRoot.toLowerCase()) return t.merkleMismatch
    }
    return null
  }

  function selectAction(nextAction: Action) {
    setAction(nextAction)
    if (account && liveSnapshot) {
      void buildPlan(nextAction)
    } else {
      setTxPlan(null)
    }
  }

  function exportSafePayload() {
    if (!txPlan) {
      toast(t.connectToPlan, "warning")
      return
    }
    const payload = toSafeTransactionPayload(txPlan, CHAIN_ID, {
      description: "Generated by Safecafe. Review all transactions before signing.",
    })
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(stringifyBigInts(payload), null, 2)], { type: "application/json" }),
    )
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = `safecafe-safe-tx-${Date.now()}.json`
    anchor.click()
    URL.revokeObjectURL(url)
    toast(t.exported, "success")
  }

  async function copyText(value: string) {
    try {
      await navigator.clipboard.writeText(value)
      toast(t.copied, "success")
    } catch {
      toast(t.copyFailed, "warning")
    }
  }

  function openExplorer(address: Address) {
    window.open(`${EXPLORER_BASE_URL}/address/${address}`, "_blank", "noopener,noreferrer")
  }

  const chainLabel = chainId === null ? t.notChecked : chainId === CHAIN_ID ? t.ethereumMainnet : t.switchToMainnet
  const chainTone = chainId === CHAIN_ID ? "ok" : chainId === null ? "neutral" : "needs-attention"

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-inner">
          <button className="brand" onClick={() => navigate("dashboard")} aria-label="Safecafe dashboard">
            <div className="brand-mark">CF</div>
            <div>
              <strong>Safecafe</strong>
              <span>{t.subtitle}</span>
            </div>
          </button>

          <div className="mobile-header-actions">
            <button className="mobile-wallet-button" onClick={() => account ? setModal({ type: "wallet" }) : connectWallet()} aria-label={account ? t.wallet : t.connectWallet}>
              <Wallet size={17} />
              <span>{account ? compactAddress(account, 5, 4) : t.connectWallet}</span>
            </button>
            <button className="menu-button" onClick={() => setIsMenuOpen((value) => !value)} aria-expanded={isMenuOpen} aria-label={t.menu}>
              {isMenuOpen ? <X size={20} /> : <Menu size={20} />}
            </button>
          </div>

          <div className={`topbar-menu ${isMenuOpen ? "open" : ""}`}>
            <nav className="nav-tabs" aria-label="Primary navigation">
              {navItems.map((item) => (
                <button className={activeNav === item ? "active" : ""} key={item} onClick={() => navigate(item)}>
                  {item === "dashboard" && <LayoutDashboard size={16} />}
                  {item === "cli" && <TerminalSquare size={16} />}
                  {t[item]}
                </button>
              ))}
            </nav>

            <div className="topbar-status">
              <button className={`chain-pill ${chainTone}`} onClick={handleNetworkClick}>
                <Globe2 size={16} />
                {chainLabel}
              </button>
              <button className="health-pill" onClick={() => setModal({ type: "data" })}>
                <span className={`dot ${liveError || !liveSnapshot ? "warning" : ""}`} />
                {liveError ? t.dataIssue : liveSnapshot ? t.liveData : t.notConnected}
              </button>
              <button className="language-pill" onClick={() => setLocale(locale === "en" ? "zh" : "en")}>
                {t.language}
              </button>
              <button className="wallet-pill" onClick={() => account ? setModal({ type: "wallet" }) : connectWallet()}>
                <Wallet size={18} />
                <span>
                  <strong>{account ? t.connected : t.connectWallet}</strong>
                  <small>{account ? compactAddress(account) : t.noAccount}</small>
                </span>
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className="page">
        <section className="summary-card enter">
          <div className="section-heading">
            <div>
              <h1>{t.accountSummary}</h1>
              <p>{liveSnapshot && account ? `${t.liveDataFor} ${compactAddress(account)}.` : t.connectToBegin}</p>
            </div>
            <div className="button-row">
              <div className={`price-chip ${safePrice.stale ? "stale" : ""}`}>
                <strong>{safePrice.usd === null ? t.priceUnavailable : `$${safePrice.usd.toFixed(3)}`}</strong>
                <small>{priceStatusLabel(safePrice, t)}</small>
              </div>
              <button className="soft-button" disabled={isReadingLive} onClick={refreshOrConnect}>
                <Database size={16} />
                {isReadingLive ? t.reading : t.refreshLive}
              </button>
            </div>
          </div>
          {liveError && <p className="warning">{liveError}</p>}
          {!account && (
            <div className="connect-panel">
              <Wallet size={20} />
              <div>
                <strong>{t.connectWallet}</strong>
                <small>{t.connectWalletHint}</small>
              </div>
              <button className="primary-button" onClick={connectWallet}>{t.connectWallet}</button>
            </div>
          )}
          <div className="summary-grid">
            <Metric icon={<Wallet />} label={t.safeBalance} value={liveSnapshot ? summary.safeBalance : null} unavailable={t.connectWallet} safePriceUsd={safePrice.usd} />
            <Metric icon={<LineChart />} label={t.totalStaked} value={liveSnapshot ? summary.totalStaked : null} unavailable={t.connectWallet} safePriceUsd={safePrice.usd} />
            <Metric icon={<Clock3 />} label={t.pendingWithdrawals} value={liveSnapshot ? summary.pendingWithdrawals : null} unavailable={t.connectWallet} safePriceUsd={safePrice.usd} />
            <Metric icon={<ArrowDownToLine />} label={t.claimableWithdrawals} value={liveSnapshot ? summary.claimableWithdrawals : null} unavailable={t.connectWallet} safePriceUsd={safePrice.usd} />
            <Metric icon={<Gift />} label={t.claimableRewards} value={liveSnapshot ? summary.claimableRewards : null} unavailable={t.connectWallet} safePriceUsd={safePrice.usd} />
          </div>
        </section>

        {activeNav === "dashboard" && (
          <DashboardView
            t={t}
            action={action}
            amount={amount}
            connectedAccount={connectedAccount}
            copyText={copyText}
            isSubmitting={isSubmitting}
            modal={modal}
            openExplorer={openExplorer}
            exportSafePayload={exportSafePayload}
            selectAction={selectAction}
            selectedValidator={selectedValidator}
            setActiveNav={navigate}
            setAmount={setAmount}
            setModal={setModal}
            setValidator={setValidator}
            showOnlyActive={showOnlyActive}
            submitPlan={submitPlan}
            txProgress={txProgress}
            txPlan={txPlan?.action === action ? txPlan : null}
            validator={validator}
            visibleValidators={visibleValidators}
            validators={validators}
            buildPlan={buildPlan}
            setShowOnlyActive={setShowOnlyActive}
            dataStatus={dataStatus}
            stakingAllowance={liveSnapshot?.stakingAllowance ?? 0n}
            summary={summary}
            safePriceUsd={safePrice.usd}
            validatorPoolTotal={validatorPoolTotal}
          />
        )}
        {activeNav === "validators" && (
          <FullPanel title={t.validators}>
            <ValidatorTable
              t={t}
              validators={visibleValidators}
              totalStaked={validatorPoolTotal}
              accountReady={Boolean(liveSnapshot)}
              setModal={setModal}
              openExplorer={openExplorer}
              safePriceUsd={safePrice.usd}
              onStake={(nextValidator) => {
                setValidator(nextValidator)
                selectAction("stake")
                navigate("dashboard")
              }}
            />
          </FullPanel>
        )}
        {activeNav === "withdrawals" && (
          <WithdrawalsView
            account={connectedAccount}
            copyText={copyText}
            exportSafePayload={exportSafePayload}
            isSubmitting={isSubmitting}
            t={t}
            selectAction={selectAction}
            selectedValidator={selectedValidator}
            summary={summary}
            submitPlan={submitPlan}
            txPlan={txPlan?.action === "claim-withdrawal" ? txPlan : null}
            txProgress={txProgress}
          />
        )}
        {activeNav === "rewards" && (
          <RewardsView
            account={connectedAccount}
            copyText={copyText}
            t={t}
            exportSafePayload={exportSafePayload}
            isSubmitting={isSubmitting}
            selectAction={selectAction}
            selectedValidator={selectedValidator}
            summary={summary}
            dataStatus={dataStatus}
            submitPlan={submitPlan}
            txPlan={txPlan?.action === "claim-rewards" ? txPlan : null}
            txProgress={txProgress}
          />
        )}
        {activeNav === "cli" && <CliView t={t} account={connectedAccount} validator={validator} amount={amount} copyText={copyText} />}
        {activeNav === "docs" && <DocsView t={t} />}
      </main>

      <footer className="footer">
        <button onClick={() => toast("Safecafe v0.1.0", "info")}>Safecafe v0.1.0</button>
        <span>{t.footerTagline}</span>
        <button onClick={() => navigate("docs")}>{t.docsTitle}</button>
      </footer>

      {modal && (
        <DetailModal
          account={account}
          copyText={copyText}
          dataStatus={dataStatus}
          disconnectWallet={disconnectWallet}
          modal={modal}
          onClose={() => setModal(null)}
          openExplorer={openExplorer}
          t={t}
        />
      )}
      <div className="toast-stack" aria-live="polite">
        {toasts.map((item) => (
          <div className={`toast ${item.tone ?? "info"}`} key={item.id}>
            {item.message}
          </div>
        ))}
      </div>
    </div>
  )
}

function DashboardView(props: {
  t: MessageBundle
  action: Action
  amount: string
  buildPlan: () => void
  connectedAccount: Address | null
  copyText: (value: string) => Promise<void>
  exportSafePayload: () => void
  isSubmitting: boolean
  modal: Modal
  openExplorer: (address: Address) => void
  selectAction: (action: Action) => void
  selectedValidator: ValidatorInfo
  setActiveNav: (nav: NavItem) => void
  setAmount: (amount: string) => void
  setModal: (modal: Modal) => void
  setShowOnlyActive: (value: boolean) => void
  setValidator: (address: Address) => void
  showOnlyActive: boolean
  submitPlan: () => void
  summary: AccountSummary
  safePriceUsd: number | null
  txPlan: TxPlan | null
  txProgress: string
  validator: Address
  visibleValidators: ValidatorInfo[]
  validators: ValidatorInfo[]
  dataStatus: DataStatus
  stakingAllowance: bigint
  validatorPoolTotal: bigint
}) {
  const { t } = props
  return (
    <div className="content-grid enter">
      <div className="main-stack">
        <section className="panel primary-actions-panel">
          <div className="panel-title">
            <h2>{t.primaryActions}</h2>
          </div>
          <div className="action-grid">
            <ActionButton active={props.action === "stake"} icon={<Upload />} title={t.stake} subtitle={t.stakeSub} onClick={() => props.selectAction("stake")} />
            <ActionButton active={props.action === "unstake"} icon={<ArrowDownToLine />} title={t.unstake} subtitle={t.unstakeSub} onClick={() => props.selectAction("unstake")} />
            <ActionButton active={props.action === "claim-withdrawal"} icon={<ArrowDownToLine />} title={t.claimWithdrawals} subtitle={t.claimWithdrawalsSub} onClick={() => props.selectAction("claim-withdrawal")} />
            <ActionButton active={props.action === "claim-rewards"} icon={<Gift />} title={t.claimRewards} subtitle={t.claimRewardsSub} onClick={() => props.selectAction("claim-rewards")} />
          </div>
          {(props.action === "stake" || props.action === "unstake") && (
            <div className="form-row slide-down">
              <label>
                {t.validator}
                <select value={props.validator} onChange={(event) => props.setValidator(event.target.value as Address)}>
                  {props.validators.map((item) => (
                    <option key={item.address} value={item.address}>{item.label}</option>
                  ))}
                </select>
              </label>
              <label>
                {t.amount}
                <input inputMode="decimal" value={props.amount} onChange={(event) => props.setAmount(event.target.value)} />
              </label>
              <button className="primary-button" onClick={() => void props.buildPlan()}>{t.reviewAction}</button>
            </div>
          )}
        </section>

        <section className="panel distribution-panel">
          <div className="panel-title">
            <h2>{t.stakingDistribution}</h2>
            <div className="button-row">
              <button className="soft-button" onClick={() => props.setActiveNav("validators")}>{t.viewAllValidators}</button>
              <button className={`soft-button ${props.showOnlyActive ? "selected" : ""}`} onClick={() => props.setShowOnlyActive(!props.showOnlyActive)}>
                <ListFilter size={15} />
                {t.filter}
              </button>
            </div>
          </div>
          <ValidatorTable
            t={t}
            validators={props.visibleValidators}
            totalStaked={props.validatorPoolTotal}
            accountReady={props.dataStatus.isLive}
            setModal={props.setModal}
            openExplorer={props.openExplorer}
            safePriceUsd={props.safePriceUsd}
            onStake={(nextValidator) => {
              props.setValidator(nextValidator)
              props.selectAction("stake")
            }}
          />
        </section>

        <RecentActivity t={t} setModal={props.setModal} setActiveNav={props.setActiveNav} />
      </div>

      <aside className="side-stack">
        <ReadinessPanel
          t={t}
          action={props.action}
          accountConnected={Boolean(props.connectedAccount)}
          amount={props.amount}
          chainId={props.dataStatus.chainId}
          selectedValidator={props.selectedValidator}
          setModal={props.setModal}
          stakingAllowance={props.stakingAllowance}
          summary={props.summary}
        />
        <TxPlanPanel
          t={t}
          account={props.connectedAccount}
          copyText={props.copyText}
          isSubmitting={props.isSubmitting}
          selectedValidator={props.selectedValidator}
          submitPlan={props.submitPlan}
          txPlan={props.txPlan}
          txProgress={props.txProgress}
          exportSafePayload={props.exportSafePayload}
          action={props.action}
          amount={props.amount}
          summary={props.summary}
        />
        <ProtocolPanel t={t} summary={props.summary} />
        <DataHealthPanel t={t} setModal={props.setModal} dataStatus={props.dataStatus} />
      </aside>
    </div>
  )
}

function ValidatorTable(props: {
  t: MessageBundle
  validators: ValidatorInfo[]
  totalStaked: bigint
  accountReady: boolean
  safePriceUsd: number | null
  setModal: (modal: Modal) => void
  openExplorer: (address: Address) => void
  onStake: (address: Address) => void
}) {
  const { t } = props
  return (
    <div className="validator-list">
      {props.validators.map((item) => {
        const share = props.totalStaked > 0n ? Number((item.totalStake * 10000n) / props.totalStaked) / 100 : 0
        return (
          <article className="validator-card-row" key={item.address}>
            <div className="validator-card-main">
              <div className="validator-cell">
              <span className="validator-icon">{item.label.slice(0, 1)}</span>
              <span>
                <strong>{item.label}</strong>
                <small>{compactAddress(item.address, 10, 6)}</small>
              </span>
              </div>
              <StatusBadge status={item.status} t={t} />
              <div className="row-actions" aria-label={t.actions}>
                <button title={t.openExplorer} onClick={() => props.openExplorer(item.address)}><ArrowUpRight size={15} /></button>
                <button title={t.stake} onClick={() => props.onStake(item.address)}><Upload size={15} /></button>
                <button title={t.more} onClick={() => props.setModal({ type: "validator", validator: item })}><MoreHorizontal size={15} /></button>
              </div>
            </div>
            <div className="validator-card-metrics">
              <ValidatorStat label={t.validatorStake} value={props.totalStaked > 0n ? `${formatSafe(item.totalStake)} SAFE` : "--"} detail={props.totalStaked > 0n ? formatUsdFromSafe(item.totalStake, props.safePriceUsd) : t.notChecked} />
              <ValidatorStat label={t.yourStake} value={props.accountReady ? `${formatSafe(item.userStake)} SAFE` : "--"} detail={props.accountReady ? formatUsdFromSafe(item.userStake, props.safePriceUsd) : t.connectWallet} />
              <ValidatorStat label={t.share} value={props.totalStaked > 0n ? `${share.toFixed(2)}%` : "--"} progress={<Progress value={share} />} />
              <ValidatorStat label={t.commission} value={`${item.commission}%`} />
              <ValidatorStat label={t.participation} value={`${item.participationRate}%`} progress={<Progress value={item.participationRate} variant="green" />} />
            </div>
          </article>
        )
      })}
      <div className="validator-total-row">
        <span>{t.total}</span>
        <strong>{props.totalStaked > 0n ? `${formatSafe(props.totalStaked)} SAFE` : "--"}</strong>
        <small>{props.totalStaked > 0n ? formatUsdFromSafe(props.totalStaked, props.safePriceUsd) : t.notChecked}</small>
      </div>
    </div>
  )
}

function ValidatorStat(props: { label: string; value: string; detail?: string; progress?: ReactNode }) {
  return (
    <div className="validator-stat">
      <small>{props.label}</small>
      <strong>{props.value}</strong>
      {props.detail && <em>{props.detail}</em>}
      {props.progress}
    </div>
  )
}

function RecentActivity(props: { t: MessageBundle; setModal: (modal: Modal) => void; setActiveNav: (nav: NavItem) => void }) {
  return (
    <section className="panel activity-panel">
      <div className="panel-title">
        <h2>{props.t.recentActivity}</h2>
        <button className="soft-button" onClick={() => props.setActiveNav("withdrawals")}>{props.t.viewAllActivity}</button>
      </div>
      <div className="empty-state compact"><Clock3 size={24} /><p>{props.t.noActivity}</p></div>
    </section>
  )
}

function ReadinessPanel(props: {
  t: MessageBundle
  action: Action
  accountConnected: boolean
  amount: string
  chainId: number | null
  selectedValidator: ValidatorInfo
  setModal: (modal: Modal) => void
  stakingAllowance: bigint
  summary: AccountSummary
}) {
  const { t } = props
  const amount = safeParsedAmount(props.amount)
  const networkOk = props.chainId === CHAIN_ID
  const amountOk = amount !== null
  const balanceOk =
    props.action === "stake"
      ? amount !== null && props.summary.safeBalance >= amount
      : props.action === "unstake"
        ? amount !== null && props.selectedValidator.userStake >= amount
        : props.action === "claim-withdrawal"
          ? props.summary.claimableWithdrawals > 0n
          : props.summary.claimableRewards > 0n
  const allowanceOk = props.action !== "stake" || (amount !== null && props.stakingAllowance >= amount)

  const balanceLabel = !amountOk && (props.action === "stake" || props.action === "unstake")
    ? t.invalidAmount
    : balanceOk
      ? t.sufficient
      : t.insufficient
  return (
    <section className="panel readiness-panel">
      <div className="panel-title"><h2>{t.txReadiness}</h2></div>
      <ChecklistRow label={t.walletConnected} value={props.accountConnected ? t.connected : t.noAccount} ok={props.accountConnected} />
      <ChecklistRow label={t.correctNetwork} value={props.chainId === null ? t.notChecked : networkOk ? t.ethereumMainnet : t.wrongNetwork} ok={networkOk} />
      <ChecklistRow label={props.action === "unstake" ? t.yourStake : t.safeBalance} value={balanceLabel} ok={balanceOk} />
      <ChecklistRow label={t.allowance} value={props.action === "stake" ? allowanceOk ? t.approved : t.approveNeeded : t.ready} ok={allowanceOk} />
      <ChecklistRow label={t.safeQueue} value={t.ready} ok />
      <button className="link-button" onClick={() => props.setModal({ type: "readiness" })}>{t.viewReadiness}<ArrowUpRight size={15} /></button>
    </section>
  )
}

function TxPlanPanel(props: {
  action: Action
  amount: string
  t: MessageBundle
  account: Address | null
  copyText: (value: string) => Promise<void>
  exportSafePayload: () => void
  isSubmitting: boolean
  selectedValidator: ValidatorInfo
  submitPlan: () => void
  txPlan: TxPlan | null
  txProgress: string
  summary: AccountSummary
}) {
  const { t, txPlan } = props
  const canSubmit = txPlan?.simulation?.status === "passed" || txPlan?.simulation?.status === "partial"
  return (
    <section className="panel tx-plan-panel">
      <div className="panel-title"><h2>{t.reviewBeforeSigning}</h2></div>
      {txPlan ? (
        <div className="tx-plan">
          <strong>{translateTxTitle(txPlan, t)}</strong>
          <small>{props.selectedValidator.label} / {props.account ? compactAddress(props.account) : props.t.noAccount}</small>
          <TxOutcomePreview
            action={props.action}
            amount={props.amount}
            selectedValidator={props.selectedValidator}
            summary={props.summary}
            t={t}
            txPlan={txPlan}
          />
          {txPlan.warnings.map((warning) => <p className="warning" key={warning}>{translateTxWarning(warning, t)}</p>)}
          {props.txProgress && <p className="progress-note"><span className="spinner" />{props.t.confirmingTx}: {props.txProgress}</p>}
          <details className="advanced-details">
            <summary>{t.advancedDetails}</summary>
            {txPlan.txs.map((tx, index) => (
              <div className="tx-step" key={`${tx.label}-${index}`}>
                <span>{index + 1}</span>
                <div><strong>{translateTxLabel(tx.label, t)}</strong><small>{compactAddress(tx.to, 10, 6)}</small></div>
                <button title={t.copy} onClick={() => props.copyText(tx.data)}><Copy size={14} /></button>
              </div>
            ))}
            <button className="soft-button full-width" onClick={props.exportSafePayload}>
              <Database size={15} />
              {t.exportSafePayload}
            </button>
          </details>
          <button className="primary-button full-width" disabled={props.isSubmitting || !canSubmit} onClick={props.submitPlan}>
            {props.isSubmitting ? t.submitting : t.submitTransactions}
          </button>
        </div>
      ) : (
        <div className="empty-state"><TerminalSquare size={28} /><p>{t.emptyPlan}</p></div>
      )}
    </section>
  )
}

function TxOutcomePreview(props: {
  action: Action
  amount: string
  selectedValidator: ValidatorInfo
  summary: AccountSummary
  t: MessageBundle
  txPlan: TxPlan
}) {
  const { t } = props
  const amount = safeParsedAmount(props.amount)
  const simulationValue =
    props.txPlan.simulation?.status === "failed"
      ? t.simulationFailed
      : props.txPlan.simulation?.status === "partial"
        ? t.simulationPartial
        : props.txPlan.simulation?.status === "passed"
          ? t.simulationPassed
          : t.notChecked
  const rows: Array<{ label: string; value: string }> = [
    { label: t.simulationStatus, value: simulationValue },
    { label: t.transactionSteps, value: `${props.txPlan.txs.length}` },
  ]

  if (props.action === "stake" && amount !== null) {
    rows.push({ label: t.balanceChange, value: `-${formatSafe(amount)} SAFE ${t.safeBalance}` })
    rows.push({ label: t.validatorResult, value: `+${formatSafe(amount)} SAFE ${props.selectedValidator.label}` })
  }
  if (props.action === "unstake" && amount !== null) {
    rows.push({ label: t.balanceChange, value: `${formatSafe(amount)} SAFE ${t.pendingWithdrawals}` })
    rows.push({ label: t.validatorResult, value: `-${formatSafe(amount)} SAFE ${props.selectedValidator.label}` })
  }
  if (props.action === "claim-withdrawal") {
    rows.push({ label: t.balanceChange, value: `+${formatSafe(props.summary.claimableWithdrawals)} SAFE ${t.safeBalance}` })
  }
  if (props.action === "claim-rewards") {
    rows.push({ label: t.balanceChange, value: `+${formatSafe(props.summary.claimableRewards)} SAFE ${t.safeBalance}` })
  }
  if (props.txPlan.txs.length > 1) {
    rows.push({ label: t.approvalStep, value: t.approveNeeded })
  }

  return (
    <div className="outcome-preview">
      <div className="outcome-head">
        <CheckCircle2 size={18} />
        <span>
          <strong>{t.expectedResult}</strong>
          <small>{props.txPlan.simulation?.message ?? t.simulationExplainer}</small>
        </span>
      </div>
      {rows.map((row) => (
        <KeyValue key={row.label} label={row.label} value={row.value} />
      ))}
    </div>
  )
}

function ProtocolPanel({ t, summary }: { t: MessageBundle; summary: AccountSummary }) {
  return (
    <section className="panel protocol-panel">
      <div className="panel-title"><h2>{t.protocol}</h2></div>
      <KeyValue label={t.stakingContract} value={compactAddress(CONTRACTS.staking)} link={`${EXPLORER_BASE_URL}/address/${CONTRACTS.staking}`} />
      <KeyValue label={t.rewardsContract} value={compactAddress(CONTRACTS.merkleDrop)} link={`${EXPLORER_BASE_URL}/address/${CONTRACTS.merkleDrop}`} />
      <KeyValue label={t.withdrawalDelay} value={formatDelayLabel(summary.withdrawDelay, t)} />
      <KeyValue label={t.protocolVersion} value="v1.2.0" />
    </section>
  )
}

function DataHealthPanel(props: { t: MessageBundle; setModal: (modal: Modal) => void; dataStatus: DataStatus }) {
  const { t } = props
  return (
    <section className="panel data-health-panel">
      <div className="panel-title"><h2>{t.dataHealth}</h2></div>
      <ChecklistRow label={t.rpc} value={props.dataStatus.liveBlock ? `${t.block} ${props.dataStatus.liveBlock}` : t.notChecked} ok={Boolean(props.dataStatus.liveBlock) && !props.dataStatus.liveError} />
      <ChecklistRow label={t.validatorInfo} value={`${props.dataStatus.validatorCount} ${t.validators}`} ok={props.dataStatus.validatorCount > 0} />
      <ChecklistRow label={t.validatorStake} value={props.dataStatus.validatorStakeStatus} ok={props.dataStatus.validatorStakeOk} />
      <ChecklistRow label={t.rewardsProofSource} value={props.dataStatus.rewardsSource} ok={props.dataStatus.proofFound || props.dataStatus.isLive} />
      <ChecklistRow label={t.merkleRoot} value={merkleLabel(t, props.dataStatus.merkleRootMatched)} ok={props.dataStatus.merkleRootMatched !== false} />
      <button className="link-button" onClick={() => props.setModal({ type: "data" })}>{t.view} {t.dataHealth}<ArrowUpRight size={15} /></button>
    </section>
  )
}

function WithdrawalsView(props: {
  account: Address | null
  copyText: (value: string) => Promise<void>
  exportSafePayload: () => void
  isSubmitting: boolean
  t: MessageBundle
  selectAction: (action: Action) => void
  selectedValidator: ValidatorInfo
  summary: AccountSummary
  submitPlan: () => void
  txPlan: TxPlan | null
  txProgress: string
}) {
  const { t } = props
  return (
    <FullPanel title={t.withdrawals}>
      <div className="split-cards">
        <InfoCard icon={<Clock3 />} title={t.pendingWithdrawals} value={`${formatSafe(props.summary.pendingWithdrawals)} SAFE`} />
        <InfoCard icon={<ArrowDownToLine />} title={t.claimableWithdrawals} value={`${formatSafe(props.summary.claimableWithdrawals)} SAFE`} />
        <InfoCard icon={<ShieldCheck />} title={t.withdrawalDelay} value={formatDelayLabel(props.summary.withdrawDelay, t)} />
      </div>
      <div className="workflow-panel">
        <button className="primary-button" onClick={() => props.selectAction("claim-withdrawal")}>{t.claimWithdrawals}</button>
        <TxPlanPanel
          action="claim-withdrawal"
          amount="0"
          account={props.account}
          copyText={props.copyText}
          exportSafePayload={props.exportSafePayload}
          isSubmitting={props.isSubmitting}
          selectedValidator={props.selectedValidator}
          submitPlan={props.submitPlan}
          t={t}
          txPlan={props.txPlan}
          txProgress={props.txProgress}
          summary={props.summary}
        />
      </div>
    </FullPanel>
  )
}

function RewardsView(props: {
  account: Address | null
  copyText: (value: string) => Promise<void>
  dataStatus: DataStatus
  exportSafePayload: () => void
  isSubmitting: boolean
  t: MessageBundle
  selectAction: (action: Action) => void
  selectedValidator: ValidatorInfo
  summary: AccountSummary
  submitPlan: () => void
  txPlan: TxPlan | null
  txProgress: string
}) {
  const { t } = props
  return (
    <FullPanel title={t.rewards}>
      <div className="split-cards">
        <InfoCard icon={<Gift />} title={t.claimableRewards} value={`${formatSafe(props.summary.claimableRewards)} SAFE`} />
        <InfoCard icon={<Database />} title={t.rewardsProofSource} value={props.dataStatus.rewardsSource} />
        <InfoCard icon={<CheckCircle2 />} title={t.merkleRoot} value={merkleLabel(t, props.dataStatus.merkleRootMatched)} />
      </div>
      <div className="workflow-panel">
        <button className="primary-button" onClick={() => props.selectAction("claim-rewards")}>{t.claimRewards}</button>
        <TxPlanPanel
          action="claim-rewards"
          amount="0"
          account={props.account}
          copyText={props.copyText}
          exportSafePayload={props.exportSafePayload}
          isSubmitting={props.isSubmitting}
          selectedValidator={props.selectedValidator}
          submitPlan={props.submitPlan}
          t={t}
          txPlan={props.txPlan}
          txProgress={props.txProgress}
          summary={props.summary}
        />
      </div>
    </FullPanel>
  )
}

function CliView(props: { t: MessageBundle; account: Address | null; validator: Address; amount: string; copyText: (value: string) => Promise<void> }) {
  const account = props.account ?? "0xYourSafe"
  const commands = [
    "pnpm install",
    "pnpm cli guide",
    `pnpm cli status --account ${account}`,
    "pnpm cli menu --active --sort participation",
    `pnpm cli brew --account ${account} --validator ${props.validator} --amount ${props.amount} --dry-run`,
    `pnpm cli --rpc https://eth.llamarpc.com beans --account ${account}`,
    "safecafe status --mock",
  ]
  return (
    <FullPanel title={props.t.cli}>
      <p>{props.t.responsiveNote}</p>
      <div className="cli-list">
        {commands.map((command) => (
          <button className="code-button" key={command} onClick={() => props.copyText(command)}>
            <code>{command}</code>
            <Copy size={14} />
          </button>
        ))}
      </div>
    </FullPanel>
  )
}

function DocsView({ t }: { t: MessageBundle }) {
  return (
    <FullPanel title={t.docsTitle}>
      <div className="docs-grid">
        <InfoCard icon={<ShieldCheck />} title={t.docsNonCustodial} value={t.docsNonCustodialValue} />
        <InfoCard icon={<TerminalSquare />} title={t.docsCliParity} value={t.docsCliParityValue} />
        <InfoCard icon={<Database />} title={t.docsReleaseManifest} value={t.docsReleaseManifestValue} />
      </div>
    </FullPanel>
  )
}

function FullPanel({ title, children }: { title: string; children: ReactNode }) {
  return <section className="panel full-panel enter"><div className="panel-title"><h2>{title}</h2></div>{children}</section>
}

function InfoCard({ icon, title, value }: { icon: ReactNode; title: string; value: string }) {
  return <div className="info-card"><span>{icon}</span><small>{title}</small><strong>{value}</strong></div>
}

function Metric({ icon, label, value, unavailable, safePriceUsd }: { icon: ReactNode; label: string; value: bigint | null; unavailable: string; safePriceUsd: number | null }) {
  return (
    <div className="metric">
      <span className="metric-icon">{icon}</span>
      <span><small>{label}</small><strong>{value === null ? "--" : formatSafe(value)}</strong><em>{value === null ? unavailable : formatUsdFromSafe(value, safePriceUsd)}</em></span>
    </div>
  )
}

function ActionButton(props: { active?: boolean; icon: ReactNode; title: string; subtitle: string; onClick: () => void }) {
  return <button className={`action-button ${props.active ? "active" : ""}`} onClick={props.onClick}><span>{props.icon}</span><strong>{props.title}</strong><small>{props.subtitle}</small></button>
}

function Progress({ value, variant = "blue" }: { value: number; variant?: "blue" | "green" }) {
  return <span className="progress-track"><span className={`progress-fill ${variant}`} style={{ width: `${Math.min(100, Math.max(0, value))}%` }} /></span>
}

function StatusBadge({ status, t }: { status: string; t: MessageBundle }) {
  const label = status === "active" ? t.active : status === "inactive" ? t.inactive : status
  return <span className={`status-badge ${status}`}>{label}</span>
}

function ChecklistRow({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  return <div className={`check-row ${ok ? "ok" : "needs-attention"}`}>{ok ? <CheckCircle2 size={17} /> : <Clock3 size={17} />}<span>{label}</span><strong>{value}</strong></div>
}

function KeyValue({ label, value, link }: { label: string; value: string; link?: string }) {
  return <div className="key-row"><span>{label}</span><strong>{value}</strong>{link && <a href={link} target="_blank" rel="noreferrer" aria-label={label}><ExternalLink size={14} /></a>}</div>
}

function DetailModal(props: {
  account: Address | null
  copyText: (value: string) => Promise<void>
  dataStatus: DataStatus
  disconnectWallet: () => void
  modal: NonNullable<Modal>
  onClose: () => void
  openExplorer: (address: Address) => void
  t: MessageBundle
}) {
  const { account, dataStatus, modal, onClose, t } = props
  let title = t.viewReadiness
  let content: ReactNode = <p>{t.readinessDescription}</p>
  if (modal.type === "validator") {
    title = modal.validator.label
    content = <><KeyValue label={t.address} value={compactAddress(modal.validator.address, 10, 8)} /><KeyValue label={t.participation} value={`${modal.validator.participationRate}%`} /><KeyValue label={t.commission} value={`${modal.validator.commission}%`} /></>
  }
  if (modal.type === "data") {
    title = t.dataHealth
    content = (
      <>
        <ChecklistRow label={t.rpc} value={dataStatus.liveBlock ? `${t.block} ${dataStatus.liveBlock}` : t.notChecked} ok={Boolean(dataStatus.liveBlock) && !dataStatus.liveError} />
        <ChecklistRow label={t.correctNetwork} value={dataStatus.chainId === null ? t.notChecked : dataStatus.chainId === CHAIN_ID ? t.ethereumMainnet : t.wrongNetwork} ok={dataStatus.chainId === CHAIN_ID} />
        <ChecklistRow label={t.validatorInfo} value={`${dataStatus.validatorCount} ${t.validators}`} ok={dataStatus.validatorCount > 0} />
        <ChecklistRow label={t.validatorStake} value={dataStatus.validatorStakeStatus} ok={dataStatus.validatorStakeOk} />
        <ChecklistRow label={t.rewardsProofSource} value={dataStatus.rewardsSource} ok={dataStatus.proofFound || dataStatus.isLive} />
        <ChecklistRow label={t.merkleRoot} value={merkleLabel(t, dataStatus.merkleRootMatched)} ok={dataStatus.merkleRootMatched !== false} />
        {dataStatus.liveError && <p className="warning">{dataStatus.liveError}</p>}
      </>
    )
  }
  if (modal.type === "network") {
    title = t.correctNetwork
    content = <><p>{t.networkDescription}</p><KeyValue label={t.correctNetwork} value={t.ethereumMainnet} /></>
  }
  if (modal.type === "wallet") {
    title = t.wallet
    content = account ? (
      <>
        <KeyValue label={t.walletConnected} value={compactAddress(account, 10, 8)} />
        <div className="modal-actions">
          <button className="soft-button" onClick={() => props.copyText(account)}><Copy size={15} />{t.copy}</button>
          <button className="soft-button" onClick={() => props.openExplorer(account)}><ArrowUpRight size={15} />{t.openExplorer}</button>
          <button className="soft-button" onClick={() => { props.disconnectWallet(); onClose() }}>{t.disconnect}</button>
        </div>
      </>
    ) : <p>{t.noAccount}</p>
  }
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal-card">
        <div className="panel-title"><h2>{title}</h2><button className="icon-button" onClick={onClose}><X size={16} /></button></div>
        <div className="modal-body">{content}</div>
      </div>
    </div>
  )
}

function safeParsedAmount(value: string): bigint | null {
  try {
    return parseSafeAmount(value)
  } catch {
    return null
  }
}

function readCachedSafePrice(): SafePriceState {
  try {
    return readStoredSafePrice(window.localStorage, safePriceCacheKey, SAFE_PRICE_SOURCE, SAFE_PRICE_CACHE_MS)
  } catch {
    return {
      usd: null,
      source: SAFE_PRICE_SOURCE,
      fetchedAt: null,
      stale: false,
      error: "",
    }
  }
}

function writeCachedSafePrice(price: SafePriceState) {
  try {
    if (price.usd !== null && price.fetchedAt !== null) {
      writeStoredSafePrice(window.localStorage, safePriceCacheKey, {
        usd: price.usd,
        source: price.source,
        fetchedAt: price.fetchedAt,
      })
    }
  } catch {
    // Price display is best-effort; blocked storage should not affect staking.
  }
}

function priceStatusLabel(price: SafePriceState, t: MessageBundle) {
  if (price.usd === null) return t.priceUnavailable
  const age = price.fetchedAt ? formatPriceAge(Date.now() - price.fetchedAt) : t.notChecked
  return `${price.source} · ${price.stale ? t.priceStale : t.priceCached} · ${age}`
}

function translateTxLabel(label: string, t: MessageBundle) {
  const labels: Record<string, string> = {
    "Approve SAFE for staking contract": t.txApproveSafe,
    "Stake SAFE to validator": t.txStakeSafe,
    "Initiate withdrawal from validator": t.txInitiateWithdrawal,
    "Claim next FIFO withdrawal": t.txClaimWithdrawal,
    "Claim Merkle rewards": t.txClaimRewards,
  }
  return labels[label] ?? label
}

function translateTxWarning(warning: string, t: MessageBundle) {
  const warnings: Record<string, string> = {
    "This plan needs approval before staking unless your wallet supports batching.": t.warningApprovalNeeded,
    "Withdrawals enter the protocol queue and become claimable after the delay.": t.warningWithdrawalQueue,
    "The staking contract claims withdrawals in FIFO order.": t.warningClaimFifo,
  }
  return warnings[warning] ?? warning
}

function translateTxTitle(plan: TxPlan, t: MessageBundle) {
  if (plan.action === "stake") return `${t.txStakeTitle} ${plan.title.replace(/^Stake\s+/, "")}`
  if (plan.action === "unstake") return `${t.txUnstakeTitle} ${plan.title.replace(/^Unstake\s+/, "")}`
  if (plan.action === "claim-withdrawal") return t.txClaimWithdrawalTitle
  if (plan.action === "claim-rewards") return t.txClaimRewardsTitle
  return plan.title
}

function formatPriceAge(ageMs: number) {
  const minutes = Math.max(0, Math.floor(ageMs / 60000))
  if (minutes < 1) return "<1m"
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h`
}

function formatDelayLabel(seconds: bigint, t: MessageBundle) {
  const value = Number(seconds)
  const days = Math.floor(value / 86400)
  if (days > 0) return `${days} ${days === 1 ? t.day : t.days}`
  const hours = Math.floor(value / 3600)
  if (hours > 0) return `${hours} ${hours === 1 ? t.hour : t.hours}`
  const minutes = Math.floor(value / 60)
  return `${minutes} ${minutes === 1 ? t.minute : t.minutes}`
}

function canUseTestWallet() {
  return testMode && Boolean(testAddress)
}

function isTestAccount(address: Address | null | undefined) {
  return canUseTestWallet() && Boolean(address && testAddress && address.toLowerCase() === testAddress.toLowerCase())
}

function createTestSnapshot(): AccountSnapshot {
  const now = BigInt(Math.floor(Date.now() / 1000))
  const futureWithdrawal = mockSummary.pendingWithdrawals > mockSummary.claimableWithdrawals
    ? mockSummary.pendingWithdrawals - mockSummary.claimableWithdrawals
    : 0n
  return {
    safeBalance: mockSummary.safeBalance,
    totalStaked: mockSummary.totalStaked,
    pendingWithdrawals: [
      { amount: mockSummary.claimableWithdrawals, claimableAt: now - 60n },
      ...(futureWithdrawal > 0n ? [{ amount: futureWithdrawal, claimableAt: now + mockSummary.withdrawDelay }] : []),
    ],
    nextClaimableWithdrawal: [mockSummary.claimableWithdrawals, now - 60n],
    cumulativeClaimed: 0n,
    withdrawDelay: mockSummary.withdrawDelay,
    stakingAllowance: 0n,
  }
}

function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function readableSimulationError(error: unknown, fallback: string) {
  if (typeof error === "object" && error !== null && "shortMessage" in error) {
    const shortMessage = (error as { shortMessage?: unknown }).shortMessage
    if (typeof shortMessage === "string" && shortMessage.trim()) return shortMessage
  }
  return error instanceof Error ? error.message : fallback
}

function merkleLabel(t: MessageBundle, matched: boolean | null) {
  if (matched === null) return t.merkleNotChecked
  return matched ? t.merkleMatched : t.merkleMismatch
}

function stringifyBigInts<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item))) as T
}
