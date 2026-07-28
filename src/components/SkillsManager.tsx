'use client';

import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Edit3, Loader2, Plus, Save, Trash2, X } from 'lucide-react';
import { CustomSelect } from '@/components/CustomSelect';
import { LiquidGlassLoader } from '@/components/LiquidGlassLoader';
import { useI18n } from '@/i18n/I18nProvider';
import { readApiJson } from '@/lib/api-client';
import { startGlobalLoading, stopGlobalLoading } from '@/lib/global-loading';
import type { SkillRecord } from '@/server/ai/schemas/test-case.schema';

type SkillDraft = {
  title: string;
  description: string;
  domains: string;
  status: SkillRecord['status'];
  tags: string;
  triggerPhrases: string;
  workflow: string;
  recovery: string;
  verification: string;
};

type EditorMode = 'create' | 'edit' | null;

type SkillsListResponse = {
  skills?: SkillRecord[];
};

type SkillMutationResponse = {
  skill?: SkillRecord;
};

const emptyDraft: SkillDraft = {
  title: '',
  description: '',
  domains: '',
  status: 'ready',
  tags: '',
  triggerPhrases: '',
  workflow: '',
  recovery: '',
  verification: '',
};

function lines(items?: string[]) {
  return (items || []).join('\n');
}

function draftFromSkill(skill: SkillRecord): SkillDraft {
  return {
    title: skill.title,
    description: skill.description,
    domains: lines(skill.domains),
    status: skill.status,
    tags: skill.tags.join(', '),
    triggerPhrases: skill.triggerPhrases.join('\n'),
    workflow: lines(skill.content.workflow),
    recovery: lines(skill.content.recovery),
    verification: lines(skill.content.verification),
  };
}

function splitList(value: string) {
  return value.split(/[\n,\uFF0C]+/).map((item) => item.trim()).filter(Boolean);
}

function splitLines(value: string) {
  return value.split('\n').map((item) => item.trim()).filter(Boolean);
}

function payloadFromDraft(draft: SkillDraft) {
  return {
    title: draft.title.trim(),
    description: draft.description.trim(),
    domains: splitList(draft.domains),
    status: draft.status,
    tags: splitList(draft.tags),
    triggerPhrases: splitList(draft.triggerPhrases),
    content: {
      workflow: splitLines(draft.workflow),
      recovery: splitLines(draft.recovery),
      verification: splitLines(draft.verification),
    },
  };
}

function statusLabel(status: SkillRecord['status']) {
  if (status === 'draft') return '草稿';
  if (status === 'disabled') return '停用';
  return '可用';
}

function DetailList({ emptyText, items }: { emptyText: string; items?: string[] }) {
  const values = (items || []).filter(Boolean);
  if (!values.length) return <p className="skills-manager-muted">{emptyText}</p>;
  return (
    <ul className="skills-manager-detail-list">
      {values.map((item, index) => (
        <li key={`${item}-${index}`}>{item}</li>
      ))}
    </ul>
  );
}

