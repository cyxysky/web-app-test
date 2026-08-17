'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Clock3, Edit3, Loader2, Plus, Save, Trash2, X } from 'lucide-react';
import { ConfirmDeleteModal } from '@/components/ConfirmDeleteModal';
import { CustomSelect } from '@/components/CustomSelect';
import { DataTransferButtons } from '@/components/DataTransferButtons';
import { LiquidGlassLoader } from '@/components/LiquidGlassLoader';
import { ManagementDataTable } from '@/components/ManagementDataTable';
import { useI18n } from '@/i18n/I18nProvider';
import { useEscapeDismiss } from '@/hooks/useEscapeDismiss';
import { readApiJson } from '@/lib/api-client';
import { startGlobalLoading, stopGlobalLoading } from '@/lib/global-loading';
import { waitForMinimumLoading } from '@/lib/minimum-loading';
import { withWebPilotBasePath } from '@/lib/webpilot-base-path';
import type { SkillRecord } from '@/server/ai/schemas/runtime.schema';

type SkillDraft = {
  shared: boolean;
  title: string;
  description: string;
  domains: string;
  status: SkillRecord['status'];
  triggerPhrases: string;
  details: string;
};

type EditorMode = 'create' | 'edit' | null;

type SkillsListResponse = {
  skills?: SkillRecord[];
};

type SkillMutationResponse = {
  skill?: SkillRecord;
};

const emptyDraft: SkillDraft = {
  shared: false,
  title: '',
  description: '',
  domains: '',
  status: 'ready',
  triggerPhrases: '',
  details: '',
};

function draftFromSkill(skill: SkillRecord): SkillDraft {
  return {
    shared: skill.shared,
    title: skill.title,
    description: skill.description,
    domains: (skill.domains || []).join('\n'),
    status: skill.status,
    triggerPhrases: skill.triggerPhrases.join('\n'),
    details: skill.content.details,
  };
}

function splitList(value: string) {
  return value.split(/[\n,\uFF0C]+/).map((item) => item.trim()).filter(Boolean);
}

function payloadFromDraft(draft: SkillDraft) {
  return {
    shared: draft.shared,
    title: draft.title.trim(),
    description: draft.description.trim(),
    domains: splitList(draft.domains),
    status: draft.status,
    triggerPhrases: splitList(draft.triggerPhrases),
    content: {
      details: draft.details.trim(),
    },
  };
}

function statusLabel(status: SkillRecord['status']) {
  if (status === 'draft') return '草稿';
  if (status === 'disabled') return '停用';
  return '可用';
}

