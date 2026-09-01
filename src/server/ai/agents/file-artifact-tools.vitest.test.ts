import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyUnoDraftLineEdits,
  editUnoFileArtifact,
  formatFileArtifactResult,
  generateUnoFileArtifact,
  getUnoApi,
  planFileArtifact,
  readUnoDraft,
  recordOfficeVisualQaProgress,
} from './file-artifact-tools';
import { resolveLibreOfficeExecutable } from '@/server/files/libreoffice';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe('UNO file tool policies', () => {
  it('requires evidence-backed page checks and a passed cross-page review before completing visual QA', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'webpilot-visual-quality-gate-'));
    roots.push(root);
    const previousArtifacts = process.env.ARTIFACTS_DIR;
    process.env.ARTIFACTS_DIR = root;
    try {
      await planFileArtifact({ documentId: 'visual-gate', documentType: 'word', fileName: 'visual-gate.docx', runId: 'chat_test' });
      const metadataPath = path.join(root, 'chat_test', 'document-drafts', 'visual-gate.json');
      const draft = JSON.parse(await readFile(metadataPath, 'utf8')) as Record<string, unknown>;
      const program = "def create_document(job):\n    document = job.writer('document')\n    document.add_paragraph('body', 'Visual QA')\n    document.save()\n    document.close()";
      const digest = createHash('sha256').update(program).digest('hex');
      const artifactId = `chat_test/generated/visual-gate/${digest}/visual-gate.docx`;
      await writeFile(metadataPath, JSON.stringify({
        ...draft,
        program,
        sourceDigest: digest,
        renderedArtifactId: artifactId,
        renderedDigest: digest,
        renderedSourceDigest: digest,
        workflow: { state: 'qa-pending', checkpointAt: new Date().toISOString(), renderedDigest: digest },
      }), 'utf8');
      await recordOfficeVisualQaProgress({
        action: 'read', artifactId, runId: 'chat_test',
        result: { ok: true, actual: JSON.stringify({ kind: 'file-visual-read', screenshotCount: 1, screenshots: [{ pageNumber: 1, screenshotDigest: 'a'.repeat(64) }] }) },
      });
      const bare = await recordOfficeVisualQaProgress({
        action: 'report', artifactId, runId: 'chat_test',
        result: { ok: true, actual: JSON.stringify({ kind: 'file-visual-report', reviews: [{ pageNumber: 1, status: 'passed', issues: [] }] }) },
      });
      expect(bare.ok).toBe(false);
      expect(bare.actual).toContain('concrete visual observation');

      const pageChecks = {
        overlap: 'passed', clipping: 'passed', alignment: 'passed', spacing: 'passed',
        typography: 'passed', contrast: 'passed', visualHierarchy: 'passed',
        chartTableLegibility: 'not-applicable', imageQuality: 'not-applicable',
      };
      const pageOnly = await recordOfficeVisualQaProgress({
        action: 'report', artifactId, runId: 'chat_test',
        result: { ok: true, actual: JSON.stringify({ kind: 'file-visual-report', reviews: [{ pageNumber: 1, status: 'passed', observation: 'The title, body, margins, and footer are visibly balanced and readable at preview scale.', checks: pageChecks, issues: [] }] }) },
      });
      expect(JSON.parse(pageOnly.actual || '{}').visualQa).toMatchObject({ complete: false, deckReviewStatus: null });

      const completed = await recordOfficeVisualQaProgress({
        action: 'report', artifactId, runId: 'chat_test',
        result: { ok: true, actual: JSON.stringify({
          kind: 'file-visual-report',
          reviews: [{ pageNumber: 1, status: 'passed', observation: 'The title, body, margins, and footer remain visibly balanced and readable at preview scale.', checks: pageChecks, issues: [] }],
          deckReview: {
            status: 'passed',
            observation: 'Across the complete rendered artifact, typography, color, spacing rhythm, and component styling form one consistent visual system.',
            checks: { templateConsistency: 'passed', typographyConsistency: 'passed', colorConsistency: 'passed', spacingRhythm: 'passed', componentConsistency: 'passed' },
            issues: [],
          },
        }) },
      });
      expect(JSON.parse(completed.actual || '{}').visualQa).toMatchObject({ complete: true, deckReviewStatus: 'passed', visualQaDigest: digest });
    } finally {
      if (previousArtifacts === undefined) delete process.env.ARTIFACTS_DIR;
      else process.env.ARTIFACTS_DIR = previousArtifacts;
    }
  });

  it('tells the model to render immediately after full validation passes', () => {
    const formatted = formatFileArtifactResult('file', JSON.stringify({
      kind: 'uno-draft-validation',
      documentId: 'ready-deck',
      fileName: 'ready.pptx',
      sourceCharacters: 24000,
      validationStatus: 'passed',
      requiredNextAction: 'render',
      automaticValidation: { passed: true, issues: [] },
    }));
    expect(formatted).toContain('Office source validated');
    expect(formatted).toContain('requiredNextAction=render');
  });

  it('compacts successful page-unit validation instead of returning its complete diagnostics payload', () => {
    const formatted = formatFileArtifactResult('file', JSON.stringify({
      kind: 'office-source-unit-validation',
      documentId: 'large-deck',
      sourceUnitPath: 'pages/slide-021',
      validation: 'passed',
      requiredNextAction: 'Continue editing other units, or call render for final full-document validation and publication.',
      automaticValidation: { passed: true, issues: [] },
    }));
    expect(formatted).toContain('Office source unit validated');
    expect(formatted).toContain('sourceUnitPath=pages/slide-021');
    expect(formatted).not.toContain('automaticValidation');
  });

  it('combines line and exact-text edits in one deterministic atomic batch', () => {
    expect(applyUnoDraftLineEdits('one\ntwo\nthree\nfour\n', [
      { kind: 'replaceText', oldText: 'one-detail', newText: 'ONE-DETAIL' },
      { kind: 'insertAfter', line: 1, newText: 'one-detail' },
      { kind: 'replaceRange', startLine: 3, endLine: 3, newText: 'THREE' },
    ])).toBe('one\nONE-DETAIL\ntwo\nTHREE\nfour\n');
  });

  it('treats an already-satisfied replaceAll as an idempotent no-op inside an atomic batch', () => {
    expect(applyUnoDraftLineEdits("style={'font_size': 1, 'background': 'card'}\n", [
      { kind: 'replaceAll', oldText: ", 'background': 'card'", newText: '' },
      { kind: 'replaceAll', oldText: ", 'background': 'card',", newText: ',' },
      { kind: 'replaceAll', oldText: "'missing-background'", newText: "'clean'" },
    ])).toBe("style={'font_size': 1}\n");
  });

  it('keeps replaceRange indentation exact unless relative indentation is explicitly requested', () => {
    const source = [
      'def create_document(job):',
      '    # old slide',
      "    page = deck.add_slide('old')",
      '    deck.save()',
      '',
    ].join('\n');
    expect(applyUnoDraftLineEdits(source, [{
      kind: 'replaceRange',
      startLine: 2,
      endLine: 3,
      newText: [
        '# replacement heading',
        "    page = deck.add_slide('slide-08')",
        '    chart_box = deck.content_box()',
      ].join('\n'),
    }])).toBe([
      'def create_document(job):',
      '# replacement heading',
      "    page = deck.add_slide('slide-08')",
      '    chart_box = deck.content_box()',
      '    deck.save()',
      '',
    ].join('\n'));
    expect(applyUnoDraftLineEdits(source, [{
      kind: 'replaceRange',
      startLine: 2,
      endLine: 3,
      preserveIndent: true,
      newText: "if enabled:\n    page = deck.add_slide('slide-08')",
    }])).toContain("    if enabled:\n        page = deck.add_slide('slide-08')");
  });

  it('persists partial syntax repairs while other source errors remain', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'webpilot-uno-cumulative-syntax-'));
    roots.push(root);
    const previousArtifacts = process.env.ARTIFACTS_DIR;
    const previousMode = process.env.OFFICE_GENERATION_MODE;
    process.env.ARTIFACTS_DIR = root;
    process.env.OFFICE_GENERATION_MODE = 'uno';
    try {
      await planFileArtifact({
        documentId: 'cumulative-syntax', documentType: 'word', fileName: 'cumulative.docx', runId: 'chat_test',
      });
      const generated = await generateUnoFileArtifact({
        documentId: 'cumulative-syntax',
        program: 'def wrong_entrypoint(job):\n    if (\n    while (',
        runId: 'chat_test',
      });
      expect(generated.ok).toBe(false);

      const firstRepair = await editUnoFileArtifact({
        documentId: 'cumulative-syntax',
        edits: [{ kind: 'replaceText', oldText: '    if (', newText: '    pass  # first repair' }],
        runId: 'chat_test',
      });
      expect(firstRepair.ok).toBe(false);
      expect(JSON.parse(firstRepair.actual || '{}')).toMatchObject({ changed: true, saved: true });
      const afterFirstRepair = await readUnoDraft({ documentId: 'cumulative-syntax', runId: 'chat_test' });
      expect(afterFirstRepair.actual).toContain('first repair');
      expect(afterFirstRepair.actual).toContain('while (');

      const secondRepair = await editUnoFileArtifact({
        documentId: 'cumulative-syntax',
        edits: [{ kind: 'replaceText', oldText: '    while (', newText: '    pass  # second repair' }],
        runId: 'chat_test',
      });
      expect(secondRepair.ok).toBe(false);
      expect(JSON.parse(secondRepair.actual || '{}')).toMatchObject({ changed: true, saved: true });
      const afterSecondRepair = await readUnoDraft({ documentId: 'cumulative-syntax', runId: 'chat_test' });
      expect(afterSecondRepair.actual).toContain('first repair');
      expect(afterSecondRepair.actual).toContain('second repair');
    } finally {
      if (previousArtifacts === undefined) delete process.env.ARTIFACTS_DIR;
      else process.env.ARTIFACTS_DIR = previousArtifacts;
      if (previousMode === undefined) delete process.env.OFFICE_GENERATION_MODE;
      else process.env.OFFICE_GENERATION_MODE = previousMode;
    }
  });

  it('uses one current source per documentId without an edit version handshake', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'webpilot-uno-single-source-'));
    roots.push(root);
    const previousArtifacts = process.env.ARTIFACTS_DIR;
    const previousMode = process.env.OFFICE_GENERATION_MODE;
    process.env.ARTIFACTS_DIR = root;
    process.env.OFFICE_GENERATION_MODE = 'uno';
    try {
      await planFileArtifact({
        documentId: 'single-source', documentType: 'word', fileName: 'single-source.docx', runId: 'chat_test',
      });
      const first = await generateUnoFileArtifact({
        documentId: 'single-source',
        program: 'def wrong_entrypoint(job):\n    return 1',
        runId: 'chat_test',
      });
      expect(first.ok).toBe(false);

      const replacement = await generateUnoFileArtifact({
        documentId: 'single-source',
        program: 'def wrong_entrypoint(job):\n    return 2',
        runId: 'chat_test',
      });
      expect(replacement.ok).toBe(false);
      const afterGenerate = JSON.parse((await readUnoDraft({
        documentId: 'single-source', runId: 'chat_test',
      })).actual || '{}') as Record<string, unknown> & { program?: string };
      expect(afterGenerate.program).toContain('return 2');
      expect(afterGenerate).not.toHaveProperty('currentRevision');
      expect(afterGenerate).not.toHaveProperty('validatedRevision');
      expect(afterGenerate).not.toHaveProperty('revisions');

      const edited = await editUnoFileArtifact({
        documentId: 'single-source',
        edits: [{ kind: 'replaceText', oldText: 'return 2', newText: 'return 3' }],
        runId: 'chat_test',
      });
      expect(edited.ok).toBe(false);
      expect(JSON.parse(edited.actual || '{}').kind).toBe('uno-draft-validation');
      const afterEdit = await readUnoDraft({ documentId: 'single-source', runId: 'chat_test' });
      expect(afterEdit.actual).toContain('return 3');
    } finally {
      if (previousArtifacts === undefined) delete process.env.ARTIFACTS_DIR;
      else process.env.ARTIFACTS_DIR = previousArtifacts;
      if (previousMode === undefined) delete process.env.OFFICE_GENERATION_MODE;
      else process.env.OFFICE_GENERATION_MODE = previousMode;
    }
  });

  it('automatically validates a line-only edit as its exact inferred slide unit', async () => {
    if (!await resolveLibreOfficeExecutable()) return;
    const root = await mkdtemp(path.join(tmpdir(), 'webpilot-uno-auto-unit-'));
    roots.push(root);
    const previousArtifacts = process.env.ARTIFACTS_DIR;
    const previousMode = process.env.OFFICE_GENERATION_MODE;
    process.env.ARTIFACTS_DIR = root;
    process.env.OFFICE_GENERATION_MODE = 'uno';
    try {
      await planFileArtifact({
        documentId: 'auto-unit', documentType: 'presentation', fileName: 'auto-unit.pptx', runId: 'chat_test',
      });
      const program = [
        'def create_document(job):',
        "    deck = job.presentation('deck')",
        "    page = deck.add_slide('slide-01')",
        "    deck.add_text('slide-01/body', page, 'First', 1000, 1000, 7000, 1400, font_size=18)",
        "    page = deck.add_slide('slide-02')",
        "    deck.add_text('slide-02/body', page, 'Second', 1000, 1000, 7000, 1400, font_size=18)",
        '    deck.save()',
        '    deck.close()',
      ].join('\n');
      const generated = await generateUnoFileArtifact({
        documentId: 'auto-unit', program, runId: 'chat_test',
      });
      expect(generated.ok).toBe(true);
      const line = program.split('\n').findIndex((value) => value.includes("'slide-02/body'")) + 1;
      const edited = await editUnoFileArtifact({
        documentId: 'auto-unit',
        edits: [{
          kind: 'replaceRange', startLine: line, endLine: line,
          newText: "    deck.add_text('slide-02/body', page, 'Second updated', 1000, 1000, 7000, 1400, font_size=18)",
        }],
        runId: 'chat_test',
      });
      expect(edited.ok).toBe(true);
      expect(JSON.parse(edited.actual || '{}')).toMatchObject({
        kind: 'office-source-unit-validation',
        sourceUnitPath: 'pages/slide-002',
        validation: 'passed',
      });
    } finally {
      if (previousArtifacts === undefined) delete process.env.ARTIFACTS_DIR;
      else process.env.ARTIFACTS_DIR = previousArtifacts;
      if (previousMode === undefined) delete process.env.OFFICE_GENERATION_MODE;
      else process.env.OFFICE_GENERATION_MODE = previousMode;
    }
  }, 60_000);

  it('keeps failed drafts editable regardless of consecutive failure count', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'webpilot-uno-edit-without-fuse-'));
    roots.push(root);
    const previousArtifacts = process.env.ARTIFACTS_DIR;
    const previousMode = process.env.OFFICE_GENERATION_MODE;
    process.env.ARTIFACTS_DIR = root;
    process.env.OFFICE_GENERATION_MODE = 'uno';
    try {
      await planFileArtifact({
        documentId: 'no-repair-fuse', documentType: 'word', fileName: 'no-repair-fuse.docx', runId: 'chat_test',
      });
      const generated = await generateUnoFileArtifact({
        documentId: 'no-repair-fuse',
        program: 'def wrong_entrypoint(job):\n    return 0',
        runId: 'chat_test',
      });
      expect(JSON.parse(generated.actual || '{}').validationFailureCount).toBe(1);
      for (let attempt = 2; attempt <= 4; attempt += 1) {
        const edited = await editUnoFileArtifact({
          documentId: 'no-repair-fuse',
          edits: [{ startLine: 2, endLine: 2, newText: `    return ${attempt}` }],
          runId: 'chat_test',
        });
        expect(edited.ok).toBe(false);
        const payload = JSON.parse(edited.actual || '{}') as {
          kind?: string;
          requiredNextAction?: string;
          validationFailureCount?: number;
        };
        expect(payload.kind).toBe('uno-draft-validation');
        expect(payload.requiredNextAction).toBe('edit');
        expect(payload.validationFailureCount).toBe(attempt);
      }
    } finally {
      if (previousArtifacts === undefined) delete process.env.ARTIFACTS_DIR;
      else process.env.ARTIFACTS_DIR = previousArtifacts;
      if (previousMode === undefined) delete process.env.OFFICE_GENERATION_MODE;
      else process.env.OFFICE_GENERATION_MODE = previousMode;
    }
  });

  it('returns the complete cached Office facade cookbook on recovery calls', async () => {
    if (!await resolveLibreOfficeExecutable()) return;
    const root = await mkdtemp(path.join(tmpdir(), 'webpilot-uno-api-unlimited-'));
    roots.push(root);
    const previousArtifacts = process.env.ARTIFACTS_DIR;
    const previousMode = process.env.OFFICE_GENERATION_MODE;
    process.env.ARTIFACTS_DIR = root;
    process.env.OFFICE_GENERATION_MODE = 'uno';
    try {
      await planFileArtifact({
        documentId: 'api-unlimited', documentType: 'presentation', fileName: 'api-unlimited.pptx', runId: 'chat_test',
      });
      const first = await getUnoApi({ documentId: 'api-unlimited', query: 'shape', runId: 'chat_test' });
      expect(first.ok).toBe(true);
      const firstPayload = JSON.parse(first.actual || '{}') as {
        kind?: string; nativeReflectionExposed?: boolean; target?: string; capabilities?: unknown[];
      };
      expect(firstPayload.kind).toBe('uno-api');
      expect(firstPayload.target).toBe('facade');
      expect(firstPayload.nativeReflectionExposed).toBe(false);
      expect(firstPayload.capabilities?.length).toBeGreaterThan(10);
      const repeated = await getUnoApi({ documentId: 'api-unlimited', query: 'chart', runId: 'chat_test' });
      const repeatedPayload = JSON.parse(repeated.actual || '{}') as {
        alreadyLoaded?: boolean; apiReference?: unknown[]; examples?: Record<string, string>; kind?: string;
      };
      expect(repeatedPayload.kind).toBe('uno-api');
      expect(repeatedPayload.alreadyLoaded).toBe(true);
      expect(repeatedPayload.apiReference?.length).toBeGreaterThan(20);
      expect(repeatedPayload.examples?.nativeColumnChart).toContain('show_legend=True');
    } finally {
      if (previousArtifacts === undefined) delete process.env.ARTIFACTS_DIR;
      else process.env.ARTIFACTS_DIR = previousArtifacts;
      if (previousMode === undefined) delete process.env.OFFICE_GENERATION_MODE;
      else process.env.OFFICE_GENERATION_MODE = previousMode;
    }
  }, 60_000);
});
