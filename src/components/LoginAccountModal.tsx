'use client';

import { useEffect, useState } from 'react';
import { KeyRound, Loader2, Save, ShieldCheck, X } from 'lucide-react';
import { useI18n } from '@/i18n/I18nProvider';
import { readApiJson } from '@/lib/api-client';
import { withWebPilotBasePath } from '@/lib/webpilot-base-path';
import { AppInput } from '@/components/ui/app-input';
import { AppModal } from '@/components/ui/app-modal';

export type LoginAccountMetadata = {
  id: string;
  userId: string;
  shared: boolean;
  domain: string;
  username: string;
  label: string;
  loginUrl?: string;
  status: 'active' | 'disabled';
  hasPassword: boolean;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  useCount: number;
};

export function loginAccountDomain(value?: string) {
  const text = (value || '').trim();
  if (!text) return '';
  try {
    return new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(text) ? text : `https://${text}`).hostname.toLowerCase();
  } catch {
    return text.toLowerCase().replace(/^https?:\/\//, '').split(/[/:?#]/)[0];
  }
}

export function LoginAccountModal({
  account,
  initialDomain,
  initialLabel,
  initialLoginUrl,
  initialUsername,
  onClose,
  onSaved,
  open,
}: {
  account?: LoginAccountMetadata;
  initialDomain?: string;
  initialLabel?: string;
  initialLoginUrl?: string;
  initialUsername?: string;
  onClose: () => void;
  onSaved: (account: LoginAccountMetadata) => void;
  open: boolean;
}) {
  const { t } = useI18n();
  const [domain, setDomain] = useState('');
  const [label, setLabel] = useState('');
  const [loginUrl, setLoginUrl] = useState('');
  const [password, setPassword] = useState('');
  const [username, setUsername] = useState('');
  const [shared, setShared] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setDomain(account?.domain || loginAccountDomain(initialDomain || initialLoginUrl));
    setLabel(account?.label || initialLabel || '');
    setLoginUrl(account?.loginUrl || initialLoginUrl || '');
    setUsername(account?.username || initialUsername || '');
    setShared(account?.shared === true);
    setPassword('');
    setError('');
  }, [account, initialDomain, initialLabel, initialLoginUrl, initialUsername, open]);

  if (!open) return null;
  const editing = Boolean(account);

  async function save() {
    const normalizedDomain = loginAccountDomain(domain || loginUrl);
    if (!normalizedDomain || !username.trim() || (!editing && !password)) {
      setError(t('请填写默认站点、用户名和密码。'));
      return;
    }
    setSaving(true);
    setError('');
    try {
      const body: Record<string, unknown> = {
        domain: normalizedDomain,
        label: label.trim(),
        loginUrl: loginUrl.trim(),
        status: account?.status || 'active',
        username: username.trim(),
        shared,
      };
      if (password) body.password = password;
      const response = await fetch(withWebPilotBasePath(account ? `/api/login-accounts/${encodeURIComponent(account.id)}` : '/api/login-accounts'), {
        method: account ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await readApiJson<{ account?: LoginAccountMetadata }>(response, t(account ? '更新账号失败' : '保存账号失败'));
      if (!data.account) throw new Error(t('后台没有返回账号信息'));
      setPassword('');
      onSaved(data.account);
      onClose();
    } catch (saveError) {
      setPassword('');
      setError(saveError instanceof Error ? saveError.message : t('保存账号失败'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <AppModal
      ariaLabelledBy="login-account-modal-title"
      dialogClassName="ui-modal ui-modal--form login-account-modal"
      dismissable={!saving}
      keyboardDismissable={!saving}
      onClose={onClose}
      open={open}
      size="wide"
    >
        <header className="ui-modal-header login-account-modal-header">
          <div className="ui-modal-heading ui-modal-heading--with-icon">
            <span className="ui-modal-heading-icon login-account-modal-icon" aria-hidden="true"><ShieldCheck size={18} /></span>
            <div className="ui-modal-heading-copy">
              <h2 className="ui-modal-title" id="login-account-modal-title">{t(editing ? '编辑登录账号' : '新增登录账号')}</h2>
              <p className="ui-modal-subtitle">{t('账号可用于任意站点；默认站点仅用于识别账号和提供登录地址')}</p>
            </div>
          </div>
          <button aria-label={t('关闭')} className="ui-icon-button ui-modal-close" disabled={saving} onClick={onClose} type="button">
            <X size={16} />
          </button>
        </header>

        <div className="ui-modal-body login-account-form">
          <label>
            <span>{t('名称')}</span>
            <AppInput disabled={saving} onChange={(event) => setLabel(event.target.value)} placeholder={t('例如：测试环境管理员')} value={label} />
          </label>
          <label>
            <span>{t('默认站点')}</span>
            <AppInput disabled={saving} onChange={(event) => setDomain(event.target.value)} placeholder="app.example.com" value={domain} />
          </label>
          <label className="wide">
            <span>{t('登录地址')} <small>{t('可选')}</small></span>
            <AppInput disabled={saving} onBlur={() => !domain && setDomain(loginAccountDomain(loginUrl))} onChange={(event) => setLoginUrl(event.target.value)} placeholder="https://app.example.com/login" value={loginUrl} />
          </label>
          <label>
            <span>{t('用户名')}</span>
            <AppInput autoComplete="off" disabled={saving} onChange={(event) => setUsername(event.target.value)} placeholder="admin@example.com" value={username} />
          </label>
          <label>
            <span>{t('密码')} {editing ? <small>{t('留空则不修改')}</small> : null}</span>
            <AppInput autoComplete="new-password" disabled={saving} onChange={(event) => setPassword(event.target.value)} placeholder={t(editing ? '保持原密码' : '输入登录密码')} type="password" value={password} />
          </label>
          <div className="resource-sharing-field wide">
            <div>
              <strong>{t('所有 ID 共享')}</strong>
              <small>{t('其他 ID 可以调用此账号，但只有创建 ID {id} 可以编辑或删除', { id: account?.userId || t('当前用户') })}</small>
            </div>
            <button aria-pressed={shared} className={`settings-toggle${shared ? ' on' : ''}`} disabled={saving} onClick={() => setShared((value) => !value)} type="button">
              <span />
            </button>
          </div>
          <div className="login-account-security-note wide">
            <KeyRound aria-hidden="true" size={14} />
            <span>{t('密码加密保存在本机后台；规划模型只会看到默认站点和用户名，登录时只使用短期安全引用。')}</span>
          </div>
          {error ? <p className="login-account-modal-error wide" role="alert">{t(error)}</p> : null}
        </div>

        <footer className="ui-modal-footer">
          <button className="ui-button ui-button--neutral" disabled={saving} onClick={onClose} type="button">{t('取消')}</button>
          <button className="ui-button ui-button--primary" disabled={saving} onClick={() => void save()} type="button">
            {saving ? <Loader2 className="spin" size={15} /> : <Save size={15} />}
            {t(saving ? '正在保存' : '保存账号')}
          </button>
        </footer>
    </AppModal>
  );
}
