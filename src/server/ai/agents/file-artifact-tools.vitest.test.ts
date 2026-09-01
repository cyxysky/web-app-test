import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyUnoDraftPatch,
  applyUnoDraftPatchHunks,
  downloadFileArtifact,
  editUnoFileArtifact,
  formatFileArtifactResult,
  generatedVerificationIssues,
  generateUnoFileArtifact,
  getUnoApi,
  planFileArtifact,
  readUnoDraft,
  recordOfficeVisualQaProgress,
  sourceUnitsForDraft,
} from './file-artifact-tools';
import { resolveLibreOfficeExecutable } from '@/server/files/libreoffice';

const roots: string[] = [];

async function editDraftText(input: {
  documentId: string;
  newText: string;
  oldText: string;
  path?: string;
  runId: string;
}) {
  const read = await readUnoDraft({ documentId: input.documentId, path: input.path, runId: input.runId });
  const state = JSON.parse(read.actual || '{}') as { patchBaseDigest?: string; program?: string };
  const program = state.program || '';
  const index = program.indexOf(input.oldText);
  if (index < 0) throw new Error(`Test patch target not found: ${input.oldText}`);
  const oldLines = input.oldText.replace(/\r\n?/g, '\n').split('\n');
  const newLines = input.newText.replace(/\r\n?/g, '\n').split('\n');
  return editUnoFileArtifact({
    documentId: input.documentId,
    path: input.path,
    baseDigest: state.patchBaseDigest,
    patch: [
      '*** Begin Patch',
      '*** Update File: draft.py',
      '@@',
      ...oldLines.map((line) => `-${line}`),
      ...newLines.map((line) => `+${line}`),
      '*** End Patch',
    ].join('\n'),
    runId: input.runId,
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe('UNO file tool policies', () => {
  it('indexes every high-level deck.slide block even when the same slide variable is reused', () => {
    const units = sourceUnitsForDraft([
      'def create_document(job):',
      "    deck = job.presentation('deck')",
      "    s = deck.slide('cover', title='Cover')",
      "    s.add_text('title', 'Cover', box=(1, 1, 4, 1))",
      "    s = deck.slide('agenda', title='Agenda')",
      "    s.add_text('body', 'Agenda', box=(1, 2, 4, 1))",
      "    s = deck.slide('closing', title='Closing')",
      "    s.add_text('body', 'Closing', box=(1, 2, 4, 1))",
      '    deck.save()',
      '    deck.close()',
    ].join('\n'), { documentType: 'presentation', generator: 'uno' });

    expect(units.map((unit) => unit.path)).toEqual(['pages/cover', 'pages/agenda', 'pages/closing']);
    expect(units[1].content).toContain('Agenda');
    expect(units[1].content).not.toContain('Cover');
    expect(units[1].content).not.toContain('Closing');
  });

  it('uses unit-relative bounded reads, clamps EOF, and returns a draft-wide patch digest', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'webpilot-unit-relative-read-'));
    roots.push(root);
    const previousArtifacts = process.env.ARTIFACTS_DIR;
    process.env.ARTIFACTS_DIR = root;
    try {
      await planFileArtifact({
        documentId: 'unit-relative-read', documentType: 'word', fileName: 'unit-relative-read.docx', runId: 'chat_test',
      });
      const metadataPath = path.join(root, 'chat_test', 'document-drafts', 'unit-relative-read.json');
      const draft = JSON.parse(await readFile(metadataPath, 'utf8')) as Record<string, unknown>;
      const program = [
        '# @webpilot-unit symbols/helper',
        'def helper():',
        '    return 1',
        '# @webpilot-endunit',
        '',
        'def create_document(job):',
        "    document = job.writer('document')",
        "    document.add_paragraph('body', 'Unit read')",
        '    document.save()',
        '    document.close()',
      ].join('\n');
      const digest = createHash('sha256').update(program).digest('hex');
      await writeFile(metadataPath, JSON.stringify({ ...draft, program, sourceDigest: digest }), 'utf8');

      const read = await readUnoDraft({
        documentId: 'unit-relative-read', path: 'symbols/helper', startLine: 1, endLine: 999, runId: 'chat_test',
      });
      expect(read.ok, read.actual).toBe(true);
      const payload = JSON.parse(read.actual || '{}') as {
        patchBaseDigest?: string;
        program?: string;
        sourceDigest?: string;
        sourceUnitDigest?: string;
        sourceUnitGlobalLines?: { startLine?: number; endLine?: number };
        sourceLineRange?: {
          coordinateSpace?: string;
          endLine?: number;
          globalEndLine?: number;
          globalStartLine?: number;
          startLine?: number;
          unitLineCount?: number;
        };
      };
      expect(payload.program).toContain('def helper():');
      expect(payload.sourceLineRange).toMatchObject({
        coordinateSpace: 'unit', startLine: 1, endLine: payload.sourceLineRange?.unitLineCount,
        globalStartLine: payload.sourceUnitGlobalLines?.startLine,
        globalEndLine: payload.sourceUnitGlobalLines?.endLine,
      });
      expect(payload.patchBaseDigest).toBe(digest);
      expect(payload.sourceUnitDigest).toBe(payload.sourceDigest);
      expect(payload.sourceUnitDigest).not.toBe(digest);

      const fallbackRead = await readUnoDraft({
        documentId: 'unit-relative-read', path: 'unit-relative-read.py', startLine: 8, endLine: 999, runId: 'chat_test',
      });
      expect(fallbackRead.ok, fallbackRead.actual).toBe(true);
      const fallbackPayload = JSON.parse(fallbackRead.actual || '{}') as {
        program?: string;
        readFallbackGuidance?: string;
        requestedPathIgnored?: string;
        sourceLineRange?: { endLine?: number };
      };
      expect(fallbackPayload.requestedPathIgnored).toBe('unit-relative-read.py');
      expect(fallbackPayload.sourceLineRange?.endLine).toBe(10);
      expect(fallbackPayload.program).toContain('document.close()');
      expect(fallbackPayload.readFallbackGuidance).toContain('complete draft');

      const edited = await editUnoFileArtifact({
        documentId: 'unit-relative-read',
        baseDigest: payload.patchBaseDigest,
        patch: [
          '*** Begin Patch',
          '*** Update File: draft.py',
          '@@',
          '-    return 1',
          '+    return (',
          '*** End Patch',
        ].join('\n'),
        render: false,
        runId: 'chat_test',
      });
      expect(edited.ok).toBe(true);
      expect(edited.actual).not.toContain('PATCH_BASE_DIGEST_MISMATCH');
      const after = await readUnoDraft({ documentId: 'unit-relative-read', runId: 'chat_test' });
      expect(after.actual).toContain('return (');
    } finally {
      if (previousArtifacts === undefined) delete process.env.ARTIFACTS_DIR;
      else process.env.ARTIFACTS_DIR = previousArtifacts;
    }
  });

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

  it('groups repeated layout failures from one helper source line', () => {
    const formatted = formatFileArtifactResult('file', JSON.stringify({
      kind: 'uno-draft-validation',
      documentId: 'large-deck',
      validation: 'failed',
      diagnostics: [
        { code: 'PRESENTATION_TEXT_OVERFLOW', severity: 'error', line: 48, elementId: 'slide-1/footer', message: 'Footer does not fit. Affected runtime elements (1): slide-1/footer.', sourceExcerpt: '> 48 | slide.add_text(...)' },
        { code: 'PRESENTATION_TEXT_OVERFLOW', severity: 'error', line: 48, elementId: 'slide-2/footer', message: 'Footer does not fit. Affected runtime elements (1): slide-2/footer.', sourceExcerpt: '> 48 | slide.add_text(...)' },
      ],
    })) || '';

    expect(formatted).toContain('[affected=2]');
    expect(formatted.match(/PRESENTATION_TEXT_OVERFLOW/g)).toHaveLength(1);
    expect(formatted).toContain('slide-1/footer,slide-2/footer');
  });

  it('applies Codex patches while preserving indentation on fuzzy-matched context', () => {
    const source = [
      'def create_document(job):',
      '    if enabled:',
      '        title = "Old"',
      '        body = "Keep"',
      '    deck.save()',
      '',
    ].join('\n');
    const patched = applyUnoDraftPatch(source, [
      '*** Begin Patch',
      '*** Update File: draft.py',
      '@@',
      ' if enabled:',
      '-        title = "Old"',
      '+        title = "New"',
      ' body = "Keep"',
      '*** End Patch',
    ].join('\n'));
    expect(patched).toBe(source.replace('"Old"', '"New"'));
    expect(() => applyUnoDraftPatch(source, [
      '*** Begin Patch',
      '*** Update File: other.py',
      '@@',
      '-        title = "Old"',
      '+        title = "New"',
      '*** End Patch',
    ].join('\n'))).toThrow(/only the staged file named 'draft\.py'/);
  });

  it('applies multiple independent patch hunks atomically and preserves indentation', () => {
    const source = [
      'def create_document(job):',
      '    if enabled:',
      '        title = "Old"',
      '        body = "Keep"',
      '    deck.save()',
      '',
    ].join('\n');
    const patched = applyUnoDraftPatch(source, [
      '*** Begin Patch',
      '*** Update File: draft.py',
      '@@',
      '     if enabled:',
      '-        title = "Old"',
      '+        title = "New"',
      '@@',
      '         body = "Keep"',
      '-    deck.save()',
      '+    deck.save(validate=True)',
      '*** End Patch',
    ].join('\n'));

    expect(patched).toBe([
      'def create_document(job):',
      '    if enabled:',
      '        title = "New"',
      '        body = "Keep"',
      '    deck.save(validate=True)',
      '',
    ].join('\n'));
    expect(source).toContain('        title = "Old"');
  });

  it('keeps successful independent hunks when one hunk has stale context', () => {
    const source = [
      'def create_document(job):',
      '    title = "Old"',
      '    body = "Current"',
      '    deck.save()',
      '',
    ].join('\n');
    const result = applyUnoDraftPatchHunks(source, [
      '*** Begin Patch',
      '*** Update File: draft.py',
      '@@',
      '-    title = "Old"',
      '+    title = "New"',
      '@@',
      '-    body = "Stale"',
      '+    body = "Replacement"',
      '@@',
      '-    deck.save()',
      '+    deck.save(validate=True)',
      '*** End Patch',
    ].join('\n'));

    expect(result.source).toContain('    title = "New"');
    expect(result.source).toContain('    body = "Current"');
    expect(result.source).toContain('    deck.save(validate=True)');
    expect(result).toMatchObject({ appliedHunks: 2, totalHunks: 3 });
    expect(result.failedHunks).toHaveLength(1);
    expect(result.failedHunks[0]).toMatchObject({ hunk: 2 });
  });

  it('allows distant atomic hunks without treating their span as a full replacement', () => {
    const source = Array.from({ length: 240 }, (_, index) => `line ${index + 1}`).join('\n') + '\n';
    const patch = [
      '*** Begin Patch',
      '*** Update File: draft.py',
      ...Array.from({ length: 12 }, (_, index) => {
        const lineNumber = 1 + index * 20;
        return ['@@', `-line ${lineNumber}`, `+LINE ${lineNumber}`];
      }).flat(),
      '*** End Patch',
    ].join('\n');

    const patched = applyUnoDraftPatch(source, patch);
    for (let index = 0; index < 12; index += 1) {
      const lineNumber = 1 + index * 20;
      expect(patched).toMatch(new RegExp(`^LINE ${lineNumber}$`, 'm'));
    }
  });

  it('applies long hunks without model-supplied line counts', () => {
    const oldLines = Array.from({ length: 18 }, (_, index) => `    value_${index + 1} = 'old'`);
    const newLines = oldLines.map((line) => line.replace("'old'", "'new'"));
    const source = ['def create_document(job):', ...oldLines, ''].join('\n');
    const patched = applyUnoDraftPatch(source, [
      '*** Begin Patch',
      '*** Update File: draft.py',
      '@@ def create_document(job):',
      ...oldLines.map((line) => `-${line}`),
      ...newLines.map((line) => `+${line}`),
      '*** End Patch',
    ].join('\n'));
    expect(patched).toBe(['def create_document(job):', ...newLines, ''].join('\n'));
  });

  it('clamps a bounded read endLine to the current source EOF', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'webpilot-read-eof-clamp-'));
    roots.push(root);
    const previousArtifacts = process.env.ARTIFACTS_DIR;
    process.env.ARTIFACTS_DIR = root;
    try {
      await planFileArtifact({
        documentId: 'read-eof-clamp', documentType: 'presentation', fileName: 'clamp.pptx', runId: 'chat_test',
      });
      const metadataPath = path.join(root, 'chat_test', 'document-drafts', 'read-eof-clamp.json');
      const draft = JSON.parse(await readFile(metadataPath, 'utf8')) as Record<string, unknown>;
      const program = Array.from({ length: 10 }, (_, index) => `# source line ${index + 1}`).join('\n');
      const digest = createHash('sha256').update(program).digest('hex');
      await writeFile(metadataPath, JSON.stringify({
        ...draft,
        program,
        sourceDigest: digest,
        workflow: { state: 'authoring', checkpointAt: new Date().toISOString() },
      }), 'utf8');

      const result = await readUnoDraft({
        documentId: 'read-eof-clamp', startLine: 8, endLine: 20, runId: 'chat_test',
      });
      expect(result.ok).toBe(true);
      const payload = JSON.parse(result.actual || '{}') as {
        program?: string;
        sourceLineRange?: { startLine?: number; endLine?: number; totalSourceLines?: number };
      };
      expect(payload.sourceLineRange).toMatchObject({ startLine: 8, endLine: 10, totalSourceLines: 10 });
      expect(payload.program).toBe('# source line 8\n# source line 9\n# source line 10');
    } finally {
      if (previousArtifacts === undefined) delete process.env.ARTIFACTS_DIR;
      else process.env.ARTIFACTS_DIR = previousArtifacts;
    }
  });

  it('returns every distinct layout overlap instead of stopping or clustering', () => {
    const issues = generatedVerificationIssues({
      elementMap: [
        { elementId: 'slide/body', line: 10, locator: { slide: 1, shape: 1 } },
        { elementId: 'slide/card-a', line: 20, locator: { slide: 1, shape: 2 } },
        { elementId: 'slide/card-b', line: 30, locator: { slide: 1, shape: 3 } },
      ],
      verification: {
        issues: ['card-a', 'card-b'].map((card, index) => ({
          description: `overlap ${index + 1}`,
          elementIds: ['slide/body', `slide/${card}`],
          page: 1,
          severity: 'error',
          type: 'text_overlap',
        })),
      },
    });
    expect(issues.map((issue) => issue.elementIds)).toEqual([
      ['slide/body', 'slide/card-a'],
      ['slide/body', 'slide/card-b'],
    ]);
  });

  it('caps same-origin concurrency and retries 429 without a 30-second wait', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'webpilot-download-concurrency-'));
    roots.push(root);
    const previousArtifacts = process.env.ARTIFACTS_DIR;
    const previousFetch = globalThis.fetch;
    process.env.ARTIFACTS_DIR = root;
    let active = 0;
    let maximumActive = 0;
    let calls = 0;
    globalThis.fetch = async (input) => {
      calls += 1;
      if (String(input).endsWith('/limited.txt')) {
        return new Response('limited', { status: 429, headers: { 'retry-after': '30' } });
      }
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
      return new Response(String(input), { status: 200, headers: { 'content-type': 'text/plain' } });
    };
    try {
      const downloads = await Promise.all([
        downloadFileArtifact({ runId: 'chat_test', url: 'https://assets.example/a.txt', fileType: 'txt' }),
        downloadFileArtifact({ runId: 'chat_test', url: 'https://assets.example/b.txt', fileType: 'txt' }),
        downloadFileArtifact({ runId: 'chat_test', url: 'https://assets.example/c.txt', fileType: 'txt' }),
        downloadFileArtifact({ runId: 'chat_test', url: 'https://assets.example/d.txt', fileType: 'txt' }),
      ]);
      expect(downloads.every((result) => result.ok)).toBe(true);
      expect(maximumActive).toBe(2);
      const before429 = Date.now();
      const limited = await downloadFileArtifact({
        runId: 'chat_test', url: 'https://assets.example/limited.txt', fileType: 'txt',
      });
      expect(limited.ok).toBe(false);
      expect(limited.actual).toContain('HTTP 429');
      expect(limited.actual).toContain('instead of sleeping');
      expect(Date.now() - before429).toBeLessThan(4_000);
      expect(calls).toBe(6);
    } finally {
      globalThis.fetch = previousFetch;
      if (previousArtifacts === undefined) delete process.env.ARTIFACTS_DIR;
      else process.env.ARTIFACTS_DIR = previousArtifacts;
    }
  });

  it('routes Wikimedia thumbnails through the official thumb CDN with identifiable request headers', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'webpilot-download-wikimedia-'));
    roots.push(root);
    const previousArtifacts = process.env.ARTIFACTS_DIR;
    const previousFetch = globalThis.fetch;
    process.env.ARTIFACTS_DIR = root;
    let seenUrl = '';
    let seenHeaders: Headers | undefined;
    globalThis.fetch = async (input, init) => {
      seenUrl = String(input);
      seenHeaders = new Headers(init?.headers);
      return new Response('image-bytes', { status: 200, headers: { 'content-type': 'image/jpeg' } });
    };
    try {
      const downloaded = await downloadFileArtifact({
        runId: 'chat_test',
        fileName: 'webb.jpg',
        fileType: 'jpg',
        url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/b/bf/Webb.jpg/1280px-Webb.jpg',
      });
      expect(downloaded.ok, downloaded.actual).toBe(true);
      expect(seenUrl).toBe('https://thumb.wikimedia.org/wikipedia/commons/thumb/b/bf/Webb.jpg/1280px-Webb.jpg');
      expect(seenHeaders?.get('referer')).toBe('https://commons.wikimedia.org/');
      expect(seenHeaders?.get('user-agent')).toContain('WebPilot-Office-Artifact');
    } finally {
      globalThis.fetch = previousFetch;
      if (previousArtifacts === undefined) delete process.env.ARTIFACTS_DIR;
      else process.env.ARTIFACTS_DIR = previousArtifacts;
    }
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

      const firstRepair = await editDraftText({
        documentId: 'cumulative-syntax',
        oldText: '    if (',
        newText: '    pass  # first repair',
        runId: 'chat_test',
      });
      expect(firstRepair.ok).toBe(true);
      expect(JSON.parse(firstRepair.actual || '{}')).toMatchObject({ editStatus: 'patch-applied', changed: true, saved: true });
      const afterFirstRepair = await readUnoDraft({ documentId: 'cumulative-syntax', runId: 'chat_test' });
      expect(afterFirstRepair.actual).toContain('first repair');
      expect(afterFirstRepair.actual).toContain('while (');

      const secondRepair = await editDraftText({
        documentId: 'cumulative-syntax',
        oldText: '    while (',
        newText: '    pass  # second repair',
        runId: 'chat_test',
      });
      expect(secondRepair.ok).toBe(true);
      expect(JSON.parse(secondRepair.actual || '{}')).toMatchObject({ editStatus: 'patch-applied', changed: true, saved: true });
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

  it('uses one current source and guards every later full-source replacement', async () => {
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
      expect(JSON.parse(replacement.actual || '{}').code).toBe('DESTRUCTIVE_GENERATE_REQUIRES_CONFIRMATION');
      const beforeReplacement = JSON.parse((await readUnoDraft({
        documentId: 'single-source', runId: 'chat_test',
      })).actual || '{}') as Record<string, unknown> & { patchBaseDigest?: string; program?: string };
      expect(beforeReplacement.program).toContain('return 1');
      const intentionalReplacement = await generateUnoFileArtifact({
        documentId: 'single-source',
        program: 'def wrong_entrypoint(job):\n    return 2',
        replaceExisting: true,
        baseDigest: beforeReplacement.patchBaseDigest,
        runId: 'chat_test',
      });
      expect(intentionalReplacement.ok).toBe(false);
      const afterGenerate = JSON.parse((await readUnoDraft({
        documentId: 'single-source', runId: 'chat_test',
      })).actual || '{}') as Record<string, unknown> & { program?: string };
      expect(afterGenerate.program).toContain('return 2');
      expect(afterGenerate).not.toHaveProperty('currentRevision');
      expect(afterGenerate).not.toHaveProperty('validatedRevision');
      expect(afterGenerate).not.toHaveProperty('revisions');

      const edited = await editDraftText({
        documentId: 'single-source',
        oldText: '    return 2',
        newText: '    return 3',
        runId: 'chat_test',
      });
      expect(edited.ok).toBe(true);
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

  it('blocks a failed tiny generate from destroying a large editable draft', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'webpilot-uno-destructive-generate-'));
    roots.push(root);
    const previousArtifacts = process.env.ARTIFACTS_DIR;
    const previousMode = process.env.OFFICE_GENERATION_MODE;
    process.env.ARTIFACTS_DIR = root;
    process.env.OFFICE_GENERATION_MODE = 'uno';
    try {
      await planFileArtifact({
        documentId: 'protected-source', documentType: 'word', fileName: 'protected.docx', runId: 'chat_test',
      });
      const largeInvalidSource = [
        'def wrong_entrypoint(job):',
        '    return 1',
        ...Array.from({ length: 180 }, (_, index) => `# retained source line ${index + 1}`),
      ].join('\n');
      const initial = await generateUnoFileArtifact({
        documentId: 'protected-source', program: largeInvalidSource, runId: 'chat_test',
      });
      expect(initial.ok).toBe(false);
      const destructive = await generateUnoFileArtifact({
        documentId: 'protected-source', program: 'def wrong_entrypoint(job):\n    return 2', runId: 'chat_test',
      });
      expect(destructive.ok).toBe(false);
      expect(JSON.parse(destructive.actual || '{}')).toMatchObject({
        code: 'DESTRUCTIVE_GENERATE_REQUIRES_CONFIRMATION',
        changed: false,
        saved: false,
      });
      const current = JSON.parse((await readUnoDraft({
        documentId: 'protected-source', runId: 'chat_test',
      })).actual || '{}') as { program?: string };
      expect(current.program).toContain('# retained source line 180');
      expect(current.program).not.toContain('return 2');
    } finally {
      if (previousArtifacts === undefined) delete process.env.ARTIFACTS_DIR;
      else process.env.ARTIFACTS_DIR = previousArtifacts;
      if (previousMode === undefined) delete process.env.OFFICE_GENERATION_MODE;
      else process.env.OFFICE_GENERATION_MODE = previousMode;
    }
  });

  it('validates an explicitly scoped patch as its exact slide unit', async () => {
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
      const edited = await editDraftText({
        documentId: 'auto-unit',
        oldText: "    deck.add_text('slide-02/body', page, 'Second', 1000, 1000, 7000, 1400, font_size=18)",
        newText: "    deck.add_text('slide-02/body', page, 'Second updated', 1000, 1000, 7000, 1400, font_size=18)",
        path: 'pages/slide-002',
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
        const edited = await editDraftText({
          documentId: 'no-repair-fuse',
          oldText: `    return ${attempt === 2 ? 0 : attempt - 1}`,
          newText: `    return ${attempt}`,
          runId: 'chat_test',
        });
        expect(edited.ok).toBe(true);
        const payload = JSON.parse(edited.actual || '{}') as {
          editStatus?: string;
          kind?: string;
          requiredNextAction?: string;
          validationFailureCount?: number;
        };
        expect(payload.kind).toBe('uno-draft-validation');
        expect(payload.editStatus).toBe('patch-applied');
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

  it('returns and caches exact Office facade modules on recovery calls', async () => {
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
      expect(firstPayload.capabilities?.length).toBeGreaterThan(0);
      const repeated = await getUnoApi({ documentId: 'api-unlimited', query: 'chart', runId: 'chat_test' });
      const repeatedPayload = JSON.parse(repeated.actual || '{}') as {
        alreadyLoaded?: boolean; apiReference?: unknown[]; examples?: Record<string, string>; kind?: string;
      };
      expect(repeatedPayload.kind).toBe('uno-api');
      expect(repeatedPayload.alreadyLoaded).toBe(false);
      expect(repeatedPayload.apiReference?.length).toBeGreaterThan(0);
      expect(repeatedPayload.examples?.nativeColumnChart).toContain('show_legend=True');
      const chartAgain = await getUnoApi({ documentId: 'api-unlimited', query: 'chart', runId: 'chat_test' });
      expect(JSON.parse(chartAgain.actual || '{}').alreadyLoaded).toBe(true);
    } finally {
      if (previousArtifacts === undefined) delete process.env.ARTIFACTS_DIR;
      else process.env.ARTIFACTS_DIR = previousArtifacts;
      if (previousMode === undefined) delete process.env.OFFICE_GENERATION_MODE;
      else process.env.OFFICE_GENERATION_MODE = previousMode;
    }
  }, 60_000);
});
