'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Edit3, Loader2, Plus, Save, Trash2 } from 'lucide-react';
import { CustomSelect } from '@/components/CustomSelect';
import { useI18n } from '@/i18n/I18nProvider';
import { startGlobalLoading, stopGlobalLoading } from '@/lib/global-loading';
import type { SkillRecord } from '@/server/ai/schemas/test-case.schema';
import { readApiJson } from '@/lib/api-client';

type SkillDraft = {
  title: string;
  description: string;
  status: SkillRecord['status'];
  tags: string;
  triggerPhrases: string;
  whenToUse: string;
  workflow: string;
  reusablePatterns: string;
  cautions: string;
  verification: string;
  sourceSummary: string;
};

const emptyDraft: SkillDraft = {
  title: '',
  description: '',
  status: 'ready',
  tags: '',
  triggerPhrases: '',
  whenToUse: '',
  workflow: '',
  reusablePatterns: '',
  cautions: '',
  verification: '',
  sourceSummary: '',
};

function lines(items?: string[]) {
  return (items || []).join('\n');
}

function draftFromSkill(skill: SkillRecord): SkillDraft {
  return {
    title: skill.title,
    description: skill.description,
    status: skill.status,
    tags: skill.tags.join(', '),
    triggerPhrases: skill.triggerPhrases.join('\n'),
    whenToUse: lines(skill.content.whenToUse),
    workflow: lines(skill.content.workflow),
    reusablePatterns: lines(skill.content.reusablePatterns),
    cautions: lines(skill.content.cautions),
    verification: lines(skill.content.verification),
    sourceSummary: skill.content.sourceSummary || '',
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
    status: draft.status,
    tags: splitList(draft.tags),
    triggerPhrases: splitList(draft.triggerPhrases),
    content: {
      whenToUse: splitLines(draft.whenToUse),
      workflow: splitLines(draft.workflow),
      reusablePatterns: splitLines(draft.reusablePatterns),
      cautions: splitLines(draft.cautions),
      verification: splitLines(draft.verification),
      sourceSummary: draft.sourceSummary.trim(),
    },
  };
}

function statusLabel(status: SkillRecord['status']) {
  if (status === 'draft') return '草稿';
  if (status === 'disabled') return '停用';
  return '可用';
}

