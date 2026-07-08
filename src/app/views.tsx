import {
  ArrowDownToLine,
  CheckCircle2,
  Clock3,
  Database,
  ExternalLink,
  Gift,
  Info,
  ShieldCheck,
  TerminalSquare,
  TrendingUp,
  Upload,
  Users,
} from "lucide-react"
import type { CSSProperties, ReactNode } from "react"
import type { Address } from "viem"
import {
  type AccountSnapshot,
  CONTRACTS,
  compactAddress,
  EXPLORER_BASE_URL,
  formatSafe,
  formatSafeInput,
  formatUsdFromSafe,
  type ValidatorInfo,
} from "../protocol"
import { formatDelayLabel, merkleLabel } from "./formatters"
import type { MessageBundle } from "./i18n"
import type { AccountSummary, Action, DataStatus, Modal, NavItem } from "./types"
import { ActionButton, CustomSelect, FullPanel, InfoCard, Progress, StatusBadge, Tooltip } from "./ui"

type ValidatorSort = "stake" | "participation" | "commission" | "name" | "yourStake"
type SubmittingAction = Action | "claim-rewards-and-stake" | null
type ExecuteActionOptions = { amount?: string; validator?: Address }
type DecisionMetrics = {
  activeValidatorCount: number
  apyPercent: number
  estimatedAnnualRewards: bigint
  protocolTvlUsd: string
  validatorPoolTotal: bigint
  withdrawDelay: bigint
}
type ActionPreview = {
  amount: bigint
  authorization: string
  expectedOutcome: string
  gas: string
  risk: string
  steps: string[]
  validatorCommission: string
}
const validatorSkeletonKeys = [
  "validator-skeleton-1",
  "validator-skeleton-2",
  "validator-skeleton-3",
  "validator-skeleton-4",
]

