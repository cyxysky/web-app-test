import { describe, expect, it } from 'vitest';
import { resolveLibreOfficeExecutable } from './libreoffice';
import { inspectUnoApi } from './uno-program';

describe('UNO cookbook ownership boundaries', () => {
  it('keeps entrypoint invocation and low-level output storage worker-owned', async () => {
    if (!await resolveLibreOfficeExecutable()) return;
    const api = await inspectUnoApi({ documentType: 'presentation', limit: 1 });
    const cookbook = api.cookbook as {
      completeExistingDocumentModification?: string;
      operations?: Record<string, string>;
      rules?: string[];
    };
    expect(cookbook.rules?.some((rule) => rule.includes('never append create_document(None)'))).toBe(true);
    expect(cookbook.operations?.save).not.toMatch(/store(?:To|As)URL/);
    expect(cookbook.completeExistingDocumentModification).not.toMatch(/store(?:To|As)URL/);
    expect(cookbook.completeExistingDocumentModification).toContain('layout.save()');
  });
});
