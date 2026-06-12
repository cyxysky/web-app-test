'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Activity, Bug, Camera, CheckCircle2, ChevronRight, Database, Eye, FileSearch, GitBranch, Loader2, Maximize2, Minus, PauseCircle, PlayCircle, Plus, Radar, SkipForward, Wrench, X } from 'lucide-react';
import { MarkdownReport } from '@/components/MarkdownReport';
import { RunMetaDrawer } from '@/components/RunMetaDrawer';
import { RunScreenshotChainButton } from '@/components/RunScreenshotChain';
import { domTreeFromToolCall } from '@/lib/ai-request-inspection';
import { artifactApiUrl as artifactUrl } from '@/lib/artifacts';
import { startGlobalLoading, stopGlobalLoading } from '@/lib/global-loading';
import type { EvidenceGraphRecord, EvidenceIndexItem, RunDebugEvent, StepExecutionResult, TaskFrame, TaskLedgerItem, TestRunRecord } from '@/server/ai/schemas/test-case.schema';

type ImageItem = { title: string; url: string };
type StepToolCallItem = NonNullable<StepExecutionResult['tools']>[number];

function traceUrl(run: TestRunRecord) {
  return artifactUrl(run.result?.tracePath);
}

function isFinished(status: TestRunRecord['status']) {
  return status === 'passed' || status === 'failed' || status === 'blocked';
}

function statusLabel(status: string) {
  return ({ queued: '排队中', running: '运行中', paused: '已暂停', passed: '通过', failed: '失败', blocked: '阻塞' } as Record<string, string>)[status] || status;
}

function StepIcon({ status }: { status: string }) {
  if (status === 'running') return <Loader2 className="spin" size={16} />;
  return <Wrench size={16} />;
}

function selectedOrLatest(steps: StepExecutionResult[], selectedIndex?: number) {
  if (!steps.length) return undefined;
  return steps.find((step) => step.index === selectedIndex) || steps[steps.length - 1];
}

