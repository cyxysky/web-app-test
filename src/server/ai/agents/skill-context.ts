import type { SkillRecord, TestCaseRecord } from '@/server/ai/schemas/test-case.schema';

function compactText(value: string, max = 900) {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function listBlock(title: string, items: string[]) {
  const clean = items.map((item) => compactText(item, 260)).filter(Boolean);
  if (!clean.length) return '';
  return [`${title}:`, ...clean.map((item, index) => `${index + 1}. ${item}`)].join('\n');
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

export function runtimeSkillsForUrl(allSkills: SkillRecord[], explicitlySelected: SkillRecord[], currentUrl: string) {
  const selectedIds = new Set(explicitlySelected.map((skill) => skill.id));
  return activeSkills([
    ...explicitlySelected,
    ...allSkills.filter((skill) => !selectedIds.has(skill.id) && skillMatchesUrl(skill, currentUrl)),
  ]);
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

export function formatSkillsForPrompt(skills: SkillRecord[]) {
  const selected = activeSkills(skills);
  if (!selected.length) return '';
  return [
    'Loaded reusable Skills for the current browser domain:',
    'A Skill may be loaded automatically by domain or explicitly referenced by the user.',
    'Use these Skills as semantic operating guidance only. Do not copy old ids, coordinates, screenshots, run ids, or raw tool inputs. Prefer current page evidence when it contradicts a Skill.',
    ...selected.map((skill, index) => [
      '',
      `Skill ${index + 1} (referenced by <skills id="${index + 1}">): ${skill.title}`,
      `Description: ${compactText(skill.description, 360)}`,
      listBlock('Workflow', skill.content.workflow),
      listBlock('Recovery', skill.content.recovery),
      listBlock('Verification', skill.content.verification),
    ].filter(Boolean).join('\n')),
  ].join('\n');
}

export function withSkillContext(testCase: TestCaseRecord, skills: SkillRecord[]) {
  const skillContext = formatSkillsForPrompt(skills);
  if (!skillContext) return testCase;
  return {
    ...testCase,
    content: {
      ...testCase.content,
      systemPrompt: [
        testCase.content.systemPrompt,
        skillContext,
      ].filter(Boolean).join('\n\n'),
    },
  };
}