export function SkillsManager({
  onChanged,
  showTitle = true,
  userId = '1',
}: {
  onChanged?: () => void;
  showTitle?: boolean;
  userId?: string;
} = {}) {
  const { t } = useI18n();
  const normalizedUserId = userId.trim() || '1';
  const skillsApiUrl = useCallback((path: string) => withWebPilotBasePath(path), []);
  const [skills, setSkills] = useState<SkillRecord[]>([]);
  const [expandedSkillIds, setExpandedSkillIds] = useState<string[]>([]);
  const [portalReady, setPortalReady] = useState(false);
  const [editorMode, setEditorMode] = useState<EditorMode>(null);
  const [editingSkillId, setEditingSkillId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SkillRecord | null>(null);
  const [draft, setDraft] = useState<SkillDraft>(emptyDraft);
  const [loading, setLoading] = useState(true);
  const loadSequenceRef = useRef(0);
  const [saving, setSaving] = useState(false);
  const [deletingSkillId, setDeletingSkillId] = useState<string | null>(null);

  const loadSkills = useCallback(async () => {
    const loadingSequence = ++loadSequenceRef.current;
    const loadingStartedAt = Date.now();
    setLoading(true);
    try {
      const response = await fetch(skillsApiUrl('/api/skills'), { cache: 'no-store' });
      const data = await readApiJson<SkillsListResponse>(response, t('加载 Skills 失败'));
      setSkills(Array.isArray(data.skills) ? data.skills : []);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : t('加载 Skills 失败'));
    } finally {
      await waitForMinimumLoading(loadingStartedAt);
      if (loadSequenceRef.current === loadingSequence) setLoading(false);
    }
  }, [skillsApiUrl, t]);

  useEffect(() => {
    void loadSkills();
  }, [loadSkills]);

  useEffect(() => {
    setPortalReady(true);
  }, []);

  useEffect(() => {
    if (!editorMode && !deleteTarget) return undefined;
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape' || saving || deletingSkillId) return;
      setEditorMode(null);
      setEditingSkillId(null);
      setDeleteTarget(null);
      setDraft(emptyDraft);
    }
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [deleteTarget, deletingSkillId, editorMode, saving]);

  function update(patch: Partial<SkillDraft>) {
    setDraft((current) => ({ ...current, ...patch }));
  }

  function toggleSkillDetails(skillId: string) {
    setExpandedSkillIds((current) => (
      current.includes(skillId)
        ? current.filter((id) => id !== skillId)
        : [...current, skillId]
    ));
  }

  function expandSkill(skillId: string) {
    setExpandedSkillIds((current) => (current.includes(skillId) ? current : [skillId, ...current]));
  }

  function openCreateSkill() {
    setEditingSkillId(null);
    setDraft(emptyDraft);
    setEditorMode('create');
  }

  function openEditSkill(skill: SkillRecord) {
    if (skill.userId !== normalizedUserId) return;
    setEditingSkillId(skill.id);
    setDraft(draftFromSkill(skill));
    setEditorMode('edit');
  }

  function closeEditorModal() {
    if (saving) return;
    setEditorMode(null);
    setEditingSkillId(null);
    setDraft(emptyDraft);
  }

  useEscapeDismiss(Boolean(editorMode), closeEditorModal);

  function requestDeleteSkill(skill: SkillRecord) {
    if (skill.userId !== normalizedUserId) return;
    setDeleteTarget(skill);
  }

  function closeDeleteModal() {
    if (deletingSkillId) return;
    setDeleteTarget(null);
  }

  async function saveSkill() {
    const payload = payloadFromDraft(draft);
    if (!payload.title) {
      window.alert(t('请输入 Skill 标题'));
      return;
    }
    if (!payload.description) {
      window.alert(t('请输入 Skill 描述'));
      return;
    }
    if (!payload.content.details) {
      window.alert(t('请输入 Skill 详细内容'));
      return;
    }

    const skillId = editingSkillId;
    setSaving(true);
    startGlobalLoading(t('正在保存 Skill'));
    try {
      const response = await fetch(skillsApiUrl(skillId ? `/api/skills/${skillId}` : '/api/skills'), {
        method: skillId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await readApiJson<SkillMutationResponse>(response, t('保存 Skill 失败'));
      if (!data.skill) throw new Error(t('保存 Skill 失败'));
      const saved = data.skill as SkillRecord;
      setSkills((current) => [saved, ...current.filter((skill) => skill.id !== saved.id)]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
      expandSkill(saved.id);
      setEditorMode(null);
      setEditingSkillId(null);
      setDraft(emptyDraft);
      onChanged?.();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : t('保存 Skill 失败'));
    } finally {
      setSaving(false);
      stopGlobalLoading();
    }
  }

  async function confirmDeleteSkill() {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setDeletingSkillId(target.id);
    startGlobalLoading(t('正在删除 Skill'));
    try {
      const response = await fetch(skillsApiUrl(`/api/skills/${target.id}`), { method: 'DELETE' });
      await readApiJson<unknown>(response, t('删除 Skill 失败'));
      setSkills((current) => current.filter((item) => item.id !== target.id));
      setExpandedSkillIds((current) => current.filter((id) => id !== target.id));
      if (editingSkillId === target.id) closeEditorModal();
      setDeleteTarget(null);
      onChanged?.();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : t('删除 Skill 失败'));
    } finally {
      setDeletingSkillId(null);
      stopGlobalLoading();
    }
  }

  const managerActions = (
    <div className="personal-memory-head-actions">
      <DataTransferButtons kind="skills" onImported={loadSkills} />
      <button className="ui-button ui-button--primary" onClick={openCreateSkill} type="button">
        <Plus size={15} />
        {t('新建 Skill')}
      </button>
    </div>
  );

  return (
    <section className={loading ? 'skills-manager is-loading' : 'skills-manager'}>
      {showTitle ? <div className="settings-section-head skills-manager-head">
        <div>
          <h2>{t('Skills 管理')}</h2>
        </div>
        {managerActions}
      </div> : null}

      <div className="skills-manager-layout">
        <div className="skills-manager-list">
          <div className="skills-manager-list-body">
            {loading ? (
              <div className="settings-loading-panel compact" role="status" aria-live="polite" aria-label={t('正在加载 Skills')}>
                <LiquidGlassLoader className="ui-liquid-glass-loader--compact" />
                <div>
                  <h2>{t('正在加载 Skills')}</h2>
                </div>
              </div>
            ) : (
              <ManagementDataTable
                columns={[
                  {
                    key: 'skill',
                    label: t('Skill'),
                    className: 'management-table-primary-column',
                    filter: { getValue: (skill) => [skill.title, skill.description, skill.id], type: 'text' },
                    render: (skill) => {
                      const expanded = expandedSkillIds.includes(skill.id);
                      return (
                        <button
                          aria-expanded={expanded}
                          className="management-table-primary-button"
                          onClick={() => toggleSkillDetails(skill.id)}
                          type="button"
                        >
                          <ChevronDown className={expanded ? 'skills-manager-chevron open' : 'skills-manager-chevron'} size={16} />
                          <span>
                            <strong>{skill.title}</strong>
                            <small>{skill.description || skill.id}</small>
                          </span>
                        </button>
                      );
                    },
                  },
                  {
                    key: 'scope',
                    label: t('适用范围'),
                    className: 'skills-manager-scope-column',
                    filter: {
                      getValue: (skill) => [
                        ...(skill.domains || []),
                        skill.shared ? t('所有 ID 共享') : t('仅创建 ID'),
                      ],
                      type: 'text',
                    },
                    render: (skill) => (
                      <div className="management-table-cell-stack">
                        <span>{skill.domains?.length ? skill.domains.join(' · ') : t('所有域名')}</span>
                        <small>{skill.shared ? t('所有 ID 共享') : t('仅创建 ID')}</small>
                      </div>
                    ),
                  },
                  {
                    key: 'triggers',
                    label: t('触发词'),
                    className: 'skills-manager-trigger-column',
                    filter: { getValue: (skill) => skill.triggerPhrases, type: 'text' },
                    render: (skill) => (
                      skill.triggerPhrases.length ? (
                        <div className="skills-manager-table-triggers">
                          {skill.triggerPhrases.slice(0, 2).map((phrase) => <span key={phrase} title={phrase}>{phrase}</span>)}
                          {skill.triggerPhrases.length > 2 ? <small>+{skill.triggerPhrases.length - 2}</small> : null}
                        </div>
                      ) : <span className="management-table-muted">{t('暂无触发词')}</span>
                    ),
                  },
                  {
                    key: 'status',
                    label: t('状态'),
                    className: 'skills-manager-status-column',
                    filter: {
                      getValue: (skill) => skill.status,
                      options: [
                        { label: t('可用'), value: 'ready' },
                        { label: t('草稿'), value: 'draft' },
                        { label: t('停用'), value: 'disabled' },
                      ],
                      type: 'select',
                    },
                    render: (skill) => <span className={`skill-status status-${skill.status}`}>{t(statusLabel(skill.status))}</span>,
                  },
                  {
                    key: 'updated',
                    label: t('最近更新'),
                    className: 'management-table-date-column',
                    filter: { getValue: (skill) => skill.updatedAt, type: 'datetime' },
                    render: (skill) => <span className="management-table-muted">{new Date(skill.updatedAt).toLocaleString()}</span>,
                  },
                  {
                    key: 'actions',
                    label: t('操作'),
                    className: 'management-table-actions-column',
                    render: (skill) => (
                      <div className="skills-manager-item-actions">
                        {skill.userId === normalizedUserId ? <>
                          <button
                            aria-label={t('编辑 Skill')}
                            className="ui-icon-button"
                            onClick={() => openEditSkill(skill)}
                            title={t('编辑')}
                            type="button"
                          >
                            <Edit3 size={14} />
                          </button>
                          <button
                            aria-label={t('删除 Skill')}
                            className="ui-icon-button ui-icon-button--danger"
                            disabled={deletingSkillId === skill.id}
                            onClick={() => requestDeleteSkill(skill)}
                            title={t('删除')}
                            type="button"
                          >
                            {deletingSkillId === skill.id ? <Loader2 className="spin" size={14} /> : <Trash2 size={14} />}
                          </button>
                        </> : <span className="resource-readonly-label">{t('只读')}</span>}
                      </div>
                    ),
                  },
                ]}
                emptyText={t('暂无 Skills')}
                getId={(skill) => skill.id}
                getSearchText={(skill) => [
                  skill.title,
                  skill.description,
                  ...(skill.domains || []),
                  ...skill.triggerPhrases,
                  skill.content.details,
                  t(statusLabel(skill.status)),
                  skill.shared ? t('所有 ID 共享') : t('仅创建 ID'),
                  skill.userId,
                ]}
                items={skills}
                renderExpandedRow={(skill) => expandedSkillIds.includes(skill.id) ? (
                    <div className="skills-manager-item-detail">
                      <div className="skills-manager-item-intro">
                        <p className="skills-manager-item-description">{skill.description || skill.id}</p>
                        <div className="skills-manager-chip-row">
                          <em className={`skill-status status-${skill.status}`}>{t(statusLabel(skill.status))}</em>
                          {skill.shared ? <em className="resource-shared-badge">{skill.userId === normalizedUserId ? t('所有 ID 共享') : t('ID {id} 共享', { id: skill.userId })}</em> : null}
                        </div>
                      </div>

                      <div className="skills-manager-section-grid">
                        <div className="skills-manager-section">
                          <div>
                            <h4>{t('触发词')}</h4>
                            <span>{skill.triggerPhrases.length}</span>
                          </div>
                          <div className="skills-manager-trigger-list">
                            {skill.triggerPhrases.length ? skill.triggerPhrases.map((phrase) => (
                              <span key={phrase}>{phrase}</span>
                            )) : <p className="skills-manager-muted">{t('暂无触发词')}</p>}
                          </div>
                        </div>

                        <div className="skills-manager-section">
                          <div>
                            <h4>{t('详细内容')}</h4>
                          </div>
                          {skill.content.details
                            ? <div className="skills-manager-details">{skill.content.details}</div>
                            : <p className="skills-manager-muted">{t('暂无内容')}</p>}
                        </div>
                      </div>

                      <div className="skills-manager-footnote">
                        <Clock3 size={13} />
                        <span>{t('最近更新')}：{new Date(skill.updatedAt).toLocaleString()}</span>
                      </div>
                    </div>
                  ) : null}
                rowClassName={(skill) => expandedSkillIds.includes(skill.id) ? 'is-expanded' : ''}
                searchPlaceholder={t('筛选 Skills')}
                toolbarActions={showTitle ? undefined : managerActions}
              />
            )}
          </div>
        </div>
      </div>

      {editorMode && portalReady ? createPortal((
        <div className="ui-modal-overlay">
          <section
            aria-labelledby="skills-manager-modal-title"
            aria-modal="true"
            className="ui-modal ui-modal--skill"
            role="dialog"
          >
            <header className="ui-modal-header">
              <div className="ui-modal-heading">
                <h2 className="ui-modal-title" id="skills-manager-modal-title">{editorMode === 'edit' ? t('编辑 Skill') : t('新建 Skill')}</h2>
                <p className="ui-modal-subtitle">{editorMode === 'edit' ? editingSkillId : t('保存后即可在对话中使用')}</p>
              </div>
              <button aria-label={t('关闭')} className="ui-icon-button ui-modal-close" onClick={closeEditorModal} type="button">
                <X size={16} />
              </button>
            </header>

            <div className="ui-modal-body skills-manager-form">
              <label className={editorMode === 'create' ? 'skills-manager-field wide' : 'skills-manager-field'}>
                <span>{t('标题')}</span>
                <input className="input settings-control" value={draft.title} onChange={(event) => update({ title: event.target.value })} />
              </label>
              {editorMode === 'edit' ? <label className="skills-manager-field">
                <span>{t('状态')}</span>
                <CustomSelect
                  className="settings-control"
                  value={draft.status}
                  onChange={(value) => update({ status: value as SkillRecord['status'] })}
                  options={[
                    { label: t('可用'), value: 'ready' },
                    { label: t('草稿'), value: 'draft' },
                    { label: t('停用'), value: 'disabled' },
                  ]}
                />
              </label> : null}
              <label className="skills-manager-field wide">
                <span>{t('描述')}</span>
                <textarea className="textarea settings-control" value={draft.description} onChange={(event) => update({ description: event.target.value })} placeholder={t('一句话说明能力和适用场景')} />
              </label>
              <label className="skills-manager-field wide">
                <span>{t('适用域名')}</span>
                <textarea className="textarea settings-control compact" value={draft.domains} onChange={(event) => update({ domains: event.target.value })} placeholder={t('留空表示所有域名；每行一个域名，可使用 *.example.com')} />
              </label>
              <label className="skills-manager-field wide">
                <span>{t('触发词')}</span>
                <textarea className="textarea settings-control compact" value={draft.triggerPhrases} onChange={(event) => update({ triggerPhrases: event.target.value })} placeholder={t('每行一个精确的用户意图')} />
              </label>
              <label className="skills-manager-field wide">
                <span>{t('详细内容')}</span>
                <textarea className="textarea settings-control skill-details" maxLength={30_000} value={draft.details} onChange={(event) => update({ details: event.target.value })} placeholder={t('填写完整操作说明，支持多段文本和 Markdown')} />
              </label>
              <div className="resource-sharing-field wide">
                <div>
                  <strong>{t('所有 ID 共享')}</strong>
                  <small>{t('其他 ID 可以使用此 Skill，但只有创建 ID {id} 可以编辑或删除', {
                    id: editorMode === 'edit' ? skills.find((skill) => skill.id === editingSkillId)?.userId || normalizedUserId : normalizedUserId,
                  })}</small>
                </div>
                <button aria-pressed={draft.shared} className={`settings-toggle${draft.shared ? ' on' : ''}`} disabled={saving} onClick={() => update({ shared: !draft.shared })} type="button">
                  <span />
                </button>
              </div>
            </div>

            <footer className="ui-modal-footer">
              <button className="ui-button ui-button--neutral" disabled={saving} onClick={closeEditorModal} type="button">
                <X size={15} />
                {t('取消')}
              </button>
              <button className="ui-button ui-button--primary" disabled={saving} onClick={() => void saveSkill()} type="button">
                {saving ? <Loader2 className="spin" size={15} /> : <Save size={15} />}
                {t('保存')}
              </button>
            </footer>
          </section>
        </div>
      ), document.body) : null}

      {deleteTarget && portalReady ? (
        <ConfirmDeleteModal
          deleting={Boolean(deletingSkillId)}
          description={t('确定删除这个 Skill 吗？')}
          id="skills-manager-delete-title"
          itemTitle={deleteTarget.title}
          onClose={closeDeleteModal}
          onConfirm={confirmDeleteSkill}
          title={t('删除 Skill')}
        />
      ) : null}
    </section>
  );
}
