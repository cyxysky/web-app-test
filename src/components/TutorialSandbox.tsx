'use client';

import Link from 'next/link';
import { CheckCircle2, Download, RotateCcw, ShieldCheck } from 'lucide-react';
import { FormEvent, useRef, useState } from 'react';
import { withWebPilotBasePath } from '@/lib/webpilot-base-path';
import styles from './TutorialSandbox.module.css';

export function TutorialSandbox() {
  const [name, setName] = useState('');
  const [department, setDepartment] = useState('');
  const [attachment, setAttachment] = useState<File | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const attachmentInputRef = useRef<HTMLInputElement>(null);

  function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
  }

  function reset() {
    setName('');
    setDepartment('');
    setAttachment(null);
    setSubmitted(false);
    if (attachmentInputRef.current) attachmentInputRef.current.value = '';
  }

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <Link href="/browser-chat">WebPilot</Link>
        <span><ShieldCheck size={15} />内置安全演练页</span>
      </header>

      <div className={styles.layout}>
        <section className={styles.intro}>
          <span className={styles.kicker}>浏览器操作演练</span>
          <h1>练习填写和验证，不接触真实业务数据</h1>
          <p>本页数据只存在于当前页面内存中。刷新页面后会清空，也不会发送到服务器。</p>
          <ol>
            <li>把姓名填写为“测试用户”</li>
            <li>把部门选择为“研发部”</li>
            <li>在实时界面中选择一个测试文件</li>
            <li>不要点击提交</li>
            <li>读取下方状态并确认结果</li>
          </ol>
        </section>

        <section className={styles.card} aria-label="新手演练表单">
          <div className={styles.cardTitle}>
            <div><span>任务 01</span><h2>员工信息演练</h2></div>
            <strong className={submitted ? styles.submitted : styles.draft}>{submitted ? '已提交' : '未提交'}</strong>
          </div>
          <form onSubmit={submit}>
            <label htmlFor="tutorial-name">姓名</label>
            <input id="tutorial-name" aria-label="姓名" data-testid="tutorial-name" onChange={(event) => setName(event.target.value)} placeholder="请输入姓名" value={name} />

            <label htmlFor="tutorial-department">部门</label>
            <select id="tutorial-department" aria-label="部门" data-testid="tutorial-department" onChange={(event) => setDepartment(event.target.value)} value={department}>
              <option value="">请选择部门</option>
              <option value="研发部">研发部</option>
              <option value="产品部">产品部</option>
              <option value="市场部">市场部</option>
            </select>

            <label htmlFor="tutorial-file">测试附件</label>
            <input
              aria-describedby="tutorial-file-hint"
              aria-label="测试附件"
              data-testid="tutorial-file"
              id="tutorial-file"
              onChange={(event) => setAttachment(event.currentTarget.files?.[0] ?? null)}
              ref={attachmentInputRef}
              type="file"
            />
            <small className={styles.fileHint} id="tutorial-file-hint">文件只保留在当前页面内存中，不会发送到服务器。</small>

            <div className={styles.actions}>
              <button className={styles.reset} onClick={reset} type="button"><RotateCcw size={15} />重置</button>
              <button className={styles.submit} type="submit"><CheckCircle2 size={15} />提交演练</button>
            </div>
          </form>

          <dl className={styles.status} aria-label="表单当前状态" data-testid="tutorial-status">
            <div><dt>姓名</dt><dd>{name || '未填写'}</dd></div>
            <div><dt>部门</dt><dd>{department || '未选择'}</dd></div>
            <div><dt>测试附件</dt><dd title={attachment?.name}>{attachment?.name || '未选择'}</dd></div>
            <div><dt>提交状态</dt><dd>{submitted ? '已提交' : '未提交'}</dd></div>
          </dl>
        </section>
      </div>

      <section className={styles.files}>
        <div><span className={styles.kicker}>可选任务</span><h2>继续练习文件读取与生成</h2><p>下载示例文件后回到对话上传，并让 WebPilot 总结内容或生成新的工作簿。</p></div>
        <div className={styles.fileLinks}>
          <a href={withWebPilotBasePath('/api/tutorial/sample/docx')}><Download size={16} />下载 DOCX 示例</a>
          <a href={withWebPilotBasePath('/api/tutorial/sample/xlsx')}><Download size={16} />下载 XLSX 示例</a>
        </div>
      </section>
    </main>
  );
}
