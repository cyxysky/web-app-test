'use client';

import { useEffect, useMemo, useState } from 'react';
import { Bug, CheckCircle2, ChevronRight, Eye, Loader2, Maximize2, Minus, PauseCircle, PlayCircle, Plus, Radar, SkipForward, Wrench, X } from 'lucide-react';
import { MarkdownReport } from '@/components/MarkdownReport';
import { RunMetaDrawer } from '@/components/RunMetaDrawer';
import type { RunDebugEvent, StepExecutionResult, TestRunRecord } from '@/server/ai/schemas/test-case.schema';

type ImageItem = { title: string; url: string };
type StepToolCallItem = NonNullable<StepExecutionResult['tools']>[number];

function artifactUrl(filePath?: string) {
  if (!filePath) return undefined;
  const normalized = filePath.replace(/\\/g, '/');
  const marker = '/artifacts/';
  const index = normalized.lastIndexOf(marker);
  if (index < 0) return filePath.startsWith('/api/artifacts/') ? filePath : undefined;
  return `/api/artifacts/${normalized.slice(index + marker.length)}`;
}

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
  const selectedStep = selectedOrLatest(steps, selectedIndex);
  const runningStep = steps.find((step) => step.status === 'running');
  const debugEnabled = Boolean(run.debug?.enabled);
  const manualIntervention = run.control?.manualIntervention;
  const visibleManualIntervention = manualIntervention?.stepIndex === resumePendingStep ? undefined : manualIntervention;
  const canPause = run.status === 'running' || run.status === 'queued';
  const canResumeRun = run.status === 'paused';
  const canContinueBlockedRun = run.status === 'blocked';

  useEffect(() => {
    if (isFinished(run.status) && run.report?.markdown) return;
    if (typeof EventSource !== 'undefined') {
      const events = new EventSource(`/api/runs/${run.id}/events`);
      events.addEventListener('run', (event) => {
        setRun(JSON.parse((event as MessageEvent).data) as TestRunRecord);
      });
      events.addEventListener('error', () => {
        events.close();
      });
      return () => events.close();
    }
    const timer = window.setInterval(async () => {
      const response = await fetch(`/api/runs/${run.id}`, { cache: 'no-store' });
      if (!response.ok) return;
      setRun((await response.json()) as TestRunRecord);
    }, 1200);
    return () => window.clearInterval(timer);
  }, [run.id, run.report?.markdown, run.status]);

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
    const response = await fetch(`/api/runs/${run.id}/skip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stepIndex: selectedStep.index }),
    });
    if (response.ok) setRun(((await response.json()) as { run: TestRunRecord }).run);
  }

  async function pauseRun() {
    if (!canPause) return;
    const response = await fetch(`/api/runs/${run.id}/pause`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stepIndex: runningStep?.index || selectedStep?.index }),
    });
    if (response.ok) setRun(((await response.json()) as { run: TestRunRecord }).run);
  }

  async function resumeRun() {
    if (!canResumeRun) return;
    const response = await fetch(`/api/runs/${run.id}/resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stepIndex: run.control?.pauseStepIndex || runningStep?.index || selectedStep?.index }),
    });
    if (response.ok) setRun(((await response.json()) as { run: TestRunRecord }).run);
  }

  async function continueBlockedRun() {
    if (!canContinueBlockedRun) return;
    const response = await fetch(`/api/runs/${run.id}/continue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    if (response.ok) setRun(((await response.json()) as { run: TestRunRecord }).run);
  }

  async function resumeManualIntervention() {
    if (!manualIntervention) return;
    setResumePendingStep(manualIntervention.stepIndex);
    const response = await fetch(`/api/runs/${run.id}/resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stepIndex: manualIntervention.stepIndex }),
    });
    if (response.ok) setRun(((await response.json()) as { run: TestRunRecord }).run);
    else setResumePendingStep(undefined);
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
            {artifactUrl(visibleManualIntervention.screenshotPath) ? (
              <button className="link-button" onClick={() => openImageByUrl(artifactUrl(visibleManualIntervention.screenshotPath)!)} type="button">
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

      {run.analysis ? (
        <section className="debug-timeline run-analysis-panel">
          <div className="section-head">
            <div>
              <h2>失败自愈与页面变化分析</h2>
              <p>运行结束后自动生成，用于下次优化 prompt 和操作策略。</p>
            </div>
          </div>
          <div className="analysis-grid">
            <div>
              <h3>修复建议</h3>
              <ul>
                {run.analysis.repairSuggestions.map((item, index) => <li key={index}>{item}</li>)}
              </ul>
            </div>
            <div>
              <h3>下次策略</h3>
              <ul>
                {(run.analysis.selfHealing.nextRunStrategy.length ? run.analysis.selfHealing.nextRunStrategy : run.analysis.selfHealing.applied).map((item, index) => <li key={index}>{item}</li>)}
              </ul>
            </div>
            <div className="wide">
              <h3>页面变化检测</h3>
              <ol>
                {run.analysis.pageChanges.map((item) => (
                  <li key={item.stepIndex}>
                    步骤 {item.stepIndex} · {item.changed ? '有变化' : '变化很小'} · {item.changeScore}: {item.summary}
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </section>
      ) : null}

      {run.result?.memory ? (
        <section className="debug-timeline run-memory-panel">
          <div className="section-head">
            <div>
              <h2>运行记忆</h2>
              <p>由所有步骤的原因、观察、发现和异常压缩生成，后续 AI 请求会持续引用。</p>
            </div>
          </div>
          <div className="analysis-grid">
            <div>
              <h3>摘要</h3>
              <p className="memory-summary">{run.result.memory.summary || '暂无摘要'}</p>
            </div>
            <div>
              <h3>累计发现</h3>
              <ul>
                {(run.result.memory.findings.length ? run.result.memory.findings : ['暂无发现']).slice(-12).map((item, index) => <li key={index}>{item}</li>)}
              </ul>
            </div>
            <div className="wide">
              <h3>压缩时间线</h3>
              <ol>
                {run.result.memory.timeline.slice(-20).map((item, index) => <li key={index}>{item}</li>)}
              </ol>
            </div>
          </div>
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
