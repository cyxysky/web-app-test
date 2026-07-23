'use client';

import { FormEvent, useState } from 'react';
import { ImageUp, Loader2, Sparkles, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { RichTextEditor } from '@/components/RichTextEditor';
import { useI18n } from '@/i18n/I18nProvider';
import { startGlobalLoading, stopGlobalLoading } from '@/lib/global-loading';
import { richTextToPlainText } from '@/lib/rich-text';
import type { TestCaseContent } from '@/server/ai/schemas/test-case.schema';
import { readApiJson } from '@/lib/api-client';
import { withWebPilotBasePath } from '@/lib/webpilot-base-path';

type UploadImageResponse = {
  imageId: string;
};

type GenerateTestCaseResponse = {
  testCaseId?: string;
};

export function NewTestCaseForm({
  groupId,
  onCreated,
}: {
  groupId?: string;
  onCreated?: (testCaseId: string) => void;
} = {}) {
  const { t } = useI18n();
  const router = useRouter();
  const [prompt, setPrompt] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [targetUrl, setTargetUrl] = useState('https://www.zhihu.com');
  const browserMode: TestCaseContent['browserMode'] = 'dom';
  const isMarked = false;
  const [imageNames, setImageNames] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');

  async function uploadImage(file: File) {
    setUploading(true);
    setError('');
    startGlobalLoading(t('正在上传图片'));
    const form = new FormData();
    form.append('file', file);
    try {
      const response = await fetch(withWebPilotBasePath('/api/uploads'), { method: 'POST', body: form });
      const data = await readApiJson<UploadImageResponse>(response, t('图片上传失败'));
      setImageNames((current) => [...current, data.imageId]);
    } finally {
      setUploading(false);
      stopGlobalLoading();
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!richTextToPlainText(prompt)) {
      setError(t('请输入测试目标'));
      return;
    }
    setLoading(true);
    setError('');
    startGlobalLoading(t('正在生成测试用例'));
    try {
      const response = await fetch(withWebPilotBasePath('/api/test-cases/generate'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, systemPrompt, targetUrl, browserMode, isMarked, imageNames, groupId }),
      });
      const data = await readApiJson<GenerateTestCaseResponse>(response, t('生成失败'));
      if (typeof data.testCaseId === 'string') onCreated?.(data.testCaseId);
      if (!onCreated) router.push('/dashboard');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('生成失败'));
    } finally {
      setLoading(false);
      stopGlobalLoading();
    }
  }

  return (
    <form className="ui-modal-form" onSubmit={submit}>
      <div className="ui-modal-body form designer-form">
        <div className="field">
          <label htmlFor="targetUrl">{t('目标地址')}</label>
          <input className="input" id="targetUrl" onChange={(event) => setTargetUrl(event.target.value)} required value={targetUrl} />
        </div>
        <div className="field">
          <label htmlFor="prompt">{t('测试目标')}</label>
          <RichTextEditor
            id="prompt"
            onChange={setPrompt}
            placeholder={t('例如：进入知乎，搜索 gpt，并确认结果页可读')}
            value={prompt}
          />
        </div>
        <div className="field">
          <label htmlFor="systemPrompt">{t('AI 操作提示词')}</label>
          <RichTextEditor
            id="systemPrompt"
            onChange={setSystemPrompt}
            placeholder={t('例如：遇到级联选择器时，必须逐级展开并选择到叶子节点，不能点击一级选项后就认为完成。')}
            value={systemPrompt}
            minHeight={160}
          />
        </div>
        <div className="field">
          <label className="file-label" htmlFor="image">
            <ImageUp size={16} />
            {t('图片上下文')}
          </label>
          <input
            className="file-input"
            id="image"
            type="file"
            accept="image/*"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void uploadImage(file).catch((err) => setError(err.message));
            }}
          />
          {uploading ? <div className="hint">{t('正在上传图片...')}</div> : null}
          {imageNames.length ? (
            <div className="upload-list">
              {imageNames.map((name) => (
                <span className="upload-chip" key={name}>
                  {name}
                  <button aria-label={t('移除 {name}', { name })} onClick={() => setImageNames((current) => current.filter((item) => item !== name))} type="button">
                    <X size={12} />
                  </button>
                </span>
              ))}
            </div>
          ) : null}
        </div>
        {error ? <div className="error">{error}</div> : null}
      </div>
      <footer className="ui-modal-footer">
        <button className="ui-button ui-button--primary" disabled={loading || uploading} type="submit">
          {loading ? <Loader2 className="spin" size={16} /> : <Sparkles size={16} />}
          {loading ? t('正在生成') : t('生成测试用例')}
        </button>
      </footer>
    </form>
  );
}
