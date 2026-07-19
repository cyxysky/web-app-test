'use client';

import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import {
  Check,
  CheckCircle2,
  ChevronDown,
  CircleDot,
  ClipboardCheck,
  FileSearch,
  GitBranch,
  KeyRound,
  ListOrdered,
  Loader2,
  LockKeyhole,
  Play,
  Plus,
  X,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { artifactApiUrl } from '@/lib/artifacts';
import { readApiJson } from '@/lib/api-client';
import type { TargetActor, TargetFlowNode, TargetWorkflowRun } from '@/server/ai/schemas/target-workflow.schema';
import { LoginAccountModal, loginAccountDomain, type LoginAccountMetadata } from '@/components/LoginAccountModal';
import styles from './BrowserChatTargetRunCard.module.css';

const runStatusLabel: Record<TargetWorkflowRun['status'], string> = {
  analyzing: '分析需求',
  collecting_requirements: '等待补充',
  preparing_authentication: '准备账号',
  awaiting_confirmation: '等待确认',
  ready: '准备执行',
  running: '执行中',
  summarizing: '正在总结',
  completed: '已完成',
  failed: '异常',
  cancelled: '已中断',
};

const nodeTypeLabel = { sequence: '串联', parallel: '并联', target: '目标' } as const;

const phaseStatusLabel: Record<string, string> = {
  pending: '等待',
  running: '进行中',
  passed: '已完成',
  failed: '异常',
  attention: '需关注',
};

export type TargetContinuePayload = {
  responses: Array<{ requirementId: string; value: string }>;
  actorCredentialIds: Array<{ actorId: string; credentialId: string }>;
};

function resultLabel(status?: string) {
  const labels: Record<string, string> = {
    pending: '等待', running: '执行中', passed: '通过', failed: '失败',
    inconclusive: '无法判断', blocked: '被阻断', cancelled: '已取消',
  };
  return status ? labels[status] || status : '等待';
}

function EvidenceItems({ items }: { items: string[] }) {
  return (
    <ul>
      {items.map((item, index) => {
        const screenshotMatch = item.match(/^\[screenshot:(.+?)\]/i);
        const screenshotPath = screenshotMatch?.[1] || (item.includes('/artifacts/') || item.includes('\\artifacts\\') ? item : '');
        const url = artifactApiUrl(screenshotPath);
        return (
          <li key={`evidence-${index}`}>
            {url ? <a href={url} rel="noopener noreferrer" target="_blank">查看截图</a> : null}
            <span>{item}</span>
          </li>
        );
      })}
    </ul>
  );
}

function PlanTextList({ items, label }: { items: string[]; label: string }) {
  if (!items.length) return null;
  return (
    <div className={styles.detailGroup}>
      <strong>{label}</strong>
      <ul>{items.map((item, index) => <li key={`${label}-${index}`}>{item}</li>)}</ul>
    </div>
  );
}

function PhaseHeader({
  description,
  icon,
  index,
  status,
  title,
}: {
  description: string;
  icon: ReactNode;
  index: number;
  status: keyof typeof phaseStatusLabel;
  title: string;
}) {
  return (
    <header className={styles.phaseHeader}>
      <span className={styles.phaseIcon} aria-hidden="true">{icon}</span>
      <div className={styles.phaseHeading}>
        <span>阶段 {String(index).padStart(2, '0')}</span>
        <strong>{title}</strong>
        <p>{description}</p>
      </div>
      <span className={styles.phaseStatus} data-status={status}>{phaseStatusLabel[status]}</span>
    </header>
  );
}

function FlowNodeView({
  node,
  nodes,
  run,
  stepNumber,
  targetStageContent,
  targetNumbers,
}: {
  node: TargetFlowNode;
  nodes: Map<string, TargetFlowNode>;
  run: TargetWorkflowRun;
  stepNumber?: number;
  targetStageContent?: Record<string, ReactNode>;
  targetNumbers: Map<string, number>;
}) {
  const result = run.results[node.id];
  const actor = node.type === 'target' && node.actorId
    ? run.plan?.actors.find((item) => item.id === node.actorId)
    : undefined;
  const hasChildren = node.type !== 'target' && node.children.length > 0;
  const nodeStatus = node.type === 'target' ? (result?.status || 'pending') : node.type;
  const targetNumber = targetNumbers.get(node.id);
  const markerNumber = node.type === 'target' ? targetNumber : stepNumber;
  const targetActivity = node.type === 'target' ? targetStageContent?.[node.id] : undefined;
  const [stageOpen, setStageOpen] = useState(() => Boolean(
    result && !['pending', 'passed'].includes(result.status),
  ));

  useEffect(() => {
    if (node.type !== 'target') return;
    if (result?.status === 'passed') {
      setStageOpen(false);
      return;
    }
    if (result && ['running', 'failed', 'blocked', 'inconclusive', 'cancelled'].includes(result.status)) {
      setStageOpen(true);
      return;
    }
    if (targetActivity && (!result || result.status === 'running')) setStageOpen(true);
  }, [node.type, result, targetActivity]);

  const marker = markerNumber ? (
    <span aria-label={`阶段 ${markerNumber}`}>{markerNumber}</span>
  ) : node.type === 'sequence' ? (
    <ListOrdered aria-hidden="true" size={14} />
  ) : node.type === 'parallel' ? (
    <GitBranch aria-hidden="true" size={14} />
  ) : (
    <CircleDot aria-hidden="true" size={14} />
  );

  return (
    <div className={styles.flowItem} data-node-type={node.type}>
      <div className={styles.flowNodeLayout}>
        <div className={styles.flowRail} aria-hidden="true">
          <span className={styles.flowMarker} data-status={nodeStatus}>{marker}</span>
          {hasChildren ? <span className={styles.flowRailTail} /> : null}
        </div>
        <div className={styles.flowBody}>
          {node.type === 'target' ? (
            <details
              className={styles.stageCard}
              data-status={result?.status || 'pending'}
              onToggle={(event) => setStageOpen(event.currentTarget.open)}
              open={stageOpen}
            >
              <summary className={styles.stageSummary}>
                <span className={styles.stageSummaryCopy}>
                  <strong>{node.title}</strong>
                  <small>{actor ? `${actor.name} · ${actor.role}` : node.objective}</small>
                </span>
                <span className={styles.stageSummaryMeta}>
                  <span className={styles.resultStatus} data-status={result?.status || 'pending'}>{resultLabel(result?.status)}</span>
                  <ChevronDown className={styles.stageChevron} aria-hidden="true" size={15} />
                </span>
              </summary>
              <div className={styles.stageBody}>
                <div className={styles.stageObjective}>
                  <span>测试目标</span>
                  <p>{node.objective}</p>
                </div>

                {targetActivity ? (
                  <section className={styles.nodeStageContent} data-target-stage={node.id}>
                    <div className={styles.inlineSectionHeading}>
                      <span className={styles.inlineSectionIcon}><Play aria-hidden="true" size={11} /></span>
                      <div><strong>执行记录</strong><small>AI 文本与工具调用</small></div>
                    </div>
                    <div className={styles.stageContent}>{targetActivity}</div>
                  </section>
                ) : null}

                <section className={styles.verificationBlock}>
                  <div className={styles.inlineSectionHeading}>
                    <span className={styles.inlineSectionIcon}><ClipboardCheck aria-hidden="true" size={12} /></span>
                    <div><strong>验证结果</strong><small>{result ? resultLabel(result.status) : '执行后逐项核验'}</small></div>
                  </div>
                  {result?.failureReason ? <p className={styles.failureReason}>失败/阻断原因：{result.failureReason}</p> : null}
                  {result?.summary ? <p className={styles.resultSummary}>{result.summary}</p> : null}
                  <ol className={styles.criteria}>
                    {node.successCriteria.map((criterion) => {
                      const criterionResult = result?.criteria.find((item) => item.criterionId === criterion.id);
                      return (
                        <li key={criterion.id}>
                          <div className={styles.criterionHead}>
                            <span>{criterion.description}</span>
                            <b data-status={criterionResult?.status || 'pending'}>{resultLabel(criterionResult?.status)}</b>
                          </div>
                          <p className={styles.evidenceRequirement}>证据要求：{criterion.evidenceRequirement}</p>
                          {criterionResult?.observation ? <p className={styles.observation}>{criterionResult.observation}</p> : null}
                          {criterionResult?.evidence.length ? (
                            <details className={styles.evidence}>
                              <summary>查看该标准的 {criterionResult.evidence.length} 条证据</summary>
                              <EvidenceItems items={criterionResult.evidence} />
                            </details>
                          ) : null}
                        </li>
                      );
                    })}
                  </ol>
                  {result?.evidence.length ? (
                    <details className={styles.evidence}>
                      <summary>目标证据汇总（{result.evidence.length}）</summary>
                      <EvidenceItems items={result.evidence} />
                    </details>
                  ) : null}
                </section>

                {(node.preconditions.length || node.inputs.length || node.outputs.length || node.resources.length) ? (
                  <details className={styles.configDisclosure}>
                    <summary>执行配置与前置条件</summary>
                    <div className={styles.targetDetails}>
                      <PlanTextList items={node.preconditions} label="前置条件" />
                      <PlanTextList items={node.inputs} label="输入" />
                      <PlanTextList items={node.outputs} label="预期输出" />
                      {node.resources.length ? (
                        <div className={styles.detailGroup}>
                          <strong>资源访问</strong>
                          <ul>
                            {node.resources.map((resource) => (
                              <li key={`${resource.key}-${resource.access}`}>
                                {resource.access === 'write' ? '写入' : '读取'} · {resource.key}
                                {resource.description ? `：${resource.description}` : ''}
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : null}
                    </div>
                  </details>
                ) : null}
              </div>
            </details>
          ) : (
            <article className={styles.groupNode} data-node-type={node.type}>
              <div className={styles.nodeHead}>
                <strong>{node.title}</strong>
                <div className={styles.nodeBadges}>
                  <span className={styles.nodeType}>{nodeTypeLabel[node.type]}</span>
                </div>
              </div>
              <p className={styles.reason}>{node.relationReason || node.description}</p>
              {node.type === 'parallel' && node.maxConcurrency ? <p className={styles.nodeMeta}>最多同时执行 {node.maxConcurrency} 个分支</p> : null}
              {node.type === 'sequence' && node.alwaysRun ? <p className={styles.nodeMeta}>即使前序失败也继续执行</p> : null}
            </article>
          )}
        </div>

        {node.type === 'sequence' ? (
          <div className={styles.sequenceChildren}>
            {node.children.map((childId, index) => {
              const child = nodes.get(childId);
              return child ? (
                <div className={styles.sequenceStep} key={child.id}>
                  <FlowNodeView node={child} nodes={nodes} run={run} stepNumber={index + 1} targetStageContent={targetStageContent} targetNumbers={targetNumbers} />
                </div>
              ) : null;
            })}
          </div>
        ) : null}

        {node.type === 'parallel' ? (
          <div className={styles.parallelChildren}>
            <div className={styles.parallelJunction}><span>同时开始</span></div>
            {node.children.map((childId) => {
              const child = nodes.get(childId);
              return child ? (
                <div className={styles.parallelBranch} key={child.id}>
                  <FlowNodeView node={child} nodes={nodes} run={run} targetStageContent={targetStageContent} targetNumbers={targetNumbers} />
                </div>
              ) : null;
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function actorNeedsCredentialPreparation(actor: TargetActor) {
  return actor.auth.required
    && actor.auth.status !== 'ready'
    && actor.auth.status !== 'verifying';
}

function actorCredentialDomain(actor: TargetActor, targetUrl?: string) {
  return loginAccountDomain(actor.auth.credentialDomain || actor.auth.loginUrl || targetUrl);
}

function accountOptionLabel(account: LoginAccountMetadata) {
  const username = account.username.trim();
  const label = account.label.trim();
  if (!label || label === username) return username;
  const lowerLabel = label.toLocaleLowerCase();
  const lowerUsername = username.toLocaleLowerCase();
  for (const separator of [' · ', ' - ', ' / ']) {
    const suffix = `${separator}${lowerUsername}`;
    if (lowerLabel.endsWith(suffix)) return label.slice(0, -suffix.length).trim() || username;
  }
  return label;
}

function AccountSelect({
  accounts,
  disabled,
  loading,
  onChange,
  onOpenChange,
  open,
  selectedAccount,
  selectedAccountId,
}: {
  accounts: LoginAccountMetadata[];
  disabled: boolean;
  loading: boolean;
  onChange: (credentialId: string) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  selectedAccount?: LoginAccountMetadata;
  selectedAccountId?: string;
}) {
  const menuId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  const options = useMemo(() => (
    selectedAccount && !accounts.some((account) => account.id === selectedAccount.id)
      ? [selectedAccount, ...accounts]
      : accounts
  ), [accounts, selectedAccount]);

  useEffect(() => {
    if (!open) return undefined;

    const positionMenu = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const viewportPadding = 8;
      const gap = 6;
      const viewportWidth = Math.max(0, window.innerWidth - viewportPadding * 2);
      const width = Math.min(Math.max(rect.width, 300), viewportWidth);
      const left = Math.max(
        viewportPadding,
        Math.min(rect.left, window.innerWidth - width - viewportPadding),
      );
      const roomBelow = window.innerHeight - rect.bottom - gap - viewportPadding;
      const roomAbove = rect.top - gap - viewportPadding;
      const above = roomBelow < 180 && roomAbove > roomBelow;
      const maxHeight = Math.max(0, Math.min(360, above ? roomAbove : roomBelow));
      setMenuStyle(above
        ? { bottom: window.innerHeight - rect.top + gap, left, maxHeight, width }
        : { left, maxHeight, top: rect.bottom + gap, width });
    };
    const closeFromOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      // Let another account trigger handle the switch in its click event. Closing
      // here would replace that trigger between pointerdown and click, requiring a
      // second click to open the next menu.
      if (event.target instanceof Element
        && event.target.closest('[data-account-select-trigger="true"]')) return;
      onOpenChange(false);
    };
    const animationFrame = window.requestAnimationFrame(() => {
      positionMenu();
      const optionElements = Array.from(
        menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') || [],
      );
      const selectedIndex = options.findIndex((account) => account.id === selectedAccountId);
      const initialOption = optionElements[Math.max(0, selectedIndex)];
      initialOption?.focus();
      initialOption?.scrollIntoView({ block: 'nearest' });
    });
    document.addEventListener('pointerdown', closeFromOutside, true);
    window.addEventListener('resize', positionMenu);
    window.addEventListener('scroll', positionMenu, true);
    return () => {
      window.cancelAnimationFrame(animationFrame);
      document.removeEventListener('pointerdown', closeFromOutside, true);
      window.removeEventListener('resize', positionMenu);
      window.removeEventListener('scroll', positionMenu, true);
    };
  }, [onOpenChange, open, options, selectedAccountId]);

  useEffect(() => {
    if (disabled) onOpenChange(false);
  }, [disabled, onOpenChange]);

  function closeAndRestoreFocus() {
    onOpenChange(false);
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  }

  function choose(credentialId: string) {
    onChange(credentialId);
    closeAndRestoreFocus();
  }

  function handleTriggerKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      closeAndRestoreFocus();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    onOpenChange(true);
  }

  function handleMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const optionElements = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') || [],
    );
    if (event.key === 'Escape') {
      event.preventDefault();
      closeAndRestoreFocus();
      return;
    }
    if (event.key === 'Tab') {
      onOpenChange(false);
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || !optionElements.length) return;
    event.preventDefault();
    const currentIndex = Math.max(0, optionElements.indexOf(document.activeElement as HTMLButtonElement));
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? optionElements.length - 1
        : event.key === 'ArrowDown'
          ? (currentIndex + 1) % optionElements.length
          : (currentIndex - 1 + optionElements.length) % optionElements.length;
    const nextOption = optionElements[nextIndex];
    nextOption?.focus();
    nextOption?.scrollIntoView({ block: 'nearest' });
  }

  const selectedPrimary = selectedAccount
    ? accountOptionLabel(selectedAccount)
    : selectedAccountId
      ? '已匹配账号'
      : '选择已有账号';
  const selectedSecondary = selectedAccount
    ? `${selectedAccount.username} · ${selectedAccount.domain}`
    : loading
      ? '正在读取账号…'
      : accounts.length
        ? `${accounts.length} 个账号可选`
        : '当前域名暂无账号';

  return (
    <>
      <button
        aria-controls={open ? menuId : undefined}
        aria-expanded={open}
        aria-haspopup="listbox"
        className={styles.accountSelectTrigger}
        data-account-select-trigger="true"
        disabled={disabled || loading}
        onClick={() => onOpenChange(!open)}
        onKeyDown={handleTriggerKeyDown}
        ref={triggerRef}
        type="button"
      >
        <span className={styles.accountSelectIcon} aria-hidden="true"><KeyRound size={14} /></span>
        <span className={styles.accountSelectText}>
          <strong>{selectedPrimary}</strong>
          <small>{selectedSecondary}</small>
        </span>
        <ChevronDown aria-hidden="true" className={open ? styles.accountSelectChevronOpen : undefined} size={15} />
      </button>
      {open && typeof document !== 'undefined' ? createPortal((
        <div
          className={styles.accountSelectMenu}
          onKeyDown={handleMenuKeyDown}
          ref={menuRef}
          style={menuStyle}
        >
          <div className={styles.accountSelectMenuHead}>
            <strong>选择登录账号</strong>
            <span>{options.length} 个可用账号</span>
          </div>
          <div
            aria-label="选择登录账号"
            className={styles.accountSelectOptions}
            id={menuId}
            role="listbox"
          >
            {options.length ? options.map((account) => (
              <button
                aria-selected={account.id === selectedAccountId}
                className={styles.accountSelectOption}
                key={account.id}
                onClick={() => choose(account.id)}
                role="option"
                type="button"
              >
                <span className={styles.accountOptionAvatar} aria-hidden="true">{(account.label || account.username).trim().slice(0, 1).toUpperCase()}</span>
                <span className={styles.accountOptionText}>
                  <strong>{accountOptionLabel(account)}</strong>
                  <small>{account.username} · {account.domain}</small>
                </span>
                {account.id === selectedAccountId ? <Check aria-hidden="true" size={14} /> : null}
              </button>
            )) : <p className={styles.accountSelectEmpty}>该域名下还没有可用账号</p>}
          </div>
          {selectedAccountId ? (
            <button className={styles.accountSelectClear} onClick={() => choose('')} type="button">
              <X aria-hidden="true" size={13} />
              清除当前选择
            </button>
          ) : null}
        </div>
      ), document.body) : null}
    </>
  );
}

function ActorCard({
  actor,
  accountSelectOpen,
  availableAccounts,
  accountsError,
  accountsLoading,
  automaticallyMatched,
  credential,
  credentialId,
  disabled,
  onCreateAccount,
  onAccountSelectOpenChange,
  onSelectAccount,
  showPermissions,
}: {
  actor: TargetActor;
  accountSelectOpen: boolean;
  availableAccounts: LoginAccountMetadata[];
  accountsError?: string;
  accountsLoading: boolean;
  automaticallyMatched: boolean;
  credential?: LoginAccountMetadata;
  credentialId?: string;
  disabled: boolean;
  onCreateAccount: () => void;
  onAccountSelectOpenChange: (open: boolean) => void;
  onSelectAccount: (credentialId: string) => void;
  showPermissions: boolean;
}) {
  const verifying = actor.auth.status === 'verifying';
  const credentialDomain = credential?.domain || actor.auth.credentialDomain || loginAccountDomain(actor.auth.loginUrl);
  const hasSelectedAccount = Boolean(credentialId);
  return (
    <li className={styles.actor}>
      <div className={styles.actorTitle}>
        <div>
          <strong>{actor.name}</strong>
          <p className={styles.muted}>{actor.purpose}</p>
        </div>
        <span className={styles.actorMeta}>{actor.role}</span>
      </div>
      {showPermissions && actor.permissions.length ? (
        <ul className={styles.permissions}>
          {actor.permissions.map((permission) => (
            <li key={permission.id}>
              <div>
                <span>{permission.resource} · {permission.action}</span>
                {permission.detail ? <small>{permission.detail}</small> : null}
              </div>
              <b>{permission.expected === 'allow' ? '允许' : permission.expected === 'deny' ? '禁止' : permission.expected === 'limited' ? '有限允许' : '待确认'}</b>
            </li>
          ))}
        </ul>
      ) : null}
      {actor.auth.loginUrl ? <p className={styles.loginUrl} title={actor.auth.loginUrl}>登录地址：{actor.auth.loginUrl}</p> : null}
      {!actor.auth.required ? <p className={styles.authReady}><CheckCircle2 size={13} /> 无需登录</p> : null}
      {actor.auth.status === 'ready' ? <p className={styles.authReady}><CheckCircle2 size={13} /> 账号已经准备完成</p> : null}
      {verifying ? (
        <div aria-live="polite" className={styles.authProgress} role="status">
          <Loader2 className="spin" size={15} />
          <span>{actor.auth.message || 'AI 正在安全验证该账号，请稍候。'}</span>
        </div>
      ) : null}
      {actor.auth.required && actor.auth.status !== 'ready' && !verifying ? (
        <>
          {actor.auth.status === 'failed' && actor.auth.message ? <p className={styles.authError}>{actor.auth.message}</p> : null}
          <div className={styles.accountPicker}>
            <div className={styles.accountPickerLabel}>
              <div>
                <strong>登录账号</strong>
                <span>{credentialDomain || '尚未识别登录域名'}</span>
              </div>
              <span
                className={styles.accountMatchState}
                data-state={hasSelectedAccount ? (automaticallyMatched ? 'matched' : 'selected') : 'empty'}
              >
                {hasSelectedAccount ? (automaticallyMatched ? '自动匹配' : '已选择') : '待选择'}
              </span>
            </div>
            <div className={styles.accountPickerActions}>
              <AccountSelect
                accounts={availableAccounts}
                disabled={disabled}
                loading={accountsLoading}
                onChange={onSelectAccount}
                onOpenChange={onAccountSelectOpenChange}
                open={accountSelectOpen}
                selectedAccount={credential}
                selectedAccountId={credentialId}
              />
              {!hasSelectedAccount ? <button className={styles.accountAddButton} disabled={disabled || accountsLoading} onClick={onCreateAccount} type="button">
                <Plus aria-hidden="true" size={13} />
                新增账号
              </button> : null}
            </div>
            {accountsError ? <p className={styles.accountError} role="alert">{accountsError}</p> : null}
          </div>
        </>
      ) : null}
    </li>
  );
}

export function BrowserChatTargetRunCard({
  analysisStageContent,
  busy,
  onContinue,
  run,
  targetStageContent,
  userId,
}: {
  analysisStageContent?: ReactNode;
  busy: boolean;
  onContinue: (payload: TargetContinuePayload) => void | Promise<void>;
  run: TargetWorkflowRun;
  targetStageContent?: Record<string, ReactNode>;
  userId?: string;
}) {
  const [actorAccountSelections, setActorAccountSelections] = useState<Record<string, LoginAccountMetadata | null>>({});
  const [availableAccounts, setAvailableAccounts] = useState<LoginAccountMetadata[]>([]);
  const [accountsLoaded, setAccountsLoaded] = useState(false);
  const [accountsLoading, setAccountsLoading] = useState(false);
  const [accountsError, setAccountsError] = useState('');
  const [accountModalActorId, setAccountModalActorId] = useState('');
  const [openAccountActorId, setOpenAccountActorId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const nodes = useMemo(() => new Map((run.plan?.nodes || []).map((node) => [node.id, node])), [run.plan?.nodes]);
  const root = run.plan ? nodes.get(run.plan.rootNodeId) : undefined;
  const targetNodes = useMemo(
    () => (run.plan?.nodes || []).filter((node): node is Extract<TargetFlowNode, { type: 'target' }> => node.type === 'target'),
    [run.plan?.nodes],
  );
  const targetNumbers = useMemo(
    () => new Map(targetNodes.map((node, index) => [node.id, index + 1])),
    [targetNodes],
  );
  const unresolved = useMemo(
    () => run.plan?.requirements.filter((item) => item.required && item.status === 'missing') || [],
    [run.plan?.requirements],
  );
  const pendingCredentialActors = useMemo(
    () => run.plan?.actors.filter(actorNeedsCredentialPreparation) || [],
    [run.plan?.actors],
  );
  const credentialActorIds = useMemo(
    () => new Set((run.plan?.actors || []).filter((actor) => actor.auth.required).map((actor) => actor.id)),
    [run.plan?.actors],
  );
  const normalRequirements = useMemo(() => unresolved.filter((item) => !(
    item.category === 'account' && item.actorId && credentialActorIds.has(item.actorId)
  )), [credentialActorIds, unresolved]);
  const verifyingActors = run.plan?.actors.filter((actor) => (
    actor.auth.status === 'verifying'
  )) || [];
  const collecting = Boolean(run.plan && (
    run.status === 'collecting_requirements'
    || !run.plan.analysisComplete
    || unresolved.length
  ));
  const initialAnalyzing = !run.plan && run.status === 'analyzing';
  const terminal = ['running', 'summarizing', 'completed', 'cancelled'].includes(run.status);
  const processing = submitting
    || run.status === 'analyzing'
    || run.status === 'ready'
    || verifyingActors.length > 0
    || (pendingCredentialActors.length > 0 && (!accountsLoaded || accountsLoading))
    || (busy && !terminal);
  const credentialsReady = pendingCredentialActors.every((actor) => Boolean(
    selectedCredentialId(actor),
  ));
  const canContinue = Boolean(run.plan
    && !terminal
    && !processing
    && !normalRequirements.length
    && credentialsReady);
  const hasSecureCredentialsToSubmit = pendingCredentialActors.length > 0;
  const settledTargetCount = targetNodes.filter((node) => {
    const status = run.results[node.id]?.status;
    return Boolean(status && !['pending', 'running'].includes(status));
  }).length;
  const hasAttentionResult = targetNodes.some((node) => {
    const status = run.results[node.id]?.status;
    return Boolean(status && ['failed', 'blocked', 'inconclusive', 'cancelled'].includes(status));
  });
  const analysisPhaseStatus: keyof typeof phaseStatusLabel = run.error
    ? 'failed'
    : run.status === 'analyzing' || (!run.plan && busy) || (collecting && processing)
      ? 'running'
      : collecting || !run.plan
        ? 'attention'
        : 'passed';
  const executionPhaseStatus: keyof typeof phaseStatusLabel = ['running', 'summarizing'].includes(run.status)
    ? 'running'
    : run.status === 'completed'
      ? (hasAttentionResult ? 'attention' : 'passed')
      : run.status === 'failed'
        ? 'failed'
        : 'pending';
  const actorSelectionKey = (run.plan?.actors || [])
    .filter((actor) => actor.auth.required && actor.auth.status !== 'ready')
    .map((actor) => actor.id)
    .join('\u001f');
  const accountModalActor = run.plan?.actors.find((actor) => actor.id === accountModalActorId);

  function hasActorAccountOverride(actorId: string) {
    return Object.prototype.hasOwnProperty.call(actorAccountSelections, actorId);
  }

  function selectedCredentialId(actor: TargetActor) {
    if (hasActorAccountOverride(actor.id)) return actorAccountSelections[actor.id]?.id;
    if (!actor.auth.credentialId) return undefined;
    if (!accountsLoaded || accountsError) return actor.auth.credentialId;
    const domain = actorCredentialDomain(actor, run.plan?.targetUrl);
    const matched = availableAccounts.find((account) => account.id === actor.auth.credentialId);
    return matched && (!domain || matched.domain === domain) ? matched.id : undefined;
  }

  function selectedCredential(actor: TargetActor) {
    const credentialId = selectedCredentialId(actor);
    if (!credentialId) return undefined;
    return actorAccountSelections[actor.id]
      || availableAccounts.find((account) => account.id === credentialId);
  }

  function availableAccountsForActor(actor: TargetActor) {
    const domain = actorCredentialDomain(actor, run.plan?.targetUrl);
    return availableAccounts.filter((account) => (
      account.status === 'active'
      && account.hasPassword
      && (!domain || account.domain === domain)
    ));
  }

  useEffect(() => {
    const actorIds = new Set(actorSelectionKey ? actorSelectionKey.split('\u001f') : []);
    setActorAccountSelections((current) => Object.fromEntries(
      Object.entries(current).filter(([actorId]) => actorIds.has(actorId)),
    ));
    setAccountModalActorId('');
    setOpenAccountActorId('');
    setSubmitError('');
  }, [actorSelectionKey, run.id, run.plan?.version]);

  useEffect(() => {
    if (!pendingCredentialActors.length) {
      setAvailableAccounts([]);
      setAccountsLoaded(false);
      setAccountsError('');
      setAccountsLoading(false);
      return undefined;
    }
    const abortController = new AbortController();
    setAccountsLoaded(false);
    setAccountsLoading(true);
    setAccountsError('');
    const query = userId ? `?userId=${encodeURIComponent(userId)}` : '';
    void fetch(`/api/login-accounts${query}`, { signal: abortController.signal })
      .then((response) => readApiJson<{ accounts?: LoginAccountMetadata[] }>(response, '读取已有账号失败'))
      .then((data) => {
        setAvailableAccounts((data.accounts || []).filter((account) => account.status === 'active' && account.hasPassword));
      })
      .catch((error) => {
        if (abortController.signal.aborted) return;
        setAvailableAccounts([]);
        setAccountsError(error instanceof Error ? error.message : '读取已有账号失败');
      })
      .finally(() => {
        if (!abortController.signal.aborted) {
          setAccountsLoaded(true);
          setAccountsLoading(false);
        }
      });
    return () => abortController.abort();
  }, [actorSelectionKey, pendingCredentialActors.length, run.id, userId]);

  async function continuePlan() {
    if (!canContinue || submitting) return;
    setSubmitting(true);
    setSubmitError('');
    try {
      await onContinue({
        responses: [],
        actorCredentialIds: pendingCredentialActors.map((actor) => ({
          actorId: actor.id,
          credentialId: selectedCredentialId(actor) || '',
        })),
      });
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : '资料提交失败，请检查后重试。');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className={styles.card} aria-label="目标测试计划" data-run-status={run.status}>
      <header className={styles.header}>
        <div className={styles.heading}>
          <strong>{run.plan?.title || '正在生成目标测试计划'}</strong>
          <span>{run.plan?.requirementSummary || 'AI 正在分析全部需求内容。'}</span>
          {run.plan ? <small>计划第 {run.plan.version} 版 · {targetNodes.length || 0} 个测试目标</small> : null}
        </div>
        <div className={styles.headerMeta}>
          {targetNodes.length ? <small>{settledTargetCount}/{targetNodes.length} 已完成</small> : null}
          <span className={styles.status} data-run-status={run.status}>{runStatusLabel[run.status]}</span>
        </div>
      </header>

      <div className={styles.phaseStack}>
        <section
          className={styles.phaseCard}
          data-initializing={initialAnalyzing || undefined}
          data-status={analysisPhaseStatus}
          data-target-stage="analysis"
        >
          {initialAnalyzing ? (
            <div className={styles.initializingBody}>
              <div aria-live="polite" className={styles.initializingStep} role="status">
                <span className={styles.initializingIcon} aria-hidden="true"><Loader2 className="spin" size={16} /></span>
                <div>
                  <strong>正在拆分测试目标</strong>
                  <span>识别账号、权限、前置依赖与可并行流程</span>
                </div>
              </div>
              {analysisStageContent ? (
                <div className={`${styles.stageContent} ${styles.initializingActivity}`}>{analysisStageContent}</div>
              ) : null}
            </div>
          ) : (
            <>
          <PhaseHeader
            description={!run.plan || run.status === 'analyzing'
              ? 'AI 正在分析目标、账号、权限与前置条件。'
              : collecting
                ? '分析需求并补齐执行所需的信息。'
                : '需求、账号与执行边界已经确认。'}
            icon={<FileSearch size={15} />}
            index={1}
            status={analysisPhaseStatus}
            title="需求分析与执行资料"
          />
          <div className={styles.phaseBody}>
            {run.error ? <p className={styles.runError}>目标分析失败：{run.error}</p> : null}

            {run.status === 'analyzing' || (busy && !terminal && !submitting) ? (
              <div aria-live="polite" className={styles.processingNotice} role="status">
                <Loader2 className="spin" size={16} />
                <div><strong>AI 正在核对需求与资料</strong><span>完成后会更新缺失内容，或自动进入执行阶段。</span></div>
              </div>
            ) : null}

            {analysisStageContent ? (
              collecting || analysisPhaseStatus === 'running' || analysisPhaseStatus === 'failed' ? (
                <div className={`${styles.stageContent} ${styles.analysisStage}`}>{analysisStageContent}</div>
              ) : (
                <details className={styles.activityDisclosure}>
                  <summary>
                    <span>查看需求分析记录</span>
                    <ChevronDown aria-hidden="true" size={14} />
                  </summary>
                  <div className={`${styles.stageContent} ${styles.analysisStage}`}>{analysisStageContent}</div>
                </details>
              )
            ) : null}

            {run.plan && collecting ? (
              <div className={styles.collectionBlock}>
                <div className={styles.collectionHeading}>
                  <div>
                    <h3>补充执行资料</h3>
                    <p>请把缺失内容直接回复在对话中。AI 会结合完整上下文重新分析，仍有缺项时会继续向你确认。</p>
                  </div>
                  <span>{normalRequirements.length + pendingCredentialActors.length} 项待补充</span>
                </div>
                {normalRequirements.length ? (
                  <ul className={styles.missingRequirements} aria-label="需要直接回复的资料">
                    {normalRequirements.map((item) => (
                      <li key={item.id}>
                        <strong>{item.title}</strong>
                        <span>{item.question}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {run.plan.actors.some((actor) => actor.auth.required && actor.auth.status !== 'ready') ? (
                  <div className={styles.actorInputBlock}>
                    <div className={styles.inlineSectionHeading}>
                      <span className={styles.inlineSectionIcon}><LockKeyhole aria-hidden="true" size={12} /></span>
                      <div><strong>账号准备</strong><small>系统先自动匹配；未命中时选择已有账号，密码仅在后台使用</small></div>
                    </div>
                    <ul className={styles.actors}>
                      {run.plan.actors.filter((actor) => actor.auth.required && actor.auth.status !== 'ready').map((actor) => (
                        <ActorCard
                          actor={actor}
                          accountSelectOpen={openAccountActorId === actor.id}
                          accountsError={accountsError}
                          accountsLoading={accountsLoading}
                          automaticallyMatched={!hasActorAccountOverride(actor.id)
                            && Boolean(actor.auth.credentialId)
                            && selectedCredentialId(actor) === actor.auth.credentialId}
                          availableAccounts={availableAccountsForActor(actor)}
                          credential={selectedCredential(actor)}
                          credentialId={selectedCredentialId(actor)}
                          disabled={processing}
                          key={actor.id}
                          onAccountSelectOpenChange={(open) => setOpenAccountActorId(open ? actor.id : '')}
                          onCreateAccount={() => {
                            setOpenAccountActorId('');
                            setAccountModalActorId(actor.id);
                          }}
                          onSelectAccount={(credentialId) => {
                            const account = availableAccountsForActor(actor).find((item) => item.id === credentialId) || null;
                            setActorAccountSelections((current) => ({ ...current, [actor.id]: account }));
                          }}
                          showPermissions={false}
                        />
                      ))}
                    </ul>
                  </div>
                ) : null}
                {normalRequirements.length ? <p className={styles.replyHint}>将以上资料整理在一条消息中直接回复即可，无需在卡片内逐项填写。</p> : null}
              </div>
            ) : null}

            {verifyingActors.length ? (
              <div aria-live="polite" className={styles.verifyingNotice} role="status">
                <Loader2 className="spin" size={15} /> AI 正在验证 {verifyingActors.length} 个账号，完成后会自动继续。
              </div>
            ) : null}

            {run.plan && !collecting ? (
              <details className={styles.phaseDisclosure}>
                <summary>
                  <span><FileSearch aria-hidden="true" size={14} /> 查看计划依据与已确认资料</span>
                  <ChevronDown aria-hidden="true" size={15} />
                </summary>
                <div className={styles.disclosureBody}>
                  {run.plan.targetUrl ? <p className={styles.targetUrl} title={run.plan.targetUrl}>目标地址：{run.plan.targetUrl}</p> : null}
                  {(run.plan.assumptions.length || run.plan.risks.length) ? (
                    <div className={styles.planBasis}>
                      <PlanTextList items={run.plan.assumptions} label="AI 采用的假设" />
                      <PlanTextList items={run.plan.risks} label="已识别风险" />
                    </div>
                  ) : null}
                  {run.plan.requirements.length ? (
                    <div className={styles.disclosureSection}>
                      <h4>执行资料</h4>
                      <ul className={styles.requirements}>
                        {run.plan.requirements.map((item) => (
                          <li className={`${styles.requirement} ${item.status === 'resolved' ? styles.resolved : ''}`} key={item.id}>
                            <strong>{item.status === 'resolved' ? '✓ ' : ''}{item.title}</strong>
                            <p className={styles.muted}>{item.status === 'resolved' ? item.resolution : item.question}</p>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {run.plan.actors.length ? (
                    <div className={styles.disclosureSection}>
                      <h4>账号、角色与权限</h4>
                      <ul className={styles.actors}>
                        {run.plan.actors.map((actor) => (
                          <ActorCard
                            actor={actor}
                            accountSelectOpen={openAccountActorId === actor.id}
                            accountsError={accountsError}
                            accountsLoading={accountsLoading}
                            automaticallyMatched={!hasActorAccountOverride(actor.id)
                              && Boolean(actor.auth.credentialId)
                              && selectedCredentialId(actor) === actor.auth.credentialId}
                            availableAccounts={availableAccountsForActor(actor)}
                            credential={selectedCredential(actor)}
                            credentialId={selectedCredentialId(actor)}
                            disabled={processing}
                            key={actor.id}
                            onAccountSelectOpenChange={(open) => setOpenAccountActorId(open ? actor.id : '')}
                            onCreateAccount={() => {
                              setOpenAccountActorId('');
                              setAccountModalActorId(actor.id);
                            }}
                            onSelectAccount={(credentialId) => {
                              const account = availableAccountsForActor(actor).find((item) => item.id === credentialId) || null;
                              setActorAccountSelections((current) => ({ ...current, [actor.id]: account }));
                            }}
                            showPermissions
                          />
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </div>
              </details>
            ) : null}

            {submitError ? <p className={styles.submitError} role="alert">{submitError}</p> : null}
          </div>

          {run.plan && !terminal && !normalRequirements.length ? (
            <footer className={styles.footer}>
              <div className={styles.footerCopy}>
                <strong>{hasSecureCredentialsToSubmit ? '使用后台账号安全登录' : '执行前进行最后一次检查'}</strong>
                <span>{hasSecureCredentialsToSubmit ? '登录完成后 AI 会继续核对计划，密码不会提供给模型。' : '检查通过后将自动开始执行，无需再次确认。'}</span>
              </div>
              <button className={styles.primary} disabled={!canContinue} onClick={() => void continuePlan()} type="button">
                {processing ? <Loader2 className="spin" size={14} /> : hasSecureCredentialsToSubmit ? <KeyRound size={14} /> : <Play size={14} />}
                {processing ? '正在检查' : hasSecureCredentialsToSubmit ? '登录并继续' : '重新检查并开始'}
              </button>
            </footer>
          ) : null}
            </>
          )}
        </section>

        {!collecting && root ? (
          <section className={styles.phaseCard} data-status={executionPhaseStatus} data-target-stage="execution">
            <PhaseHeader
              description={`${targetNodes.length} 个目标按前置关系串联或并行执行，互不共享浏览器会话。`}
              icon={<GitBranch size={15} />}
              index={2}
              status={executionPhaseStatus}
              title="执行流程"
            />
            <div className={`${styles.phaseBody} ${styles.executionBody}`}>
              <div className={styles.tree}>
                <FlowNodeView
                  node={root}
                  nodes={nodes}
                  run={run}
                  targetNumbers={targetNumbers}
                  targetStageContent={targetStageContent}
                />
              </div>
            </div>
          </section>
        ) : null}

        {run.status === 'summarizing' || run.summary ? (
          <section className={styles.phaseCard} data-status={run.status === 'summarizing' ? 'running' : hasAttentionResult ? 'attention' : 'passed'} data-target-stage="summary">
            <PhaseHeader
              description="汇总每个测试目标的结论、失败原因与证据。"
              icon={<ClipboardCheck size={15} />}
              index={3}
              status={run.status === 'summarizing' ? 'running' : hasAttentionResult ? 'attention' : 'passed'}
              title="结果总结"
            />
            <div className={styles.phaseBody}>
              {run.status === 'summarizing' && !run.summary ? (
                <div className={styles.processingNotice}><Loader2 className="spin" size={16} /><div><strong>正在生成最终总结</strong><span>正在核对所有阶段结果与证据。</span></div></div>
              ) : null}
              {run.summary ? (
                <>
                  <div className={styles.resultOverview} data-status={hasAttentionResult ? 'attention' : 'passed'}>
                    <CheckCircle2 aria-hidden="true" size={17} />
                    <div>
                      <strong>{hasAttentionResult ? '测试完成，存在需要关注的目标' : `${targetNodes.length} 个目标全部通过`}</strong>
                      <span>{hasAttentionResult ? '展开完整总结查看失败原因、阻断项与证据。' : '全部目标均已完成验证；完整结论与证据可按需展开。'}</span>
                    </div>
                  </div>
                  <details className={styles.summaryDisclosure} open={hasAttentionResult}>
                    <summary>
                      <span>查看完整总结与证据</span>
                      <ChevronDown aria-hidden="true" size={14} />
                    </summary>
                    <div className={styles.summary}><ReactMarkdown remarkPlugins={[remarkGfm]}>{run.summary}</ReactMarkdown></div>
                  </details>
                </>
              ) : null}
            </div>
          </section>
        ) : null}
      </div>
      <LoginAccountModal
        initialDomain={accountModalActor?.auth.credentialDomain || loginAccountDomain(accountModalActor?.auth.loginUrl || run.plan?.targetUrl)}
        initialLabel={accountModalActor ? `${accountModalActor.name} · ${accountModalActor.role}` : ''}
        initialLoginUrl={accountModalActor?.auth.loginUrl}
        initialUsername={accountModalActor?.auth.username}
        onClose={() => setAccountModalActorId('')}
        onSaved={(account) => {
          if (!accountModalActorId) return;
          setAvailableAccounts((current) => [account, ...current.filter((item) => item.id !== account.id)]);
          setActorAccountSelections((current) => ({ ...current, [accountModalActorId]: account }));
        }}
        open={Boolean(accountModalActor)}
        userId={userId}
      />
    </section>
  );
}
