'use client';

import { FormEvent, useState } from 'react';
import { ImageUp, Loader2, Sparkles, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { RichTextEditor } from '@/components/RichTextEditor';
import { richTextToPlainText } from '@/lib/rich-text';
import type { TestCaseContent } from '@/server/ai/schemas/test-case.schema';

export function NewTestCaseForm({ groupId }: { groupId?: string } = {}) {
  const router = useRouter();
  const [prompt, setPrompt] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [targetUrl, setTargetUrl] = useState('https://www.zhihu.com');
  const [browserMode, setBrowserMode] = useState<TestCaseContent['browserMode']>('default');
  const [imageNames, setImageNames] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');

  async function uploadImage(file: File) {
    setUploading(true);
    setError('');
    const form = new FormData();
    form.append('file', file);
    try {
      const response = await fetch('/api/uploads', { method: 'POST', body: form });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '图片上传失败');
      setImageNames((current) => [...current, data.imageId]);
    } finally {
      setUploading(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!richTextToPlainText(prompt)) {
      setError('请输入测试目标');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/test-cases/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, systemPrompt, targetUrl, browserMode, imageNames, groupId }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '生成失败');
      window.dispatchEvent(new Event('navigation-loading:start'));
      router.push(`/test-cases/${data.testCaseId}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : '生成失败');
    } finally {
      setLoading(false);
    }
  }

  return (
    <form className="form designer-form" onSubmit={submit}>
      <div className="field">
        <label htmlFor="targetUrl">目标地址</label>
        <input className="input" id="targetUrl" onChange={(event) => setTargetUrl(event.target.value)} required value={targetUrl} />
      </div>
      <div className="field">
        <label htmlFor="browserMode">浏览器操作模式</label>
        <select
          className="input"
          id="browserMode"
          value={browserMode}
          onChange={(event) => setBrowserMode(event.target.value as TestCaseContent['browserMode'])}
        >
          <option value="default">默认配置</option>
          <option value="dom">DOM 交互</option>
          <option value="visual-markers">视觉标识</option>
          <option value="visual-coordinate">纯视觉坐标</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor="prompt">测试目标</label>
        <RichTextEditor
          id="prompt"
          onChange={setPrompt}
          placeholder="例如：进入知乎，搜索 gpt，并确认结果页可读"
          value={prompt}
        />
      </div>
      <div className="field">
        <label htmlFor="systemPrompt">AI 操作提示词</label>
        <RichTextEditor
          id="systemPrompt"
          onChange={setSystemPrompt}
          placeholder="例如：遇到级联选择器时，必须逐级展开并选择到叶子节点，不能点击一级选项后就认为完成。"
          value={systemPrompt}
          minHeight={160}
        />
      </div>
      <div className="field">
        <label className="file-label" htmlFor="image">
          <ImageUp size={16} />
          图片上下文
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
        {uploading ? <div className="hint">正在上传图片...</div> : null}
        {imageNames.length ? (
          <div className="upload-list">
            {imageNames.map((name) => (
              <span className="upload-chip" key={name}>
                {name}
                <button aria-label={`移除 ${name}`} onClick={() => setImageNames((current) => current.filter((item) => item !== name))} type="button">
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        ) : null}
      </div>
      {error ? <div className="error">{error}</div> : null}
      <button className="button full-width" disabled={loading || uploading} type="submit">
        {loading ? <Loader2 className="spin" size={16} /> : <Sparkles size={16} />}
        {loading ? '正在生成' : '生成测试用例'}
      </button>
    </form>
  );
}
