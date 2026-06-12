'use client';

import { useState } from 'react';
import { Database, Loader2, Save } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { startGlobalLoading, stopGlobalLoading } from '@/lib/global-loading';
import type { SiteKnowledgeRecord } from '@/server/ai/schemas/test-case.schema';

type KnowledgeDraft = {
  title: string;
  loginMethods: string;
  pageStructure: string;
  reliableSelectors: string;
  commonFailures: string;
  businessConcepts: string;
  repairHints: string;
  notes: string;
};

function lines(value?: string[]) {
  return (value || []).join('\n');
}

function splitLines(value: string) {
  return value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
}

function createDraft(item?: SiteKnowledgeRecord, targetUrl = ''): KnowledgeDraft {
  return {
    title: item?.title || targetUrl,
    loginMethods: lines(item?.loginMethods),
    pageStructure: lines(item?.pageStructure),
    reliableSelectors: lines(item?.reliableSelectors),
    commonFailures: lines(item?.commonFailures),
    businessConcepts: lines(item?.businessConcepts),
    repairHints: lines(item?.repairHints),
    notes: item?.notes || '',
  };
}

export function SiteKnowledgePanel({
  initialKnowledge,
  targetUrl,
}: {
  initialKnowledge?: SiteKnowledgeRecord;
  targetUrl: string;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState(() => createDraft(initialKnowledge, targetUrl));
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  function update(patch: Partial<KnowledgeDraft>) {
    setDraft((current) => ({ ...current, ...patch }));
  }

  async function save() {
    setSaving(true);
    setNotice('');
    setError('');
    startGlobalLoading('正在保存站点知识');
    try {
      const response = await fetch('/api/site-knowledge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetUrl,
          title: draft.title,
          loginMethods: splitLines(draft.loginMethods),
          pageStructure: splitLines(draft.pageStructure),
          reliableSelectors: splitLines(draft.reliableSelectors),
          commonFailures: splitLines(draft.commonFailures),
          businessConcepts: splitLines(draft.businessConcepts),
          repairHints: splitLines(draft.repairHints),
          notes: draft.notes,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '保存站点知识失败');
      setNotice('已保存，后续运行会自动注入这些站点经验。');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存站点知识失败');
    } finally {
      setSaving(false);
      stopGlobalLoading();
    }
  }

  return (
    <section className="content-band site-knowledge-panel">
      <div className="section-head">
        <div>
          <h2>站点知识库</h2>
          <p>{initialKnowledge ? `已沉淀 ${initialKnowledge.origin}` : '为当前目标地址沉淀可复用执行经验'}</p>
        </div>
        <button className="icon-text-button" disabled={saving} onClick={save} type="button">
          {saving ? <Loader2 className="spin" size={16} /> : <Save size={16} />}
          {saving ? '保存中' : '保存知识'}
        </button>
      </div>

      <div className="site-knowledge-grid">
        <label className="wide">
          站点名称
          <input className="input" value={draft.title} onChange={(event) => update({ title: event.target.value })} />
        </label>
        <label>
          登录方式
          <textarea className="textarea compact" value={draft.loginMethods} onChange={(event) => update({ loginMethods: event.target.value })} />
        </label>
        <label>
          页面结构
          <textarea className="textarea compact" value={draft.pageStructure} onChange={(event) => update({ pageStructure: event.target.value })} />
        </label>
        <label>
          可靠选择器/入口
          <textarea className="textarea compact" value={draft.reliableSelectors} onChange={(event) => update({ reliableSelectors: event.target.value })} />
        </label>
        <label>
          常见失败
          <textarea className="textarea compact" value={draft.commonFailures} onChange={(event) => update({ commonFailures: event.target.value })} />
        </label>
        <label>
          业务概念
          <textarea className="textarea compact" value={draft.businessConcepts} onChange={(event) => update({ businessConcepts: event.target.value })} />
        </label>
        <label>
          修复经验
          <textarea className="textarea compact" value={draft.repairHints} onChange={(event) => update({ repairHints: event.target.value })} />
        </label>
        <label className="wide">
          备注
          <textarea className="textarea compact" value={draft.notes} onChange={(event) => update({ notes: event.target.value })} />
        </label>
      </div>
      <div className="site-knowledge-note">
        <Database size={15} />
        <span>每行一条知识；保存后进入 SQLite，并会随备份/导出一起迁移。</span>
      </div>
      {notice ? <p className="storage-status-note">{notice}</p> : null}
      {error ? <p className="error">{error}</p> : null}
    </section>
  );
}