export function DashboardView(props: {
  t: MessageBundle
  action: Action
  actionPreview: ActionPreview
  amount: string
  accountReady: boolean
  connectedAccount: Address | null
  executeClaimRewardsAndStake: (validator: Address) => Promise<void>
  executeAction: (action?: Action, options?: ExecuteActionOptions) => Promise<void>
  isLoadingValidators: boolean
  isSubmitting: boolean
  restakePreview: ActionPreview
  submittingAction: SubmittingAction
  modal: Modal
  onConnect: () => Promise<void>
  openExplorer: (address: Address) => void
  selectAction: (action: Action) => void
  selectedValidator: ValidatorInfo
  setActiveNav: (nav: NavItem) => void
  setAmount: (amount: string) => void
  setModal: (modal: Modal) => void
  setShowOnlyActive: (value: boolean) => void
  setValidator: (address: Address) => void
  showOnlyActive: boolean
  summary: AccountSummary
  safePriceUsd: number | null
  txProgress: string
  validator: Address
  visibleValidators: ValidatorInfo[]
  validators: ValidatorInfo[]
  dataStatus: DataStatus
  decisionMetrics: DecisionMetrics
  stakingAllowance: bigint
  validatorPoolTotal: bigint
}) {
  const { t } = props
  const hasValidators = props.validators.length > 0
  const accountActionLabel = props.connectedAccount ? t.refreshLive : t.connectWallet
  const stakeOrUnstakeLoading = props.submittingAction === props.action
  const claimRewardsLoading = props.submittingAction === "claim-rewards"
  const claimAndStakeLoading = props.submittingAction === "claim-rewards-and-stake"
  const validatorOptions = props.validators.map((item) => ({
    value: item.address,
    label: item.label,
    detail: `${compactAddress(item.address, 8, 6)} · ${t.yourStake} ${
      props.accountReady ? `${formatSafe(item.userStake)} SAFE` : "--"
    }`,
  }))
  return (
    <div className="content-grid enter">
      <DecisionMetricsStrip t={t} metrics={props.decisionMetrics} accountReady={props.accountReady} />
      <div className="main-stack">
        <section className="panel primary-actions-panel">
          <div className="action-grid">
            <ActionButton
              active={props.action === "stake"}
              icon={<Upload />}
              title={t.txStakeTitle}
              subtitle={t.stakeSub}
              onClick={() => props.selectAction("stake")}
            />
            <ActionButton
              active={props.action === "unstake"}
              icon={<ArrowDownToLine />}
              title={t.txUnstakeTitle}
              subtitle={t.unstakeSub}
              onClick={() => props.selectAction("unstake")}
            />
            <ActionButton
              active={props.action === "claim-rewards"}
              icon={<Gift />}
              title={t.claimRewards}
              subtitle={t.claimRewardsSub}
              disabled={props.isSubmitting}
              onClick={() => props.selectAction("claim-rewards")}
            />
          </div>
          {(props.action === "stake" || props.action === "unstake") && (
            <div className="form-row slide-down">
              <label>
                {props.action === "stake" ? t.stakeAction : t.unstakeAction} {t.amount}
                <div className="amount-input-wrap">
                  <input
                    inputMode="decimal"
                    value={props.amount}
                    placeholder="0.00"
                    onChange={(event) => props.setAmount(event.target.value)}
                  />
                  <span>SAFE</span>
                  <button
                    type="button"
                    disabled={!props.accountReady}
                    onClick={() =>
                      props.setAmount(
                        formatSafeInput(
                          props.action === "stake" ? props.summary.safeBalance : props.selectedValidator.userStake,
                        ),
                      )
                    }
                  >
                    MAX
                  </button>
                </div>
                {!props.accountReady && <small className="planning-mode-hint">{t.planningModeHint}</small>}
              </label>
              <div className="field-group">
                <span className="field-label">{t.validator}</span>
                <CustomSelect
                  disabled={!hasValidators}
                  label={t.validator}
                  value={props.validator}
                  onChange={(value) => props.setValidator(value as Address)}
                  options={validatorOptions}
                />
              </div>
              <button
                type="button"
                className="primary-button"
                disabled={props.isSubmitting}
                onClick={() =>
                  void (props.accountReady
                    ? props.executeAction(props.action, { amount: props.amount, validator: props.validator })
                    : props.onConnect())
                }
              >
                {stakeOrUnstakeLoading
                  ? t.preparingAction
                  : !props.accountReady
                    ? accountActionLabel
                    : props.action === "stake"
                      ? t.stakeAction
                      : t.unstakeAction}
              </button>
              <TransactionPreview t={t} preview={props.actionPreview} />
              {props.txProgress && (
                <p className="action-progress-note">
                  <span className="spinner" />
                  {props.txProgress}
                </p>
              )}
            </div>
          )}
          {props.action === "claim-rewards" && (
            <div className="form-row slide-down">
              <div className="field-group restake-target-field">
                <span className="field-label">{t.restakeTargetValidator}</span>
                <CustomSelect
                  disabled={!hasValidators || props.isSubmitting}
                  label={t.restakeTargetValidator}
                  value={props.validator}
                  onChange={(value) => props.setValidator(value as Address)}
                  options={validatorOptions}
                />
              </div>
              <div className="claim-action-row">
                <button
                  type="button"
                  className="primary-button"
                  disabled={props.isSubmitting}
                  onClick={() =>
                    void (props.accountReady
                      ? props.executeAction("claim-rewards", { amount: props.amount, validator: props.validator })
                      : props.onConnect())
                  }
                >
                  {claimRewardsLoading ? t.preparingAction : !props.accountReady ? accountActionLabel : t.claimToWallet}
                </button>
                <button
                  type="button"
                  className="feature-button"
                  disabled={props.isSubmitting}
                  onClick={() =>
                    void (props.accountReady ? props.executeClaimRewardsAndStake(props.validator) : props.onConnect())
                  }
                >
                  <Upload size={15} aria-hidden="true" />
                  {claimAndStakeLoading
                    ? t.preparingAction
                    : !props.accountReady
                      ? accountActionLabel
                      : t.claimAndRestake}
                </button>
              </div>
              <TransactionPreview t={t} title={t.claimToWallet} preview={props.actionPreview} />
              <TransactionPreview t={t} title={t.claimAndRestake} preview={props.restakePreview} />
              <p className="restake-preview-note">{t.restakePreview}</p>
              <ol className="restake-flow-steps" aria-label={t.claimAndRestake}>
                <li>{t.claimToWallet}</li>
                <li>{t.allowance}</li>
                <li>{t.stakeAction}</li>
              </ol>
              {props.txProgress && (
                <p className="action-progress-note">
                  <span className="spinner" />
                  {props.txProgress}
                </p>
              )}
            </div>
          )}
        </section>
      </div>

      <aside className="side-stack">
        <StakingOverview
          t={t}
          accountReady={props.accountReady}
          summary={props.summary}
          safePriceUsd={props.safePriceUsd}
        />
        <ValidatorParticipationPanel
          t={t}
          accountReady={props.accountReady}
          summary={props.summary}
          validators={props.validators}
        />
      </aside>
    </div>
  )
}

