'use client';

import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, CircleDot, GitBranch, KeyRound, ListOrdered, Loader2, LockKeyhole, Play, Sparkles } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { artifactApiUrl } from '@/lib/artifacts';
import type { TargetActor, TargetFlowNode, TargetWorkflowRun } from '@/server/ai/schemas/target-workflow.schema';
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

export type TargetContinuePayload = {
  responses: Array<{ requirementId: string; value: string }>;
  actorCredentials: Array<{ actorId: string; username: string; password: string }>;
};

type ActorCredentialDraft = { username: string; password: string };

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

function FlowNodeView({
  branchNumber,
  node,
  nodes,
  run,
  stepNumber,
}: {
  branchNumber?: number;
  node: TargetFlowNode;
  nodes: Map<string, TargetFlowNode>;
  run: TargetWorkflowRun;
  stepNumber?: number;
}) {
  const result = run.results[node.id];
  const actor = node.type === 'target' && node.actorId
    ? run.plan?.actors.find((item) => item.id === node.actorId)
    : undefined;
  const hasChildren = node.type !== 'target' && node.children.length > 0;
  const nodeStatus = node.type === 'target' ? (result?.status || 'pending') : node.type;
  const marker = stepNumber ? (
    <span aria-label={`步骤 ${stepNumber}`}>{stepNumber}</span>
  ) : node.type === 'sequence' ? (
    <ListOrdered aria-hidden="true" size={14} />
  ) : node.type === 'parallel' ? (
    <GitBranch aria-hidden="true" size={14} />
  ) : (
    <CircleDot aria-hidden="true" size={14} />
  );

  return (
    <div className={`${styles.flowItem} ${styles[`flow${node.type[0].toUpperCase()}${node.type.slice(1)}`]}`}>
      {branchNumber ? (
        <div className={styles.branchLabel}>
          <span>分支 {String(branchNumber).padStart(2, '0')}</span>
          <small>并行执行</small>
        </div>
      ) : null}
      <div className={styles.flowNodeLayout}>
        <div className={styles.flowRail} aria-hidden="true">
          <span className={styles.flowMarker} data-status={nodeStatus}>{marker}</span>
          {hasChildren ? <span className={styles.flowRailTail} /> : null}
        </div>
        <div className={styles.flowBody}>
          <article className={`${styles.node} ${styles[node.type] || ''}`}>
            <div className={styles.nodeHead}>
              <strong>{node.title}</strong>
              <div className={styles.nodeBadges}>
                {stepNumber ? <span className={styles.stepLabel}>步骤 {String(stepNumber).padStart(2, '0')}</span> : null}
                <span className={styles.nodeType}>{nodeTypeLabel[node.type]}</span>
                {node.type === 'target' ? (
                  <span className={styles.resultStatus} data-status={result?.status || 'pending'}>{resultLabel(result?.status)}</span>
                ) : null}
              </div>
            </div>
            {node.type === 'target' ? (
              <>
                <p className={styles.reason}>{node.objective}</p>
                {actor ? <p className={styles.nodeMeta}>执行账号：{actor.name} · {actor.role}</p> : null}
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
                <h4 className={styles.criteriaTitle}>验收标准与证据要求</h4>
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
                {result?.failureReason ? <p className={styles.failureReason}>失败/阻断原因：{result.failureReason}</p> : null}
                {result?.summary ? <p className={styles.message}>{result.summary}</p> : null}
                {result?.evidence.length ? (
                  <details className={styles.evidence}>
                    <summary>目标证据汇总（{result.evidence.length}）</summary>
                    <EvidenceItems items={result.evidence} />
                  </details>
                ) : null}
              </>
            ) : (
              <>
                {node.description ? <p className={styles.nodeDescription}>{node.description}</p> : null}
                <p className={styles.reason}>{node.relationReason}</p>
                {node.type === 'parallel' && node.maxConcurrency ? <p className={styles.nodeMeta}>最大并发：{node.maxConcurrency}</p> : null}
                {node.type === 'sequence' && node.alwaysRun ? <p className={styles.nodeMeta}>即使前序失败也继续执行</p> : null}
              </>
            )}
          </article>
        </div>

        {node.type === 'sequence' ? (
          <div className={styles.sequenceChildren}>
            {node.children.map((childId, index) => {
              const child = nodes.get(childId);
              return child ? (
                <div className={styles.sequenceStep} key={child.id}>
                  <FlowNodeView node={child} nodes={nodes} run={run} stepNumber={index + 1} />
                </div>
              ) : null;
            })}
          </div>
        ) : null}

        {node.type === 'parallel' ? (
          <div className={styles.parallelChildren}>
            <div className={styles.parallelJunction}><span>同时开始</span></div>
            {node.children.map((childId, index) => {
              const child = nodes.get(childId);
              return child ? (
                <div className={styles.parallelBranch} key={child.id}>
                  <FlowNodeView branchNumber={index + 1} node={child} nodes={nodes} run={run} />
                </div>
              ) : null;
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function actorNeedsCredentialInput(actor: TargetActor) {
  return actor.auth.required
    && actor.auth.status !== 'ready'
    && actor.auth.status !== 'verifying'
    && !actor.auth.credentialsAvailable;
}

function ActorCard({
  actor,
  credentials,
  disabled,
  onCredentialChange,
  showPermissions,
}: {
  actor: TargetActor;
  credentials: ActorCredentialDraft;
  disabled: boolean;
  onCredentialChange: (field: keyof ActorCredentialDraft, value: string) => void;
  showPermissions: boolean;
}) {
  const needsCredentials = actorNeedsCredentialInput(actor);
  const verifying = actor.auth.status === 'verifying' || Boolean(actor.auth.credentialsAvailable && actor.auth.status !== 'ready');
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
      {needsCredentials ? (
        <>
          {actor.auth.status === 'failed' && actor.auth.message ? <p className={styles.authError}>{actor.auth.message}</p> : null}
          <div className={styles.credentialFields}>
            <label>
              <span>登录账号</span>
              <input
                autoComplete="off"
                disabled={disabled}
                name={`target-actor-${actor.id}-username`}
                onChange={(event) => onCredentialChange('username', event.target.value)}
                placeholder="请输入该角色的账号"
                type="text"
                value={credentials.username}
              />
            </label>
            <label>
              <span>登录密码</span>
              <input
                autoComplete="new-password"
                disabled={disabled}
                name={`target-actor-${actor.id}-password`}
                onChange={(event) => onCredentialChange('password', event.target.value)}
                placeholder="请输入密码"
                type="password"
                value={credentials.password}
              />
            </label>
          </div>
          <p className={styles.secretHint}><KeyRound size={12} /> 密码只通过安全引用用于登录，不会写入对话、计划或执行日志。</p>
        </>
      ) : null}
      {actor.auth.required && !needsCredentials && !verifying && actor.auth.status !== 'ready' ? (
        <p className={styles.message}>{actor.auth.message || '账号仍在准备中。'}</p>
      ) : null}
    </li>
  );
}

function RequirementInput({
  disabled,
  onChange,
  question,
  title,
  value,
}: {
  disabled: boolean;
  onChange: (value: string) => void;
  question: string;
  title: string;
  value: string;
}) {
  const multiline = question.length > 72 || question.includes('\n');
  return (
    <li className={styles.requirementInput}>
      <label>
        <strong>{title}</strong>
        <span>{question}</span>
        {multiline ? (
          <textarea
            disabled={disabled}
            onChange={(event) => onChange(event.target.value)}
            placeholder="请填写完整信息"
            rows={3}
            value={value}
          />
        ) : (
          <input
            disabled={disabled}
            onChange={(event) => onChange(event.target.value)}
            placeholder="请输入内容"
            type="text"
            value={value}
          />
        )}
      </label>
    </li>
  );
}

export function BrowserChatTargetRunCard({
  busy,
  onContinue,
  run,
}: {
  busy: boolean;
  onContinue: (payload: TargetContinuePayload) => void | Promise<void>;
  run: TargetWorkflowRun;
}) {
  const [requirementValues, setRequirementValues] = useState<Record<string, string>>({});
  const [actorCredentials, setActorCredentials] = useState<Record<string, ActorCredentialDraft>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const nodes = useMemo(() => new Map((run.plan?.nodes || []).map((node) => [node.id, node])), [run.plan?.nodes]);
  const root = run.plan ? nodes.get(run.plan.rootNodeId) : undefined;
  const unresolved = useMemo(
    () => run.plan?.requirements.filter((item) => item.required && item.status === 'missing') || [],
    [run.plan?.requirements],
  );
  const pendingCredentialActors = useMemo(
    () => run.plan?.actors.filter(actorNeedsCredentialInput) || [],
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
    actor.auth.status === 'verifying' || Boolean(actor.auth.credentialsAvailable && actor.auth.status !== 'ready')
  )) || [];
  const collecting = Boolean(run.plan && (
    run.status === 'collecting_requirements'
    || !run.plan.analysisComplete
    || unresolved.length
  ));
  const processing = busy || submitting || run.status === 'analyzing' || run.status === 'ready' || verifyingActors.length > 0;
  const terminal = ['running', 'summarizing', 'completed', 'cancelled'].includes(run.status);
  const requirementsFilled = normalRequirements.every((item) => Boolean(requirementValues[item.id]?.trim()));
  const credentialsFilled = pendingCredentialActors.every((actor) => {
    const draft = actorCredentials[actor.id];
    return Boolean(draft?.username.trim() && draft.password);
  });
  const canContinue = Boolean(run.plan && !terminal && !processing && requirementsFilled && credentialsFilled);
  const hasInputsToSubmit = normalRequirements.length > 0 || pendingCredentialActors.length > 0;
  const requirementDraftKey = unresolved.map((item) => item.id).join('\u001f');
  const actorDraftKey = (run.plan?.actors || [])
    .filter((actor) => actor.auth.required && actor.auth.status !== 'ready')
    .map((actor) => actor.id)
    .join('\u001f');

  useEffect(() => {
    const missingIds = requirementDraftKey ? requirementDraftKey.split('\u001f') : [];
    setRequirementValues((current) => Object.fromEntries(
      missingIds.map((requirementId) => [requirementId, current[requirementId] || '']),
    ));
    const actorIds = actorDraftKey ? actorDraftKey.split('\u001f') : [];
    setActorCredentials((current) => Object.fromEntries(
      actorIds.map((actorId) => [actorId, { username: current[actorId]?.username || '', password: '' }]),
    ));
    setSubmitError('');
  }, [actorDraftKey, requirementDraftKey, run.id, run.plan?.version]);

  function updateActorCredential(actorId: string, field: keyof ActorCredentialDraft, value: string) {
    setActorCredentials((current) => ({
      ...current,
      [actorId]: { ...(current[actorId] || { username: '', password: '' }), [field]: value },
    }));
  }

  async function continuePlan() {
    if (!canContinue || submitting) return;
    setSubmitting(true);
    setSubmitError('');
    try {
      await onContinue({
        responses: normalRequirements.map((item) => ({
          requirementId: item.id,
          value: requirementValues[item.id].trim(),
        })),
        actorCredentials: pendingCredentialActors.map((actor) => ({
          actorId: actor.id,
          username: actorCredentials[actor.id].username.trim(),
          password: actorCredentials[actor.id].password,
        })),
      });
      setRequirementValues({});
      setActorCredentials((current) => Object.fromEntries(
        Object.entries(current).map(([actorId, value]) => [actorId, { ...value, password: '' }]),
      ));
    } catch (error) {
      setActorCredentials((current) => Object.fromEntries(
        Object.entries(current).map(([actorId, value]) => [actorId, { ...value, password: '' }]),
      ));
      setSubmitError(error instanceof Error ? error.message : '资料提交失败，请检查后重试。');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className={styles.card} aria-label="目标测试计划">
      <header className={styles.header}>
        <div className={styles.heading}>
          <strong>{run.plan?.title || '正在生成目标测试计划'}</strong>
          <span>{run.plan?.requirementSummary || 'AI 正在分析全部需求内容。'}</span>
          {run.plan ? <small>计划第 {run.plan.version} 版 · {collecting ? '正在收集执行资料' : '需求分析已完成'}</small> : null}
        </div>
        <span className={styles.status} data-run-status={run.status}>{runStatusLabel[run.status]}</span>
      </header>

      {run.error ? <p className={styles.runError}>目标分析失败：{run.error}</p> : null}

      {run.status === 'analyzing' || (busy && !submitting) ? (
        <div aria-live="polite" className={styles.processingNotice} role="status">
          <Loader2 className="spin" size={17} />
          <div><strong>AI 正在核对需求与资料</strong><span>完成后会更新需要补充的内容或开始执行。</span></div>
        </div>
      ) : null}

      {run.plan ? (
        <>
          {collecting ? (
            <section className={styles.section}>
              <div className={styles.collectionHeading}>
                <div>
                  <h3>补全执行资料</h3>
                  <p>请一次性填写当前缺失内容。提交后 AI 会重新检查全部需求；仍有缺项时会继续向你确认。</p>
                </div>
                <span>{normalRequirements.length + pendingCredentialActors.length} 项待补充</span>
              </div>
              {normalRequirements.length ? (
                <ul className={styles.requirementForm}>
                  {normalRequirements.map((item) => (
                    <RequirementInput
                      disabled={processing}
                      key={item.id}
                      onChange={(value) => setRequirementValues((current) => ({ ...current, [item.id]: value }))}
                      question={item.question}
                      title={item.title}
                      value={requirementValues[item.id] || ''}
                    />
                  ))}
                </ul>
              ) : null}
              <p className={styles.replyHint}>普通资料也可以直接在下方对话中回复；账号密码请只在卡片内填写，避免进入模型上下文。</p>
            </section>
          ) : null}

          {!collecting && (run.plan.targetUrl || run.plan.assumptions.length || run.plan.risks.length) ? (
            <section className={styles.section}>
              <h3>计划依据与风险</h3>
              {run.plan.targetUrl ? <p className={styles.targetUrl} title={run.plan.targetUrl}>目标地址：{run.plan.targetUrl}</p> : null}
              <div className={styles.planBasis}>
                <PlanTextList items={run.plan.assumptions} label="AI 采用的假设" />
                <PlanTextList items={run.plan.risks} label="已识别风险" />
              </div>
            </section>
          ) : null}

          {!collecting && run.plan.requirements.length ? (
            <section className={styles.section}>
              <h3>执行资料</h3>
              <ul className={styles.requirements}>
                {run.plan.requirements.map((item) => (
                  <li className={`${styles.requirement} ${item.status === 'resolved' ? styles.resolved : ''}`} key={item.id}>
                    <strong>{item.status === 'resolved' ? '✓ ' : ''}{item.title}</strong>
                    <p className={styles.muted}>{item.status === 'resolved' ? item.resolution : item.question}</p>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {run.plan.actors.length ? (
            <section className={styles.section}>
              <h3><LockKeyhole size={14} /> {collecting ? '账号资料' : '账号、角色与权限'}</h3>
              <ul className={styles.actors}>
                {run.plan.actors.map((actor) => (
                  <ActorCard
                    actor={actor}
                    credentials={actorCredentials[actor.id] || { username: '', password: '' }}
                    disabled={processing}
                    key={actor.id}
                    onCredentialChange={(field, value) => updateActorCredential(actor.id, field, value)}
                    showPermissions={!collecting}
                  />
                ))}
              </ul>
            </section>
          ) : null}

          {verifyingActors.length ? (
            <div aria-live="polite" className={styles.verifyingNotice} role="status">
              <Loader2 className="spin" size={15} /> AI 正在验证 {verifyingActors.length} 个账号，验证完成后会自动继续。
            </div>
          ) : null}

          {!collecting && root ? (
            <section className={styles.section}>
              <h3><GitBranch size={14} /> 串并联流程树</h3>
              <div className={styles.tree}>
                <div className={styles.flowStart} aria-label="流程起点">
                  <span className={styles.flowStartMarker}><Play aria-hidden="true" size={11} /></span>
                  <strong>开始</strong>
                </div>
                <span className={styles.flowStartConnector} aria-hidden="true" />
                <FlowNodeView node={root} nodes={nodes} run={run} />
                <span className={styles.flowSummaryConnector} aria-hidden="true" />
                <div className={styles.flowSummary} aria-label="结果汇总">
                  <span className={styles.flowSummaryMarker}><Sparkles aria-hidden="true" size={13} /></span>
                  <div><strong>结果汇总</strong><p>主 AI 汇总全部目标的结论、失败原因与证据。</p></div>
                </div>
              </div>
            </section>
          ) : null}

          {run.summary ? (
            <section className={styles.section}>
              <h3>最终总结</h3>
              <div className={styles.summary}><ReactMarkdown remarkPlugins={[remarkGfm]}>{run.summary}</ReactMarkdown></div>
            </section>
          ) : null}

          {submitError ? <p className={styles.submitError} role="alert">{submitError}</p> : null}

          {!terminal ? (
            <footer className={styles.footer}>
              <div className={styles.footerCopy}>
                <strong>{hasInputsToSubmit ? '提交后由 AI 再次检查' : '执行前进行最后一次检查'}</strong>
                <span>{hasInputsToSubmit ? '如果资料仍不完整，卡片会继续显示新的问题。' : '检查通过后将自动开始执行，无需再次确认。'}</span>
              </div>
              <button className={styles.primary} disabled={!canContinue} onClick={() => void continuePlan()} type="button">
                {processing ? <Loader2 className="spin" size={14} /> : hasInputsToSubmit ? <KeyRound size={14} /> : <Play size={14} />}
                {processing ? '正在检查' : hasInputsToSubmit ? '提交资料并继续' : '重新检查并开始'}
              </button>
            </footer>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
