import type { CapabilitySkill } from '@webpilot/capability-sdk';
export const mediaRuntimeSkillId = 'system-media-runtime';
export const mediaRuntimeSkill = Object.freeze({
  id: mediaRuntimeSkillId, title: 'Media Runtime',
  summary: `<system_skill id="${mediaRuntimeSkillId}">Inspect media before expensive processing, use bounded frame/OCR/transcription scopes, and label generated versus source media accurately.</system_skill>`,
  content: `# Media Runtime\n\n- Inspect the source before choosing OCR, transcription, or frame extraction.\n- Use the smallest adequate page, time, language, and frame scope.\n- Preserve timestamps and source references with extracted evidence.\n- OCR and transcription are probabilistic; flag uncertain names, numbers, and inaudible text.\n- Clearly label generated images and never present them as source evidence.`,
  required: true, activation: [{ toolName: 'media', actions: ['inspect', 'extractFrames', 'ocr', 'transcribe', 'generateImage'] }],
} satisfies CapabilitySkill);