function DecisionMetricsStrip({
  accountReady,
  metrics,
  t,
}: {
  accountReady: boolean
  metrics: DecisionMetrics
  t: MessageBundle
}) {
  return (
    <section className="decision-strip" aria-label={t.publicProtocolData}>
      <div className="decision-primary">
        <span className="decision-icon">
          <Database size={28} />
        </span>
        <span>{t.estimatedAnnualRewards}</span>
        <strong>{accountReady ? `${formatSafe(metrics.estimatedAnnualRewards)} SAFE` : "-- SAFE"}</strong>
      </div>
      <div>
        <span className="decision-icon">
          <TrendingUp size={28} />
        </span>
        <span>{t.protocolTvl}</span>
        <strong>{metrics.protocolTvlUsd}</strong>
        <small>{formatSafe(metrics.validatorPoolTotal, 0)} SAFE</small>
      </div>
      <div>
        <span className="decision-icon">
          <Clock3 size={28} />
        </span>
        <span>{t.unstakeDelay}</span>
        <strong>{formatDelayLabel(metrics.withdrawDelay, t)}</strong>
      </div>
      <div>
        <span className="decision-icon">
          <Users size={28} />
        </span>
        <span>{t.activeValidatorsMetric}</span>
        <strong>{metrics.activeValidatorCount}</strong>
      </div>
    </section>
  )
}

