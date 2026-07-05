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
import { useI18n } from '@/i18n/I18nProvider';
import { readApiJson } from '@/lib/api-client';
import {
  modelSelectionDiagnosticLabel,
  modelSelectionOptionsForConfig,
  modelSelectionValueForConfig,
  normalizeRuntimeModelConfig,
  parseModelSelectionValue,
  resolveRuntimeModelSelection,
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
  const initialSelection = resolveRuntimeModelSelection(null, { model: initialModel, provider: initialModelProvider });
  const [currentTestCase, setCurrentTestCase] = useState(testCase);
  const [editorActions, setEditorActions] = useState<TestCaseEditorActionState>({ generatingFrame: false, saving: false });
  const [modelProvider, setModelProvider] = useState<ModelProvider>(() => initialSelection.provider);
  const [modelId, setModelId] = useState(() => initialSelection.model);
  const [modelConfig, setModelConfig] = useState<RuntimeModelConfig | null>(null);

  const modelSelection = modelSelectionValueForConfig(modelConfig, { model: modelId, provider: modelProvider });
  const modelSelectionDiagnostic = modelSelectionDiagnosticLabel(modelConfig, { model: modelId, provider: modelProvider });
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
    const nextModel = resolveRuntimeModelSelection(modelConfig, selection);
    setModelProvider(nextModel.provider);
    setModelId(nextModel.model);
  }, [modelConfig]);

  useEffect(() => {
    let alive = true;
    async function loadModelConfig() {
      try {
        const response = await fetch('/api/settings/model', { cache: 'no-store' });
        const data = await readApiJson<any>(response, '加载模型配置失败');
        if (!alive) return;
        const nextConfig = normalizeRuntimeModelConfig(data.config as Partial<RuntimeModelConfig> | undefined);
        if (!nextConfig) return;
        const nextModel = resolveRuntimeModelSelection(nextConfig, {
          model: initialModel,
          provider: initialModelProvider,
        });
        setModelConfig(nextConfig);
        setModelProvider(nextModel.provider);
        setModelId(nextModel.model);
      } catch {
        if (!alive) return;
        const fallback = resolveRuntimeModelSelection(null);
        setModelProvider(fallback.provider);
        setModelId(fallback.model);
      }
    }
    void loadModelConfig();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    setModelId((current) => resolveRuntimeModelSelection(modelConfig, { model: current, provider: modelProvider }).model);
  }, [modelConfig, modelProvider]);

  useEffect(() => {
    if (!initialModelProvider || !initialModel) return;
    const nextModel = resolveRuntimeModelSelection(modelConfig, { model: initialModel, provider: initialModelProvider });
    setModelProvider(nextModel.provider);
    setModelId(nextModel.model);
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
            title={modelSelectionDiagnostic}
            value={modelSelection}
          />
          <button
            aria-label={t('生成内容框架')}
            className="ui-icon-button case-detail-icon-button"
            disabled={editorActions.generatingFrame || editorActions.saving}
            onClick={() => void editorRef.current?.generateFrame()}
            title={t('生成内容框架')}
            type="button"
          >
            {editorActions.generatingFrame ? <Loader2 className="spin" size={16} /> : <Sparkles size={16} />}
          </button>
          <button
            aria-label={t('保存需求')}
            className="ui-icon-button case-detail-icon-button"
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
            className="ui-icon-button ui-icon-button--danger case-detail-icon-button"
            label=""
            onDeleted={variant === 'panel' ? onDeleted : undefined}
            redirectTo={variant === 'page' ? '/dashboard' : undefined}
            testCaseId={currentTestCase.id}
            testCaseTitle={currentTestCase.title}
          />
        </div>
        {variant === 'panel' ? (
          <button aria-label={t('关闭')} className="ui-icon-button case-detail-close-button" onClick={onClose} title={t('关闭')} type="button">
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
