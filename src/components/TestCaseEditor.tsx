'use client';

import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import { Loader2, Save, Sparkles } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { CustomSelect } from '@/components/CustomSelect';
import { RichTextEditor } from '@/components/RichTextEditor';
import { useI18n } from '@/i18n/I18nProvider';
import { startGlobalLoading, stopGlobalLoading } from '@/lib/global-loading';
import { richTextToPlainText } from '@/lib/rich-text';
import type { ModelProvider, SkillRecord, TestCaseContent, TestCaseRecord } from '@/server/ai/schemas/test-case.schema';
import { readApiJson } from '@/lib/api-client';

export type TestCaseEditorActionState = {
  generatingFrame: boolean;
  saving: boolean;
};

export type TestCaseEditorHandle = {
  generateFrame: () => Promise<void>;
  save: () => Promise<void>;
};

export const TestCaseEditor = forwardRef<TestCaseEditorHandle, {
  model?: string;
  modelProvider?: ModelProvider;
  onActionStateChange?: (state: TestCaseEditorActionState) => void;
  onSaved?: (testCase: TestCaseRecord) => void;
  showSectionActions?: boolean;
  skills: SkillRecord[];
  testCase: TestCaseRecord;
}>(function TestCaseEditor({
  model,
  modelProvider,
  onActionStateChange,
  onSaved,
  showSectionActions = true,
  skills,
  testCase,
}, ref) {
  const { t } = useI18n();
  const router = useRouter();
  const [draft, setDraft] = useState<TestCaseContent>({
    ...testCase.content,
    browserMode: testCase.content.browserMode || 'default',
    isMarked: testCase.content.isMarked ?? true,
    userRequirement: testCase.content.userRequirement || testCase.description,
    systemPrompt: testCase.content.systemPrompt || '',
    skillIds: testCase.content.skillIds || [],
    steps: [],
  });
  const [saving, setSaving] = useState(false);
  const [generatingFrame, setGeneratingFrame] = useState(false);
  const [frameText, setFrameText] = useState(() => (
    testCase.content.taskFrame ? JSON.stringify(testCase.content.taskFrame, null, 2) : ''
  ));
  const [error, setError] = useState('');

  useEffect(() => {
    onActionStateChange?.({ generatingFrame, saving });
  }, [generatingFrame, onActionStateChange, saving]);

  function update(patch: Partial<TestCaseContent>) {
    setDraft((current) => ({ ...current, ...patch }));
  }

  function toggleSkill(skillId: string) {
    setDraft((current) => {
      const selected = new Set(current.skillIds || []);
      if (selected.has(skillId)) selected.delete(skillId);
      else selected.add(skillId);
      return { ...current, skillIds: [...selected] };
    });
  }

  async function save() {
    const plainRequirement = richTextToPlainText(draft.userRequirement || draft.description);
    if (!plainRequirement) {
      setError(t('请输入用户需求'));
      return;
    }
    let taskFrame: TestCaseContent['taskFrame'] | undefined;
    if (frameText.trim()) {
      try {
        const parsed = JSON.parse(frameText);
        taskFrame = parsed || undefined;
      } catch {
        setError(t('内容框架不是合法 JSON，请修正后再保存'));
        return;
      }
    }
    setSaving(true);
    setError('');
    startGlobalLoading(t('正在保存测试需求'));
    try {
      const payload = {
        ...draft,
        taskFrame,
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
      const data = await readApiJson<any>(response, t('保存失败'));
      onSaved?.(data as TestCaseRecord);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('保存失败'));
    } finally {
      setSaving(false);
      stopGlobalLoading();
    }
  }

  async function generateFrame() {
    const plainRequirement = richTextToPlainText(draft.userRequirement || draft.description);
    if (!plainRequirement) {
      setError(t('请输入用户需求后再生成内容框架'));
      return;
    }
    setGeneratingFrame(true);
    setError('');
    startGlobalLoading(t('正在生成内容框架'));
    try {
      const response = await fetch(`/api/test-cases/${testCase.id}/task-frame`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          modelProvider,
          userRequirement: draft.userRequirement || draft.description,
          systemPrompt: draft.systemPrompt || '',
          targetUrl: draft.targetUrl,
        }),
      });
      const data = await readApiJson<any>(response, t('生成内容框架失败'));
      setFrameText(JSON.stringify(data.taskFrame, null, 2));
      update({ taskFrame: data.taskFrame });
    } catch (err) {
      setError(err instanceof Error ? err.message : t('生成内容框架失败'));
    } finally {
      setGeneratingFrame(false);
      stopGlobalLoading();
    }
  }

  useImperativeHandle(ref, () => ({
    generateFrame,
    save,
  }));

  return (
    <section className="content-band test-goal-list">
      <div className="runtime-case-form">
        <label>
          {t('用例标题')}
          <input className="input" value={draft.title} onChange={(event) => update({ title: event.target.value })} />
        </label>
        <label>
          {t('目标地址')}
          <input className="input" value={draft.targetUrl} onChange={(event) => update({ targetUrl: event.target.value })} />
        </label>
        <label>
          {t('浏览器操作模式')}
          <CustomSelect
            value={draft.browserMode || 'default'}
            onChange={(nextValue) => update({ browserMode: nextValue as TestCaseContent['browserMode'] })}
            options={[
              { label: t('默认配置'), value: 'default' },
              { label: t('DOM 交互'), value: 'dom' },
              { label: t('视觉标识'), value: 'visual-markers' },
            ]}
          />
        </label>
        {draft.browserMode === 'visual-markers' ? (
          <label>
            {t('视觉标记截图')}
            <span className="inline-check">
              <input
                type="checkbox"
                checked={draft.isMarked ?? true}
                onChange={(event) => update({ isMarked: event.target.checked })}
              />
              {t('启用截图 marker')}
            </span>
            <span className="hint">{t('关闭后只发送原始截图，并在提示词中加入可交互元素摘要。')}</span>
          </label>
        ) : null}
        <label className="wide">
          Skills
          <div className="skill-picker">
            {skills.length ? skills.map((skill) => (
              <label className="skill-picker-item" key={skill.id} title={skill.description}>
                <input
                  type="checkbox"
                  checked={(draft.skillIds || []).includes(skill.id)}
                  onChange={() => toggleSkill(skill.id)}
                />
                <span>
                  <b>{skill.title}</b>
                  <small>{skill.description}</small>
                </span>
              </label>
            )) : <span className="hint">No skills yet. Generate one from a run record first.</span>}
          </div>
        </label>
        <label className="wide">
          {t('用户需求')}
          <RichTextEditor
            id="userRequirement"
            value={draft.userRequirement || draft.description}
            onChange={(value) => update({ userRequirement: value, description: richTextToPlainText(value) })}
            minHeight={260}
          />
        </label>
        <label className="wide">
          {t('AI 操作提示词')}
          <RichTextEditor
            id="systemPrompt"
            value={draft.systemPrompt || ''}
            onChange={(value) => update({ systemPrompt: value })}
            placeholder={t('例如：遇到级联选择器时，必须逐级展开并选择到叶子节点，不能点击一级选项后就认为完成。')}
            minHeight={180}
          />
        </label>
        <label className="wide">
          {t('AI 内容框架')}
          <textarea
            className="textarea task-frame-json-editor"
            value={frameText}
            onChange={(event) => setFrameText(event.target.value)}
            placeholder={t('点击“生成内容框架”后，可在这里修改 AI 生成的任务框架 JSON。')}
          />
          <span className="hint">{t('该框架会作为运行时 AI 的初始 TaskFrame，并进入最终报告。维度应描述需求内容和测试覆盖轴，不应描述登录状态、阅读进度或生成状态。')}</span>
        </label>
      </div>

      {error ? <div className="error">{error}</div> : null}
    </section>
  );
});
