'use client';

import { useEffect, useMemo, useState } from 'react';
import { Bug, CheckCircle2, ChevronRight, Eye, Loader2, Maximize2, Minus, PauseCircle, PlayCircle, Plus, Radar, SkipForward, Wrench, X } from 'lucide-react';
import { MarkdownReport } from '@/components/MarkdownReport';
import { RunMetaDrawer } from '@/components/RunMetaDrawer';
import type { RunDebugEvent, StepExecutionResult, TestRunRecord } from '@/server/ai/schemas/test-case.schema';

type ImageItem = { title: string; url: string };

function artifactUrl(filePath?: string) {
  if (!filePath) return undefined;
  const normalized = filePath.replace(/\\/g, '/');
  const marker = '/artifacts/';
  const index = normalized.lastIndexOf(marker);
  if (index < 0) return filePath.startsWith('/api/artifacts/') ? filePath : undefined;
  return `/api/artifacts/${normalized.slice(index + marker.length)}`;
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
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

function stepToolSummary(step: StepExecutionResult) {
  const tools = step.tools || [];
  if (!tools.length) return '未调用工具';
  return tools.map((tool) => tool.name).join(' · ');
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
    if (before) images.push({ title: `步骤 ${step.index} 执行前截图`, url: before });
    if (after) images.push({ title: `步骤 ${step.index} 执行后截图`, url: after });
  }
  return images;
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

function ReportEvidence({
  run,
  images,
  openImage,
}: {
  run: TestRunRecord;
  images: ImageItem[];
  openImage: (url: string) => void;
}) {
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
  const [resumePendingStep, setResumePendingStep] = useState<number | undefined>();
  const steps = run.result?.steps || [];
  const allImages = collectStepImages(steps);
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

  const before = artifactUrl(selectedStep?.beforeScreenshotPath);
  const after = artifactUrl(selectedStep?.afterScreenshotPath || selectedStep?.screenshotPath);

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
          {steps.map((step) => (
            <button className={selectedStep?.index === step.index ? 'rail-step active' : 'rail-step'} key={step.index} onClick={() => setSelectedIndex(step.index)} type="button">
              <span className="rail-icon"><StepIcon status={step.status} /></span>
              <span className="rail-copy">
                <strong>{step.action}</strong>
                <small>步骤 {step.index} · {stepToolSummary(step)}</small>
              </span>
            </button>
          ))}
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
                <div>
                  <dt>工具调用</dt>
                  <dd>
                    {selectedStep.tools?.length ? (
                      <ol className="tool-call-list">
                        {selectedStep.tools.map((tool, index) => {
                          const input = formatToolInput(tool.input);
                          return (
                            <li key={`${tool.name}-${index}`}>
                              <strong>{tool.name}</strong>
                              {input ? <code>{input}</code> : null}
                            </li>
                          );
                        })}
                      </ol>
                    ) : (
                      '本步未调用浏览器工具'
                    )}
                  </dd>
                </div>
                <div>
                  <dt>执行前截图</dt>
                  <dd>{before ? <button className="link-button" onClick={() => openImageByUrl(before)} type="button"><Eye size={14} />查看</button> : '暂无'}</dd>
                </div>
                <div>
                  <dt>执行后截图</dt>
                  <dd>{after ? <button className="link-button" onClick={() => openImageByUrl(after)} type="button"><Eye size={14} />查看</button> : '暂无'}</dd>
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

      {reportOpen && run.report?.markdown ? (
        <div className="modal-overlay" onClick={() => setReportOpen(false)} role="presentation">
          <section className="report-modal" onClick={(event) => event.stopPropagation()} role="dialog" aria-label="最终报告">
            <header>
              <h2>最终报告</h2>
              <button className="icon-button" onClick={() => setReportOpen(false)} type="button" aria-label="关闭"><X size={18} /></button>
            </header>
            <ReportEvidence run={run} images={allImages} openImage={openImageByUrl} />
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