function TransactionPreview({ preview, t, title }: { preview: ActionPreview; t: MessageBundle; title?: string }) {
  return (
    <section
      className="transaction-preview"
      aria-label={title ? `${t.transactionPreview}: ${title}` : t.transactionPreview}
    >
      <div className="transaction-preview-header">
        <strong>{title ?? t.transactionPreview}</strong>
        <span>{title ? t.transactionPreview : t.walletConfirmationHint}</span>
      </div>
      {title && <p className="transaction-preview-note">{t.walletConfirmationHint}</p>}
      <div className="transaction-preview-grid">
        <PreviewItem label={t.estimatedGas} value={preview.gas} />
        <PreviewItem label={t.validatorCommission} value={preview.validatorCommission} />
        <PreviewItem label={t.authorizationAmount} value={preview.authorization} />
        <PreviewItem label={t.expectedOutcome} value={preview.expectedOutcome} />
        <PreviewItem label={t.slashingRisk} value={preview.risk} />
        <PreviewItem label={t.protocol} value={t.noProtocolFee} />
      </div>
      <ol className="transaction-steps" aria-label={t.transactionSteps}>
        {preview.steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
    </section>
  )
}

function PreviewItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

export function ValidatorTable(props: {
  t: MessageBundle
  validators: ValidatorInfo[]
  totalStaked: bigint
  accountReady: boolean
  emptyMessage?: string
  isLoading?: boolean
  safePriceUsd: number | null
  setModal: (modal: Modal) => void
  openExplorer: (address: Address) => void
  onStake: (address: Address) => void
  onUnstake: (address: Address) => void
}) {
  const { t } = props
  return (
    <div className="validator-list">
      <div className="validator-header">
        <span>{t.validator}</span>
        <span>{t.commission}</span>
        <span>{t.participation14d}</span>
        <span>{t.totalSafeStaked}</span>
        <span>{t.yourStake}</span>
        <span>{t.status}</span>
        <span>{t.actions}</span>
      </div>
      {props.isLoading &&
        validatorSkeletonKeys.map((key) => (
          <div className="validator-row validator-row-skeleton" key={key}>
            <span />
            <span />
            <span />
            <span />
            <span />
            <span />
            <span />
          </div>
        ))}
      {props.validators.map((item) => {
        return (
          <article className="validator-row" key={item.address}>
            <div className="validator-identity">
              <strong>{item.label}</strong>
              <button className="validator-address-link" type="button" onClick={() => props.openExplorer(item.address)}>
                {compactAddress(item.address, 6, 4)}
              </button>
            </div>
            <ValidatorStat label={t.commission} tooltip={t.commissionTooltip} value={`${item.commission}%`} />
            <ValidatorStat
              label={t.participation14d}
              tooltip={t.participationTooltip}
              value={`${item.participationRate.toFixed(2)}%`}
              detail={`${formatSafe(item.totalStake)} SAFE`}
              progress={<Progress value={item.participationRate} variant="green" />}
            />
            <ValidatorStat
              label={t.totalSafeStaked}
              tooltip={t.totalSafeStakedTooltip}
              value={formatSafe(item.totalStake)}
            />
            <ValidatorStat
              label={t.yourStake}
              tooltip={t.yourStakeTooltip}
              value={props.accountReady ? formatSafe(item.userStake) : "--"}
            />
            <StatusBadge status={item.status} t={t} />
            <div className="validator-row-actions">
              <button
                className="primary-button"
                type="button"
                disabled={item.status !== "active"}
                onClick={() => props.onStake(item.address)}
              >
                {t.stakeAction}
              </button>
              <Tooltip
                className="validator-action-tooltip"
                label={props.accountReady ? t.yourStakeTooltip : t.connectWalletHint}
              >
                <button
                  className="secondary-action-button"
                  type="button"
                  disabled={!props.accountReady || item.userStake <= 0n}
                  onClick={() => props.onUnstake(item.address)}
                >
                  {t.unstakeAction}
                </button>
              </Tooltip>
              <Tooltip label={t.more}>
                <button
                  className="row-arrow"
                  type="button"
                  aria-label={t.more}
                  onClick={() => props.setModal({ type: "validator", validator: item })}
                >
                  ›
                </button>
              </Tooltip>
            </div>
          </article>
        )
      })}
      {!props.isLoading && props.validators.length === 0 && (
        <div className="empty-state validator-empty">
          <Database size={24} />
          <p>{props.emptyMessage ?? t.validatorInfoFailed}</p>
        </div>
      )}
    </div>
  )
}

export function ValidatorToolbar(props: {
  activeOnly: boolean
  isLoading: boolean
  query: string
  setActiveOnly: (value: boolean) => void
  setQuery: (value: string) => void
  setSort: (value: ValidatorSort) => void
  shownCount: number
  sort: ValidatorSort
  t: MessageBundle
  totalCount: number
  updatedBlock: bigint | null
  validatorLoadError: string
}) {
  const sortOptions: Array<{ value: ValidatorSort; label: string }> = [
    { value: "stake", label: props.t.sortStake },
    { value: "participation", label: props.t.sortParticipation },
    { value: "commission", label: props.t.sortCommission },
    { value: "name", label: props.t.sortName },
    { value: "yourStake", label: props.t.sortYourStake },
  ]
  return (
    <div className="validator-toolbar">
      <div className="validator-search">
        <input
          aria-label={props.t.searchValidators}
          placeholder={props.t.searchValidators}
          value={props.query}
          onChange={(event) => props.setQuery(event.target.value)}
        />
      </div>
      <CustomSelect
        label={props.t.sortBy}
        value={props.sort}
        onChange={(value) => props.setSort(value as ValidatorSort)}
        options={sortOptions}
      />
      <button
        className={`segmented-toggle ${props.activeOnly ? "active" : ""}`}
        type="button"
        onClick={() => props.setActiveOnly(!props.activeOnly)}
      >
        {props.activeOnly ? props.t.activeOnly : props.t.allValidators}
      </button>
      <div className={`validator-data-note ${props.validatorLoadError ? "warning" : ""}`}>
        <strong>
          {props.isLoading
            ? props.t.loadingValidators
            : `${props.shownCount}/${props.totalCount} ${props.t.validatorsShown}`}
        </strong>
        <small>
          {props.validatorLoadError
            ? props.validatorLoadError
            : props.updatedBlock
              ? `${props.t.dataUpdated}: ${props.t.block} ${props.updatedBlock}`
              : props.t.liveData}
        </small>
      </div>
    </div>
  )
}

function ValidatorStat(props: {
  label: string
  value: string
  detail?: string
  progress?: ReactNode
  tooltip?: string
}) {
  return (
    <div className="validator-stat">
      <small>
        {props.label}
        {props.tooltip && (
          <Tooltip label={props.tooltip}>
            <Info size={15} />
          </Tooltip>
        )}
      </small>
      <strong>{props.value}</strong>
      {props.detail && <em>{props.detail}</em>}
      {props.progress}
    </div>
  )
}

function StakingOverview({
  t,
  accountReady,
  summary,
  safePriceUsd,
}: {
  t: MessageBundle
  accountReady: boolean
  summary: AccountSummary
  safePriceUsd: number | null
}) {
  const totalBalance = summary.safeBalance + summary.totalStaked
  const stakedShare = totalBalance > 0n ? Number((summary.totalStaked * 10000n) / totalBalance) / 100 : 0
  const safeBalanceShare = Math.max(0, 100 - stakedShare)
  const formattedTotal = accountReady ? formatSafe(totalBalance) : "--"

  return (
    <section className="panel overview-panel">
      <h2>{t.stakingOverview}</h2>
      <div className="overview-layout">
        <div className="overview-copy">
          <small>
            {t.safeBalance} + {t.totalStaked}
          </small>
          <strong>{formattedTotal} SAFE</strong>
          <em>{accountReady ? formatUsdFromSafe(totalBalance, safePriceUsd) : t.connectWallet}</em>
          <div className="overview-legend">
            <span>
              <i className="staked-dot" />
              {t.totalStaked}{" "}
              <b>{accountReady ? `${formatSafe(summary.totalStaked)} SAFE (${stakedShare.toFixed(1)}%)` : "--"}</b>
            </span>
            <span>
              <i />
              {t.safeBalance}{" "}
              <b>{accountReady ? `${formatSafe(summary.safeBalance)} SAFE (${safeBalanceShare.toFixed(1)}%)` : "--"}</b>
            </span>
          </div>
        </div>
        <div
          className={`donut ${accountReady ? "" : "empty"}`}
          style={{ "--staked": `${accountReady ? stakedShare : 0}%` } as CSSProperties}
        >
          <div>
            <small>{t.totalStaked}</small>
            <strong>{accountReady ? `${stakedShare.toFixed(2)}%` : "--"}</strong>
            <em>{accountReady ? `${formatSafe(summary.totalStaked)} SAFE` : t.notConnected}</em>
          </div>
        </div>
      </div>
    </section>
  )
}

function compareBigintDesc(a: bigint, b: bigint) {
  if (a === b) return 0
  return a > b ? -1 : 1
}

function ValidatorParticipationPanel({
  accountReady,
  summary,
  t,
  validators,
}: {
  accountReady: boolean
  summary: AccountSummary
  t: MessageBundle
  validators: ValidatorInfo[]
}) {
  const positions = validators
    .filter((item) => item.userStake > 0n)
    .sort((a, b) => compareBigintDesc(a.userStake, b.userStake))
    .slice(0, 4)

  return (
    <section className="panel positions-panel">
      <div className="panel-title">
        <div>
          <h2>
            {t.validatorParticipation}
            <Tooltip label={t.validatorParticipationSummaryTooltip}>
              <Info size={15} />
            </Tooltip>
          </h2>
        </div>
        <strong>{accountReady ? `${positions.length} ${t.validators}` : "--"}</strong>
      </div>
      <div className="positions-list">
        {accountReady && positions.length > 0 ? (
          positions.map((validator) => {
            const validatorShare =
              summary.totalStaked > 0n ? Number((validator.userStake * 10000n) / summary.totalStaked) / 100 : 0
            return (
              <div className="position-row" key={validator.address}>
                <span className="validator-avatar">
                  <ShieldCheck size={18} />
                </span>
                <span className="position-main">
                  <strong>{validator.label}</strong>
                  <small>{compactAddress(validator.address, 8, 6)}</small>
                </span>
                <span className="position-amount">
                  <b>{formatSafe(validator.userStake)} SAFE</b>
                  <small>{validatorShare.toFixed(2)}%</small>
                </span>
                <Progress value={validatorShare} variant="green" />
              </div>
            )
          })
        ) : (
          <p className="positions-empty">{accountReady ? t.positionsHistoryEmpty : t.connectWalletHint}</p>
        )}
      </div>
    </section>
  )
}

function formatWithdrawalEta(claimableAt: bigint, t: MessageBundle) {
  const now = BigInt(Math.floor(Date.now() / 1000))
  if (claimableAt <= now) return t.claimable
  return formatDelayLabel(claimableAt - now, t)
}

export function WithdrawalsView(props: {
  executeAction: (action?: Action, options?: ExecuteActionOptions) => Promise<void>
  isSubmitting: boolean
  liveSnapshot: AccountSnapshot | null
  submittingAction: SubmittingAction
  t: MessageBundle
  selectAction: (action: Action) => void
  summary: AccountSummary
  txProgress: string
}) {
  const { t } = props
  const isClaimingWithdrawal = props.submittingAction === "claim-withdrawal"
  const pendingRows = props.liveSnapshot?.pendingWithdrawals ?? []
  return (
    <FullPanel title={t.withdrawals}>
      <div className="split-cards">
        <InfoCard
          icon={<Clock3 />}
          title={t.pendingWithdrawals}
          value={`${formatSafe(props.summary.pendingWithdrawals)} SAFE`}
        />
        <InfoCard
          icon={<ArrowDownToLine />}
          title={t.claimableWithdrawals}
          value={`${formatSafe(props.summary.claimableWithdrawals)} SAFE`}
        />
        <InfoCard
          icon={<ShieldCheck />}
          title={t.withdrawalDelay}
          value={formatDelayLabel(props.summary.withdrawDelay, t)}
        />
      </div>
      <section className="withdrawal-timeline" aria-label={t.withdrawalTimeline}>
        <h3>{t.withdrawalTimeline}</h3>
        <div className="timeline-steps">
          <span>{t.submitted}</span>
          <span>{t.unlocking}</span>
          <span>{t.claimable}</span>
          <span>{t.claimed}</span>
        </div>
        <div className="withdrawal-queue">
          {pendingRows.length ? (
            pendingRows.map((item) => (
              <div className="withdrawal-row" key={`${item.amount}-${item.claimableAt}`}>
                <span>
                  <strong>{formatSafe(item.amount)} SAFE</strong>
                  <small>{t.withdrawalEta}</small>
                </span>
                <time>{formatWithdrawalEta(item.claimableAt, t)}</time>
              </div>
            ))
          ) : (
            <p>{t.noPendingWithdrawalRows}</p>
          )}
        </div>
      </section>
      <div className="workflow-panel">
        <button
          type="button"
          className="primary-button"
          disabled={props.isSubmitting}
          onClick={() => {
            props.selectAction("claim-withdrawal")
            void props.executeAction("claim-withdrawal")
          }}
        >
          {isClaimingWithdrawal ? t.preparingAction : t.claimWithdrawals}
        </button>
        {props.txProgress && (
          <p className="action-progress-note">
            <span className="spinner" />
            {props.txProgress}
          </p>
        )}
      </div>
    </FullPanel>
  )
}

export function RewardsView(props: {
  actionPreview: ActionPreview
  dataStatus: DataStatus
  executeClaimRewardsAndStake: (validator: Address) => Promise<void>
  executeAction: (action?: Action, options?: ExecuteActionOptions) => Promise<void>
  isSubmitting: boolean
  restakePreview: ActionPreview
  selectedValidator: ValidatorInfo
  submittingAction: SubmittingAction
  t: MessageBundle
  selectAction: (action: Action) => void
  summary: AccountSummary
  txProgress: string
}) {
  const { t } = props
  const isClaimingRewards = props.submittingAction === "claim-rewards"
  const isClaimingAndRestaking = props.submittingAction === "claim-rewards-and-stake"
  return (
    <FullPanel title={t.rewards}>
      <div className="split-cards">
        <InfoCard
          icon={<Gift />}
          title={t.claimableRewards}
          value={`${formatSafe(props.summary.claimableRewards)} SAFE`}
        />
        <InfoCard icon={<Database />} title={t.rewardsProofSource} value={props.dataStatus.rewardsSource} />
        <InfoCard
          icon={<CheckCircle2 />}
          title={t.merkleRoot}
          value={merkleLabel(t, props.dataStatus.merkleRootMatched)}
        />
      </div>
      <div className="workflow-panel">
        <TransactionPreview t={t} preview={props.actionPreview} />
        <div className="restake-preview-note reward-restake-target">
          <strong>{t.restakeTargetValidator}</strong>
          <span>
            {props.selectedValidator.label} · {compactAddress(props.selectedValidator.address, 8, 6)}
          </span>
        </div>
        <div className="claim-action-row">
          <button
            type="button"
            className="primary-button"
            disabled={props.isSubmitting}
            onClick={() => {
              props.selectAction("claim-rewards")
              void props.executeAction("claim-rewards", { validator: props.selectedValidator.address })
            }}
          >
            {isClaimingRewards ? t.preparingAction : t.claimToWallet}
          </button>
          <button
            type="button"
            className="feature-button"
            disabled={props.isSubmitting}
            onClick={() => {
              props.selectAction("claim-rewards")
              void props.executeClaimRewardsAndStake(props.selectedValidator.address)
            }}
          >
            <span aria-hidden="true">✨</span>
            {isClaimingAndRestaking ? t.preparingAction : t.claimAndRestake}
          </button>
        </div>
        <p className="restake-preview-note">{t.restakePreview}</p>
        <TransactionPreview t={t} preview={props.restakePreview} />
        <ol className="restake-flow-steps" aria-label={t.claimAndRestake}>
          <li>{t.claimToWallet}</li>
          <li>{t.allowance}</li>
          <li>{t.stakeAction}</li>
        </ol>
        {props.txProgress && (
          <p className="action-progress-note">
            <span className="spinner" />
            {props.txProgress}
          </p>
        )}
      </div>
    </FullPanel>
  )
}

export function DocsView({
  copyText,
  openExplorer,
  t,
}: {
  copyText: (value: string) => Promise<void>
  openExplorer: (address: Address) => void
  t: MessageBundle
}) {
  const contracts = [
    { label: t.safeTokenContract, address: CONTRACTS.safeToken },
    { label: t.stakingContractShort, address: CONTRACTS.staking },
    { label: t.rewardsContractShort, address: CONTRACTS.merkleDrop },
  ]
  return (
    <FullPanel title={t.docsTitle}>
      <div className="docs-grid">
        <InfoCard icon={<ShieldCheck />} title={t.docsNonCustodial} value={t.docsNonCustodialValue} />
        <InfoCard icon={<TerminalSquare />} title={t.docsCliParity} value={t.docsCliParityValue} />
        <InfoCard icon={<Database />} title={t.docsReleaseManifest} value={t.docsReleaseManifestValue} />
      </div>
      <section className="trust-panel">
        <div className="trust-panel-heading">
          <div>
            <h3>{t.trustVerification}</h3>
            <p>{t.trustVerificationSubtitle}</p>
          </div>
          <span>{t.chainIdentity}</span>
        </div>
        <div className="trust-grid">
          {contracts.map((item) => (
            <div className="trust-row" key={item.label}>
              <span>
                <small>{item.label}</small>
                <strong>{compactAddress(item.address, 10, 8)}</strong>
              </span>
              <div>
                <button type="button" className="code-button" onClick={() => void copyText(item.address)}>
                  {t.copy}
                </button>
                <button type="button" className="code-button" onClick={() => openExplorer(item.address)}>
                  <ExternalLink size={14} />
                  {t.openExplorer}
                </button>
              </div>
            </div>
          ))}
          <div className="trust-row">
            <span>
              <small>{t.frontendIntegrity}</small>
              <strong>{t.frontendIntegrityValue}</strong>
            </span>
            <div>
              <a
                className="code-button"
                href={`${EXPLORER_BASE_URL}/address/${CONTRACTS.staking}`}
                target="_blank"
                rel="noreferrer"
              >
                <ExternalLink size={14} />
                Etherscan
              </a>
            </div>
          </div>
          <div className="trust-row">
            <span>
              <small>{t.auditStatus}</small>
              <strong>{t.auditStatusValue}</strong>
            </span>
          </div>
        </div>
      </section>
    </FullPanel>
  )
}
