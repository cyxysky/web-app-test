import type { SkillRecord } from '@/server/ai/schemas/runtime.schema';
import { fuzzyRetrievalScore, retrievalQueryTexts } from '@/lib/fuzzy-retrieval';

function compactText(value: string, max = 900) {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function xmlAttribute(value: unknown) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function activeSkills(skills: SkillRecord[]) {
  return [...new Map(skills.filter((skill) => skill.status === 'ready').map((skill) => [skill.id, skill])).values()];
}

export function skillRelevanceScore(skill: SkillRecord, query: unknown) {
  return Math.max(
    fuzzyRetrievalScore(query, [skill.title]) * 8,
    fuzzyRetrievalScore(query, [skill.description]) * 5,
    fuzzyRetrievalScore(query, skill.triggerPhrases) * 10,
  );
}

export function runtimeSkills(
  allSkills: SkillRecord[],
  explicitlySelected: SkillRecord[],
  loadedSkillIds: ReadonlySet<string> = new Set(),
  query: unknown = '',
) {
  const activeExplicitlySelected = activeSkills(explicitlySelected);
  const selectedIds = new Set(activeExplicitlySelected.map((skill) => skill.id));
  const autoSkills = allSkills
    .filter((skill) => !selectedIds.has(skill.id))
    .map((skill) => ({
      skill,
      relevance: skillRelevanceScore(skill, query),
    }))
    .filter((item) => !retrievalQueryTexts(query).length || item.relevance >= 3.8)
    .sort((left, right) => right.relevance - left.relevance || left.skill.id.localeCompare(right.skill.id))
    .filter((item) => !loadedSkillIds.has(item.skill.id))
    .slice(0, 8)
    .map((item) => item.skill);
  return activeSkills([
    ...activeExplicitlySelected,
    ...autoSkills,
  ].filter((skill) => !loadedSkillIds.has(skill.id)));
}

export function formatSkillReferencesForUser(skills: SkillRecord[]) {
  const selected = activeSkills(skills);
  if (!selected.length) return '';
  return selected.map((skill, index) => [
    `<skills id="${index + 1}">`,
    `Title: ${compactText(skill.title, 120)}`,
    `</skills>`,
  ].filter(Boolean).join('\n')).join('\n\n');
}

export function formatSkillSummariesForPrompt(skills: SkillRecord[]) {
  const selected = activeSkills(skills);
  if (!selected.length) return '';
  return [
    'Available Skill summaries for the current task:',
    'When a Skill is relevant, call skill with action="read" and its id before performing the related browser actions. The complete current Skill is loaded into the next model context.',
    'Do not call skill action="read" repeatedly while a Skill remains loaded. Prefer current page evidence when it contradicts a Skill.',
    ...selected.map((skill, index) => [
      '',
      `<skill id="${xmlAttribute(skill.id)}" version="${xmlAttribute(skill.version)}" index="${index + 1}">`,
      `Title: ${compactText(skill.title, 120)}`,
      `Summary: ${compactText(skill.description, 360)}`,
      skill.triggerPhrases.length ? `Triggers: ${skill.triggerPhrases.map((phrase) => compactText(phrase, 80)).join(', ')}` : '',
      '</skill>',
    ].filter(Boolean).join('\n')),
  ].join('\n');
}

export function formatLoadedSkillsForPrompt(skills: SkillRecord[]) {
  const selected = activeSkills(skills);
  if (!selected.length) return '';
  return [
    'Loaded Skills for the current runtime context:',
    'Follow these operating instructions for the current task. Prefer current page evidence when it contradicts a Skill.',
    ...selected.map((skill) => [
      '',
      `<skill id="${xmlAttribute(skill.id)}" version="${xmlAttribute(skill.version)}">`,
      `Title: ${compactText(skill.title, 120)}`,
      `Summary: ${compactText(skill.description, 360)}`,
      'Content:',
      skill.content.details.trim(),
      '</skill>',
    ].filter(Boolean).join('\n')),
  ].join('\n');
}
