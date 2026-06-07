'use client';

import { useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, Images, Maximize2, X } from 'lucide-react';
import type { StepExecutionResult, TestRunRecord } from '@/server/ai/schemas/test-case.schema';

type ScreenshotChainPhase = 'before' | 'tool' | 'after';
type ScreenshotChainItem = {
  action: string;
  key: string;
  phase: ScreenshotChainPhase;
  stepIndex: number;
  title: string;
  toolName?: string;
  url: string;
};

function artifactUrl(filePath?: string) {
  if (!filePath) return undefined;
  const normalized = filePath.replace(/\\/g, '/');
  const marker = '/artifacts/';
  const index = normalized.lastIndexOf(marker);
  if (index < 0) return filePath.startsWith('/api/artifacts/') ? filePath : undefined;
  return `/api/artifacts/${normalized.slice(index + marker.length)}`;
}

function isOriginalScreenshot(shot: NonNullable<NonNullable<StepExecutionResult['tools']>[number]['screenshots']>[number]) {
  if (shot.kind === 'marker') return false;
  return !/-markers\.png$/i.test(shot.path.replace(/\\/g, '/'));
}

function addChainItem(items: ScreenshotChainItem[], seen: Set<string>, item: ScreenshotChainItem) {
  const identity = `${item.stepIndex}:${item.phase}:${item.toolName || ''}:${item.url}:${item.title}`;
  if (seen.has(identity)) return;
  seen.add(identity);
  items.push(item);
}

export function collectRunScreenshotChain(run: TestRunRecord) {
  const items: ScreenshotChainItem[] = [];
  const seen = new Set<string>();

  for (const step of run.result?.steps || []) {
    const before = artifactUrl(step.beforeScreenshotPath);
    const after = artifactUrl(step.afterScreenshotPath || step.screenshotPath);
    if (before) {
      addChainItem(items, seen, {
        action: step.action,
        key: `step-${step.index}-before-${before}`,
        phase: 'before',
        stepIndex: step.index,
        title: `步骤 ${step.index} · 操作前`,
        url: before,
      });
    }
    for (const [toolIndex, tool] of (step.tools || []).entries()) {
      for (const [shotIndex, shot] of (tool.screenshots || []).entries()) {
        if (!isOriginalScreenshot(shot)) continue;
        const url = artifactUrl(shot.path);
        if (!url) continue;
        addChainItem(items, seen, {
          action: step.action,
          key: `step-${step.index}-tool-${toolIndex}-${shotIndex}-${url}`,
          phase: 'tool',
          stepIndex: step.index,
          title: `步骤 ${step.index} · ${tool.name} · ${shot.title || `截图 ${shotIndex + 1}`}`,
          toolName: tool.name,
          url,
        });
      }
    }
    if (after) {
      addChainItem(items, seen, {
        action: step.action,
        key: `step-${step.index}-after-${after}`,
        phase: 'after',
        stepIndex: step.index,
        title: `步骤 ${step.index} · 操作后`,
        url: after,
      });
    }
  }

  return items;
}

function compactText(value?: string, max = 120) {
  const text = (value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function phaseLabel(item: ScreenshotChainItem) {
  if (item.phase === 'before') return '操作前';
  if (item.phase === 'after') return '操作后';
  return item.toolName ? `工具截图 · ${item.toolName}` : '工具截图';
}

function nodeLabel(item: ScreenshotChainItem) {
  if (item.phase === 'before') return '前';
  if (item.phase === 'after') return '后';
  return '工具';
}

function ScreenshotChainModal({ items, onClose, title }: { items: ScreenshotChainItem[]; onClose: () => void; title: string }) {
  const [index, setIndex] = useState(0);
  const current = items[index];

  function show(nextIndex: number) {
    setIndex(Math.min(Math.max(nextIndex, 0), items.length - 1));
  }

  if (!current) return null;

  return (
    <div className="modal-overlay" onClick={onClose} role="presentation">
      <section className="screenshot-chain-modal" onClick={(event) => event.stopPropagation()} role="dialog" aria-label="操作截图链">
        <header className="screenshot-chain-modal-head">
          <div className="screenshot-chain-title">
            <Images size={18} />
            <div>
              <h2>{title}</h2>
              <span>{index + 1}/{items.length}</span>
            </div>
          </div>
          <button className="icon-button" onClick={onClose} type="button" aria-label="关闭">
            <X size={18} />
          </button>
        </header>
        <div className="screenshot-chain-modal-toolbar">
          <button className="icon-text-button" disabled={index <= 0} onClick={() => show(index - 1)} type="button" title="上一张">
            <ArrowLeft size={16} />
            <span>上一张</span>
          </button>
          <button className="icon-text-button" disabled={index >= items.length - 1} onClick={() => show(index + 1)} type="button" title="下一张">
            <span>下一张</span>
            <ArrowRight size={16} />
          </button>
          <a className="icon-button" href={current.url} target="_blank" rel="noreferrer" aria-label="打开原图" title="打开原图">
            <Maximize2 size={17} />
          </a>
        </div>
        <button className="screenshot-chain-stage" onClick={() => window.open(current.url, '_blank', 'noopener,noreferrer')} type="button">
          <img alt={current.title} src={current.url} />
        </button>
        <div className="screenshot-chain-caption">
          <span className={`screenshot-chain-phase phase-${current.phase}`}>{phaseLabel(current)}</span>
          <strong>步骤 {current.stepIndex}</strong>
          <span>{compactText(current.action, 140)}</span>
        </div>
        <ol className="screenshot-chain-strip" aria-label="截图链节点">
          {items.map((item, itemIndex) => (
            <li key={item.key}>
              <button
                className={itemIndex === index ? `screenshot-chain-node active phase-${item.phase}` : `screenshot-chain-node phase-${item.phase}`}
                onClick={() => show(itemIndex)}
                title={`${item.title} · ${item.action}`}
                type="button"
              >
                <span>{item.stepIndex}</span>
                <b>{nodeLabel(item)}</b>
              </button>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

export function RunScreenshotChainButton({
  className = 'icon-text-button',
  label = '截图链',
  run,
}: {
  className?: string;
  label?: string;
  run: TestRunRecord;
}) {
  const [open, setOpen] = useState(false);
  const items = useMemo(() => collectRunScreenshotChain(run), [run]);
  const disabled = !items.length;

  return (
    <>
      <button className={className} disabled={disabled} onClick={() => setOpen(true)} type="button" title={disabled ? '暂无截图链' : '查看截图链'}>
        <Images size={14} />
        {label}
      </button>
      {open ? <ScreenshotChainModal items={items} onClose={() => setOpen(false)} title={run.report?.title || `运行 ${run.id}`} /> : null}
    </>
  );
}