function formatToolInput(input: unknown) {
  if (input === undefined || input === null) return '';
  if (typeof input === 'object' && !Array.isArray(input) && Object.keys(input as Record<string, unknown>).length === 0) return '';
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

function toolStatusLabel(ok?: boolean) {
  if (ok === true) return '成功';
  if (ok === false) return '失败';
  return '执行中';
}

function toolStatusClass(ok?: boolean) {
  if (ok === false) return 'tool-status failed';
  if (ok === undefined) return 'tool-status pending';
  return 'tool-status';
}

function sameDisplayText(a?: string, b?: string) {
  const left = (a || '').replace(/\s+/g, ' ').trim();
  const right = (b || '').replace(/\s+/g, ' ').trim();
  return Boolean(left && right && left === right);
}

function visibleStepObservation(step: StepExecutionResult) {
  const observation = step.observation || step.note || '';
  return sameDisplayText(observation, step.action) ? '' : observation;
}

function compactText(value?: string, max = 120) {
  const text = (value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function percentLabel(value?: number) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'n/a';
  return `${Math.round(value * 100)}%`;
}

function tokenLabel(value?: number) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'n/a';
  if (value >= 1000) return `${Math.round(value / 100) / 10}k`;
  return String(value);
}

function stepToolBadges(step: StepExecutionResult) {
  const badges: Array<{ name: string; count: number; ok?: boolean }> = [];
  for (const tool of step.tools || []) {
    const current = badges.find((badge) => badge.name === tool.name);
    if (current) {
      current.count += 1;
      if (tool.ok === false) current.ok = false;
      else if (current.ok !== false && tool.ok === undefined) current.ok = undefined;
    } else {
      badges.push({ name: tool.name, count: 1, ok: tool.ok });
    }
  }
  return badges;
}

function ledgerKey(item: TaskLedgerItem) {
  return item.id || `${item.dimensionId}:${item.status || ''}:${item.title}`.toLowerCase();
}

function collectRunTaskFrame(run: TestRunRecord) {
  return run.result?.taskFrame || run.result?.steps.map((step) => step.taskFrame || step.workingMemory?.taskFrame).filter(Boolean).at(-1);
}

function collectRunLedgerItems(run: TestRunRecord) {
  const map = new Map<string, TaskLedgerItem>();
  const items = [
    ...(run.result?.ledgerItems || []),
    ...(run.result?.steps || []).flatMap((step) => step.ledgerItems || []),
    ...(run.result?.steps || []).flatMap((step) => step.workingMemory?.ledgerItems || []),
  ];
  for (const item of items) map.set(ledgerKey(item), item);
  return [...map.values()];
}

function dimensionLabel(frame: TaskFrame | undefined, dimensionId: string) {
  return frame?.dimensions.find((dimension) => dimension.id === dimensionId)?.name || dimensionId || '未分组';
}

function ledgerStatusLabel(status?: TaskLedgerItem['status']) {
  return ({
    covered: '已覆盖',
    decision: '结论',
    evidence: '证据',
    finding: '发现',
    issue: '问题',
    question: '疑问',
    risk: '风险',
  } as Record<string, string>)[status || 'finding'] || status || '发现';
}

function ledgerSeverityLabel(severity?: TaskLedgerItem['severity']) {
  return ({
    critical: '严重',
    info: '信息',
    major: '重要',
    minor: '一般',
  } as Record<string, string>)[severity || 'info'] || severity || '信息';
}

function ledgerToneClass(item: TaskLedgerItem) {
  if (item.severity === 'critical') return 'critical';
  if (item.severity === 'major') return 'major';
  if (item.status === 'issue' || item.status === 'risk') return 'warning';
  if (item.status === 'covered') return 'covered';
  return 'neutral';
}

function ledgerCounts(items: TaskLedgerItem[]) {
  return {
    covered: items.filter((item) => item.status === 'covered').length,
    important: items.filter((item) => item.severity === 'critical' || item.severity === 'major').length,
    issue: items.filter((item) => item.status === 'issue').length,
    question: items.filter((item) => item.status === 'question').length,
    risk: items.filter((item) => item.status === 'risk').length,
  };
}

function toolBadgeLabel(badge: { name: string; count: number }) {
  return `${badge.name}${badge.count > 1 ? ` ×${badge.count}` : ''}`;
}

function toolPreviewText(tool: StepToolCallItem, input: string, screenshotCount: number) {
  const parts: string[] = [];
  if (tool.reason) parts.push(`原因：${compactText(tool.reason, 96)}`);
  else if (tool.result) parts.push(`结果：${compactText(tool.result, 96)}`);
  else if (input) parts.push(`参数：${compactText(input, 96)}`);
  if (screenshotCount) parts.push(`${screenshotCount} 张截图`);
  return parts.join(' · ');
}

function formatDetails(details: unknown) {
  if (details === undefined) return '';
  if (typeof details === 'string') return details;
  try {
    return JSON.stringify(details, null, 2);
  } catch {
    return String(details);
  }
}

function collectStepImages(steps: StepExecutionResult[]) {
  const images: ImageItem[] = [];
  for (const step of steps) {
    const before = artifactUrl(step.beforeScreenshotPath);
    const after = artifactUrl(step.afterScreenshotPath || step.screenshotPath);
    if (before) images.push({ title: `Step ${step.index} before screenshot`, url: before });
    if (after) images.push({ title: `Step ${step.index} after screenshot`, url: after });
    for (const tool of step.tools || []) {
      for (const [shotIndex, shot] of (tool.screenshots || []).entries()) {
        const url = artifactUrl(shot.path);
        if (url) images.push({ title: `Step ${step.index} · ${tool.name} · ${shot.title || `visual ${shotIndex + 1}`}`, url });
      }
    }
  }
  return images;
}

function toolScreenshotItems(step: StepExecutionResult, toolIndex: number) {
  const tool = step.tools?.[toolIndex];
  if (!tool?.screenshots?.length) return [];
  const items: ImageItem[] = [];
  for (const [shotIndex, shot] of tool.screenshots.entries()) {
    const url = artifactUrl(shot.path);
    if (url) items.push({ title: shot.title || `${tool.name} visual ${shotIndex + 1}`, url });
  }
  return items;
}

function ToolCallCard({
  expanded,
  index,
  onToggle,
  openImage,
  step,
  tool,
}: {
  expanded: boolean;
  index: number;
  onToggle: () => void;
  openImage: (url: string) => void;
  step: StepExecutionResult;
  tool: StepToolCallItem;
}) {
  const input = formatToolInput(tool.input);
  const screenshots = toolScreenshotItems(step, index);
  const preview = toolPreviewText(tool, input, screenshots.length);
  const domTree = domTreeFromToolCall(tool, step.aiRequest);

  return (
    <li className={expanded ? 'expanded' : undefined}>
      <button className="tool-call-toggle" onClick={onToggle} type="button" aria-expanded={expanded}>
        <span className="tool-call-heading">
          <span className="tool-call-title">
            <strong>{tool.name}</strong>
          </span>
          <span className={toolStatusClass(tool.ok)}>{toolStatusLabel(tool.ok)}</span>
          <ChevronRight className="tool-call-chevron" size={16} />
        </span>
        {preview ? <span className="tool-call-preview">{preview}</span> : null}
      </button>
      {expanded ? (
        <div className="tool-call-details">
          {tool.reason ? (
            <p className="tool-call-reason">
              <span>调用原因</span>
              {tool.reason}
            </p>
          ) : null}
          {input ? (
            <div className="tool-call-block">
              <span>参数</span>
              <code>{input}</code>
            </div>
          ) : null}
          {tool.result ? (
            <div className="tool-call-block">
              <span>结果</span>
              <p>{tool.result}</p>
            </div>
          ) : null}
          {domTree ? (
            <details className="debug-details">
              <summary>模型看到的 DOM 树</summary>
              <pre>{domTree}</pre>
            </details>
          ) : null}
          {screenshots.length ? (
            <div className="tool-shot-grid">
              {screenshots.map((shot) => (
                <button className="tool-shot-button" key={shot.url} onClick={() => openImage(shot.url)} type="button">
                  <img alt={shot.title} src={shot.url} />
                  <span>{shot.title}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function DebugEventRow({ event }: { event: RunDebugEvent }) {
  const details = formatDetails(event.details);

  return (
    <li>
      <div className="debug-row-main">
        <time>{new Date(event.time).toLocaleTimeString()}</time>
        <strong>{event.phase}</strong>
        <span>{event.stepIndex ? `步骤 ${event.stepIndex} · ` : ''}{event.message}</span>
      </div>
      {details ? (
        <details className="debug-details">
          <summary>查看 AI 输出 / 工具详情</summary>
          <pre>{details}</pre>
        </details>
      ) : null}
    </li>
  );
}

function ImageViewer({ images, initialIndex, onClose }: { images: ImageItem[]; initialIndex: number; onClose: () => void }) {
  const [index, setIndex] = useState(initialIndex);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [drag, setDrag] = useState<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null);
  const current = images[index] || images[0];

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  function zoom(nextScale: number) {
    setScale(Math.min(5, Math.max(0.25, nextScale)));
  }

  function show(nextIndex: number) {
    setIndex(Math.min(Math.max(nextIndex, 0), images.length - 1));
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }

  if (!current) return null;

  return (
    <div
      className="fullscreen-image-viewer"
      onClick={onClose}
      onWheel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        zoom(scale + (event.deltaY < 0 ? 0.12 : -0.12));
      }}
      role="presentation"
    >
      <div className="image-viewer-toolbar" onClick={(event) => event.stopPropagation()}>
        <strong>{current.title}</strong>
        <div>
          <button className="icon-button" disabled={index <= 0} onClick={() => show(index - 1)} type="button">上一张</button>
          <span>{index + 1}/{images.length}</span>
          <button className="icon-button" disabled={index >= images.length - 1} onClick={() => show(index + 1)} type="button">下一张</button>
          <button className="icon-button" onClick={() => zoom(scale - 0.25)} type="button" aria-label="缩小"><Minus size={18} /></button>
          <span>{Math.round(scale * 100)}%</span>
          <button className="icon-button" onClick={() => zoom(scale + 0.25)} type="button" aria-label="放大"><Plus size={18} /></button>
          <button className="icon-button" onClick={() => { setScale(1); setOffset({ x: 0, y: 0 }); }} type="button" aria-label="重置"><Maximize2 size={18} /></button>
          <button className="icon-button" onClick={onClose} type="button" aria-label="关闭"><X size={18} /></button>
        </div>
      </div>
      <div className="image-viewer-stage">
        <img
          alt={current.title}
          draggable={false}
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            setDrag({ pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, originX: offset.x, originY: offset.y });
          }}
          onPointerMove={(event) => {
            if (!drag || drag.pointerId !== event.pointerId) return;
            setOffset({ x: drag.originX + event.clientX - drag.startX, y: drag.originY + event.clientY - drag.startY });
          }}
          onPointerUp={() => setDrag(null)}
          src={current.url}
          style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})` }}
        />
      </div>
    </div>
  );
}

function ReportAccordion({ title, items }: { title: string; items: string[] }) {
  return (
    <details className="report-accordion">
      <summary>
        <ChevronRight size={16} />
        <span>{title}</span>
        <b>{items.length}</b>
      </summary>
      <div>
        {items.length ? (
          <ul>
            {items.map((item, index) => <li key={index}>{item}</li>)}
          </ul>
        ) : (
          <p>暂无记录。</p>
        )}
      </div>
    </details>
  );
}

function LedgerItemCard({ frame, item, index }: { frame?: TaskFrame; item: TaskLedgerItem; index: number }) {
  const tone = ledgerToneClass(item);
  const evidence = item.evidence?.slice(0, 4) || [];
  const attributes = item.attributes?.slice(0, 6) || [];
  return (
    <li className={`ledger-item-card ${tone}`}>
      <div className="ledger-item-index">{String(index + 1).padStart(2, '0')}</div>
      <div className="ledger-item-main">
        <div className="ledger-item-title-row">
          <strong>{item.title}</strong>
          <span className={`ledger-pill ${tone}`}>{ledgerStatusLabel(item.status)}</span>
          <span className={`ledger-pill severity-${item.severity || 'info'}`}>{ledgerSeverityLabel(item.severity)}</span>
        </div>
        {item.summary ? <p className="ledger-item-summary">{item.summary}</p> : null}
        <div className="ledger-meta-row">
          <span>{dimensionLabel(frame, item.dimensionId)}</span>
          {item.sourceStep ? <span>Step {item.sourceStep}</span> : null}
          {typeof item.confidence === 'number' ? <span>置信度 {Math.round(item.confidence * 100)}%</span> : null}
        </div>
        {item.expected || item.actual ? (
          <div className="ledger-compare-grid">
            {item.expected ? (
              <div>
                <b>期望</b>
                <p>{item.expected}</p>
              </div>
            ) : null}
            {item.actual ? (
              <div>
                <b>实际</b>
                <p>{item.actual}</p>
              </div>
            ) : null}
          </div>
        ) : null}
        {attributes.length ? (
          <div className="ledger-chip-row">
            {attributes.map((pair, pairIndex) => (
              <span key={`${pair.key}-${pairIndex}`}>{pair.key}: {pair.value}</span>
            ))}
          </div>
        ) : null}
        {evidence.length ? (
          <div className="ledger-evidence-row">
            <b>证据</b>
            {evidence.map((itemEvidence, evidenceIndex) => (
              <span key={`${itemEvidence}-${evidenceIndex}`}>{itemEvidence}</span>
            ))}
          </div>
        ) : null}
      </div>
    </li>
  );
}

function LedgerItemList({ frame, items, limit }: { frame?: TaskFrame; items: TaskLedgerItem[]; limit?: number }) {
  const visibleItems = typeof limit === 'number' ? items.slice(-limit) : items;
  if (!visibleItems.length) return <p className="empty-ledger">暂无结构化台账项</p>;
  return (
    <ul className="ledger-list">
      {visibleItems.map((item, index) => (
        <LedgerItemCard frame={frame} index={index} item={item} key={`${ledgerKey(item)}-${index}`} />
      ))}
    </ul>
  );
}

function LedgerSectionCard({
  defaultOpen = false,
  description,
  frame,
  items,
  limit,
  title,
}: {
  defaultOpen?: boolean;
  description?: string;
  frame?: TaskFrame;
  items: TaskLedgerItem[];
  limit?: number;
  title: string;
}) {
  const counts = ledgerCounts(items);
  const [open, setOpen] = useState(defaultOpen);
  return (
    <details className="ledger-section-card" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        <ChevronRight size={16} />
        <div className="ledger-section-title">
          <strong>{title}</strong>
          {description ? <span>{description}</span> : null}
        </div>
        <div className="ledger-section-counts">
          <span>{items.length} 条</span>
          {counts.important ? <span className="major">{counts.important} 重要</span> : null}
          {counts.issue ? <span>{counts.issue} 问题</span> : null}
          {counts.risk ? <span>{counts.risk} 风险</span> : null}
          {counts.question ? <span>{counts.question} 疑问</span> : null}
        </div>
      </summary>
      <div className="ledger-section-body">
        <LedgerItemList frame={frame} items={items} limit={limit} />
      </div>
    </details>
  );
}

function LedgerPanel({ frame, items }: { frame?: TaskFrame; items: TaskLedgerItem[] }) {
  if (!items.length) return null;
  const grouped = new Map<string, TaskLedgerItem[]>();
  for (const item of items) grouped.set(item.dimensionId || 'general', [...(grouped.get(item.dimensionId || 'general') || []), item]);
  const totals = ledgerCounts(items);
  return (
    <section className="task-ledger-panel">
      <div className="section-head compact">
        <div>
          <h2>结构化台账</h2>
          <p>{items.length} 条由 AI 在执行过程中沉淀的覆盖、发现、问题与风险</p>
        </div>
      </div>
      <div className="ledger-summary-strip">
        <span>全部 {items.length}</span>
        <span>已覆盖 {totals.covered}</span>
        <span>问题 {totals.issue}</span>
        <span>风险 {totals.risk}</span>
        <span>疑问 {totals.question}</span>
        {totals.important ? <span className="major">重要 {totals.important}</span> : null}
      </div>
      <div className="ledger-groups">
        {[...grouped.entries()].map(([dimensionId, dimensionItems]) => (
          <LedgerSectionCard
            defaultOpen={dimensionItems.some((item) => item.severity === 'critical' || item.severity === 'major')}
            description="按执行过程中沉淀的结构化条目汇总"
            frame={frame}
            items={dimensionItems}
            key={dimensionId}
            limit={24}
            title={dimensionLabel(frame, dimensionId)}
          />
        ))}
      </div>
    </section>
  );
}

function DiagnosticMetric({ icon, label, value }: { icon: ReactNode; label: string; value: number | string }) {
  return (
    <div className="diagnostic-metric">
      <span>{icon}</span>
      <div>
        <strong>{value}</strong>
        <p>{label}</p>
      </div>
    </div>
  );
}

function EvidenceIndexRow({ item }: { item: EvidenceIndexItem }) {
  const url = artifactUrl(item.path);
  return (
    <li className="evidence-index-row">
      <div>
        <strong>{item.title}</strong>
        <p>
          {[
            item.stepIndex ? `Step ${item.stepIndex}` : '',
            item.toolName,
            item.kind,
            item.status,
            item.severity,
          ].filter(Boolean).join(' · ')}
        </p>
        {item.summary ? <span>{compactText(item.summary, 180)}</span> : null}
      </div>
      {url ? (
        <a href={url} rel="noreferrer" target="_blank">
          <Eye size={14} />
          Open
        </a>
      ) : null}
    </li>
  );
}

function RunDiagnosticsPanel({ run }: { run: TestRunRecord }) {
  const diagnostics = run.result?.diagnostics;
  const traceEvents = run.result?.traceEvents || [];
  const evidenceIndex = run.result?.evidenceIndex || [];
  if (!diagnostics && !traceEvents.length && !evidenceIndex.length) return null;
  const recentEvents = traceEvents.slice(-16).reverse();
  const evidencePreview = evidenceIndex.slice(-24).reverse();

  return (
    <section className="run-diagnostics-panel">
      <div className="section-head compact">
        <div>
          <h2>运行诊断</h2>
          <p>Trace store、证据索引和运行指标会随每次步骤写入同步刷新</p>
        </div>
      </div>
      <div className="diagnostic-metric-grid">
        <DiagnosticMetric icon={<Activity size={16} />} label="步骤" value={diagnostics?.stepCount ?? run.result?.steps.length ?? 0} />
        <DiagnosticMetric icon={<Wrench size={16} />} label="工具调用" value={diagnostics?.toolCallCount ?? 0} />
        <DiagnosticMetric icon={<Bug size={16} />} label="失败工具" value={diagnostics?.failedToolCallCount ?? 0} />
        <DiagnosticMetric icon={<Camera size={16} />} label="截图证据" value={diagnostics?.screenshotCount ?? evidenceIndex.filter((item) => item.kind === 'screenshot').length} />
        <DiagnosticMetric icon={<Database size={16} />} label="台账项" value={diagnostics?.ledgerItemCount ?? run.result?.ledgerItems?.length ?? 0} />
        <DiagnosticMetric icon={<FileSearch size={16} />} label="Trace 事件" value={diagnostics?.traceEventCount ?? traceEvents.length} />
        <DiagnosticMetric icon={<Activity size={16} />} label="上下文峰值" value={tokenLabel(diagnostics?.maxEstimatedContextTokens)} />
        <DiagnosticMetric icon={<Radar size={16} />} label="最新占用" value={percentLabel(diagnostics?.latestContextBudgetRatio)} />
        <DiagnosticMetric icon={<Minus size={16} />} label="压缩次数" value={diagnostics?.contextCompressionCount ?? 0} />
        <DiagnosticMetric icon={<Plus size={16} />} label="最新图片" value={diagnostics?.latestContextImageCount ?? 0} />
      </div>
      <div className="diagnostic-columns">
        <details className="diagnostic-card" open>
          <summary>
            <ChevronRight size={16} />
            <span>最近 Trace 事件</span>
          </summary>
          {recentEvents.length ? (
            <ol className="trace-event-list">
              {recentEvents.map((event) => (
                <li key={event.id}>
                  <span>{event.type}</span>
                  <div>
                    <strong>{event.phase || event.toolName || event.status || 'event'}</strong>
                    <p>{event.stepIndex ? `Step ${event.stepIndex} · ` : ''}{compactText(event.message, 180)}</p>
                  </div>
                </li>
              ))}
            </ol>
          ) : <p className="empty-ledger">暂无 Trace 事件</p>}
        </details>
        <details className="diagnostic-card" open>
          <summary>
            <ChevronRight size={16} />
            <span>证据索引</span>
          </summary>
          {evidencePreview.length ? (
            <ul className="evidence-index-list">
              {evidencePreview.map((item) => <EvidenceIndexRow item={item} key={item.id} />)}
            </ul>
          ) : <p className="empty-ledger">暂无证据索引</p>}
        </details>
      </div>
    </section>
  );
}

function ContextSummarySection({ title, items }: { title: string; items?: string[] }) {
  return (
    <div className="context-summary-section">
      <strong>{title}</strong>
      {items?.length ? (
        <ul>
          {items.map((item, index) => <li key={`${title}-${index}`}>{item}</li>)}
        </ul>
      ) : <p>无</p>}
    </div>
  );
}

function RunContextSummaryPanel({ run }: { run: TestRunRecord }) {
  const summary = run.result?.contextSummary || run.result?.contextSummaries?.at(-1);
  if (!summary) return null;
  return (
    <section className="run-context-summary-panel">
      <div className="section-head compact">
        <div>
          <h2>结构化上下文摘要</h2>
          <p>v{summary.version} · {summary.source} · 步骤 {summary.sourceStepRange.join(' - ')}</p>
        </div>
      </div>
      <div className="context-summary-grid">
        <ContextSummarySection items={summary.implementationGoal} title="具体实现目标" />
        <ContextSummarySection items={summary.currentImplementationStatus} title="当前实现状态" />
        <ContextSummarySection items={summary.nextExecutionPlan} title="后续执行方案" />
        <ContextSummarySection items={summary.previousSummary} title="对此前的总结" />
        <ContextSummarySection items={summary.ledgerDigest} title="结构化台账摘要" />
        <ContextSummarySection items={summary.evidenceDigest} title="证据索引摘要" />
        <ContextSummarySection items={summary.antiRegressionRules} title="防回退规则" />
        <ContextSummarySection items={summary.currentPageState} title="当前页面状态" />
      </div>
    </section>
  );
}

function RunCoverageMatrixPanel({ run }: { run: TestRunRecord }) {
  const matrix = run.result?.coverageMatrix || [];
  if (!matrix.length) return null;
  return (
    <section className="coverage-matrix-panel">
      <div className="section-head compact">
        <div>
          <h2>覆盖矩阵</h2>
          <p>{matrix.length} 个需求维度，按结构化台账和证据索引自动汇总</p>
        </div>
      </div>
      <div className="coverage-matrix-list">
        {matrix.map((item) => (
          <article className={`coverage-matrix-item ${item.status}`} key={item.dimensionId}>
            <div>
              <strong>{item.dimensionName}</strong>
              <p>{item.latestSummary || item.nextAction || item.dimensionId}</p>
            </div>
            <div className="coverage-matrix-meta">
              <span>{item.status}</span>
              <span>{item.itemCount} 台账</span>
              <span>{item.evidenceItemIds.length} 证据</span>
              {item.latestStep ? <span>Step {item.latestStep}</span> : null}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function graphNodeTypeLabel(type: EvidenceGraphRecord['nodes'][number]['type']) {
  return ({
    evidence: '证据',
    ledger: '台账',
    step: '步骤',
    tool: '工具',
  } as Record<string, string>)[type] || type;
}

function graphEdgeTypeLabel(type: EvidenceGraphRecord['edges'][number]['type']) {
  return ({
    belongs_to: '归属',
    executes: '执行',
    produces: '产生',
    supports: '支撑',
  } as Record<string, string>)[type] || type;
}

function RunEvidenceGraphPanel({ run }: { run: TestRunRecord }) {
  const graph = run.result?.evidenceGraph;
  if (!graph?.nodes.length) return null;

  const nodes = graph.nodes.slice(-120);
  const edges = graph.edges.slice(-160);
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const groupedNodes = new Map<EvidenceGraphRecord['nodes'][number]['type'], EvidenceGraphRecord['nodes']>;
  const edgeCounts = edges.reduce<Record<string, number>>((counts, edge) => {
    counts[edge.type] = (counts[edge.type] || 0) + 1;
    return counts;
  }, {});

  for (const node of nodes) {
    groupedNodes.set(node.type, [...(groupedNodes.get(node.type) || []), node]);
  }

  const visibleEdges = edges.slice(-36).reverse();

  return (
    <section className="evidence-graph-panel">
      <div className="section-head compact">
        <div>
          <h2>证据关系图</h2>
          <p>{graph.nodes.length} 个节点 · {graph.edges.length} 条关系，串联步骤、工具、台账和证据</p>
        </div>
        <GitBranch size={18} />
      </div>
      <div className="evidence-graph-summary">
        {(['step', 'tool', 'ledger', 'evidence'] as const).map((type) => (
          <span key={type}>{graphNodeTypeLabel(type)} {groupedNodes.get(type)?.length || 0}</span>
        ))}
        {Object.entries(edgeCounts).map(([type, count]) => (
          <span key={type}>{graphEdgeTypeLabel(type as EvidenceGraphRecord['edges'][number]['type'])} {count}</span>
        ))}
      </div>
      <div className="evidence-graph-layout">
        <div className="evidence-graph-lanes">
          {(['step', 'tool', 'ledger', 'evidence'] as const).map((type) => {
            const laneNodes = (groupedNodes.get(type) || []).slice(-12).reverse();
            return (
              <div className={`evidence-graph-lane ${type}`} key={type}>
                <strong>{graphNodeTypeLabel(type)}</strong>
                {laneNodes.length ? (
                  <ul>
                    {laneNodes.map((node) => (
                      <li key={node.id}>
                        <span>{node.status || node.type}</span>
                        <b>{node.label}</b>
                        {node.summary ? <p>{compactText(node.summary, 96)}</p> : null}
                      </li>
                    ))}
                  </ul>
                ) : <p className="empty-ledger">暂无节点</p>}
              </div>
            );
          })}
        </div>
        <details className="evidence-graph-edges" open>
          <summary>
            <ChevronRight size={16} />
            <span>最近关系</span>
          </summary>
          {visibleEdges.length ? (
            <ol>
              {visibleEdges.map((edge, index) => {
                const from = nodeById.get(edge.from);
                const to = nodeById.get(edge.to);
                return (
                  <li key={`${edge.from}-${edge.type}-${edge.to}-${index}`}>
                    <span>{graphEdgeTypeLabel(edge.type)}</span>
                    <div>
                      <b>{from?.label || edge.from}</b>
                      <p>{to?.label || edge.to}</p>
                    </div>
                  </li>
                );
              })}
            </ol>
          ) : <p className="empty-ledger">暂无关系</p>}
        </details>
      </div>
    </section>
  );
}

function ReportEvidence({ run }: { run: TestRunRecord }) {
  return (
    <div className="report-evidence">
      <section>
        <h3>运行日志</h3>
        <ReportAccordion title="Console 错误" items={run.result?.consoleErrors || []} />
        <ReportAccordion title="网络异常" items={run.result?.networkErrors || []} />
      </section>
    </div>
  );
}

export function RunProgress({ initialRun, testCaseTitle = '未知用例' }: { initialRun: TestRunRecord; testCaseTitle?: string }) {
  const [run, setRun] = useState(initialRun);
  const [selectedIndex, setSelectedIndex] = useState<number | undefined>(() => initialRun.result?.steps.at(-1)?.index);
  const [imagePreview, setImagePreview] = useState<{ images: ImageItem[]; index: number } | null>(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [requestOpen, setRequestOpen] = useState(false);
  const [expandedToolCards, setExpandedToolCards] = useState<Record<string, boolean>>({});
  const [resumePendingStep, setResumePendingStep] = useState<number | undefined>();
  const steps = useMemo(() => run.result?.steps || [], [run.result?.steps]);
  const allImages = useMemo(() => collectStepImages(steps), [steps]);
  const taskFrame = useMemo(() => collectRunTaskFrame(run), [run]);
  const ledgerItems = useMemo(() => collectRunLedgerItems(run), [run]);
  const selectedStep = selectedOrLatest(steps, selectedIndex);
  const selectedStepLedgerItems = useMemo(() => {
    if (!selectedStep) return [];
    if (selectedStep.ledgerItems?.length) return selectedStep.ledgerItems;
    return (selectedStep.workingMemory?.ledgerItems || []).filter((item) => item.sourceStep === selectedStep.index);
  }, [selectedStep]);
  const runningStep = steps.find((step) => step.status === 'running');
  const debugEnabled = Boolean(run.debug?.enabled);
  const manualIntervention = run.control?.manualIntervention;
  const visibleManualIntervention = manualIntervention?.stepIndex === resumePendingStep ? undefined : manualIntervention;
  const manualInterventionScreenshotUrl = artifactUrl(visibleManualIntervention?.screenshotPath);
  const canPause = run.status === 'running' || run.status === 'queued';
  const canResumeRun = run.status === 'paused';
  const canContinueBlockedRun = run.status === 'blocked';

  useEffect(() => {
    let active = true;
    let events: EventSource | undefined;
    let timer: number | undefined;
    let refreshInFlight: Promise<void> | undefined;

    const stopRealtime = () => {
      active = false;
      if (timer !== undefined) window.clearInterval(timer);
      events?.close();
    };

    const refreshRun = async () => {
      if (refreshInFlight) return refreshInFlight;
      refreshInFlight = (async () => {
        const response = await fetch(`/api/runs/${run.id}`, { cache: 'no-store' });
        if (!response.ok || !active) {
          if (response.status === 404) stopRealtime();
          return;
        }
        const latest = (await response.json()) as TestRunRecord;
        setRun(latest);
        if (isFinished(latest.status) && latest.report?.markdown) stopRealtime();
      })().finally(() => {
        refreshInFlight = undefined;
      });
      return refreshInFlight;
    };

    if (typeof EventSource !== 'undefined') {
      events = new EventSource(`/api/runs/${run.id}/events`);
      events.addEventListener('run', () => {
        void refreshRun();
      });
      events.addEventListener('error', () => {
        void refreshRun();
      });
    }

    timer = window.setInterval(() => {
      void refreshRun();
    }, 1000);
    void refreshRun();

    return stopRealtime;
  }, [run.id]);

  useEffect(() => {
    const latest = steps.at(-1)?.index;
    if (!latest) return;
    setSelectedIndex((current) => current || latest);
  }, [steps]);

  useEffect(() => {
    if (!manualIntervention || manualIntervention.stepIndex !== resumePendingStep) setResumePendingStep(undefined);
  }, [manualIntervention, resumePendingStep]);

  useEffect(() => {
    setRequestOpen(false);
  }, [selectedStep?.index]);

  const progressText = useMemo(() => {
    if (run.status === 'paused') return 'AI 测试已暂停';
    if (!steps.length) return run.status === 'running' ? 'AI 正在启动浏览器' : '暂无执行步骤';
    if (runningStep) return `正在记录步骤 ${runningStep.index}`;
    return `已记录 ${steps.length} 个操作`;
  }, [run.status, runningStep, steps]);

  function openImageByUrl(url: string) {
    const images = allImages.some((image) => image.url === url) ? allImages : [...allImages, { title: '当前截图', url }];
    const index = images.findIndex((image) => image.url === url);
    setImagePreview({ images, index: Math.max(index, 0) });
  }

  function toolCardKey(step: StepExecutionResult, tool: StepToolCallItem, index: number) {
    return `${step.index}:${index}:${tool.name}`;
  }

  function isToolCardExpanded(step: StepExecutionResult, tool: StepToolCallItem, index: number) {
    const key = toolCardKey(step, tool, index);
    return expandedToolCards[key] ?? tool.ok !== true;
  }

  function toggleToolCard(step: StepExecutionResult, tool: StepToolCallItem, index: number) {
    const key = toolCardKey(step, tool, index);
    const current = isToolCardExpanded(step, tool, index);
    setExpandedToolCards((state) => ({ ...state, [key]: !current }));
  }

  async function skipSelectedStep() {
    if (!selectedStep) return;
    startGlobalLoading('正在跳过步骤');
    try {
      const response = await fetch(`/api/runs/${run.id}/skip`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stepIndex: selectedStep.index }),
      });
      if (response.ok) setRun(((await response.json()) as { run: TestRunRecord }).run);
    } finally {
      stopGlobalLoading();
    }
  }

  async function pauseRun() {
    if (!canPause) return;
    startGlobalLoading('正在暂停运行');
    try {
      const response = await fetch(`/api/runs/${run.id}/pause`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stepIndex: runningStep?.index || selectedStep?.index }),
      });
      if (response.ok) setRun(((await response.json()) as { run: TestRunRecord }).run);
    } finally {
      stopGlobalLoading();
    }
  }

  async function resumeRun() {
    if (!canResumeRun) return;
    startGlobalLoading('正在继续运行');
    try {
      const response = await fetch(`/api/runs/${run.id}/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stepIndex: run.control?.pauseStepIndex || runningStep?.index || selectedStep?.index }),
      });
      if (response.ok) setRun(((await response.json()) as { run: TestRunRecord }).run);
    } finally {
      stopGlobalLoading();
    }
  }

  async function continueBlockedRun() {
    if (!canContinueBlockedRun) return;
    startGlobalLoading('正在继续运行');
    try {
      const response = await fetch(`/api/runs/${run.id}/continue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (response.ok) setRun(((await response.json()) as { run: TestRunRecord }).run);
    } finally {
      stopGlobalLoading();
    }
  }

  async function resumeManualIntervention() {
    if (!manualIntervention) return;
    setResumePendingStep(manualIntervention.stepIndex);
    startGlobalLoading('正在恢复人工校验');
    try {
      const response = await fetch(`/api/runs/${run.id}/resume`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stepIndex: manualIntervention.stepIndex }),
      });
      if (response.ok) setRun(((await response.json()) as { run: TestRunRecord }).run);
      else setResumePendingStep(undefined);
    } finally {
      stopGlobalLoading();
    }
  }

  return (
    <div className="test-cockpit">
      <div className="cockpit-toolbar">
        <div style={{ display: "flex", gap: "16px", alignItems: "center" }}>
          <span>{progressText}</span>
          <span>{steps.length} 条操作</span>
          {run.report?.markdown ? (
            <button className="link-button" onClick={() => setReportOpen(true)} type="button">
              查看最终报告
            </button>
          ) : null}
          <RunScreenshotChainButton className="link-button" label="查看截图链" run={run} />
          {isFinished(run.status) ? (
            <a className="link-button" href={`/api/runs/${run.id}/pdf`} target="_blank">
              导出 PDF
            </a>
          ) : null}
          {traceUrl(run) ? (
            <a className="link-button" href={traceUrl(run)} target="_blank">
              下载 Trace
            </a>
          ) : null}
          {isFinished(run.status) && steps.some((step) => step.tools?.some((tool) => tool.ok !== false)) ? (
            <a className="link-button" href={`/api/runs/${run.id}/recorded-flow`} target="_blank">
              导出录制流
            </a>
          ) : null}
          {debugEnabled ? (
            <span className="debug-phase">
              <Bug size={14} />
              {run.debug?.phase || 'debug'}
              {run.debug?.stepIndex ? ` · 步骤 ${run.debug.stepIndex}` : ''}
            </span>
          ) : null}
        </div>
        <div style={{ display: "flex", gap: "16px" }}>
          {canPause ? (
            <button className="link-button" onClick={pauseRun} type="button">
              <PauseCircle size={16} />
              暂停
            </button>
          ) : null}
          {canResumeRun ? (
            <button className="link-button" onClick={resumeRun} type="button">
              <PlayCircle size={16} />
              继续
            </button>
          ) : null}
          {canContinueBlockedRun ? (
            <button className="link-button" onClick={continueBlockedRun} type="button">
              <PlayCircle size={16} />
              继续运行
            </button>
          ) : null}
          <RunMetaDrawer run={run} testCaseTitle={testCaseTitle} />
          <span className={`run-status-large status-${run.status}`}>
            <Radar size={18} />
            {statusLabel(run.status)}
          </span>
        </div>
      </div>

      {visibleManualIntervention ? (
        <div className="manual-intervention-banner">
          <div>
            <strong>需要人工介入</strong>
            <p>{visibleManualIntervention.reason}</p>
          </div>
          <div className="manual-intervention-actions">
            {manualInterventionScreenshotUrl ? (
              <button className="link-button" onClick={() => openImageByUrl(manualInterventionScreenshotUrl)} type="button">
                <Eye size={14} />
                查看当前截图
              </button>
            ) : null}
            <button className="link-button" onClick={resumeManualIntervention} type="button">
              <CheckCircle2 size={16} />
              执行完毕
            </button>
          </div>
        </div>
      ) : null}

      <section className="cockpit-body">
        <aside className="step-rail" aria-label="执行步骤">
          {steps.map((step) => {
            const badges = stepToolBadges(step);
            const visibleBadges = badges.slice(0, 4);
            const hiddenBadgeCount = Math.max(0, badges.length - visibleBadges.length);
            const toolPopover = badges.map(toolBadgeLabel).join(' · ');
            return (
              <button className={selectedStep?.index === step.index ? 'rail-step active' : 'rail-step'} key={step.index} onClick={() => setSelectedIndex(step.index)} type="button">
                <span className="rail-icon"><StepIcon status={step.status} /></span>
                <span className="rail-copy">
                  <strong>{step.action}</strong>
                  <small className="rail-step-meta">
                    <span>步骤 {step.index}</span>
                    {visibleBadges.length ? (
                      <span className="rail-tool-chips" aria-label={`工具：${badges.map((badge) => badge.name).join('、')}`}>
                        {visibleBadges.map((badge) => (
                          <span className={badge.ok === false ? 'rail-tool-chip failed' : 'rail-tool-chip'} key={badge.name}>
                            {toolBadgeLabel(badge)}
                          </span>
                        ))}
                        {hiddenBadgeCount ? <span className="rail-tool-chip muted">+{hiddenBadgeCount}</span> : null}
                      </span>
                    ) : null}
                  </small>
                  {toolPopover ? <span className="rail-tool-popover" role="tooltip">{toolPopover}</span> : null}
                </span>
              </button>
            );
          })}
        </aside>

        <article className="evidence-panel">
          {selectedStep ? (
            <>
              <header className="evidence-title">
                <div>
                  <span className="rail-icon"><StepIcon status={selectedStep.status} /></span>
                  <div>
                    <h3>{selectedStep.action}</h3>
                    <p>步骤 {selectedStep.index}</p>
                  </div>
                </div>
                <div className="evidence-actions">
                  {selectedStep.aiRequest ? (
                    <button className="link-button" onClick={() => setRequestOpen(true)} type="button">
                      <Bug size={14} />
                      查看请求内容
                    </button>
                  ) : null}
                  {selectedStep.status === 'running' ? (
                    <button className="text-danger-button" onClick={skipSelectedStep} type="button">
                      <SkipForward size={15} />
                      跳过当前步骤
                    </button>
                  ) : null}
                </div>
              </header>
              <dl className="evidence-properties">
                <div>
                  <dt>AI 操作</dt>
                  <dd>{selectedStep.action}</dd>
                </div>
                {visibleStepObservation(selectedStep) ? (
                  <div>
                    <dt>页面观察</dt>
                    <dd>{visibleStepObservation(selectedStep)}</dd>
                  </div>
                ) : null}
                <div>
                  <dt>重要发现</dt>
                  <dd>
                    {selectedStep.findings?.length ? (
                      <ul className="compact-bullet-list">
                        {selectedStep.findings.map((item, index) => <li key={index}>{item}</li>)}
                      </ul>
                    ) : (
                      '暂无发现'
                    )}
                  </dd>
                </div>
                <div>
                  <dt>工具调用</dt>
                  <dd>
                    {selectedStep.tools?.length ? (
                      <ol className="tool-call-list">
                        {selectedStep.tools.map((tool, index) => (
                          <ToolCallCard
                            expanded={isToolCardExpanded(selectedStep, tool, index)}
                            index={index}
                            key={`${tool.name}-${index}`}
                            onToggle={() => toggleToolCard(selectedStep, tool, index)}
                            openImage={openImageByUrl}
                            step={selectedStep}
                            tool={tool}
                          />
                        ))}
                      </ol>
                    ) : (
                      '本步未调用浏览器工具'
                    )}
                  </dd>
                </div>
              </dl>
            </>
          ) : (
            <div className="empty-state">等待 AI 写入第一条执行记录。</div>
          )}
        </article>
      </section>

      <LedgerPanel frame={taskFrame} items={ledgerItems} />
      <RunCoverageMatrixPanel run={run} />
      <RunEvidenceGraphPanel run={run} />
      <RunContextSummaryPanel run={run} />
      <RunDiagnosticsPanel run={run} />

      {debugEnabled ? (
        <section className="debug-timeline">
          <div className="section-head"><div><h2>Debug 流程</h2><p>显示 AI 请求响应、工具调用、工具结果和当前卡住阶段。</p></div></div>
          <ol>
            {(run.debug?.events || []).slice(-80).map((event, index) => (
              <DebugEventRow event={event} key={`${event.time}-${index}`} />
            ))}
          </ol>
        </section>
      ) : null}

      {reportOpen && run.report?.markdown ? (
        <div className="modal-overlay" onClick={() => setReportOpen(false)} role="presentation">
          <section className="report-modal" onClick={(event) => event.stopPropagation()} role="dialog" aria-label="最终报告">
            <header>
              <h2>最终报告</h2>
              <button className="icon-button" onClick={() => setReportOpen(false)} type="button" aria-label="关闭"><X size={18} /></button>
            </header>
            <ReportEvidence run={run} />
            <MarkdownReport markdown={run.report.markdown} onImageClick={openImageByUrl} />
          </section>
        </div>
      ) : null}

      {requestOpen && selectedStep?.aiRequest ? (
        <div className="modal-overlay" onClick={() => setRequestOpen(false)} role="presentation">
          <section className="report-modal ai-request-modal" onClick={(event) => event.stopPropagation()} role="dialog" aria-label="AI 请求内容">
            <header>
              <h2>AI 请求内容 · 步骤 {selectedStep.index}</h2>
              <button className="icon-button" onClick={() => setRequestOpen(false)} type="button" aria-label="关闭"><X size={18} /></button>
            </header>
            <pre className="ai-request-pre">{JSON.stringify(selectedStep.aiRequest, null, 2)}</pre>
          </section>
        </div>
      ) : null}

      {imagePreview ? (
        <ImageViewer images={imagePreview.images} initialIndex={imagePreview.index} onClose={() => setImagePreview(null)} />
      ) : null}
    </div>
  );
}
