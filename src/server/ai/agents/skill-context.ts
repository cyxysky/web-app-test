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
  return skills.filter((skill) => skill.status === 'ready').slice(0, 8);
}

export function normalizeSkillDomain(value: string) {
  const raw = value.trim().toLowerCase();
  if (!raw) return '';
  const wildcard = raw.startsWith('*.');
  const candidate = wildcard ? raw.slice(2) : raw;
  try {
    const hostname = new URL(candidate.includes('://') ? candidate : `https://${candidate}`).hostname
      .replace(/^\.+|\.+$/g, '');
    return hostname ? `${wildcard ? '*.' : ''}${hostname}` : '';
  } catch {
    return candidate.split('/')[0].split(':')[0].replace(/^\.+|\.+$/g, '');
  }
}

export function normalizeSkillDomains(values?: string[]) {
  return Array.from(new Set((values || []).map(normalizeSkillDomain).filter(Boolean)));
}

function hostnameFromUrl(value: string) {
  try {
    return new URL(value).hostname.toLowerCase().replace(/^\.+|\.+$/g, '');
  } catch {
    return normalizeSkillDomain(value).replace(/^\*\./, '');
  }
}

export function skillMatchesUrl(skill: SkillRecord, currentUrl: string) {
  const domains = normalizeSkillDomains(skill.domains);
  if (!domains.length) return true;
  const hostname = hostnameFromUrl(currentUrl);
  if (!hostname) return false;
  return domains.some((domain) => {
    if (!domain.startsWith('*.')) return hostname === domain;
    const base = domain.slice(2);
    return hostname === base || hostname.endsWith(`.${base}`);
  });
}

function skillRelevanceScore(skill: SkillRecord, query: unknown) {
  return Math.max(
    fuzzyRetrievalScore(query, [skill.title]) * 8,
    fuzzyRetrievalScore(query, [skill.description]) * 5,
    fuzzyRetrievalScore(query, skill.triggerPhrases) * 10,
  );
}

export function runtimeSkillsForUrl(
  allSkills: SkillRecord[],
  explicitlySelected: SkillRecord[],
  currentUrl: string,
  loadedSkillIds: ReadonlySet<string> = new Set(),
  query: unknown = '',
) {
  const activeExplicitlySelected = explicitlySelected.filter((skill) => skillMatchesUrl(skill, currentUrl));
  const selectedIds = new Set(activeExplicitlySelected.map((skill) => skill.id));
  const autoSkills = allSkills
    .filter((skill) => !selectedIds.has(skill.id) && skillMatchesUrl(skill, currentUrl))
    .map((skill) => ({
      skill,
      relevance: skillRelevanceScore(skill, query),
      domainScoped: normalizeSkillDomains(skill.domains).length > 0,
    }))
    .filter((item) => !retrievalQueryTexts(query).length || item.domainScoped || item.relevance >= 3.8)
    .sort((left, right) => right.relevance - left.relevance)
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
    'Available Skill summaries for the current task and browser domain:',
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
    'Loaded Skills for the current browser context:',
    'Follow these operating instructions only while they remain applicable to the current page. Prefer current page evidence when it contradicts a Skill.',
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
