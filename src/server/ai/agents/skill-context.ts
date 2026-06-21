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

function inlineList(items: string[], maxItems = 3, maxChars = 220) {
  return items
    .map((item) => compactText(item, maxChars))
    .filter(Boolean)
    .slice(0, maxItems)
    .join('；');
}

export function activeSkills(skills: SkillRecord[]) {
  return skills.filter((skill) => skill.status === 'ready').slice(0, 8);
}

export function formatSkillReferencesForUser(skills: SkillRecord[]) {
  const selected = activeSkills(skills);
  if (!selected.length) return '';
  return selected.map((skill, index) => [
    `<skills id="${index + 1}">`,
    `Title: ${compactText(skill.title, 120)}`,
    `Description: ${compactText(skill.description, 260)}`,
    skill.tags.length ? `Tags: ${skill.tags.slice(0, 6).join(', ')}` : '',
    skill.triggerPhrases.length ? `Trigger phrases: ${skill.triggerPhrases.slice(0, 6).join(', ')}` : '',
    skill.content.whenToUse.length ? `When to use: ${inlineList(skill.content.whenToUse)}` : '',
    `</skills>`,
  ].filter(Boolean).join('\n')).join('\n\n');
}

export function formatSkillsForPrompt(skills: SkillRecord[]) {
  const selected = activeSkills(skills);
  if (!selected.length) return '';
  return [
    'Loaded reusable Skills:',
    'The latest user message may include compact Skill references such as <skills id="1">...</skills>. Match that id to the detailed Skill with the same number below.',
    'Use referenced Skills to understand the user intent, expected workflow, domain vocabulary, and verification points.',
    'Use these Skills as semantic operating guidance only. Do not copy old ids, coordinates, screenshots, run ids, or raw tool inputs. Prefer current page evidence when it contradicts a Skill.',
    ...selected.map((skill, index) => [
      '',
      `Skill ${index + 1} (referenced by <skills id="${index + 1}">): ${skill.title}`,
      `Description: ${compactText(skill.description, 360)}`,
      skill.triggerPhrases.length ? `Trigger phrases: ${skill.triggerPhrases.join(', ')}` : '',
      skill.tags.length ? `Tags: ${skill.tags.join(', ')}` : '',
      listBlock('When to use', skill.content.whenToUse),
      listBlock('Workflow', skill.content.workflow),
      listBlock('Reusable patterns', skill.content.reusablePatterns),
      listBlock('Cautions', skill.content.cautions),
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