export function SkillsManager({ onChanged }: { onChanged?: () => void } = {}) {
  const { t } = useI18n();
  const [skills, setSkills] = useState<SkillRecord[]>([]);
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [draft, setDraft] = useState<SkillDraft>(emptyDraft);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deletingSkillId, setDeletingSkillId] = useState<string | null>(null);

  const selectedSkill = selectedSkillId ? skills.find((skill) => skill.id === selectedSkillId) : undefined;
  const filteredSkills = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return skills;
    return skills.filter((skill) => [
      skill.title,
      skill.description,
      skill.status,
      ...skill.tags,
      ...skill.triggerPhrases,
    ].some((value) => value.toLowerCase().includes(keyword)));
  }, [query, skills]);

  const loadSkills = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/skills', { cache: 'no-store' });
      const data = await readApiJson<any>(response, t('加载 Skills 失败'));
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

  function update(patch: Partial<SkillDraft>) {
    setDraft((current) => ({ ...current, ...patch }));
  }

  function selectSkill(skill: SkillRecord) {
    setSelectedSkillId(skill.id);
    setDraft(draftFromSkill(skill));
  }

  function createSkill() {
    setSelectedSkillId(null);
    setDraft(emptyDraft);
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

    setSaving(true);
    startGlobalLoading(t('正在保存 Skill'));
    try {
      const response = await fetch(selectedSkillId ? `/api/skills/${selectedSkillId}` : '/api/skills', {
        method: selectedSkillId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await readApiJson<any>(response, t('保存 Skill 失败'));
      if (!data.skill) throw new Error(t('保存 Skill 失败'));
      const saved = data.skill as SkillRecord;
      setSkills((current) => [saved, ...current.filter((skill) => skill.id !== saved.id)]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
      setSelectedSkillId(saved.id);
      setDraft(draftFromSkill(saved));
      onChanged?.();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : t('保存 Skill 失败'));
    } finally {
      setSaving(false);
      stopGlobalLoading();
    }
  }

  async function deleteSkill(skill: SkillRecord) {
    if (!window.confirm(t('确定删除这个 Skill 吗？已加载它的测试用例会自动移除引用。'))) return;
    setDeletingSkillId(skill.id);
    startGlobalLoading(t('正在删除 Skill'));
    try {
      const response = await fetch(`/api/skills/${skill.id}`, { method: 'DELETE' });
      const data = await readApiJson<any>(response, t('删除 Skill 失败'));
      setSkills((current) => current.filter((item) => item.id !== skill.id));
      if (selectedSkillId === skill.id) createSkill();
      onChanged?.();
    } catch (error) {
      window.alert(error instanceof Error ? error.message : t('删除 Skill 失败'));
    } finally {
      setDeletingSkillId(null);
      stopGlobalLoading();
    }
  }

  return (
    <section className="skills-manager">
      <div className="settings-section-head">
        <div>
          <h2>{t('Skills 管理')}</h2>
          <span>{t('管理目标模式和对话模式可加载的复用技能。')}</span>
        </div>
        <button className="settings-save-button" onClick={createSkill} type="button">
          <Plus size={15} />
          {t('新建 Skill')}
        </button>
      </div>

      <div className="skills-manager-layout">
        <div className="settings-card skills-manager-list">
          <input
            className="input settings-control"
            placeholder={t('搜索 Skills')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <div className="skills-manager-list-body">
            {loading ? (
              <div className="settings-loading-panel compact">
                <Loader2 className="spin" size={16} />
                <span>{t('正在加载 Skills')}</span>
              </div>
            ) : filteredSkills.length ? filteredSkills.map((skill) => (
              <button
                className={selectedSkillId === skill.id ? 'skills-manager-item active' : 'skills-manager-item'}
                key={skill.id}
                onClick={() => selectSkill(skill)}
                type="button"
              >
                <span>
                  <b>{skill.title}</b>
                  <small>{skill.description || skill.id}</small>
                </span>
                <em className={`skill-status status-${skill.status}`}>{t(statusLabel(skill.status))}</em>
              </button>
            )) : (
              <div className="empty-state">{t('暂无 Skills')}</div>
            )}
          </div>
        </div>

        <div className="settings-card skills-manager-editor">
          <div className="skills-manager-editor-head">
            <div>
              <h3>{selectedSkill ? t('编辑 Skill') : t('新建 Skill')}</h3>
              <span>{selectedSkill ? selectedSkill.id : t('保存后即可在 / 菜单和测试用例中使用')}</span>
            </div>
            <div className="skills-manager-actions">
              {selectedSkill ? (
                <button
                  className="settings-picker-button danger"
                  disabled={saving || deletingSkillId === selectedSkill.id}
                  onClick={() => void deleteSkill(selectedSkill)}
                  type="button"
                >
                  {deletingSkillId === selectedSkill.id ? <Loader2 className="spin" size={15} /> : <Trash2 size={15} />}
                  {t('删除')}
                </button>
              ) : null}
              <button className="settings-save-button" disabled={saving} onClick={() => void saveSkill()} type="button">
                {saving ? <Loader2 className="spin" size={15} /> : <Save size={15} />}
                {t('保存')}
              </button>
            </div>
          </div>

          <div className="skills-manager-form">
            <label className="skills-manager-field">
              <span>{t('标题')}</span>
              <input className="input settings-control" value={draft.title} onChange={(event) => update({ title: event.target.value })} />
            </label>
            <label className="skills-manager-field">
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
            </label>
            <label className="skills-manager-field wide">
              <span>{t('描述')}</span>
              <textarea className="textarea settings-control" value={draft.description} onChange={(event) => update({ description: event.target.value })} />
            </label>
            <label className="skills-manager-field">
              <span>{t('标签')}</span>
              <textarea className="textarea settings-control compact" value={draft.tags} onChange={(event) => update({ tags: event.target.value })} placeholder={t('逗号或换行分隔')} />
            </label>
            <label className="skills-manager-field">
              <span>{t('触发词')}</span>
              <textarea className="textarea settings-control compact" value={draft.triggerPhrases} onChange={(event) => update({ triggerPhrases: event.target.value })} placeholder={t('逗号或换行分隔')} />
            </label>
            <label className="skills-manager-field wide">
              <span>{t('何时使用')}</span>
              <textarea className="textarea settings-control" value={draft.whenToUse} onChange={(event) => update({ whenToUse: event.target.value })} placeholder={t('每行一条')} />
            </label>
            <label className="skills-manager-field wide">
              <span>{t('操作流程')}</span>
              <textarea className="textarea settings-control tall" value={draft.workflow} onChange={(event) => update({ workflow: event.target.value })} placeholder={t('每行一个步骤')} />
            </label>
            <label className="skills-manager-field">
              <span>{t('可复用模式')}</span>
              <textarea className="textarea settings-control" value={draft.reusablePatterns} onChange={(event) => update({ reusablePatterns: event.target.value })} placeholder={t('每行一条')} />
            </label>
            <label className="skills-manager-field">
              <span>{t('注意事项')}</span>
              <textarea className="textarea settings-control" value={draft.cautions} onChange={(event) => update({ cautions: event.target.value })} placeholder={t('每行一条')} />
            </label>
            <label className="skills-manager-field wide">
              <span>{t('验证方式')}</span>
              <textarea className="textarea settings-control" value={draft.verification} onChange={(event) => update({ verification: event.target.value })} placeholder={t('每行一条')} />
            </label>
            <label className="skills-manager-field wide">
              <span>{t('来源摘要')}</span>
              <textarea className="textarea settings-control" value={draft.sourceSummary} onChange={(event) => update({ sourceSummary: event.target.value })} />
            </label>
          </div>

          <div className="skills-manager-footnote">
            <Edit3 size={14} />
            <span>{t('可用状态的 Skill 会出现在对话 / 菜单和测试用例选择列表中。')}</span>
          </div>
        </div>
      </div>
    </section>
  );
}
