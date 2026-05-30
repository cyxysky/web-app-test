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
    userRequirement: testCase.content.userRequirement || testCase.description,
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
        <label className="wide">
          用户需求
          <RichTextEditor
            id="userRequirement"
            value={draft.userRequirement || draft.description}
            onChange={(value) => update({ userRequirement: value, description: richTextToPlainText(value) })}
            minHeight={260}
          />
        </label>
      </div>

      {error ? <div className="error">{error}</div> : null}
    </section>
  );
}
