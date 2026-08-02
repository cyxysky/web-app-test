'use client';

import { FormEvent, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '@/i18n/I18nProvider';
import styles from './page.module.css';

type ErrorMap = Record<string, string>;

const requiredMessage = '此项为必填项';
const regions: Record<string, string[]> = {
  中国: ['杭州', '上海'],
  欧洲: ['伦敦', '巴黎'],
};
const treeGroups = [
  { name: '产品中心', children: ['产品设计', '用户研究'] },
  { name: '研发中心', children: ['前端研发', '后端研发', '质量保障'] },
];
const skillOptions = ['自动化测试', '可访问性', '性能测试', '安全测试'];
const interferenceCards = Array.from({ length: 24 }, (_, index) => ({
  id: `BG-${String(index + 1).padStart(2, '0')}`,
  owner: ['测试负责人', '质量审核员', '产品经理', '发布管理员'][index % 4],
  status: ['等待处理', '执行中', '已完成'][index % 3],
  title: ['回归测试计划', '核心链路检查', '自动化测试任务', '可访问性审计'][index % 4],
}));
const duplicateActions = ['提交并确认', '完成', '确认提交', '中国', '杭州', '研发中心', '质量保障', '即时消息'];
const stressRows = Array.from({ length: 72 }, (_, index) => ({
  id: `STRESS-${String(index + 1).padStart(3, '0')}`,
  action: duplicateActions[index % duplicateActions.length],
}));

function ErrorText({ id, message }: { id: string; message?: string }) {
  const { t } = useI18n();
  return message ? <span className={styles.error} id={id} role="alert">{t(message)}</span> : null;
}

function DuplicateModalFields({ zeroSized = false }: { zeroSized?: boolean }) {
  const { t } = useI18n();
  const hiddenClass = zeroSized ? styles.zeroSizeElement : undefined;
  return (
    <form className={styles.decoyFields} onSubmit={(event) => event.preventDefault()}>
      <label>{t('任务名称')} <input className={hiddenClass} data-testid="title-input" defaultValue={t('隐藏任务')} placeholder={t('例如：回归测试计划')} /></label>
      <label>{t('负责人邮箱')} <input className={hiddenClass} data-testid="owner-email-input" defaultValue="hidden@example.com" placeholder="tester@example.com" type="email" /></label>
      <label>{t('开始日期')} <input className={hiddenClass} data-testid="start-date-input" defaultValue="2025-01-01" placeholder="YYYY-MM-DD" /></label>
      <label>{t('联系人 {index}', { index: 1 })} <input aria-label={t('联系人 {index}', { index: 1 })} className={hiddenClass} data-testid="contact-0" defaultValue={t('隐藏联系人')} /></label>
      <label><input className={hiddenClass} data-testid="agreement-checkbox" defaultChecked type="checkbox" /> {t('我已阅读并同意测试协议')}</label>
      <button className={hiddenClass} data-testid="submit-form" type="submit">{t('提交并确认')}</button>
    </form>
  );
}

function StressDuplicateFields({ disabled = false, label, readOnly = false }: { disabled?: boolean; label: string; readOnly?: boolean }) {
  const { t } = useI18n();
  return (
    <fieldset aria-label={t('{label} 重复控件', { label: t(label) })} className={styles.stressDuplicateFields} disabled={disabled}>
      <legend>{t(label)}</legend>
      <input aria-label={t('任务名称')} data-testid="title-input" defaultValue={t('{label} 任务', { label: t(label) })} placeholder={t('例如：回归测试计划')} readOnly={readOnly} />
      <input aria-label={t('负责人邮箱')} data-testid="owner-email-input" defaultValue="trap@example.com" placeholder="tester@example.com" readOnly={readOnly} type="email" />
      <input aria-label={t('开始日期')} data-testid="start-date-input" defaultValue="2025-02-01" placeholder="YYYY-MM-DD" readOnly={readOnly} />
      <input aria-label={t('联系人 {index}', { index: 1 })} data-testid="contact-0" defaultValue={t('{label} 联系人', { label: t(label) })} readOnly={readOnly} />
      <button data-testid="region-cascader-trigger" type="button">{t('请选择国家与城市')}</button>
      <button data-testid="department-tree-trigger" type="button">{t('请选择组织节点')}</button>
      <button data-testid="skills-trigger" type="button">{t('请选择一项或多项')}</button>
      <label><input data-testid="agreement-checkbox" defaultChecked type="checkbox" /> {t('我已阅读并同意测试协议')}</label>
      <button data-testid="submit-form" type="button">{t('提交并确认')}</button>
    </fieldset>
  );
}

export default function ModalFormTestPage() {
  const { t } = useI18n();
  const [portalReady, setPortalReady] = useState(false);
  const [open, setOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [success, setSuccess] = useState(false);
  const [errors, setErrors] = useState<ErrorMap>({});
  const [title, setTitle] = useState('');
  const [ownerEmail, setOwnerEmail] = useState('');
  const [category, setCategory] = useState('');
  const [region, setRegion] = useState('');
  const [department, setDepartment] = useState('');
  const [channel, setChannel] = useState('');
  const [skills, setSkills] = useState<string[]>([]);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [description, setDescription] = useState('');
  const [richText, setRichText] = useState('');
  const [agreement, setAgreement] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [priority, setPriority] = useState('50');
  const [color, setColor] = useState('#2563eb');
  const [budget, setBudget] = useState('');
  const [keyword, setKeyword] = useState('');
  const [contacts, setContacts] = useState(['']);
  const [cascaderOpen, setCascaderOpen] = useState(false);
  const [regionGroup, setRegionGroup] = useState('');
  const [treeOpen, setTreeOpen] = useState(false);
  const [expandedTreeGroups, setExpandedTreeGroups] = useState<string[]>([]);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [noiseTick, setNoiseTick] = useState(0);
  const [trapInteractions, setTrapInteractions] = useState(0);
  const richTextRef = useRef<HTMLDivElement>(null);

  useEffect(() => setPortalReady(true), []);

  useEffect(() => {
    const timer = window.setInterval(() => setNoiseTick((value) => (value + 1) % 10_000), 800);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (confirmOpen) setConfirmOpen(false);
      else if (cascaderOpen || treeOpen || skillsOpen) {
        setCascaderOpen(false);
        setTreeOpen(false);
        setSkillsOpen(false);
      } else setOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [cascaderOpen, confirmOpen, open, skillsOpen, treeOpen]);

  function clearError(name: string) {
    setErrors((current) => {
      if (!current[name]) return current;
      const next = { ...current };
      delete next[name];
      return next;
    });
  }

  function validate() {
    const next: ErrorMap = {};
    const datePattern = /^\d{4}-\d{2}-\d{2}$/;
    if (!title.trim()) next.title = requiredMessage;
    if (!ownerEmail.trim()) next.ownerEmail = requiredMessage;
    else if (!/^\S+@\S+\.\S+$/.test(ownerEmail)) next.ownerEmail = '请输入有效邮箱地址';
    if (!category) next.category = requiredMessage;
    if (!region) next.region = requiredMessage;
    if (!department) next.department = requiredMessage;
    if (!channel) next.channel = requiredMessage;
    if (!skills.length) next.skills = '请至少选择一项';
    if (!startDate) next.startDate = requiredMessage;
    else if (!datePattern.test(startDate)) next.startDate = '请输入 YYYY-MM-DD 格式的日期';
    if (!endDate) next.endDate = requiredMessage;
    else if (!datePattern.test(endDate)) next.endDate = '请输入 YYYY-MM-DD 格式的日期';
    if (startDate && endDate && startDate > endDate) next.endDate = '结束日期不能早于开始日期';
    if (!description.trim()) next.description = requiredMessage;
    if (!richText.trim()) next.richText = requiredMessage;
    if (!agreement) next.agreement = '请阅读并同意测试协议';
    if (contacts.some((contact) => !contact.trim())) next.contacts = '联系人姓名不能为空';
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!validate()) return;
    setCascaderOpen(false);
    setTreeOpen(false);
    setSkillsOpen(false);
    setConfirmOpen(true);
  }

  function resetForm() {
    setErrors({});
    setTitle('');
    setOwnerEmail('');
    setCategory('');
    setRegion('');
    setRegionGroup('');
    setDepartment('');
    setChannel('');
    setSkills([]);
    setStartDate('');
    setEndDate('');
    setDescription('');
    setRichText('');
    setAgreement(false);
    setEnabled(true);
    setPriority('50');
    setColor('#2563eb');
    setBudget('');
    setKeyword('');
    setContacts(['']);
    setCascaderOpen(false);
    setTreeOpen(false);
    setSkillsOpen(false);
    setConfirmOpen(false);
    if (richTextRef.current) richTextRef.current.textContent = '';
  }

  function closeForm() {
    setCascaderOpen(false);
    setTreeOpen(false);
    setSkillsOpen(false);
    setConfirmOpen(false);
    setOpen(false);
  }

  function openForm() {
    resetForm();
    setSuccess(false);
    setTrapInteractions(0);
    setOpen(true);
  }

  function recordTrapInteraction() {
    setTrapInteractions((value) => value + 1);
  }

  function chooseRegion(city: string) {
    setRegion(`${regionGroup} / ${city}`);
    clearError('region');
    setCascaderOpen(false);
  }

  function chooseDepartment(group: string, child: string) {
    setDepartment(`${group} / ${child}`);
    clearError('department');
    setTreeOpen(false);
  }

  function toggleSkill(skill: string) {
    setSkills((current) => current.includes(skill)
      ? current.filter((item) => item !== skill)
      : [...current, skill]);
    clearError('skills');
  }

  function formatRichText(command: 'bold' | 'italic') {
    richTextRef.current?.focus();
    document.execCommand(command);
  }

  const modal = open && portalReady ? createPortal((
    <div className={styles.backdrop} data-testid="comprehensive-modal-backdrop">
      <section aria-labelledby="comprehensive-form-title" aria-modal="true" className={styles.modal} role="dialog">
        <header className={styles.modalHeader}>
          <div>
            <p className={styles.kicker}>{t('代码模式交互实验室')}</p>
            <h2 id="comprehensive-form-title">{t('综合控件弹窗表单')}</h2>
            <p>{t('必填校验、Portal 子浮层和二次确认均已启用。')}</p>
          </div>
          <button aria-label={t('关闭综合表单')} className={styles.iconButton} onClick={closeForm} type="button">×</button>
        </header>

        <form className={styles.form} noValidate onSubmit={submit}>
          <div className={styles.formBody}>
            <div className={styles.grid}>
            <label className={styles.field}>
              <span>{t('任务名称')} <b>*</b></span>
              <input aria-describedby="title-error" aria-invalid={Boolean(errors.title)} data-testid="title-input" onChange={(event) => { setTitle(event.target.value); clearError('title'); }} placeholder={t('例如：回归测试计划')} value={title} />
              <ErrorText id="title-error" message={errors.title} />
            </label>

            <label className={styles.field}>
              <span>{t('负责人邮箱')} <b>*</b></span>
              <input aria-describedby="owner-email-error" aria-invalid={Boolean(errors.ownerEmail)} data-testid="owner-email-input" onChange={(event) => { setOwnerEmail(event.target.value); clearError('ownerEmail'); }} placeholder="tester@example.com" type="email" value={ownerEmail} />
              <ErrorText id="owner-email-error" message={errors.ownerEmail} />
            </label>

            <label className={styles.field}>
              <span>{t('任务类型')} <b>*</b></span>
              <select aria-describedby="category-error" aria-invalid={Boolean(errors.category)} data-testid="category-select" onChange={(event) => { setCategory(event.target.value); clearError('category'); }} value={category}>
                <option value="">{t('请选择任务类型')}</option>
                <option value="功能测试">{t('功能测试')}</option>
                <option value="回归测试">{t('回归测试')}</option>
                <option value="验收测试">{t('验收测试')}</option>
              </select>
              <ErrorText id="category-error" message={errors.category} />
            </label>

            <div className={styles.field}>
              <span>{t('执行地区（级联）')} <b>*</b></span>
              <button aria-controls="region-cascader-popup" aria-describedby="region-error" aria-expanded={cascaderOpen} aria-haspopup="dialog" className={styles.selectButton} data-invalid={Boolean(errors.region)} data-testid="region-cascader-trigger" onClick={() => { setCascaderOpen((value) => !value); setTreeOpen(false); setSkillsOpen(false); }} type="button">
                <span>{region ? region.split(' / ').map((item) => t(item)).join(' / ') : t('请选择国家与城市')}</span><i>⌄</i>
              </button>
              <ErrorText id="region-error" message={errors.region} />
            </div>

            <div className={styles.field}>
              <span>{t('负责部门（树选择）')} <b>*</b></span>
              <button aria-controls="department-tree-popup" aria-describedby="department-error" aria-expanded={treeOpen} aria-haspopup="tree" className={styles.selectButton} data-invalid={Boolean(errors.department)} data-testid="department-tree-trigger" onClick={() => { setTreeOpen((value) => !value); setCascaderOpen(false); setSkillsOpen(false); }} type="button">
                <span>{department ? department.split(' / ').map((item) => t(item)).join(' / ') : t('请选择组织节点')}</span><i>⌄</i>
              </button>
              <ErrorText id="department-error" message={errors.department} />
            </div>

            <div className={styles.field}>
              <span>{t('测试技能（多选下拉）')} <b>*</b></span>
              <button aria-controls="skills-popup" aria-describedby="skills-error" aria-expanded={skillsOpen} aria-haspopup="listbox" className={styles.selectButton} data-invalid={Boolean(errors.skills)} data-testid="skills-trigger" onClick={() => { setSkillsOpen((value) => !value); setCascaderOpen(false); setTreeOpen(false); }} type="button">
                <span>{skills.length ? skills.map((skill) => t(skill)).join('、') : t('请选择一项或多项')}</span><i>⌄</i>
              </button>
              <ErrorText id="skills-error" message={errors.skills} />
            </div>

            <fieldset className={styles.fieldset}>
              <legend>{t('通知渠道')} <b>*</b></legend>
              <div className={styles.inlineChoices}>
                {['邮件', '站内信', '即时消息'].map((item) => (
                  <label key={item}><input checked={channel === item} name="channel" onChange={() => { setChannel(item); clearError('channel'); }} type="radio" value={item} /> {t(item)}</label>
                ))}
              </div>
              <ErrorText id="channel-error" message={errors.channel} />
            </fieldset>

            <label className={styles.field}>
              <span>{t('预算')}</span>
              <input data-testid="budget-input" min="0" onChange={(event) => setBudget(event.target.value)} placeholder="0.00" step="100" type="number" value={budget} />
            </label>

            <label className={styles.field}>
              <span>{t('开始日期')} <b>*</b></span>
              <input aria-describedby="start-date-error" aria-invalid={Boolean(errors.startDate)} data-testid="start-date-input" inputMode="numeric" onChange={(event) => { setStartDate(event.target.value); clearError('startDate'); }} placeholder="YYYY-MM-DD" type="text" value={startDate} />
              <ErrorText id="start-date-error" message={errors.startDate} />
            </label>

            <label className={styles.field}>
              <span>{t('结束日期')} <b>*</b></span>
              <input aria-describedby="end-date-error" aria-invalid={Boolean(errors.endDate)} data-testid="end-date-input" inputMode="numeric" onChange={(event) => { setEndDate(event.target.value); clearError('endDate'); }} placeholder="YYYY-MM-DD" type="text" value={endDate} />
              <ErrorText id="end-date-error" message={errors.endDate} />
            </label>

            <label className={styles.field}>
              <span>{t('关键词（自动补全）')}</span>
              <input data-testid="keyword-input" list="keyword-options" onChange={(event) => setKeyword(event.target.value)} placeholder={t('输入或选择关键词')} value={keyword} />
              <datalist id="keyword-options"><option value={t('冒烟测试')} /><option value={t('核心链路')} /><option value={t('跨浏览器')} /></datalist>
            </label>

            <label className={styles.field}>
              <span>{t('主题颜色')}</span>
              <input aria-label={t('主题颜色')} data-testid="color-input" onChange={(event) => setColor(event.target.value)} type="color" value={color} />
            </label>

            <label className={`${styles.field} ${styles.wide}`}>
              <span>{t('任务说明')} <b>*</b></span>
              <textarea aria-describedby="description-error" aria-invalid={Boolean(errors.description)} data-testid="description-textarea" onChange={(event) => { setDescription(event.target.value); clearError('description'); }} placeholder={t('请输入测试范围、目标与验收标准')} rows={4} value={description} />
              <ErrorText id="description-error" message={errors.description} />
            </label>

            <div className={`${styles.field} ${styles.wide}`}>
              <span>{t('富文本备注')} <b>*</b></span>
              <div className={styles.editor}>
                <div aria-label={t('富文本工具栏')} className={styles.toolbar} role="toolbar">
                  <button aria-label={t('加粗')} onClick={() => formatRichText('bold')} type="button"><b>B</b></button>
                  <button aria-label={t('斜体')} onClick={() => formatRichText('italic')} type="button"><i>I</i></button>
                </div>
                <div
                  aria-describedby="rich-text-error"
                  aria-invalid={Boolean(errors.richText)}
                  aria-label={t('富文本备注')}
                  className={styles.richText}
                  contentEditable
                  data-placeholder={t('输入富文本备注，可使用工具栏格式化')}
                  data-testid="rich-text-editor"
                  onInput={(event) => { setRichText(event.currentTarget.textContent || ''); clearError('richText'); }}
                  ref={richTextRef}
                  role="textbox"
                  suppressContentEditableWarning
                />
              </div>
              <ErrorText id="rich-text-error" message={errors.richText} />
            </div>

            <div className={`${styles.field} ${styles.wide}`}>
              <div className={styles.fieldHeader}><span>{t('联系人（动态表单项）')} <b>*</b></span><button className={styles.textButton} data-testid="add-contact" onClick={() => setContacts((current) => [...current, ''])} type="button">＋ {t('添加联系人')}</button></div>
              <div className={styles.contacts}>
                {contacts.map((contact, index) => (
                  <div className={styles.contactRow} key={`contact-${index}`}>
                    <input aria-label={t('联系人 {index}', { index: index + 1 })} data-testid={`contact-${index}`} onChange={(event) => { const value = event.target.value; setContacts((current) => current.map((item, itemIndex) => itemIndex === index ? value : item)); clearError('contacts'); }} placeholder={t('联系人 {index}', { index: index + 1 })} value={contact} />
                    {contacts.length > 1 ? <button aria-label={t('删除联系人 {index}', { index: index + 1 })} className={styles.removeButton} onClick={() => setContacts((current) => current.filter((_, itemIndex) => itemIndex !== index))} type="button">{t('删除')}</button> : null}
                  </div>
                ))}
              </div>
              <ErrorText id="contacts-error" message={errors.contacts} />
            </div>

            <div className={`${styles.field} ${styles.wide} ${styles.compactControls}`}>
              <label className={styles.switchLabel}><button aria-checked={enabled} className={`${styles.switch} ${enabled ? styles.switchOn : ''}`} data-testid="enabled-switch" onClick={() => setEnabled((value) => !value)} role="switch" type="button"><span /></button> {t('启用自动执行')}</label>
              <label className={styles.rangeLabel}>{t('优先级')} <input aria-label={t('优先级')} data-testid="priority-slider" max="100" min="0" onChange={(event) => setPriority(event.target.value)} type="range" value={priority} /><output>{priority}</output></label>
              <label className={styles.uploadLabel}>{t('附件')} <input aria-label={t('附件')} data-testid="file-input" type="file" /></label>
            </div>

            <label className={`${styles.agreement} ${styles.wide}`}>
              <input aria-describedby="agreement-error" aria-invalid={Boolean(errors.agreement)} checked={agreement} data-testid="agreement-checkbox" onChange={(event) => { setAgreement(event.target.checked); clearError('agreement'); }} type="checkbox" />
              <span>{t('我已阅读并同意测试协议')} <b>*</b></span>
              <ErrorText id="agreement-error" message={errors.agreement} />
            </label>
            </div>
          </div>

          <footer className={styles.modalFooter}>
            <button className={styles.secondaryButton} onClick={resetForm} type="button">{t('重置')}</button>
            <button className={styles.primaryButton} data-testid="submit-form" type="submit">{t('提交并确认')}</button>
          </footer>
        </form>
      </section>
    </div>
  ), document.body) : null;

  const overlays = open && portalReady ? createPortal((
    <>
      {cascaderOpen ? (
        <section aria-label={t('地区级联选择')} className={`${styles.popup} ${styles.cascaderPopup}`} data-testid="region-cascader-popup" id="region-cascader-popup" role="dialog">
          <div className={styles.popupColumn}>
            <strong>{t('区域')}</strong>
            {Object.keys(regions).map((group) => <button aria-pressed={regionGroup === group} key={group} onClick={() => setRegionGroup(group)} type="button">{t(group)}<span>›</span></button>)}
          </div>
          <div className={styles.popupColumn}>
            <strong>{t('城市')}</strong>
            {regionGroup ? regions[regionGroup].map((city) => <button key={city} onClick={() => chooseRegion(city)} type="button">{t(city)}</button>) : <p>{t('请先选择区域')}</p>}
          </div>
        </section>
      ) : null}

      {treeOpen ? (
        <section aria-label={t('部门树选择')} className={`${styles.popup} ${styles.treePopup}`} data-testid="department-tree-popup" id="department-tree-popup" role="tree">
          {treeGroups.map((group) => {
            const expanded = expandedTreeGroups.includes(group.name);
            return <div aria-expanded={expanded} aria-selected="false" key={group.name} role="treeitem">
              <button className={styles.treeGroup} onClick={() => setExpandedTreeGroups((current) => expanded ? current.filter((item) => item !== group.name) : [...current, group.name])} type="button"><span>{expanded ? '−' : '+'}</span>{t(group.name)}</button>
              {expanded ? <div className={styles.treeChildren} role="group">{group.children.map((child) => <button aria-selected={department === `${group.name} / ${child}`} key={child} onClick={() => chooseDepartment(group.name, child)} role="treeitem" type="button">{t(child)}</button>)}</div> : null}
            </div>;
          })}
        </section>
      ) : null}

      {skillsOpen ? (
        <section aria-label={t('测试技能多选')} aria-multiselectable="true" className={`${styles.popup} ${styles.skillsPopup}`} data-testid="skills-popup" id="skills-popup" role="listbox">
          {skillOptions.map((skill) => <button aria-selected={skills.includes(skill)} key={skill} onClick={() => toggleSkill(skill)} role="option" type="button"><span aria-hidden="true">{skills.includes(skill) ? '✓' : ''}</span>{t(skill)}</button>)}
          <button className={styles.popupDone} onClick={() => setSkillsOpen(false)} type="button">{t('完成')}</button>
        </section>
      ) : null}

      {confirmOpen ? (
        <div className={styles.confirmBackdrop} data-testid="confirm-backdrop">
          <section aria-labelledby="confirm-title" aria-modal="true" className={styles.confirmModal} role="dialog">
            <p className={styles.kicker}>{t('二次确认弹窗')}</p>
            <h3 id="confirm-title">{t('确认提交测试表单？')}</h3>
            <dl>
              <div><dt>{t('任务')}</dt><dd>{title}</dd></div>
              <div><dt>{t('类型')}</dt><dd>{t(category)}</dd></div>
              <div><dt>{t('地区')}</dt><dd>{region.split(' / ').map((item) => t(item)).join(' / ')}</dd></div>
              <div><dt>{t('部门')}</dt><dd>{department.split(' / ').map((item) => t(item)).join(' / ')}</dd></div>
              <div><dt>{t('技能')}</dt><dd>{skills.map((skill) => t(skill)).join('、')}</dd></div>
              <div><dt>{t('时间')}</dt><dd>{startDate} — {endDate}</dd></div>
            </dl>
            <div className={styles.confirmActions}>
              <button className={styles.secondaryButton} onClick={() => setConfirmOpen(false)} type="button">{t('返回修改')}</button>
              <button className={styles.primaryButton} data-testid="confirm-submit" onClick={() => { closeForm(); setSuccess(true); }} type="button">{t('确认提交')}</button>
            </div>
          </section>
        </div>
      ) : null}
    </>
  ), document.body) : null;

  return (
    <main className={styles.page}>
      <section className={styles.hero}>
        <p className={styles.kicker}>{t('浏览器自动化测试场景')}</p>
        <h1>{t('综合弹窗表单测试页')}</h1>
        <p>{t('用于验证 Code 模式对必填校验、主弹窗、Portal 子浮层、动态字段和二次确认弹窗的连续操作能力。')}</p>
        <button className={styles.launchButton} data-testid="open-comprehensive-form" onClick={openForm} type="button">{t('打开综合弹窗表单')}</button>
        {success ? <div className={styles.success} data-testid="submit-success" role="status"><strong>{t('提交成功')}</strong><span>{t('所有必填字段和多层浮层交互均已完成。')}</span></div> : null}
        <output className={styles.trapCounter} data-testid="trap-interaction-count">{t('背景误操作计数：{count}', { count: trapInteractions })}</output>
      </section>
      <section className={styles.coverage} aria-label={t('测试覆盖范围')}>
        {['必填校验', '级联选择', '树选择', '多选下拉', '单选框 / 复选框', '日期范围', '文本域 / 富文本', '动态字段', '上传 / 滑块 / 开关', '二次确认弹窗'].map((item) => <span key={item}>{t(item)}</span>)}
      </section>

      <section aria-label={t('背景干扰工作台')} className={styles.interference} data-testid="background-interference" onClickCapture={recordTrapInteraction} onFocusCapture={recordTrapInteraction} onInputCapture={recordTrapInteraction}>
        <header className={styles.interferenceHeader}>
          <div>
            <p className={styles.kicker}>{t('背景干扰实验室')}</p>
            <h2>{t('高密度后台工作台')}</h2>
            <p>{t('这些控件仅用于验证弹窗打开后，背景元素不会被误识别或误操作。')}</p>
          </div>
          <div className={styles.headerActions}>
            <button type="button">{t('完成')}</button>
            <button type="button">{t('提交并确认')}</button>
          </div>
        </header>

        <form className={styles.backgroundFilters} onSubmit={(event) => event.preventDefault()}>
          <label>{t('任务名称')} <input defaultValue={t('背景回归测试计划')} placeholder={t('例如：回归测试计划')} /></label>
          <label>{t('负责人邮箱')} <input defaultValue="background@example.com" placeholder="tester@example.com" type="email" /></label>
          <label>{t('任务类型')} <select defaultValue="回归测试"><option value="功能测试">{t('功能测试')}</option><option value="回归测试">{t('回归测试')}</option><option value="验收测试">{t('验收测试')}</option></select></label>
          <label>{t('开始日期')} <input defaultValue="2026-07-01" placeholder="YYYY-MM-DD" /></label>
          <label>{t('结束日期')} <input defaultValue="2026-07-31" placeholder="YYYY-MM-DD" /></label>
          <label>{t('关键词')} <input defaultValue={t('核心链路')} placeholder={t('输入或选择关键词')} /></label>
          <fieldset><legend>{t('通知渠道')}</legend><label><input defaultChecked name="background-channel" type="radio" /> {t('即时消息')}</label><label><input name="background-channel" type="radio" /> {t('邮件')}</label></fieldset>
          <label className={styles.backgroundAgreement}><input defaultChecked type="checkbox" /> {t('我已阅读并同意测试协议')}</label>
          <button type="submit">{t('提交并确认')}</button>
        </form>

        <div className={styles.backgroundGrid}>
          {interferenceCards.map((card, index) => (
            <article className={styles.noiseCard} key={card.id}>
              <div><span>{card.id}</span><em data-status={card.status}>{t(card.status)}</em></div>
              <h3>{t(card.title)}</h3>
              <p>{t('负责人：{owner}', { owner: t(card.owner) })}</p>
              <label><input defaultChecked={index % 3 === 0} type="checkbox" /> {t('选中任务')}</label>
              <div className={styles.noiseActions}>
                <button type="button">{t('查看详情')}</button>
                <button type="button">{t(duplicateActions[index % duplicateActions.length])}</button>
              </div>
            </article>
          ))}
        </div>
      </section>

      <aside aria-label={t('背景固定快捷操作')} className={styles.floatingRail} onClickCapture={recordTrapInteraction} onFocusCapture={recordTrapInteraction} onInputCapture={recordTrapInteraction}>
        <strong>{t('快捷操作')}</strong>
        {duplicateActions.map((action) => <button key={action} type="button">{t(action)}</button>)}
      </aside>

      <div aria-label={t('背景底部操作条')} className={styles.bottomDock} onClickCapture={recordTrapInteraction} onFocusCapture={recordTrapInteraction} onInputCapture={recordTrapInteraction} role="region">
        <label>{t('联系人 {index}', { index: 1 })} <input defaultValue={t('背景联系人')} /></label>
        <button type="button">{t('重置')}</button>
        <button type="button">{t('提交并确认')}</button>
      </div>

      <section aria-label={t('综合控件弹窗表单')} aria-modal="true" className={`${styles.decoyDialog} ${styles.displayNoneElement}`} data-testid="hidden-display-dialog" onClickCapture={recordTrapInteraction} onFocusCapture={recordTrapInteraction} onInputCapture={recordTrapInteraction} role="dialog">
        <h2>{t('综合控件弹窗表单')}</h2>
        <DuplicateModalFields />
      </section>

      <section aria-label={t('综合控件弹窗表单')} aria-modal="true" className={`${styles.decoyDialog} ${styles.zeroSizeElement}`} data-testid="hidden-zero-dialog" onClickCapture={recordTrapInteraction} onFocusCapture={recordTrapInteraction} onInputCapture={recordTrapInteraction} role="dialog">
        <h2>{t('综合控件弹窗表单')}</h2>
        <DuplicateModalFields zeroSized />
      </section>

      <div className={styles.visibleHiddenChildHost} data-testid="visible-hidden-dialog-parent" onClickCapture={recordTrapInteraction} onFocusCapture={recordTrapInteraction} onInputCapture={recordTrapInteraction}>
        <section aria-label={t('综合控件弹窗表单')} aria-modal="true" className={`${styles.decoyDialog} ${styles.displayNoneElement}`} data-testid="hidden-child-dialog" role="dialog">
          <h2>{t('综合控件弹窗表单')}</h2>
          <DuplicateModalFields />
        </section>
      </div>

      <div aria-label={t('重复输入元素干扰区')} className={styles.duplicateInputTrap} data-testid="duplicate-hidden-inputs" onClickCapture={recordTrapInteraction} onFocusCapture={recordTrapInteraction} onInputCapture={recordTrapInteraction}>
        <input className={styles.displayNoneElement} data-testid="title-input" defaultValue={t('display none 输入')} placeholder={t('例如：回归测试计划')} />
        <input className={styles.zeroSizeElement} data-testid="title-input" defaultValue={t('零尺寸输入')} placeholder={t('例如：回归测试计划')} />
        <span className={styles.visibleHiddenInputParent}><input className={styles.displayNoneElement} data-testid="title-input" defaultValue={t('隐藏子输入')} placeholder={t('例如：回归测试计划')} /></span>
      </div>

      <section aria-label={t('综合干扰矩阵')} className={styles.stressTrapMatrix} data-testid="stress-trap-matrix" onClickCapture={recordTrapInteraction} onFocusCapture={recordTrapInteraction} onInputCapture={recordTrapInteraction}>
        <div className={styles.visibilityHiddenTrap}><StressDuplicateFields label="visibility hidden" /></div>
        <div className={styles.opacityZeroTrap}><StressDuplicateFields label="opacity zero" /></div>
        <div className={styles.scaleZeroTrap}><StressDuplicateFields label="scale zero" /></div>
        <div className={styles.offscreenTrap}><StressDuplicateFields label="offscreen" /></div>
        <div className={styles.clippedTrap}><StressDuplicateFields label="clip path" /></div>
        <div className={styles.contentHiddenTrap}><StressDuplicateFields label="content visibility" /></div>
        <div hidden><StressDuplicateFields label="hidden attribute" /></div>
        <div aria-hidden="true" className={styles.semanticTrap}><StressDuplicateFields label="aria hidden" /></div>
        <div className={styles.semanticTrap} inert><StressDuplicateFields label="inert" /></div>
        <div className={styles.semanticTrap}><StressDuplicateFields disabled label="disabled" /></div>
        <div className={styles.semanticTrap}><StressDuplicateFields label="readonly" readOnly /></div>
        <div className={styles.pointerNoneTrap}><StressDuplicateFields label="pointer events" /></div>
        <div className={styles.overflowClipHost}><StressDuplicateFields label="overflow clipped" /></div>
        <details><summary>{t('折叠干扰控件')}</summary><StressDuplicateFields label="closed details" /></details>
        <div className={styles.coveredTrap}><StressDuplicateFields label="covered" /><span aria-hidden="true" className={styles.trapCover} /></div>
      </section>

      <section aria-label={t('高密度动态节点')} className={styles.performanceNoise} data-testid="performance-noise" onClickCapture={recordTrapInteraction} onFocusCapture={recordTrapInteraction} onInputCapture={recordTrapInteraction}>
        <header><strong>{t('动态 DOM 压力区')}</strong><output aria-label={t('背景更新计数')}>{noiseTick}</output></header>
        <div>
          {stressRows.map((row, index) => (
            <article data-tick={noiseTick} key={row.id}>
              <span>{row.id}</span>
              <input aria-label={t('任务名称')} data-testid="title-input" defaultValue={t('背景压力任务 {index}', { index: index + 1 })} placeholder={t('例如：回归测试计划')} />
              <button data-testid="submit-form" type="button">{t(row.action)}</button>
            </article>
          ))}
        </div>
      </section>
      {modal}
      {overlays}
    </main>
  );
}