export function SkillsManager({ onChanged }: { onChanged?: () => void } = {}) {
  const { t } = useI18n();
  const [skills, setSkills] = useState<SkillRecord[]>([]);
  const [expandedSkillIds, setExpandedSkillIds] = useState<string[]>([]);
  const [portalReady, setPortalReady] = useState(false);
  const [editorMode, setEditorMode] = useState<EditorMode>(null);
  const [editingSkillId, setEditingSkillId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SkillRecord | null>(null);
  const [draft, setDraft] = useState<SkillDraft>(emptyDraft);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deletingSkillId, setDeletingSkillId] = useState<string | null>(null);

  const loadSkills = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/skills', { cache: 'no-store' });
      const data = await readApiJson<SkillsListResponse>(response, t('加载 Skills 失败'));
      setSkills(Array.isArray(data.skills) ? data.skills : []);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : t('加载 Skills 失败'));
    } finally {
      setLoading(false);
    }
  }, [t]);

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

  function requestDeleteSkill(skill: SkillRecord) {
    setDeleteTarget(skill);
  }

  function closeDeleteModal() {
    if (deletingSkillId) return;
    setDeleteTarget(null);
  }

  function detailSections(skill: SkillRecord) {
    return [
      { key: 'workflow', label: t('操作流程'), items: skill.content.workflow },
      { key: 'recovery', label: t('恢复策略'), items: skill.content.recovery },
      { key: 'verification', label: t('验证方式'), items: skill.content.verification },
    ];
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

    const skillId = editingSkillId;
    setSaving(true);
    startGlobalLoading(t('正在保存 Skill'));
    try {
      const response = await fetch(skillId ? `/api/skills/${skillId}` : '/api/skills', {
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
      const response = await fetch(`/api/skills/${target.id}`, { method: 'DELETE' });
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

  return (
    <section className={loading ? 'skills-manager is-loading' : 'skills-manager'}>
      <div className="settings-section-head skills-manager-head">
        <div>
          <h2>{t('Skills 管理')}</h2>
        </div>
        <button className="ui-button ui-icon-button" onClick={openCreateSkill} type="button">
          <Plus size={15} />
          {t('新建 Skill')}
        </button>
      </div>

      <div className="skills-manager-layout">
        <div className="settings-card skills-manager-list">
          <div className="skills-manager-list-body">
            {loading ? (
              <div className="settings-loading-panel compact" role="status" aria-live="polite" aria-label={t('正在加载 Skills')}>
                <LiquidGlassLoader className="ui-liquid-glass-loader--compact" />
                <div>
                  <h2>{t('正在加载 Skills')}</h2>
                </div>
              </div>
            ) : skills.length ? skills.map((skill) => {
              const expanded = expandedSkillIds.includes(skill.id);
              return (
                <div
                  className={expanded ? 'skills-manager-item expanded' : 'skills-manager-item'}
                  key={skill.id}
                >
                  <div className="skills-manager-item-row">
                    <button
                      aria-expanded={expanded}
                      className="skills-manager-item-main"
                      onClick={() => toggleSkillDetails(skill.id)}
                      type="button"
                    >
                      <ChevronDown className={expanded ? 'skills-manager-chevron open' : 'skills-manager-chevron'} size={16} />
                      <b>{skill.title}</b>
                    </button>
                    <div className="skills-manager-item-actions">
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
                    </div>
                  </div>

                  {expanded ? (
                    <div className="skills-manager-item-detail">
                      <p className="skills-manager-item-description">{skill.description || skill.id}</p>
                      <div className="skills-manager-chip-row">
                        <em className={`skill-status status-${skill.status}`}>{t(statusLabel(skill.status))}</em>
                        <span className="skills-manager-chip">
                          {skill.domains?.length ? skill.domains.join(', ') : t('所有域名')}
                        </span>
                        {skill.tags.length ? skill.tags.map((tag) => (
                          <span className="skills-manager-chip" key={tag}>{tag}</span>
                        )) : <span className="skills-manager-muted">{t('暂无标签')}</span>}
                      </div>

                      <div className="skills-manager-section wide">
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

                      <div className="skills-manager-section-grid">
                        {detailSections(skill).map((section) => (
                          <div className={section.key === 'workflow' ? 'skills-manager-section wide' : 'skills-manager-section'} key={section.key}>
                            <div>
                              <h4>{section.label}</h4>
                              <span>{section.items?.length || 0}</span>
                            </div>
                            <DetailList emptyText={t('暂无内容')} items={section.items} />
                          </div>
                        ))}
                      </div>

                      <div className="skills-manager-footnote">
                        <Edit3 size={14} />
                        <span>{t('最近更新')}：{new Date(skill.updatedAt).toLocaleString()}</span>
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            }) : (
              <div className="empty-state">{t('暂无 Skills')}</div>
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
                <p className="ui-modal-subtitle">{editorMode === 'edit' ? editingSkillId : t('保存后即可在对话和测试用例中使用')}</p>
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
              {editorMode === 'edit' ? <label className="skills-manager-field">
                <span>{t('标签')}</span>
                <textarea className="textarea settings-control compact" value={draft.tags} onChange={(event) => update({ tags: event.target.value })} placeholder={t('逗号或换行分隔')} />
              </label> : null}
              <label className={editorMode === 'create' ? 'skills-manager-field wide' : 'skills-manager-field'}>
                <span>{t('触发词')}</span>
                <textarea className="textarea settings-control compact" value={draft.triggerPhrases} onChange={(event) => update({ triggerPhrases: event.target.value })} placeholder={t('每行一个精确的用户意图')} />
              </label>
              <label className="skills-manager-field wide">
                <span>{t('操作流程')}</span>
                <textarea className="textarea settings-control tall" value={draft.workflow} onChange={(event) => update({ workflow: event.target.value })} placeholder={t('每行一个步骤')} />
              </label>
              <label className="skills-manager-field">
                <span>{t('恢复策略')}</span>
                <textarea className="textarea settings-control" value={draft.recovery} onChange={(event) => update({ recovery: event.target.value })} placeholder={t('只填写失败时的替代操作')} />
              </label>
              <label className="skills-manager-field">
                <span>{t('验证方式')}</span>
                <textarea className="textarea settings-control" value={draft.verification} onChange={(event) => update({ verification: event.target.value })} placeholder={t('只填写最终可观察的成功信号')} />
              </label>
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

      {deleteTarget && portalReady ? createPortal((
        <div className="ui-modal-overlay" onMouseDown={closeDeleteModal}>
          <section
            aria-labelledby="skills-manager-delete-title"
            aria-modal="true"
            className="ui-modal ui-modal--compact"
            onMouseDown={(event) => event.stopPropagation()}
            role="dialog"
          >
            <header className="ui-modal-header">
              <h2 className="ui-modal-title" id="skills-manager-delete-title">{t('删除 Skill')}</h2>
              <button aria-label={t('关闭')} className="ui-icon-button ui-modal-close" onClick={closeDeleteModal} type="button">
                <X size={16} />
              </button>
            </header>
            <div className="ui-modal-body skills-manager-delete-body">
              <div className="skills-manager-delete-icon">
                <Trash2 size={20} />
              </div>
              <h3>{deleteTarget.title}</h3>
              <p>{t('确定删除这个 Skill 吗？已加载它的测试用例会自动移除引用。')}</p>
            </div>
            <footer className="ui-modal-footer">
              <button className="ui-button ui-button--neutral" disabled={Boolean(deletingSkillId)} onClick={closeDeleteModal} type="button">
                <X size={15} />
                {t('取消')}
              </button>
              <button className="ui-button ui-button--danger" disabled={Boolean(deletingSkillId)} onClick={() => void confirmDeleteSkill()} type="button">
                {deletingSkillId ? <Loader2 className="spin" size={15} /> : <Trash2 size={15} />}
                {t('删除')}
              </button>
            </footer>
          </section>
        </div>
      ), document.body) : null}
    </section>
  );
}
