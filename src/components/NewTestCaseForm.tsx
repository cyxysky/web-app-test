'use client';

import { FormEvent, useState } from 'react';
import { ImageUp, Loader2, Sparkles } from 'lucide-react';
import { useRouter } from 'next/navigation';

export function NewTestCaseForm() {
  const router = useRouter();
  const [prompt, setPrompt] = useState('');
  const [targetUrl, setTargetUrl] = useState('https://example.com');
  const [imageNames, setImageNames] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');

  async function uploadImage(file: File) {
    setUploading(true);
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
    setLoading(true);
    setError('');

    try {
      const response = await fetch('/api/test-cases/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, targetUrl, imageNames }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '生成失败');
      router.push(`/test-cases/${data.testCaseId}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : '生成失败');
    } finally {
      setLoading(false);
    }
  }

  return (
    <form className="form" onSubmit={submit}>
      <div className="field">
        <label htmlFor="targetUrl">目标地址</label>
        <input
          className="input"
          id="targetUrl"
          onChange={(event) => setTargetUrl(event.target.value)}
          placeholder="https://staging.example.com"
          required
          value={targetUrl}
        />
      </div>
      <div className="field">
        <label htmlFor="prompt">测试需求</label>
        <textarea
          className="textarea"
          id="prompt"
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="例如：测试登录、错误密码提示、记住我、登录后的跳转。请尽量写清楚账号、入口和预期结果。"
          required
          value={prompt}
        />
      </div>
      <div className="field">
        <label className="file-label" htmlFor="image">
          <ImageUp size={16} /> 图片上下文
        </label>
        <input
          id="image"
          type="file"
          accept="image/*"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void uploadImage(file).catch((err) => setError(err.message));
          }}
        />
        {uploading ? <div className="meta">正在上传图片...</div> : null}
        {imageNames.length > 0 ? <div className="meta">已上传：{imageNames.join(', ')}</div> : null}
      </div>
      {error ? <div className="error">{error}</div> : null}
      <button className="button" disabled={loading || uploading} type="submit">
        {loading ? <Loader2 className="spin" size={16} /> : <Sparkles size={16} />}
        {loading ? '正在生成' : '生成测试用例'}
      </button>
    </form>
  );
}
