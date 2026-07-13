'use client';

import { useState } from 'react';
import { Info, X } from 'lucide-react';
import { useI18n } from '@/i18n/I18nProvider';
import type { TestRunRecord } from '@/server/ai/schemas/test-case.schema';

export function RunMetaDrawer({ run, testCaseTitle }: { run: TestRunRecord; testCaseTitle: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);

  return (
    <>
      <button className="link-button run-meta-trigger" onClick={() => setOpen(true)} type="button">
        <Info size={16} />
        {t('运行信息')}
      </button>
      {open ? (
        <div className="drawer-overlay" role="presentation" onClick={() => setOpen(false)}>
          <aside className="run-drawer" role="dialog" aria-label={t('运行信息')} onClick={(event) => event.stopPropagation()}>
            <header>
              <div>
                <h2>{t('运行信息')}</h2>
              </div>
              <button className="ui-icon-button" onClick={() => setOpen(false)} type="button" aria-label={t('关闭')}>
                <X size={18} />
              </button>
            </header>
            <dl className="drawer-form-list">
              <div>
                <dt>{t('运行 ID')}</dt>
                <dd>{run.id}</dd>
              </div>
              <div>
                <dt>{t('当前用例')}</dt>
                <dd>{testCaseTitle}</dd>
              </div>
              <div>
                <dt>{t('开始时间')}</dt>
                <dd>{run.startedAt || '-'}</dd>
              </div>
              <div>
                <dt>{t('结束时间')}</dt>
                <dd>{run.endedAt || '-'}</dd>
              </div>
              <div>
                <dt>{t('步骤记录')}</dt>
                <dd>{run.result?.steps.length || 0}</dd>
              </div>
              <div>
                <dt>{t('报告状态')}</dt>
                <dd>{run.report ? t('已生成') : t('生成中')}</dd>
              </div>
            </dl>
          </aside>
        </div>
      ) : null}
    </>
  );
}
