'use client';

import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Download, Loader2, ShieldCheck, Upload, X } from 'lucide-react';
import { useI18n } from '@/i18n/I18nProvider';
import { readApiJson } from '@/lib/api-client';
import { withWebPilotBasePath } from '@/lib/webpilot-base-path';

type DataTransferKind = 'credentials' | 'skills' | 'memory' | 'model';

type ExportResponse = {
  fileName: string;
  bundle: Record<string, unknown>;
  count: number;
};

type ImportResponse = {
  created: number;
  updated: number;
  total: number;
};

type PassphraseModal = {
  operation: 'export' | 'import';
  bundle?: unknown;
};

const maxImportBytes = 20 * 1024 * 1024;

function downloadJson(fileName: string, value: unknown) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function DataTransferButtons({
  authorizationToken,
  disabled = false,
  kind,
  onImported,
  userId,
}: {
  authorizationToken?: string;
  disabled?: boolean;
  kind: DataTransferKind;
  onImported?: () => Promise<void> | void;
  userId: string;
}) {
  const { t } = useI18n();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [busyOperation, setBusyOperation] = useState<'export' | 'import' | ''>('');
  const [passphraseModal, setPassphraseModal] = useState<PassphraseModal | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [passphraseConfirmation, setPassphraseConfirmation] = useState('');
  const kindLabel = kind === 'credentials'
    ? t('账号密码')
    : kind === 'skills'
      ? 'Skills'
      : kind === 'model' ? t('模型配置') : t('记忆');
  const encryptedTransfer = kind === 'credentials' || kind === 'model';

  async function requestTransfer(body: Record<string, unknown>) {
    const response = await fetch(withWebPilotBasePath('/api/data-transfer'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(authorizationToken ? { Authorization: `Bearer ${authorizationToken}` } : {}),
      },
      body: JSON.stringify({ ...body, kind, userId }),
    });
    return response;
  }

  async function performExport(exportPassphrase?: string) {
    const response = await requestTransfer({ operation: 'export', passphrase: exportPassphrase });
    const data = await readApiJson<ExportResponse>(response, t('导出失败'));
    downloadJson(data.fileName, data.bundle);
  }

  async function performImport(bundle: unknown, importPassphrase?: string) {
    const response = await requestTransfer({ operation: 'import', bundle, passphrase: importPassphrase });
    const data = await readApiJson<ImportResponse>(response, t('导入失败'));
    await onImported?.();
    window.alert(t('已导入 {count} 条{kind}数据（新增 {created}，更新 {updated}）', {
      count: data.total,
      kind: kindLabel,
      created: data.created,
      updated: data.updated,
    }));
  }

  async function exportWithoutPassphrase() {
    setBusyOperation('export');
    try {
      await performExport();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : t('导出失败'));
    } finally {
      setBusyOperation('');
    }
  }

  function beginExport() {
    if (encryptedTransfer) {
      setPassphrase('');
      setPassphraseConfirmation('');
      setPassphraseModal({ operation: 'export' });
      return;
    }
    void exportWithoutPassphrase();
  }

  function beginImport() {
    fileInputRef.current?.click();
  }

  async function handleImportFile(file?: File) {
    if (!file) return;
    try {
      if (file.size > maxImportBytes) throw new Error(t('导入文件不能超过 20 MB'));
      const bundle = JSON.parse(await file.text()) as unknown;
      if (encryptedTransfer) {
        setPassphrase('');
        setPassphraseConfirmation('');
        setPassphraseModal({ operation: 'import', bundle });
        return;
      }
      setBusyOperation('import');
      await performImport(bundle);
    } catch (error) {
      window.alert(error instanceof SyntaxError
        ? t('导入文件不是有效的 JSON')
        : error instanceof Error ? error.message : t('导入失败'));
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
      if (!encryptedTransfer) setBusyOperation('');
    }
  }

  function closePassphraseModal() {
    if (busyOperation) return;
    setPassphraseModal(null);
    setPassphrase('');
    setPassphraseConfirmation('');
  }

  async function submitPassphrase() {
    if (!passphraseModal) return;
    if (passphrase.trim().length < 8) {
      window.alert(t('导出密码至少需要 8 个字符'));
      return;
    }
    if (passphraseModal.operation === 'export' && passphrase !== passphraseConfirmation) {
      window.alert(t('两次输入的密码不一致'));
      return;
    }
    setBusyOperation(passphraseModal.operation);
    try {
      if (passphraseModal.operation === 'export') await performExport(passphrase);
      else await performImport(passphraseModal.bundle, passphrase);
      setPassphraseModal(null);
      setPassphrase('');
      setPassphraseConfirmation('');
    } catch (error) {
      window.alert(error instanceof Error ? error.message : t(passphraseModal.operation === 'export' ? '导出失败' : '导入失败'));
    } finally {
      setBusyOperation('');
    }
  }

  const busy = Boolean(busyOperation);
  return (
    <>
      <div className="data-transfer-buttons">
        <button className="ui-button ui-button--neutral" disabled={disabled || busy} onClick={beginExport} type="button">
          {busyOperation === 'export' ? <Loader2 className="spin" size={15} /> : <Download size={15} />}
          {t('导出')}
        </button>
        <button className="ui-button ui-button--neutral" disabled={disabled || busy} onClick={beginImport} type="button">
          {busyOperation === 'import' ? <Loader2 className="spin" size={15} /> : <Upload size={15} />}
          {t('导入')}
        </button>
      </div>
      <input
        accept="application/json,.json"
        className="data-transfer-file-input"
        onChange={(event) => void handleImportFile(event.target.files?.[0])}
        ref={fileInputRef}
        type="file"
      />
      {passphraseModal ? createPortal((
        <div className="ui-modal-overlay" onMouseDown={closePassphraseModal}>
          <section
            aria-labelledby="data-transfer-passphrase-title"
            aria-modal="true"
            className="ui-modal ui-modal--compact ui-modal--data-transfer"
            onMouseDown={(event) => event.stopPropagation()}
            role="dialog"
          >
            <header className="ui-modal-header">
              <div className="ui-modal-heading">
                <h2 className="ui-modal-title" id="data-transfer-passphrase-title">
                  {t(passphraseModal.operation === 'export' ? '加密导出{kind}' : '解密导入{kind}', { kind: kindLabel })}
                </h2>
                <p className="ui-modal-subtitle">{t('{kind}文件使用 AES-256-GCM 加密，只有输入此密码才能导入。', { kind: kindLabel })}</p>
              </div>
              <button aria-label={t('关闭')} className="ui-icon-button ui-modal-close" disabled={busy} onClick={closePassphraseModal} type="button">
                <X size={16} />
              </button>
            </header>
            <div className="ui-modal-body data-transfer-passphrase-form">
              <div className="data-transfer-security-note">
                <ShieldCheck size={17} />
                <span>{t('导出文件不包含服务器主密钥。请妥善保存此密码，系统无法找回。')}</span>
              </div>
              <label>
                <span>{t('导出文件密码')}</span>
                <input autoComplete={passphraseModal.operation === 'export' ? 'new-password' : 'current-password'} autoFocus className="input" maxLength={1_024} onChange={(event) => setPassphrase(event.target.value)} type="password" value={passphrase} />
              </label>
              {passphraseModal.operation === 'export' ? (
                <label>
                  <span>{t('再次输入密码')}</span>
                  <input autoComplete="new-password" className="input" maxLength={1_024} onChange={(event) => setPassphraseConfirmation(event.target.value)} type="password" value={passphraseConfirmation} />
                </label>
              ) : null}
            </div>
            <footer className="ui-modal-footer">
              <button className="ui-button ui-button--neutral" disabled={busy} onClick={closePassphraseModal} type="button">
                <X size={15} />
                {t('取消')}
              </button>
              <button className="ui-button ui-button--primary" disabled={busy} onClick={() => void submitPassphrase()} type="button">
                {busy ? <Loader2 className="spin" size={15} /> : passphraseModal.operation === 'export' ? <Download size={15} /> : <Upload size={15} />}
                {t(passphraseModal.operation === 'export' ? '导出' : '导入')}
              </button>
            </footer>
          </section>
        </div>
      ), document.body) : null}
    </>
  );
}
