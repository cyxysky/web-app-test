'use client';

import { useState } from 'react';
import { Loader2, Save } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { RichTextEditor } from '@/components/RichTextEditor';
import { richTextToPlainText } from '@/lib/rich-text';
import type { TestCaseContent, TestCaseRecord } from '@/server/ai/schemas/test-case.schema';

export function TestCaseEditor({ testCase }: { testCase: TestCaseRecord }) {
  const router = useRouter();
  const [draft, setDraft] = useState<TestCaseContent>({
    ...testCase.content,
    browserMode: testCase.content.browserMode || 'default',
    userRequirement: testCase.content.userRequirement || testCase.description,
    systemPrompt: testCase.content.systemPrompt || '',
    steps: [],
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  function update(patch: Partial<TestCaseContent>) {
    setDraft((current) => ({ ...current, ...patch }));
  }

  async function save() {
    const plainRequirement = richTextToPlainText(draft.userRequirement || draft.description);
    if (!plainRequirement) {
      setError('请输入用户需求');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const payload = {
        ...draft,
        description: plainRequirement,
        testData: {
          ...draft.testData,
          userRequirement: plainRequirement,
        },
        steps: [],
      };
      const response = await fetch(`/api/test-cases/${testCase.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '保存失败');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="content-band test-goal-list">
      <div className="section-head">
        <div>
          <h2>测试需求</h2>
          <p>这里不再预设执行步骤。运行时 AI 会读取当前界面截图和这段需求，自行决定下一步操作，并把实际执行结果记录成步骤。</p>
        </div>
        <button className="icon-text-button" disabled={saving} onClick={save} type="button">
          {saving ? <Loader2 className="spin" size={16} /> : <Save size={16} />}
          {saving ? '保存中' : '保存需求'}
        </button>
      </div>

      <div className="runtime-case-form">
        <label>
          用例标题
          <input className="input" value={draft.title} onChange={(event) => update({ title: event.target.value })} />
        </label>
        <label>
          目标地址
          <input className="input" value={draft.targetUrl} onChange={(event) => update({ targetUrl: event.target.value })} />
        </label>
        <label>
          浏览器操作模式
          <select
            className="input"
            value={draft.browserMode}
            onChange={(event) => update({ browserMode: event.target.value as TestCaseContent['browserMode'] })}
          >
            <option value="default">默认配置</option>
            <option value="dom">DOM 交互</option>
            <option value="visual-markers">视觉标识</option>
            <option value="visual-coordinate">纯视觉坐标</option>
          </select>
        </label>
        <label className="wide">
          用户需求
          <RichTextEditor
            id="userRequirement"
            value={draft.userRequirement || draft.description}
            onChange={(value) => update({ userRequirement: value, description: richTextToPlainText(value) })}
            minHeight={260}
          />
        </label>
        <label className="wide">
          AI 操作提示词
          <RichTextEditor
            id="systemPrompt"
            value={draft.systemPrompt || ''}
            onChange={(value) => update({ systemPrompt: value })}
            placeholder="例如：遇到级联选择器时，必须逐级展开并选择到叶子节点，不能点击一级选项后就认为完成。"
            minHeight={180}
          />
        </label>
      </div>

      {error ? <div className="error">{error}</div> : null}
    </section>
  );
}
