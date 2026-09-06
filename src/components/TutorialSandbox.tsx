'use client';

import Link from 'next/link';
import { CheckCircle2, FileSearch, RotateCcw, ShieldCheck } from 'lucide-react';
import { FormEvent, useRef, useState } from 'react';
import { useFilePreview } from '@/components/FilePreviewProvider';
import { withWebPilotBasePath } from '@/lib/webpilot-base-path';
import { AppInput } from '@/components/ui/app-input';
import { useI18n } from '@/i18n/I18nProvider';
import { OrbitIcon } from '@/components/OrbitIcon';
import styles from './TutorialSandbox.module.css';

export function TutorialSandbox() {
  const { t } = useI18n();
  const { openFilePreview } = useFilePreview();
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
        <Link href="/browser-chat"><OrbitIcon size={28} />Orbit</Link>
        <span><ShieldCheck size={15} />{t("内置安全演练页")}</span>
      </header>

      <div className={styles.layout}>
        <section className={styles.intro}>
          <span className={styles.kicker}>{t("浏览器操作演练")}</span>
          <h1>{t("练习填写和验证，不接触真实业务数据")}</h1>
          <p>{t("本页数据只存在于当前页面内存中。刷新页面后会清空，也不会发送到服务器。")}</p>
          <ol>
            <li>{t("把姓名填写为“测试用户”")}</li>
            <li>{t("把部门选择为“研发部”")}</li>
            <li>{t("在实时界面中选择一个测试文件")}</li>
            <li>{t("不要点击提交")}</li>
            <li>{t("读取下方状态并确认结果")}</li>
          </ol>
        </section>

        <section className={styles.card} aria-label={t("新手演练表单")}>
          <div className={styles.cardTitle}>
            <div><span>{t("任务 01")}</span><h2>{t("员工信息演练")}</h2></div>
            <strong className={submitted ? styles.submitted : styles.draft}>{t(submitted ? '已提交' : '未提交')}</strong>
          </div>
          <form onSubmit={submit}>
            <label htmlFor="tutorial-name">{t("姓名")}</label>
            <AppInput id="tutorial-name" aria-label={t("姓名")} data-testid="tutorial-name" onChange={(event) => setName(event.target.value)} placeholder={t("请输入姓名")} value={name} />

            <label htmlFor="tutorial-department">{t("部门")}</label>
            <select id="tutorial-department" aria-label={t("部门")} data-testid="tutorial-department" onChange={(event) => setDepartment(event.target.value)} value={department}>
              <option value="">{t("请选择部门")}</option>
              <option value="研发部">{t("研发部")}</option>
              <option value="产品部">{t("产品部")}</option>
              <option value="市场部">{t("市场部")}</option>
            </select>

            <label htmlFor="tutorial-file">{t("测试附件")}</label>
            <input
              aria-describedby="tutorial-file-hint"
              aria-label={t("测试附件")}
              data-testid="tutorial-file"
              id="tutorial-file"
              onChange={(event) => setAttachment(event.currentTarget.files?.[0] ?? null)}
              ref={attachmentInputRef}
              type="file"
            />
            <small className={styles.fileHint} id="tutorial-file-hint">{t("文件只保留在当前页面内存中，不会发送到服务器。")}</small>

            <div className={styles.actions}>
              <button className={styles.reset} onClick={reset} type="button"><RotateCcw size={15} />{t("重置")}</button>
              <button className={styles.submit} type="submit"><CheckCircle2 size={15} />{t("提交演练")}</button>
            </div>
          </form>

          <dl className={styles.status} aria-label={t("表单当前状态")} data-testid="tutorial-status">
            <div><dt>{t("姓名")}</dt><dd>{name || t('未填写')}</dd></div>
            <div><dt>{t("部门")}</dt><dd>{department ? t(department) : t('未选择')}</dd></div>
            <div>
              <dt>{t("测试附件")}</dt>
              <dd title={attachment?.name}>
                {attachment ? (
                  <button onClick={() => openFilePreview({ fileName: attachment.name, mimeType: attachment.type, source: attachment })} type="button">
                    {attachment.name}
                  </button>
                ) : t('未选择')}
              </dd>
            </div>
            <div><dt>{t("提交状态")}</dt><dd>{t(submitted ? '已提交' : '未提交')}</dd></div>
          </dl>
        </section>
      </div>

      <section className={styles.files}>
        <div><span className={styles.kicker}>{t("可选任务")}</span><h2>{t("继续练习文件读取与生成")}</h2><p>{t("下载示例文件后回到对话上传，并让 Orbit 总结内容或生成新的工作簿。")}</p></div>
        <div className={styles.fileLinks}>
          <a data-file-name="Orbit-新手示例.docx" href={withWebPilotBasePath('/api/tutorial/sample/docx')}><FileSearch size={16} />{t("预览 DOCX 示例")}</a>
          <a data-file-name="Orbit-新手示例.xlsx" href={withWebPilotBasePath('/api/tutorial/sample/xlsx')}><FileSearch size={16} />{t("预览 XLSX 示例")}</a>
        </div>
      </section>
    </main>
  );
}
