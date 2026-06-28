'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Loader2, Save, Sparkles, X } from 'lucide-react';
import { CustomSelect } from '@/components/CustomSelect';
import { DeleteTestCaseButton } from '@/components/DeleteTestCaseButton';
import { RunDefaultRecordedRunButton } from '@/components/RunDefaultRecordedRunButton';
import { RunHistoryList } from '@/components/RunHistoryList';
import { RunTestButton } from '@/components/RunTestButton';
import {
  TestCaseEditor,
  type TestCaseEditorActionState,
  type TestCaseEditorHandle,
} from '@/components/TestCaseEditor';
import { defaultModelByProvider } from '@/config/settings';
import { useI18n } from '@/i18n/I18nProvider';
import {
  defaultModelForConfig,
  modelSelectionOptionsForConfig,
  modelSelectionValue,
  normalizeModelId,
  normalizeModelProvider,
  parseModelSelectionValue,
  type RuntimeModelConfig,
} from '@/lib/model-selection';
import type { ModelProvider, SkillRecord, TestCaseRecord, TestRunRecord } from '@/server/ai/schemas/test-case.schema';

export function TestCaseDetailWorkspace({
  initialModel,
  initialModelProvider,
  onClose,
  onDeleted,
  onOpenRun,
  onSaved,
  runs,
  skills,
  testCase,
  variant = 'page',
}: {
  initialModel?: string;
  initialModelProvider?: ModelProvider;
  onClose?: () => void;
  onDeleted?: () => void;
  onOpenRun?: (runId: string, testCaseId: string) => void;
  onSaved?: (testCase: TestCaseRecord) => void;
  runs: TestRunRecord[];
  skills: SkillRecord[];
  testCase: TestCaseRecord;
  variant?: 'page' | 'panel';
}) {
  const { t } = useI18n();
  const editorRef = useRef<TestCaseEditorHandle | null>(null);
  const [currentTestCase, setCurrentTestCase] = useState(testCase);
  const [editorActions, setEditorActions] = useState<TestCaseEditorActionState>({ generatingFrame: false, saving: false });
  const [modelProvider, setModelProvider] = useState<ModelProvider>(() => initialModelProvider || 'openrouter');
  const [modelId, setModelId] = useState(() => initialModel || defaultModelByProvider[initialModelProvider || 'openrouter']);
  const [modelConfig, setModelConfig] = useState<RuntimeModelConfig | null>(null);

  const modelSelection = modelSelectionValue(modelProvider, modelId || defaultModelForConfig(modelConfig, modelProvider));
  const modelSelectionOptions = useMemo(() => modelSelectionOptionsForConfig(modelConfig), [modelConfig]);

  useEffect(() => {
    setCurrentTestCase(testCase);
  }, [testCase]);

  const updateEditorActions = useCallback((state: TestCaseEditorActionState) => {
    setEditorActions((current) => (
      current.generatingFrame === state.generatingFrame && current.saving === state.saving ? current : state
    ));
  }, []);

  const changeModelSelection = useCallback((value: string) => {
    const selection = parseModelSelectionValue(value);
    const model = normalizeModelId(selection.model, selection.provider, modelConfig);
    setModelProvider(selection.provider);
    setModelId(model);
  }, [modelConfig]);

  useEffect(() => {
    let alive = true;
    async function loadModelConfig() {
      try {
        const response = await fetch('/api/settings/model', { cache: 'no-store' });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || '加载模型配置失败');
        if (!alive) return;
        const config = data.config as Partial<RuntimeModelConfig> | undefined;
        if (!config?.provider || !config.providers) return;
        const provider = normalizeModelProvider(config.provider);
        const nextConfig: RuntimeModelConfig = {
          provider,
          providers: config.providers,
          updatedAt: config.updatedAt || '',
        };
        setModelConfig(nextConfig);
        setModelProvider(provider);
        setModelId(defaultModelForConfig(nextConfig, provider));
      } catch {
        if (!alive) return;
        setModelProvider('openrouter');
        setModelId(defaultModelByProvider.openrouter);
      }
    }
    void loadModelConfig();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    setModelId((current) => normalizeModelId(current, modelProvider, modelConfig));
  }, [modelConfig, modelProvider]);

  useEffect(() => {
    if (!initialModelProvider || !initialModel) return;
    const provider = normalizeModelProvider(initialModelProvider);
    setModelProvider(provider);
    setModelId(normalizeModelId(initialModel, provider, modelConfig));
  }, [initialModel, initialModelProvider, modelConfig]);

  const handleSaved = useCallback((nextTestCase: TestCaseRecord) => {
    setCurrentTestCase(nextTestCase);
    onSaved?.(nextTestCase);
  }, [onSaved]);

  const handleOpenRun = useCallback((runId: string) => {
    onOpenRun?.(runId, currentTestCase.id);
  }, [currentTestCase.id, onOpenRun]);

  const content = (
    <>
      <header className="case-inline-header">
        {variant === 'panel' ? (
          <></>
        ) : (
          <Link className="ghost-link" href="/dashboard">
            <ArrowLeft size={15} />
            工作台
          </Link>
        )}
        <div className="case-inline-actions">
          <CustomSelect
            className="case-model-select"
            onChange={changeModelSelection}
            options={modelSelectionOptions}
            value={modelSelection}
          />
          <button
            aria-label={t('生成内容框架')}
            className="icon-button case-detail-icon-button"
            disabled={editorActions.generatingFrame || editorActions.saving}
            onClick={() => void editorRef.current?.generateFrame()}
            title={t('生成内容框架')}
            type="button"
          >
            {editorActions.generatingFrame ? <Loader2 className="spin" size={16} /> : <Sparkles size={16} />}
          </button>
          <button
            aria-label={t('保存需求')}
            className="icon-button case-detail-icon-button"
            disabled={editorActions.saving}
            onClick={() => void editorRef.current?.save()}
            title={t('保存需求')}
            type="button"
          >
            {editorActions.saving ? <Loader2 className="spin" size={16} /> : <Save size={16} />}
          </button>
          <RunDefaultRecordedRunButton
            defaultRecordedRunId={currentTestCase.content.defaultRecordedRunId}
            iconOnly
            model={modelId}
            modelProvider={modelProvider}
            onStarted={onOpenRun ? handleOpenRun : undefined}
            testCaseId={currentTestCase.id}
          />
          <RunTestButton iconOnly model={modelId} modelProvider={modelProvider} onStarted={onOpenRun ? handleOpenRun : undefined} testCaseId={currentTestCase.id} />
          <DeleteTestCaseButton
            className="icon-button case-detail-icon-button danger"
            label=""
            onDeleted={variant === 'panel' ? onDeleted : undefined}
            redirectTo={variant === 'page' ? '/dashboard' : undefined}
            testCaseId={currentTestCase.id}
            testCaseTitle={currentTestCase.title}
          />
        </div>
        {variant === 'panel' ? (
          <button aria-label={t('关闭')} className="icon-button case-detail-close-button" onClick={onClose} title={t('关闭')} type="button">
            <X size={17} />
          </button>
        ) : null}
      </header>

      <TestCaseEditor
        model={modelId}
        modelProvider={modelProvider}
        onActionStateChange={updateEditorActions}
        onSaved={handleSaved}
        ref={editorRef}
        showSectionActions={false}
        skills={skills}
        testCase={currentTestCase}
      />

      <section className="content-band run-history-panel">
        <RunHistoryList defaultRecordedRunId={currentTestCase.content.defaultRecordedRunId} onOpenRun={onOpenRun ? handleOpenRun : undefined} runs={runs} testCaseId={currentTestCase.id} />
      </section>
    </>
  );

  return variant === 'panel' ? (
    <section className="case-workspace case-workspace-panel">
      {content}
    </section>
  ) : (
    <main className="case-workspace">
      {content}
    </main>
  );
}
