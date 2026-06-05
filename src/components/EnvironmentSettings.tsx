'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, Loader2, Plus, Save, Trash2 } from 'lucide-react';
import type { RuntimeEnvRecord } from '@/server/ai/schemas/test-case.schema';

type EnvRow = Pick<RuntimeEnvRecord, 'key' | 'value' | 'enabled' | 'secret'> & {
  readonly?: boolean;
  source?: string;
};

export function EnvironmentSettings() {
  const [items, setItems] = useState<EnvRow[]>([]);
  const [processItems, setProcessItems] = useState<EnvRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    setLoading(true);
    try {
      const response = await fetch('/api/settings/env', { cache: 'no-store' });
      const data = await response.json();
      setItems(data.saved || []);
      setProcessItems(data.process || []);
    } finally {
      setLoading(false);
    }
  }

  function update(index: number, patch: Partial<EnvRow>) {
    setItems((current) => current.map((item, itemIndex) => (itemIndex === index ? { ...item, ...patch } : item)));
  }

  function add(row?: EnvRow) {
    setItems((current) => [
      ...current,
      row || { key: '', value: '', enabled: true, secret: false },
    ]);
  }

  function remove(index: number) {
    setItems((current) => current.filter((_item, itemIndex) => itemIndex !== index));
  }

  async function save() {
    setSaving(true);
    try {
      const response = await fetch('/api/settings/env', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '保存失败');
      setItems(data.saved || []);
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="settings-workspace">
      <header className="settings-header">
        <Link className="ghost-link" href="/dashboard">
          <ArrowLeft size={15} />
          返回工作台
        </Link>
        <div>
          <h1>环境配置</h1>
          <span>保存后会应用到后续测试运行、模型调用、浏览器模式和队列并发。</span>
        </div>
      </header>

      <section className="settings-panel">
        <div className="plain-section-head">
          <div>
            <h2>网页保存的环境变量</h2>
            <span>{items.length} 项</span>
          </div>
          <div className="dashboard-actions">
            <button className="icon-text-button" onClick={() => add()} type="button">
              <Plus size={15} />
              新增
            </button>
            <button className="icon-text-button" disabled={saving} onClick={save} type="button">
              {saving ? <Loader2 className="spin" size={15} /> : <Save size={15} />}
              保存
            </button>
          </div>
        </div>
        {loading ? (
          <div className="empty-state">正在读取配置。</div>
        ) : (
          <div className="env-table">
            {items.map((item, index) => (
              <div className="env-row" key={`${item.key}-${index}`}>
                <input className="input" placeholder="KEY" value={item.key} onChange={(event) => update(index, { key: event.target.value })} />
                <input className="input" placeholder="value" type={item.secret ? 'password' : 'text'} value={item.value} onChange={(event) => update(index, { value: event.target.value })} />
                <label className="inline-check">
                  <input checked={item.enabled} onChange={(event) => update(index, { enabled: event.target.checked })} type="checkbox" />
                  启用
                </label>
                <label className="inline-check">
                  <input checked={Boolean(item.secret)} onChange={(event) => update(index, { secret: event.target.checked })} type="checkbox" />
                  密钥
                </label>
                <button className="icon-button" onClick={() => remove(index)} type="button" aria-label="删除">
                  <Trash2 size={16} />
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="settings-panel">
        <div className="plain-section-head">
          <div>
            <h2>当前进程变量</h2>
            <span>可导入到网页配置后修改保存</span>
          </div>
        </div>
        <div className="process-env-list">
          {processItems.slice(0, 80).map((item) => (
            <button className="process-env-row" disabled={item.readonly} key={item.key} onClick={() => add({ ...item, enabled: true })} type="button">
              <strong>{item.key}</strong>
              <span>{item.secret ? '已隐藏' : item.value}</span>
            </button>
          ))}
        </div>
      </section>
    </main>
  );
}
