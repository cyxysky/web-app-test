import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  applyUnoDraftPatch,
  downloadFileArtifact,
  editUnoFileArtifact,
  formatFileArtifactResult,
  generatedRuntimeDiagnostics,
  generatedVerificationIssues,
  generateUnoFileArtifact,
  getOfficeJsApi,
  getUnoApi,
  listOfficeDrafts,
  officeValidationCacheBaseName,
  officeValidationRepairHints,
  pendingOfficeDocumentWork,
  planFileArtifact,
  readUnoDraft,
  recordOfficeVisualQaProgress,
  renderFileArtifact,
  sourceUnitsForDraft,
  syncDocumentAssets,
  verifyCurrentUnoRenderedArtifact,
} from '@webpilot/capability-file/node/workspace';
import { resolveLibreOfficeExecutable } from '@webpilot/capability-file/node';
import { repairFileArtifactDownloadLinks } from '@/server/capabilities/browser-chat-file-links';

const passedPageVisualChecks = {
  overlap: 'passed', clipping: 'passed', alignment: 'passed', spacing: 'passed',
  typography: 'passed', contrast: 'passed', visualHierarchy: 'passed',
  chartTableLegibility: 'not-applicable', imageQuality: 'not-applicable',
} as const;
const passedDeckVisualChecks = {
  templateConsistency: 'passed', typographyConsistency: 'passed', colorConsistency: 'passed',
  spacingRhythm: 'passed', componentConsistency: 'passed',
} as const;

async function editDraftText(input: {
  documentId: string;
  includeVisualVerification?: boolean;
  newText: string;
  oldText: string;
  path?: string;
  render?: boolean;
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
    includeVisualVerification: input.includeVisualVerification,
    render: input.render,
    runId: input.runId,
  });
}

test('uses a LibreOffice-safe non-hidden basename for validation artifacts', () => {
  const digest = 'a'.repeat(64);
  const basename = officeValidationCacheBaseName('jwst-deck', digest);
  assert.equal(basename, `validation-jwst-deck-${digest}`);
  assert.doesNotMatch(basename, /^\./);
});

test('repairs artifact links by artifact ID without trusting the model hostname or link label', () => {
  const tools = [
    {
      name: 'file',
      result: {
        ok: true,
        actual: JSON.stringify({
          artifactId: 'generated/chat_test/report.docx',
          fileName: 'report.docx',
          downloadUrl: '/webpilot/api/artifacts/generated/chat_test/report.docx?download=1',
        }),
      },
    },
    {
      name: 'file',
      result: {
        ok: true,
        actual: JSON.stringify({
          artifactId: 'generated/chat_test/deck.pptx',
          fileName: 'deck.pptx',
          downloadUrl: '/webpilot/api/artifacts/generated/chat_test/deck.pptx?download=1',
        }),
      },
    },
  ];

  const repaired = repairFileArtifactDownloadLinks([
    '[下载](https://chat_test/api/artifacts/generated/chat_test/report.docx?download=1)',
    '[下载](https://invalid.test/api/artifacts/generated/chat_test/deck.pptx?download=1)',
  ].join('\n'), tools);

  assert.equal(repaired, [
    '[下载](/webpilot/api/artifacts/generated/chat_test/report.docx?download=1)',
    '[下载](/webpilot/api/artifacts/generated/chat_test/deck.pptx?download=1)',
  ].join('\n'));
});

const wordProgram = `
def create_document(job):
    document = job.writer('document')
    document.add_paragraph('body', 'Generated through the UNO worker')
    document.save()
    document.close()
`;

test('requires a stable documentId during semantic planning', async () => {
  const planned = await planFileArtifact({ documentType: 'word', fileName: 'report.docx', runId: 'chat_test' });
  assert.equal(planned.ok, false);
  assert.match(planned.actual || '', /stable model-chosen documentId/);
});

test('returns workflow guidance when API inspection or generation is requested before planning', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'webpilot-office-unplanned-'));
  const previous = process.env.ARTIFACTS_DIR;
  process.env.ARTIFACTS_DIR = root;
  try {
    const api = await getOfficeJsApi({
      documentId: 'missing-js-draft',
      documentType: 'presentation',
      runId: 'chat_test',
    });
    assert.equal(api.ok, false);
    assert.match(api.actual || '', /not planned.*action=plan/i);

    const generated = await generateUnoFileArtifact({
      documentId: 'missing-office-draft',
      program: wordProgram,
      render: false,
      runId: 'chat_test',
    });
    assert.equal(generated.ok, false);
    assert.match(generated.actual || '', /not planned.*action=plan/i);
    assert.doesNotMatch(generated.actual || '', /ENOENT|document-drafts/i);
  } finally {
    if (previous === undefined) delete process.env.ARTIFACTS_DIR;
    else process.env.ARTIFACTS_DIR = previous;
    await rm(root, { force: true, recursive: true });
  }
});

test('formats a failed validation as failed instead of validated', () => {
  const formatted = formatFileArtifactResult('file', JSON.stringify({
    kind: 'uno-draft-validation',
    documentId: 'failed-edit',
    fileName: 'failed.docx',
    validation: 'failed',
    saved: true,
    error: 'Syntax error',
    diagnostics: [{
      code: 'PYTHON_SYNTAX',
      line: 51,
      column: 5,
      severity: 'error',
      message: 'expected an indented block',
      sourceExcerpt: '  50 | if ready:\n> 51 | next_step() ',
    }],
    repairHints: ['Read a small range around line 51 and repair that exact block.'],
  }));
  assert.match(formatted || '', /validation failed/i);
  assert.match(formatted || '', /workingSourceSaved=true/);
  assert.match(formatted || '', /PYTHON_SYNTAX@51:5/);
  assert.match(formatted || '', /source=.*51 \| next_step/);
  assert.match(formatted || '', /repairHints=/);
  assert.doesNotMatch(formatted || '', /source validated/i);
});

test('formats a passed draft validation with render as the next action', () => {
  const formatted = formatFileArtifactResult('file', JSON.stringify({
    kind: 'uno-draft-validation',
    documentId: 'ready-deck',
    fileName: 'ready.pptx',
    sourceCharacters: 24000,
    validationStatus: 'passed',
    requiredNextAction: 'render',
    automaticValidation: { passed: true, issues: [] },
  }));
  assert.match(formatted || '', /source validated/i);
  assert.match(formatted || '', /requiredNextAction=render/);
});

test('keeps structural counts and visual gate status in the model-facing artifact summary', () => {
  const formatted = formatFileArtifactResult('file', JSON.stringify({
    kind: 'generated',
    artifactId: 'generated/chat_test/workbook.xlsx',
    fileName: 'workbook.xlsx',
    downloadUrl: '/webpilot/api/artifacts/generated/chat_test/workbook.xlsx?download=1',
    automaticValidation: {
      passed: false,
      formatChecks: { spreadsheet: { chartCount: 0, errorCellCount: 1, formulaCount: 12, worksheetCount: 3 } },
      issues: [{ severity: 'error', code: 'XLSX_FORMULA_ERROR_LITERAL', message: 'sheet3.xml contains one visible error cell.' }],
    },
    visualVerification: { gateStatus: 'pending-model-review', imageCount: 3, pageCount: 3, renderedPages: [1, 2, 3] },
  }));

  assert.match(formatted || '', /Automatic validation passed=false/);
  assert.match(formatted || '', /"chartCount":0/);
  assert.match(formatted || '', /XLSX_FORMULA_ERROR_LITERAL/);
  assert.match(formatted || '', /Visual QA=pending-model-review/);
  assert.match(formatted || '', /pageCount=3/);
});

test('deduplicates concurrent downloads and reuses the per-run URL cache', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'webpilot-download-cache-'));
  const previousRoot = process.env.ARTIFACTS_DIR;
  const previousFetch = globalThis.fetch;
  process.env.ARTIFACTS_DIR = root;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response('cached-download', { status: 200, headers: { 'content-type': 'text/plain' } });
  };
  try {
    const input = { fileType: 'txt', runId: 'chat_test', url: 'https://example.test/asset.txt' };
    const [first, concurrent] = await Promise.all([downloadFileArtifact(input), downloadFileArtifact(input)]);
    assert.equal(first.ok, true, first.actual);
    assert.equal(concurrent.actual, first.actual);
    assert.equal(calls, 1);
    const cached = await downloadFileArtifact(input);
    assert.equal(cached.ok, true, cached.actual);
    assert.equal(JSON.parse(cached.actual || '{}').cacheHit, true);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousRoot === undefined) delete process.env.ARTIFACTS_DIR;
    else process.env.ARTIFACTS_DIR = previousRoot;
    await rm(root, { force: true, recursive: true });
  }
});

test('caps independent same-origin downloads at two concurrent requests', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'webpilot-download-domain-queue-'));
  const previousRoot = process.env.ARTIFACTS_DIR;
  const previousFetch = globalThis.fetch;
  process.env.ARTIFACTS_DIR = root;
  let active = 0;
  let maximumActive = 0;
  globalThis.fetch = async (input) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 15));
    active -= 1;
    return new Response(`download:${String(input)}`, { status: 200, headers: { 'content-type': 'text/plain' } });
  };
  try {
    const downloads = await Promise.all([
      downloadFileArtifact({ runId: 'chat_test', url: 'https://queue.example.test/a.txt', fileType: 'txt' }),
      downloadFileArtifact({ runId: 'chat_test', url: 'https://queue.example.test/b.txt', fileType: 'txt' }),
      downloadFileArtifact({ runId: 'chat_test', url: 'https://queue.example.test/c.txt', fileType: 'txt' }),
      downloadFileArtifact({ runId: 'chat_test', url: 'https://queue.example.test/d.txt', fileType: 'txt' }),
    ]);
    assert.equal(downloads.every((result) => result.ok), true);
    assert.equal(maximumActive, 2);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousRoot === undefined) delete process.env.ARTIFACTS_DIR;
    else process.env.ARTIFACTS_DIR = previousRoot;
    await rm(root, { force: true, recursive: true });
  }
});

test('retries HTTP 429 once with a capped delay and rejects manual sleeping', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'webpilot-download-rate-limit-'));
  const previousRoot = process.env.ARTIFACTS_DIR;
  const previousFetch = globalThis.fetch;
  process.env.ARTIFACTS_DIR = root;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response('rate limited', {
      status: 429,
      headers: { 'retry-after': '30' },
    });
  };
  try {
    const downloaded = await downloadFileArtifact({
      runId: 'chat_test',
      url: 'https://rate-limit.example.test/image.jpg',
      fileType: 'jpg',
    });
    assert.equal(downloaded.ok, false);
    assert.match(downloaded.actual || '', /HTTP 429/);
    assert.match(downloaded.actual || '', /instead of sleeping/);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousRoot === undefined) delete process.env.ARTIFACTS_DIR;
    else process.env.ARTIFACTS_DIR = previousRoot;
    await rm(root, { force: true, recursive: true });
  }
});

test('uses the required model-provided file type when a downloaded URL has no extension', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'webpilot-download-extension-'));
  const previousRoot = process.env.ARTIFACTS_DIR;
  const previousFetch = globalThis.fetch;
  process.env.ARTIFACTS_DIR = root;
  globalThis.fetch = async () => new Response('jpeg-content', {
    status: 200,
    headers: { 'content-type': 'image/jpeg' },
  });
  try {
    const downloaded = await downloadFileArtifact({
      fileType: 'jpg',
      runId: 'chat_test',
      url: 'https://images.example.test/photo-1547721064-da6cfb341d50?w=1920&q=80',
    });
    assert.equal(downloaded.ok, true, downloaded.actual);
    const payload = JSON.parse(downloaded.actual || '{}') as { fileName?: string; path?: string };
    assert.equal(payload.fileName, 'photo-1547721064-da6cfb341d50.jpg');
    assert.equal(path.extname(payload.path || ''), '.jpg');
    assert.equal(await readFile(payload.path || '', 'utf8'), 'jpeg-content');
  } finally {
    globalThis.fetch = previousFetch;
    if (previousRoot === undefined) delete process.env.ARTIFACTS_DIR;
    else process.env.ARTIFACTS_DIR = previousRoot;
    await rm(root, { force: true, recursive: true });
  }
});

test('rejects a download before fetching when the model omits fileType', async () => {
  const previousFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response('unexpected');
  };
  try {
    const downloaded = await downloadFileArtifact({
      runId: 'chat_test',
      url: 'https://downloads.example.test/file',
    });
    assert.equal(downloaded.ok, false);
    assert.match(downloaded.actual || '', /requires fileType/);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('corrects a model-provided download file type when the response reports a different format', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'webpilot-download-type-correction-'));
  const previousRoot = process.env.ARTIFACTS_DIR;
  const previousFetch = globalThis.fetch;
  process.env.ARTIFACTS_DIR = root;
  globalThis.fetch = async () => new Response('jpeg-content', {
    status: 200,
    headers: { 'content-type': 'image/jpeg' },
  });
  try {
    const downloaded = await downloadFileArtifact({
      fileType: 'png',
      runId: 'chat_test',
      url: 'https://images.example.test/photo',
    });
    assert.equal(downloaded.ok, true, downloaded.actual);
    assert.equal(JSON.parse(downloaded.actual || '{}').fileName, 'photo.jpeg');
  } finally {
    globalThis.fetch = previousFetch;
    if (previousRoot === undefined) delete process.env.ARTIFACTS_DIR;
    else process.env.ARTIFACTS_DIR = previousRoot;
    await rm(root, { force: true, recursive: true });
  }
});

test('keeps a provided download extension instead of replacing it from the response MIME type', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'webpilot-download-explicit-extension-'));
  const previousRoot = process.env.ARTIFACTS_DIR;
  const previousFetch = globalThis.fetch;
  process.env.ARTIFACTS_DIR = root;
  globalThis.fetch = async () => new Response('content', {
    status: 200,
    headers: { 'content-type': 'application/octet-stream' },
  });
  try {
    const downloaded = await downloadFileArtifact({
      fileName: 'custom-image.png',
      fileType: 'png',
      runId: 'chat_test',
      url: 'https://downloads.example.test/file',
    });
    assert.equal(downloaded.ok, true, downloaded.actual);
    assert.equal(JSON.parse(downloaded.actual || '{}').fileName, 'custom-image.png');
  } finally {
    globalThis.fetch = previousFetch;
    if (previousRoot === undefined) delete process.env.ARTIFACTS_DIR;
    else process.env.ARTIFACTS_DIR = previousRoot;
    await rm(root, { force: true, recursive: true });
  }
});

test('returns concrete JavaScript cookbook recipes for assets, tables, page breaks, and PDF', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'webpilot-js-cookbook-'));
  const previousRoot = process.env.ARTIFACTS_DIR;
  const previousMode = process.env.OFFICE_GENERATION_MODE;
  process.env.ARTIFACTS_DIR = root;
  process.env.OFFICE_GENERATION_MODE = 'javascript';
  try {
    const planned = await planFileArtifact({
      documentId: 'js-cookbook',
      documentType: 'word',
      fileName: 'cookbook.pdf',
      runId: 'chat_test',
    });
    assert.equal(planned.ok, true, planned.actual);
    const cookbook = await getOfficeJsApi({ documentId: 'js-cookbook', documentType: 'word', runId: 'chat_test' });
    assert.equal(cookbook.ok, true, cookbook.actual);
    const payload = JSON.parse(cookbook.actual || '{}') as {
      recipes?: Record<string, string>;
      rules?: string[];
    };
    assert.match(payload.recipes?.assets || '', /\{ name, bytes \}/);
    assert.match(payload.recipes?.wordTable || '', /new TableRow/);
    assert.match(payload.recipes?.wordPageBreak || '', /new PageBreak/);
    assert.match(payload.recipes?.pdf || '', /converts that Office output to PDF/);
    assert.ok(payload.rules?.some((rule) => rule.includes('never call split()')));
  } finally {
    if (previousRoot === undefined) delete process.env.ARTIFACTS_DIR;
    else process.env.ARTIFACTS_DIR = previousRoot;
    if (previousMode === undefined) delete process.env.OFFICE_GENERATION_MODE;
    else process.env.OFFICE_GENERATION_MODE = previousMode;
    await rm(root, { force: true, recursive: true });
  }
});

test('does not infer existing-file modification from natural-language intent', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'webpilot-uno-plan-create-'));
  const previous = process.env.ARTIFACTS_DIR;
  const previousMode = process.env.OFFICE_GENERATION_MODE;
  process.env.ARTIFACTS_DIR = root;
  delete process.env.OFFICE_GENERATION_MODE;
  try {
    const planned = await planFileArtifact({
      documentId: 'new-repair-guide',
      documentType: 'word',
      fileName: 'repair-guide.docx',
      intent: 'Create a new guide and repair its layout if needed.',
      runId: 'chat_test',
    });
    assert.equal(planned.ok, true, planned.actual);
    const payload = JSON.parse(planned.actual || '{}') as { generator?: string; operation?: string };
    assert.equal(payload.operation, 'create');
    assert.equal(payload.generator, 'uno');
  } finally {
    if (previous === undefined) delete process.env.ARTIFACTS_DIR;
    else process.env.ARTIFACTS_DIR = previous;
    if (previousMode === undefined) delete process.env.OFFICE_GENERATION_MODE;
    else process.env.OFFICE_GENERATION_MODE = previousMode;
    await rm(root, { force: true, recursive: true });
  }
});

test('mounts uploads, downloads, and previous generated files into one conversation asset workspace', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'webpilot-uno-assets-'));
  const upload = path.join(root, 'panda.jpg');
  const previous = process.env.ARTIFACTS_DIR;
  process.env.ARTIFACTS_DIR = root;
  try {
    await writeFile(upload, 'upload');
    await mkdir(path.join(root, 'chat_test', 'downloads'), { recursive: true });
    await writeFile(path.join(root, 'chat_test', 'downloads', 'cover.png'), 'download');
    await mkdir(path.join(root, 'chat_test', 'generated'), { recursive: true });
    await writeFile(path.join(root, 'chat_test', 'generated', 'existing.docx'), 'generated');
    const assets = await syncDocumentAssets('chat_test', [{ ref: 'upload-panda', name: 'panda.jpg', path: upload }]);
    assert.deepEqual(assets.map((asset) => asset.assetName), [
      'attachment-upload-panda-panda.jpg',
      'download-cover.png',
      'generated-existing.docx',
    ]);
    assert.ok(assets.every((asset) => /^[a-f0-9]{64}$/.test(asset.sha256)));
    assert.equal((await readFile(path.join(root, 'chat_test', 'document-assets', 'attachment-upload-panda-panda.jpg'), 'utf8')), 'upload');
  } finally {
    if (previous === undefined) delete process.env.ARTIFACTS_DIR;
    else process.env.ARTIFACTS_DIR = previous;
    await rm(root, { force: true, recursive: true });
  }
});

test('validates a complete UNO draft before render publishes the artifact', async (context) => {
  if (!await resolveLibreOfficeExecutable()) {
    context.skip('LibreOffice is not installed.');
    return;
  }
  const root = await mkdtemp(path.join(tmpdir(), 'webpilot-uno-artifact-'));
  const previous = process.env.ARTIFACTS_DIR;
  process.env.ARTIFACTS_DIR = root;
  try {
    const planned = await planFileArtifact({
      documentId: 'uno-report', documentType: 'word', fileName: 'report.docx', runId: 'chat_test',
    });
    assert.equal(planned.ok, true, planned.actual);
    const result = await generateUnoFileArtifact({
      documentId: 'uno-report', program: wordProgram, includeVisualVerification: false, runId: 'chat_test',
    });
    assert.equal(result.ok, true, result.actual);
    const validation = JSON.parse(result.actual || '{}') as { kind?: string; qualityGate?: { structural?: boolean } };
    assert.equal(validation.kind, 'uno-draft-validation');
    assert.equal(validation.qualityGate?.structural, true);

    const published = await renderFileArtifact({ documentId: 'uno-report', includeVisualVerification: false, runId: 'chat_test' });
    assert.equal(published.ok, true, published.actual);
    const payload = JSON.parse(published.actual || '{}') as { artifactId?: string; path?: string; sourceDigest?: string; qualityGate?: { structural?: boolean }; cacheHit?: boolean };
    assert.equal(payload.artifactId, `chat_test/generated/uno-report/${payload.sourceDigest}/report.docx`);
    assert.equal(payload.qualityGate?.structural, true);
    assert.equal(payload.cacheHit, true);
    assert.ok((await readFile(payload.path || '')).byteLength > 64);

    const overwrite = await generateUnoFileArtifact({
      documentId: 'uno-report', program: wordProgram, render: false, runId: 'chat_test',
    });
    assert.equal(overwrite.ok, false, overwrite.actual);
    assert.equal(JSON.parse(overwrite.actual || '{}').code, 'DESTRUCTIVE_GENERATE_REQUIRES_CONFIRMATION');

    const draft = await readUnoDraft({ documentId: 'uno-report', runId: 'chat_test' });
    assert.equal(draft.ok, true, draft.actual);
    const draftPayload = JSON.parse(draft.actual || '{}') as { patchBaseDigest: string; sourceDigest: string };
    const atomicallyReplaced = await generateUnoFileArtifact({
      documentId: 'uno-report',
      program: wordProgram.replace('Generated through the UNO worker', 'Generated through atomic replacement'),
      replaceExisting: true,
      baseDigest: draftPayload.patchBaseDigest,
      render: false,
      runId: 'chat_test',
    });
    assert.equal(atomicallyReplaced.ok, true, atomicallyReplaced.actual);
    const replacementPayload = JSON.parse(atomicallyReplaced.actual || '{}') as { sourceDigest: string };
    assert.notEqual(replacementPayload.sourceDigest, draftPayload.sourceDigest);
    assert.match(draft.actual || '', /Generated through the UNO worker/);
    assert.match(await readFile(path.join(root, 'chat_test', 'document-drafts', 'uno-report.py'), 'utf8'), /create_document/);
    assert.match(await readFile(path.join(root, 'chat_test', 'document-drafts', 'uno-report.json'), 'utf8'), /sourceDigest/);

    const rerendered = await renderFileArtifact({ documentId: 'uno-report', includeVisualVerification: false, runId: 'chat_test' });
    assert.equal(rerendered.ok, true, rerendered.actual);
    const replacement = await editDraftText({
      documentId: 'uno-report',
      oldText: "    document.add_paragraph('body', 'Generated through atomic replacement')",
      newText: "    document.add_paragraph('body', 'Generated through a replacement program')",
      render: false,
      runId: 'chat_test',
    });
    assert.equal(replacement.ok, true, replacement.actual);
    const staleVisual = await verifyCurrentUnoRenderedArtifact({ runId: 'chat_test', artifactId: payload.artifactId || '' });
    assert.equal(staleVisual.ok, false, staleVisual.actual);
  } finally {
    if (previous === undefined) delete process.env.ARTIFACTS_DIR;
    else process.env.ARTIFACTS_DIR = previous;
    await rm(root, { force: true, recursive: true });
  }
});

test('supports Codex patches without numeric hunk counts', () => {
  const source = 'one\ntwo\nthree\nfour\n';
  assert.equal(applyUnoDraftPatch(source, [
    '*** Begin Patch',
    '*** Update File: draft.py',
    '@@',
    ' one',
    '-two',
    '+TWO',
    ' three',
    ' four',
    '*** End Patch',
  ].join('\n')), 'one\nTWO\nthree\nfour\n');
  const python = [
    'def create_document(job):',
    '    deck = job.presentation("deck")',
    '    title = "Old"',
    '    deck.save()',
    '',
  ].join('\n');
  assert.equal(applyUnoDraftPatch(python, [
    '*** Begin Patch',
    '*** Update File: draft.py',
    '@@ def create_document(job):',
    '     deck = job.presentation("deck")',
    '-    title = "Old"',
    '+    title = "New"',
    '     deck.save()',
    '*** End Patch',
  ].join('\n')), python.replace('"Old"', '"New"'));
  assert.equal(applyUnoDraftPatch(python, [
    '*** Begin Patch',
    '*** Update File: draft.py',
    '@@',
    ' deck = job.presentation("deck")',
    '-    title = "Old"',
    '+    title = "New"',
    ' deck.save()',
    '*** End Patch',
  ].join('\n')), python.replace('"Old"', '"New"'));
  assert.equal(applyUnoDraftPatch('same\ntarget\nsame\ntarget\n', [
    '*** Begin Patch',
    '*** Update File: draft.py',
    '@@',
    '-target',
    '+changed',
    '*** End Patch',
  ].join('\n')), 'same\nchanged\nsame\ntarget\n');
});

test('allows many distant atomic Codex patch hunks without treating their span as a full replacement', () => {
  const source = Array.from({ length: 240 }, (_, index) => `line ${index + 1}`).join('\n') + '\n';
  const patch = [
    '*** Begin Patch',
    '*** Update File: draft.py',
    ...Array.from({ length: 12 }, (_, index) => {
      const lineNumber = 1 + index * 20;
      return [
        '@@',
        `-line ${lineNumber}`,
        `+LINE ${lineNumber}`,
      ];
    }).flat(),
    '*** End Patch',
  ].join('\n');

  const patched = applyUnoDraftPatch(source, patch);
  for (let index = 0; index < 12; index += 1) {
    const lineNumber = 1 + index * 20;
    assert.match(patched, new RegExp(`^LINE ${lineNumber}$`, 'm'));
  }
});

test('keeps page and element IDs while deduplicating overlap diagnostics', () => {
  const diagnostics = generatedVerificationIssues({
    verification: {
      issues: Array.from({ length: 2 }, () => ({
        description: 'High-confidence text-box overlap between shapes 3 and 4.',
        elementIds: ['slide-2/title', 'slide-2/subtitle'],
        page: 2,
        severity: 'warning',
        shapes: [3, 4],
        type: 'text_overlap',
      })),
    },
  });
  assert.equal(diagnostics.length, 1);
  assert.deepEqual(diagnostics[0].elementIds, ['slide-2/title', 'slide-2/subtitle']);
  assert.deepEqual(diagnostics[0].locator, { slide: 2, shapes: [3, 4] });
  assert.equal(diagnostics[0].severity, 'warning');
});

test('preserves deterministic runtime ID disambiguation as a warning diagnostic', () => {
  const diagnostics = generatedRuntimeDiagnostics({
    runtimeDiagnostics: [{
      code: 'ELEMENT_ID_AUTO_DISAMBIGUATED',
      elementId: 'slide-01/title-2',
      line: 42,
      message: "Duplicate requested elementId 'slide-01/title' was registered as 'slide-01/title-2'.",
      severity: 'warning',
    }],
  });
  assert.deepEqual(diagnostics, [{
    code: 'ELEMENT_ID_AUTO_DISAMBIGUATED',
    elementId: 'slide-01/title-2',
    line: 42,
    message: "Duplicate requested elementId 'slide-01/title' was registered as 'slide-01/title-2'.",
    severity: 'warning',
  }]);
});

test('returns every pairwise presentation overlap for one-pass layout repair', () => {
  const diagnostics = generatedVerificationIssues({
    elementMap: [
      { elementId: 'slide-2/oversized-copy', line: 120, locator: { slide: 2, shape: 3 } },
      { elementId: 'slide-2/card-a', line: 130, locator: { slide: 2, shape: 4 } },
      { elementId: 'slide-2/card-b', line: 140, locator: { slide: 2, shape: 5 } },
      { elementId: 'slide-2/card-c', line: 150, locator: { slide: 2, shape: 6 } },
    ],
    verification: {
      issues: ['card-a', 'card-b', 'card-c'].map((card, index) => ({
        description: `text overlap ${index + 1}`,
        elementIds: ['slide-2/oversized-copy', `slide-2/${card}`],
        page: 2,
        severity: 'error',
        shapes: [3, index + 4],
        type: 'text_overlap',
      })),
    },
  });
  assert.equal(diagnostics.length, 3);
  assert.deepEqual(diagnostics.map((diagnostic) => diagnostic.elementIds), [
    ['slide-2/oversized-copy', 'slide-2/card-a'],
    ['slide-2/oversized-copy', 'slide-2/card-b'],
    ['slide-2/oversized-copy', 'slide-2/card-c'],
  ]);
  assert.deepEqual(diagnostics.map((diagnostic) => diagnostic.line), [120, 120, 120]);
});

test('infers editable page and sheet units from proven UNO authoring patterns', () => {
  const writerUnits = sourceUnitsForDraft(`def create_document(job):
    layout = job.writer('report')
    layout.add_paragraph('cover/title', 'Cover')
    layout.add_page_break('break/page-002')
    layout.add_heading('page-002/title', 'Page two')
    layout.add_page_break('break/page-003')
    layout.add_paragraph('page-003/body', 'Page three')
    layout.save()
    layout.close()
`, { documentType: 'word', generator: 'uno' });
  assert.deepEqual(writerUnits.map((unit) => unit.path), [
    'pages/page-001', 'pages/page-002', 'pages/page-003',
  ]);
  assert.match(writerUnits[1].content, /page-002\/title/);
  assert.doesNotMatch(writerUnits[1].content, /page-003\/body/);

  const calcUnits = sourceUnitsForDraft(`def create_document(job):
    workbook = job.spreadsheet('book')
    dashboard = workbook.add_worksheet('sheet/dashboard', 'Dashboard')
    data = workbook.add_worksheet('sheet/data', 'Data')
    dashboard.getCellRangeByName('A1').String = 'Dashboard'
    dashboard.getCellRangeByName('A2').Formula = '=Data.A1'
    data.getCellRangeByName('A1').Value = 42
    workbook.save()
    workbook.close()
`, { documentType: 'spreadsheet', generator: 'uno' });
  assert.deepEqual(calcUnits.map((unit) => unit.path), ['sheets/sheet-001', 'sheets/sheet-002']);
  assert.match(calcUnits[0].content, /Dashboard/);
  assert.doesNotMatch(calcUnits[0].content, /Value = 42/);

  const presentationUnits = sourceUnitsForDraft(`def create_document(job):
    deck = job.presentation('deck')
    def add_bg(sid, page):
        deck.add_shape(sid + '/bg', page, 0, 0, 1000, 1000)
    def section_divider(sid, title):
        page = deck.add_slide(sid)
        add_bg(sid, page)
        deck.add_text(sid + '/title', page, title, 100, 100, 800, 200)
    section_divider('s03-section', 'Section')
    page = deck.add_slide('s30-risk-matrix')
    add_bg('s30', page)
    deck.save()
    deck.close()
`, { documentType: 'presentation', generator: 'uno' });
  assert.deepEqual(presentationUnits.map((unit) => unit.path), [
    'symbols/add_bg', 'symbols/section_divider', 'pages/s03-section', 'pages/s30-risk-matrix',
  ]);
  assert.match(presentationUnits[1].content, /def section_divider/);
  assert.match(presentationUnits[2].content, /section_divider\('s03-section'/);
  assert.doesNotMatch(presentationUnits[3].content, /def section_divider/);

  const facadeUnits = sourceUnitsForDraft(`def create_document(job):
    deck = job.presentation('deck')
    s = deck.slide('cover', title='Cover')
    s.add_text('title', 'Cover', box=(1, 1, 4, 1))
    s = deck.slide('agenda', title='Agenda')
    s.add_text('body', 'Agenda', box=(1, 2, 4, 1))
    s = deck.slide('closing', title='Closing')
    s.add_text('body', 'Closing', box=(1, 2, 4, 1))
    deck.save()
    deck.close()
`, { documentType: 'presentation', generator: 'uno' });
  assert.deepEqual(facadeUnits.map((unit) => unit.path), [
    'pages/cover', 'pages/agenda', 'pages/closing',
  ]);
  assert.match(facadeUnits[1].content, /Agenda/);
  assert.doesNotMatch(facadeUnits[1].content, /Cover/);
  assert.doesNotMatch(facadeUnits[1].content, /Closing/);
});

test('returns focused repair hints for common UNO runtime failures', () => {
  const hints = officeValidationRepairHints([], [
    "NameError: name 'F' is not defined",
    "FileNotFoundError: Asset 'diagram.png' is not in this conversation workspace. Available assets: download-diagram.png, photo.jpg",
    'ValueError: Presentation geometry requires non-negative position and positive size',
  ].join('\n'));
  assert.ok(hints.some((hint) => hint.includes('Python name F is undefined')));
  assert.ok(hints.some((hint) => hint.includes('download-diagram.png')));
  assert.ok(hints.some((hint) => hint.includes('zero-size placeholder')));
  const helperHints = officeValidationRepairHints([], "TypeError: create_document.<locals>.add_rect() got an unexpected keyword argument 'layout_role'");
  assert.ok(helperHints.some((hint) => hint.includes('locally defined helper')));
  assert.equal(helperHints.some((hint) => hint.includes('Query unoApi')), false);
  const bridgeHints = officeValidationRepairHints([{ code: 'UNO_BRIDGE_DISPOSED', message: 'Binary URP bridge disposed', severity: 'error' }]);
  assert.ok(bridgeHints.some((hint) => hint.includes('retried once')));
  const startupHints = officeValidationRepairHints([{ code: 'UNO_BRIDGE_STARTUP', message: "couldn't connect to pipe", severity: 'error' }]);
  assert.ok(startupHints.some((hint) => hint.includes('Do not edit the Office source')));
});

test('infers unoApi document type and caches facade modules independently', async (context) => {
  if (!await resolveLibreOfficeExecutable()) {
    context.skip('LibreOffice is not installed.');
    return;
  }
  const root = await mkdtemp(path.join(tmpdir(), 'webpilot-uno-api-defaults-'));
  const previousArtifacts = process.env.ARTIFACTS_DIR;
  const previousMode = process.env.OFFICE_GENERATION_MODE;
  process.env.ARTIFACTS_DIR = root;
  process.env.OFFICE_GENERATION_MODE = 'uno';
  try {
    const planned = await planFileArtifact({
      documentId: 'uno-api-defaults',
      documentType: 'presentation',
      fileName: 'defaults.pptx',
      runId: 'chat_test',
    });
    assert.equal(planned.ok, true, planned.actual);
    const result = await getUnoApi({ documentId: 'uno-api-defaults', runId: 'chat_test' });
    assert.equal(result.ok, true, result.actual);
    const payload = JSON.parse(result.actual || '{}') as {
      documentType?: string;
      target?: string;
      nativeReflectionExposed?: boolean;
      moduleIndex?: unknown[];
      delivery?: string;
    };
    assert.equal(payload.documentType, 'presentation');
    assert.equal(payload.target, 'facade');
    assert.equal(payload.nativeReflectionExposed, false);
    assert.equal(payload.delivery, 'module-index');
    assert.ok((payload.moduleIndex || []).length > 10);
    const repeated = await getUnoApi({ documentId: 'uno-api-defaults', query: 'chart', runId: 'chat_test' });
    const repeatedPayload = JSON.parse(repeated.actual || '{}') as {
      alreadyLoaded?: boolean; apiReference?: unknown[]; examples?: Record<string, string>; kind?: string;
    };
    assert.equal(repeatedPayload.kind, 'uno-api');
    assert.equal(repeatedPayload.alreadyLoaded, false);
    assert.ok((repeatedPayload.apiReference || []).length > 0);
    assert.match(repeatedPayload.examples?.nativeColumnChart || '', /show_legend=True/);
    const chartAgain = await getUnoApi({ documentId: 'uno-api-defaults', query: 'chart', runId: 'chat_test' });
    assert.equal(JSON.parse(chartAgain.actual || '{}').alreadyLoaded, true);
  } finally {
    if (previousArtifacts === undefined) delete process.env.ARTIFACTS_DIR;
    else process.env.ARTIFACTS_DIR = previousArtifacts;
    if (previousMode === undefined) delete process.env.OFFICE_GENERATION_MODE;
    else process.env.OFFICE_GENERATION_MODE = previousMode;
    await rm(root, { force: true, recursive: true });
  }
});

test('keeps one current source per documentId without revision history', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'webpilot-office-single-source-'));
  const previous = process.env.ARTIFACTS_DIR;
  process.env.ARTIFACTS_DIR = root;
  try {
    await planFileArtifact({ documentId: 'single-source-workflow', documentType: 'word', fileName: 'single.docx', runId: 'chat_test' });
    const generated = await generateUnoFileArtifact({ documentId: 'single-source-workflow', program: wordProgram, render: false, runId: 'chat_test' });
    assert.equal(generated.ok, true, generated.actual);
    const edited = await editDraftText({
      documentId: 'single-source-workflow',
      oldText: "    document.add_paragraph('body', 'Generated through the UNO worker')",
      newText: "    document.add_paragraph('body', 'Current source edit')",
      render: false,
      runId: 'chat_test',
    });
    assert.equal(edited.ok, true, edited.actual);
    const current = await readUnoDraft({ documentId: 'single-source-workflow', runId: 'chat_test' });
    const payload = JSON.parse(current.actual || '{}') as Record<string, unknown> & { program?: string };
    assert.match(payload.program || '', /Current source edit/);
    assert.equal('currentRevision' in payload, false);
    assert.equal('validatedRevision' in payload, false);
    assert.equal('revisions' in payload, false);
    const metadata = JSON.parse(await readFile(path.join(root, 'chat_test', 'document-drafts', 'single-source-workflow.json'), 'utf8')) as Record<string, unknown>;
    assert.equal('currentRevision' in metadata, false);
    assert.equal('validatedRevision' in metadata, false);
    assert.equal('revisions' in metadata, false);
  } finally {
    if (previous === undefined) delete process.env.ARTIFACTS_DIR;
    else process.env.ARTIFACTS_DIR = previous;
    await rm(root, { force: true, recursive: true });
  }
});

test('saves cumulative syntax repairs so multiple errors can be fixed across edits', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'webpilot-office-edit-repair-'));
  const previous = process.env.ARTIFACTS_DIR;
  process.env.ARTIFACTS_DIR = root;
  try {
    await planFileArtifact({ documentId: 'transactional-edit', documentType: 'word', fileName: 'transaction.docx', runId: 'chat_test' });
    const generated = await generateUnoFileArtifact({ documentId: 'transactional-edit', program: wordProgram, render: false, runId: 'chat_test' });
    assert.equal(generated.ok, true, generated.actual);
    const before = JSON.parse((await readUnoDraft({ documentId: 'transactional-edit', runId: 'chat_test' })).actual || '{}') as {
      program?: string;
      sourceDigest?: string;
    };

    const failed = await editDraftText({
      documentId: 'transactional-edit',
      oldText: "    document.add_paragraph('body', 'Generated through the UNO worker')",
      newText: '    if (\n    while (',
      includeVisualVerification: false,
      runId: 'chat_test',
    });
    assert.equal(failed.ok, true, failed.actual);
    const failure = JSON.parse(failed.actual || '{}') as {
      kind?: string;
      changed?: boolean;
      saved?: boolean;
      requiredNextAction?: string;
    };
    assert.equal(failure.kind, 'uno-draft-validation');
    assert.equal(failure.changed, true);
    assert.equal(failure.saved, true);
    assert.equal(failure.requiredNextAction, 'edit');

    const after = JSON.parse((await readUnoDraft({ documentId: 'transactional-edit', runId: 'chat_test' })).actual || '{}') as {
      program?: string;
      sourceDigest?: string;
      validationStatus?: string;
    };
    assert.notEqual(after.sourceDigest, before.sourceDigest);
    assert.notEqual(after.program, before.program);
    assert.match(after.program || '', /if \(/);
    assert.match(after.program || '', /while \(/);
    assert.equal(after.validationStatus, 'failed');

    const firstRepair = await editDraftText({
      documentId: 'transactional-edit',
      oldText: '    if (',
      newText: "    document.add_paragraph('body', 'First syntax error repaired')",
      includeVisualVerification: false,
      runId: 'chat_test',
    });
    assert.equal(firstRepair.ok, true, firstRepair.actual);
    const afterFirstRepair = await readUnoDraft({ documentId: 'transactional-edit', runId: 'chat_test' });
    assert.match(afterFirstRepair.actual || '', /First syntax error repaired/);
    assert.match(afterFirstRepair.actual || '', /while \(/);

    const repaired = await editDraftText({
      documentId: 'transactional-edit',
      oldText: '    while (',
      newText: '    # Second syntax error repaired',
      includeVisualVerification: false,
      runId: 'chat_test',
    });
    assert.equal(repaired.ok, true, repaired.actual);
    const repairedDraft = JSON.parse((await readUnoDraft({ documentId: 'transactional-edit', runId: 'chat_test' })).actual || '{}') as {
      program?: string;
      validationStatus?: string;
    };
    assert.match(repairedDraft.program || '', /First syntax error repaired/);
    assert.match(repairedDraft.program || '', /Second syntax error repaired/);
    assert.equal(repairedDraft.validationStatus, 'passed');
  } finally {
    if (previous === undefined) delete process.env.ARTIFACTS_DIR;
    else process.env.ARTIFACTS_DIR = previous;
    await rm(root, { force: true, recursive: true });
  }
});

test('reads and edits one marked page unit without changing other source units', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'webpilot-office-source-units-'));
  const previous = process.env.ARTIFACTS_DIR;
  process.env.ARTIFACTS_DIR = root;
  const unitProgram = `def create_document(job):
    document = job.writer('document')
    # @webpilot-unit pages/page-001
    document.add_paragraph('page-one', 'page one')
    # @webpilot-endunit
    # @webpilot-unit pages/page-002
    document.add_paragraph('page-two', 'page two')
    # @webpilot-endunit
    document.save()
    document.close()
`;
  try {
    await planFileArtifact({ documentId: 'unit-workflow', documentType: 'word', fileName: 'units.docx', runId: 'chat_test' });
    const generated = await generateUnoFileArtifact({ documentId: 'unit-workflow', program: unitProgram, render: false, runId: 'chat_test' });
    assert.equal(generated.ok, true, generated.actual);
    const unitRead = await readUnoDraft({ documentId: 'unit-workflow', path: 'pages/page-002', runId: 'chat_test' });
    assert.equal(unitRead.ok, true, unitRead.actual);
    const unitPayload = JSON.parse(unitRead.actual || '{}') as {
      lineCount?: number; patchBaseDigest?: string; program?: string; sourceUnitPath?: string;
      sourceLineRange?: { coordinateSpace?: string; startLine?: number; endLine?: number };
    };
    assert.equal(unitPayload.sourceUnitPath, 'pages/page-002');
    assert.equal(unitPayload.lineCount, 1);
    assert.match(unitPayload.program || '', /page two/);
    assert.doesNotMatch(unitPayload.program || '', /page one/);
    assert.deepEqual(unitPayload.sourceLineRange, {
      startLine: 7,
      endLine: 7,
      coordinateSpace: 'global',
      totalSourceLines: 10,
      unitLineCount: 1,
    });
    assert.match(unitPayload.program || '', /^    document\.add_paragraph/);

    const edited = await editUnoFileArtifact({
      documentId: 'unit-workflow',
      path: 'pages/page-002',
      baseDigest: unitPayload.patchBaseDigest,
      patch: [
        '*** Begin Patch',
        '*** Update File: draft.py',
        '@@',
        "-    document.add_paragraph('page-two', 'page two')",
        "+    document.add_paragraph('page-two', 'updated page two')",
        '*** End Patch',
      ].join('\n'),
      render: false,
      runId: 'chat_test',
    });
    assert.equal(edited.ok, true, edited.actual);
    const complete = await readUnoDraft({ documentId: 'unit-workflow', runId: 'chat_test' });
    assert.match(complete.actual || '', /page one/);
    assert.match(complete.actual || '', /updated page two/);
    const state = JSON.parse(complete.actual || '{}') as { sourceUnits?: Array<{ path: string; status: string }> };
    assert.deepEqual(state.sourceUnits?.map((unit) => unit.path), ['pages/page-001', 'pages/page-002']);
    assert.equal(state.sourceUnits?.find((unit) => unit.path === 'pages/page-002')?.status, 'passed');
  } finally {
    if (previous === undefined) delete process.env.ARTIFACTS_DIR;
    else process.env.ARTIFACTS_DIR = previous;
    await rm(root, { force: true, recursive: true });
  }
});

test('indexes large presentation slide blocks and requires bounded source reads', async (context) => {
  if (!await resolveLibreOfficeExecutable()) {
    context.skip('LibreOffice is not installed.');
    return;
  }
  const root = await mkdtemp(path.join(tmpdir(), 'webpilot-office-inferred-units-'));
  const previous = process.env.ARTIFACTS_DIR;
  const previousMode = process.env.OFFICE_GENERATION_MODE;
  process.env.ARTIFACTS_DIR = root;
  process.env.OFFICE_GENERATION_MODE = 'uno';
  const filler = Array.from({ length: 305 }, (_, index) => `    # shared helper note ${index + 1}`).join('\n');
  const program = `def create_document(job):
    deck = job.presentation('deck')
${filler}
    page1 = deck.add_slide('slide-01')
    deck.add_text('slide-01/title', page1, 'One', 1000, 1000, 8000, 1400, font_size=24)
    page2 = deck.add_slide('slide-02')
    deck.add_text('slide-02/title', page2, 'Two', 1000, 1000, 8000, 1400, font_size=24)
    deck.save()
    deck.close()
`;
  try {
    await planFileArtifact({ documentId: 'inferred-units', documentType: 'presentation', fileName: 'inferred.pptx', runId: 'chat_test' });
    const generated = await generateUnoFileArtifact({ documentId: 'inferred-units', program, render: false, runId: 'chat_test' });
    assert.equal(generated.ok, true, generated.actual);
    const overview = JSON.parse((await readUnoDraft({ documentId: 'inferred-units', runId: 'chat_test' })).actual || '{}') as {
      program?: string;
      programOmitted?: boolean;
      sourceUnits?: Array<{ inferred?: boolean; path?: string }>;
    };
    assert.equal(overview.programOmitted, true);
    assert.equal(overview.program, undefined);
    assert.deepEqual(overview.sourceUnits?.map((unit) => unit.path), ['pages/slide-001', 'pages/slide-002']);
    assert.ok(overview.sourceUnits?.every((unit) => unit.inferred));

    const helperWindow = JSON.parse((await readUnoDraft({
      documentId: 'inferred-units', startLine: 150, endLine: 158, runId: 'chat_test',
    })).actual || '{}') as { program?: string; sourceLineRange?: { startLine?: number; endLine?: number } };
    assert.deepEqual(helperWindow.sourceLineRange, {
      startLine: 150,
      endLine: 158,
      coordinateSpace: 'global',
      totalSourceLines: 313,
    });
    assert.match(helperWindow.program || '', /^    # shared helper note 148/);

    const secondSlide = JSON.parse((await readUnoDraft({
      documentId: 'inferred-units', path: 'pages/slide-002', runId: 'chat_test',
    })).actual || '{}') as { program?: string; sourceUnitPath?: string };
    assert.equal(secondSlide.sourceUnitPath, 'pages/slide-002');
    assert.match(secondSlide.program || '', /slide-02\/title/);
    assert.doesNotMatch(secondSlide.program || '', /slide-01\/title/);

    const fallbackWindow = JSON.parse((await readUnoDraft({
      documentId: 'inferred-units', path: 'inferred-units.py', startLine: 306, endLine: 9999, runId: 'chat_test',
    })).actual || '{}') as {
      program?: string;
      readFallbackGuidance?: string;
      requestedPathIgnored?: string;
      sourceLineRange?: { endLine?: number };
    };
    assert.equal(fallbackWindow.requestedPathIgnored, 'inferred-units.py');
    assert.equal(fallbackWindow.sourceLineRange?.endLine, 313);
    assert.match(fallbackWindow.program || '', /deck\.save\(\)/);
    assert.match(fallbackWindow.readFallbackGuidance || '', /complete draft/);
  } finally {
    if (previous === undefined) delete process.env.ARTIFACTS_DIR;
    else process.env.ARTIFACTS_DIR = previous;
    if (previousMode === undefined) delete process.env.OFFICE_GENERATION_MODE;
    else process.env.OFFICE_GENERATION_MODE = previousMode;
    await rm(root, { force: true, recursive: true });
  }
});

test('recovers an interrupted validation checkpoint after a backend restart', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'webpilot-office-recovery-'));
  const previous = process.env.ARTIFACTS_DIR;
  process.env.ARTIFACTS_DIR = root;
  try {
    await planFileArtifact({ documentId: 'recover-workflow', documentType: 'word', fileName: 'recover.docx', runId: 'chat_test' });
    await generateUnoFileArtifact({ documentId: 'recover-workflow', program: wordProgram, render: false, runId: 'chat_test' });
    const metadataPath = path.join(root, 'chat_test', 'document-drafts', 'recover-workflow.json');
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as Record<string, unknown>;
    metadata.workflow = { state: 'validating', checkpointAt: new Date(0).toISOString() };
    await writeFile(metadataPath, JSON.stringify(metadata), 'utf8');
    const recovered = await readUnoDraft({ documentId: 'recover-workflow', runId: 'chat_test' });
    assert.equal(recovered.ok, true, recovered.actual);
    const payload = JSON.parse(recovered.actual || '{}') as { workflow?: { state?: string; recoveredFrom?: string } };
    assert.equal(payload.workflow?.state, 'render-ready');
    assert.equal(payload.workflow?.recoveredFrom, 'validating');
  } finally {
    if (previous === undefined) delete process.env.ARTIFACTS_DIR;
    else process.env.ARTIFACTS_DIR = previous;
    await rm(root, { force: true, recursive: true });
  }
});

test('applies a Codex patch only against the latest source digest', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'webpilot-uno-editor-'));
  const previous = process.env.ARTIFACTS_DIR;
  process.env.ARTIFACTS_DIR = root;
  try {
    await planFileArtifact({ documentId: 'editor-workflow', documentType: 'word', fileName: 'editor.docx', runId: 'chat_test' });
    const generated = await generateUnoFileArtifact({
      documentId: 'editor-workflow', program: wordProgram, render: false, runId: 'chat_test',
    });
    assert.equal(generated.ok, true, generated.actual);

    const retried = await editDraftText({
      documentId: 'editor-workflow',
      oldText: "    document.add_paragraph('body', 'Generated through the UNO worker')",
      newText: "    document.add_paragraph('body', 'generate retry')",
      render: false,
      runId: 'chat_test',
    });
    assert.equal(retried.ok, true, retried.actual);

    const current = await readUnoDraft({ documentId: 'editor-workflow', runId: 'chat_test' });
    assert.equal(current.ok, true, current.actual);
    assert.match(current.actual || '', /generate retry/);
    const currentPayload = JSON.parse(current.actual || '{}') as { patchBaseDigest?: string };
    const stale = await editUnoFileArtifact({
      documentId: 'editor-workflow',
      baseDigest: '0'.repeat(64),
      patch: [
        '*** Begin Patch',
        '*** Update File: draft.py',
        '@@',
        '-def create_document(job):',
        '+def create_document(job):',
        '*** End Patch',
      ].join('\n'),
      runId: 'chat_test',
    });
    assert.equal(stale.ok, false, stale.actual);
    assert.equal(JSON.parse(stale.actual || '{}').code, 'PATCH_BASE_DIGEST_MISMATCH');

    const edited = await editUnoFileArtifact({
      documentId: 'editor-workflow',
      baseDigest: currentPayload.patchBaseDigest,
      patch: [
        '*** Begin Patch',
        '*** Update File: draft.py',
        '@@',
        "     document = job.writer('document')",
        "-    document.add_paragraph('body', 'generate retry')",
        "+    document.add_paragraph('body', 'targeted edit')",
        '     document.save()',
        '*** End Patch',
      ].join('\n'),
      render: false,
      runId: 'chat_test',
    });
    assert.equal(edited.ok, true, edited.actual);
    const afterEdit = JSON.parse((await readUnoDraft({ documentId: 'editor-workflow', runId: 'chat_test' })).actual || '{}') as {
      patchBaseDigest?: string;
    };
    const unchanged = await editUnoFileArtifact({
      documentId: 'editor-workflow',
      baseDigest: afterEdit.patchBaseDigest,
      patch: [
        '*** Begin Patch',
        '*** Update File: draft.py',
        '@@',
        "     document = job.writer('document')",
        "-    document.add_paragraph('body', 'targeted edit')",
        "+    document.add_paragraph('body', 'targeted edit')",
        '     document.save()',
        '*** End Patch',
      ].join('\n'),
      render: false,
      runId: 'chat_test',
    });
    assert.equal(unchanged.ok, false, unchanged.actual);
    assert.match(unchanged.actual || '', /only matching context and no unambiguous source change/);

    const replacementProgram = wordProgram.replace('Generated through the UNO worker', 'whole-file replacement');
    const replaced = await editUnoFileArtifact({
      documentId: 'editor-workflow',
      program: replacementProgram,
      render: false,
      runId: 'chat_test',
    });
    assert.equal(replaced.ok, false, replaced.actual);
    assert.match(replaced.actual || '', /requires a Codex-format patch rather than a complete program/);
    assert.match(await readFile(path.join(root, 'chat_test', 'document-drafts', 'editor-workflow.py'), 'utf8'), /targeted edit/);
  } finally {
    if (previous === undefined) delete process.env.ARTIFACTS_DIR;
    else process.env.ARTIFACTS_DIR = previous;
    await rm(root, { force: true, recursive: true });
  }
});

test('allows independent PDF and DOCX workspaces with different documentIds in one run', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'webpilot-uno-multiple-documents-'));
  const previous = process.env.ARTIFACTS_DIR;
  process.env.ARTIFACTS_DIR = root;
  try {
    const pdf = await planFileArtifact({
      documentId: 'ai-wiki-pdf-001', documentType: 'word', fileName: 'ai-wiki.pdf', runId: 'chat_test',
    });
    assert.equal(pdf.ok, true, pdf.actual);
    const docx = await planFileArtifact({
      documentId: 'ai-wiki-docx-001', documentType: 'word', fileName: 'ai-wiki.docx', runId: 'chat_test',
    });
    assert.equal(docx.ok, true, docx.actual);
    assert.equal(JSON.parse(pdf.actual || '{}').documentId, 'ai-wiki-pdf-001');
    assert.equal(JSON.parse(docx.actual || '{}').documentId, 'ai-wiki-docx-001');
    assert.ok(await readFile(path.join(root, 'chat_test', 'document-drafts', 'ai-wiki-pdf-001.json'), 'utf8'));
    assert.ok(await readFile(path.join(root, 'chat_test', 'document-drafts', 'ai-wiki-docx-001.json'), 'utf8'));
  } finally {
    if (previous === undefined) delete process.env.ARTIFACTS_DIR;
    else process.env.ARTIFACTS_DIR = previous;
    await rm(root, { force: true, recursive: true });
  }
});

test('refuses to run a workspace source that no longer matches its saved source metadata', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'webpilot-uno-workspace-'));
  const previous = process.env.ARTIFACTS_DIR;
  process.env.ARTIFACTS_DIR = root;
  try {
    await planFileArtifact({ documentId: 'workspace-integrity', documentType: 'word', fileName: 'report.docx', runId: 'chat_test' });
    const generated = await generateUnoFileArtifact({
      documentId: 'workspace-integrity', program: wordProgram, render: false, runId: 'chat_test',
    });
    assert.equal(generated.ok, true, generated.actual);
    await writeFile(path.join(root, 'chat_test', 'document-drafts', 'workspace-integrity.py'), `${wordProgram}\n# changed outside the editor workflow\n`, 'utf8');
    const read = await readUnoDraft({ documentId: 'workspace-integrity', runId: 'chat_test' });
    assert.equal(read.ok, false);
    assert.match(read.actual || '', /does not match its saved source metadata/);
  } finally {
    if (previous === undefined) delete process.env.ARTIFACTS_DIR;
    else process.env.ARTIFACTS_DIR = previous;
    await rm(root, { force: true, recursive: true });
  }
});

test('saves a rejected initial source so the model can read and edit it in place', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'webpilot-uno-reject-'));
  const previous = process.env.ARTIFACTS_DIR;
  process.env.ARTIFACTS_DIR = root;
  try {
    await planFileArtifact({ documentId: 'rejected-program', documentType: 'word', fileName: 'report.docx', runId: 'chat_test' });
    const result = await generateUnoFileArtifact({
      documentId: 'rejected-program',
      program: 'def wrong_entrypoint(job):\n    return None',
      runId: 'chat_test',
    });
    assert.equal(result.ok, false);
    assert.match(result.actual || '', /define exactly one synchronous create_document\(job\)/);
    const failure = JSON.parse(result.actual || '{}') as { requiredNextAction?: string; saved?: boolean };
    assert.equal(failure.saved, true);
    assert.equal(failure.requiredNextAction, 'edit');
    const catalog = await listOfficeDrafts({ runId: 'chat_test' });
    assert.equal(catalog.ok, true, catalog.actual);
    const catalogEntry = (JSON.parse(catalog.actual || '{}') as { drafts?: Array<{ documentId?: string; sourceDigest?: string | null; state?: string; validationStatus?: string }> })
      .drafts?.find((draft) => draft.documentId === 'rejected-program');
    assert.match(catalogEntry?.sourceDigest || '', /^[a-f0-9]{64}$/);
    assert.equal(catalogEntry?.state, 'authoring');
    assert.equal(catalogEntry?.validationStatus, 'failed');
    const readable = JSON.parse((await readUnoDraft({ documentId: 'rejected-program', runId: 'chat_test' })).actual || '{}') as {
      program?: string;
      validationStatus?: string;
    };
    assert.match(readable.program || '', /wrong_entrypoint/);
    assert.equal(readable.validationStatus, 'failed');
    const pending = await pendingOfficeDocumentWork('chat_test', new Set(['rejected-program']));
    assert.equal(pending[0]?.requiredNextAction, 'render');
    const retriedRender = await renderFileArtifact({ documentId: 'rejected-program', runId: 'chat_test' });
    assert.equal(retriedRender.ok, false);
    assert.match(retriedRender.actual || '', /define exactly one synchronous create_document\(job\)/);
    assert.doesNotMatch(retriedRender.actual || '', /office-render-blocked/);
  } finally {
    if (previous === undefined) delete process.env.ARTIFACTS_DIR;
    else process.env.ARTIFACTS_DIR = previous;
    await rm(root, { force: true, recursive: true });
  }
});

test('does not require visual QA when the active model cannot inspect images', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'webpilot-uno-structural-only-'));
  const previous = process.env.ARTIFACTS_DIR;
  process.env.ARTIFACTS_DIR = root;
  try {
    await planFileArtifact({
      documentId: 'structural-only-model', documentType: 'word', fileName: 'report.docx', runId: 'chat_test',
    });
    const draftsDir = path.join(root, 'chat_test', 'document-drafts');
    const metadataPath = path.join(draftsDir, 'structural-only-model.json');
    const draft = JSON.parse(await readFile(metadataPath, 'utf8')) as Record<string, unknown>;
    const digest = createHash('sha256').update(wordProgram).digest('hex');
    await writeFile(path.join(draftsDir, 'structural-only-model.py'), wordProgram, 'utf8');
    await writeFile(metadataPath, JSON.stringify({
      ...draft,
      program: wordProgram,
      renderedDigest: digest,
      renderedSourceDigest: digest,
      sourceDigest: digest,
      validatedSourceDigest: digest,
      validationStatus: 'passed',
      workflow: { state: 'qa-pending', checkpointAt: new Date().toISOString() },
    }), 'utf8');

    const visualModelPending = await pendingOfficeDocumentWork(
      'chat_test',
      new Set(['structural-only-model']),
    );
    assert.equal(visualModelPending[0]?.requiredNextAction, 'visualIndex');

    const textModelPending = await pendingOfficeDocumentWork(
      'chat_test',
      new Set(['structural-only-model']),
      { requireVisualQa: false },
    );
    assert.deepEqual(textModelPending, []);
  } finally {
    if (previous === undefined) delete process.env.ARTIFACTS_DIR;
    else process.env.ARTIFACTS_DIR = previous;
    await rm(root, { force: true, recursive: true });
  }
});

test('does not complete visual QA when any fully read page has a failed review', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'webpilot-visual-qa-failed-page-'));
  const previous = process.env.ARTIFACTS_DIR;
  process.env.ARTIFACTS_DIR = root;
  try {
    await planFileArtifact({
      documentId: 'visual-review', documentType: 'word', fileName: 'report.docx', runId: 'chat_test',
    });
    const draftsDir = path.join(root, 'chat_test', 'document-drafts');
    const metadataPath = path.join(draftsDir, 'visual-review.json');
    const draft = JSON.parse(await readFile(metadataPath, 'utf8')) as Record<string, unknown>;
    const digest = createHash('sha256').update(wordProgram).digest('hex');
    const artifactId = `chat_test/generated/visual-review/${digest}/report.docx`;
    await writeFile(path.join(draftsDir, 'visual-review.py'), wordProgram, 'utf8');
    await writeFile(metadataPath, JSON.stringify({
      ...draft,
      program: wordProgram,
      renderedArtifactId: artifactId,
      renderedDigest: digest,
      renderedSourceDigest: digest,
      sourceDigest: digest,
      validatedSourceDigest: digest,
      validationStatus: 'passed',
      workflow: { state: 'qa-pending', checkpointAt: new Date().toISOString(), renderedDigest: digest },
    }), 'utf8');

    const readResult = await recordOfficeVisualQaProgress({
      action: 'read',
      artifactId,
      runId: 'chat_test',
      result: {
        ok: true,
        actual: JSON.stringify({
          kind: 'file-visual-read',
          screenshotCount: 2,
          screenshots: [
            { pageNumber: 1, screenshotDigest: 'a'.repeat(64) },
            { pageNumber: 2, screenshotDigest: 'b'.repeat(64) },
          ],
        }),
      },
    });
    assert.equal(readResult.ok, true, readResult.actual);
    const reportResult = await recordOfficeVisualQaProgress({
      action: 'report',
      artifactId,
      runId: 'chat_test',
      result: {
        ok: true,
        actual: JSON.stringify({
          kind: 'file-visual-report',
          reviews: [
            { pageNumber: 1, status: 'passed', observation: 'The title, body copy, and footer are visibly separated with balanced whitespace.', checks: passedPageVisualChecks, issues: [] },
            { pageNumber: 2, status: 'failed', observation: 'The body text visibly collides with the footer and interrupts the bottom spacing rhythm.', checks: { ...passedPageVisualChecks, overlap: 'failed' }, issues: [{ type: 'overlap', description: 'Text overlaps the footer.' }] },
          ],
          deckReview: { status: 'failed', observation: 'Comparing both rendered pages shows that the footer clearance is inconsistent and the second page breaks the shared vertical spacing system.', checks: { ...passedDeckVisualChecks, spacingRhythm: 'failed' }, issues: [{ type: 'spacing-consistency', description: 'Footer spacing differs across pages.' }] },
        }),
      },
    });
    assert.equal(reportResult.ok, true, reportResult.actual);
    const resultPayload = JSON.parse(reportResult.actual || '{}') as { visualQa?: { complete?: boolean; visualQaDigest?: string | null } };
    assert.equal(resultPayload.visualQa?.complete, false);
    assert.equal(resultPayload.visualQa?.visualQaDigest, null);
    const pendingRepair = await pendingOfficeDocumentWork('chat_test', new Set(['visual-review']));
    assert.equal(pendingRepair[0]?.requiredNextAction, 'edit');
    assert.deepEqual(pendingRepair[0]?.visualQaFailedPages, [2]);
    const saved = JSON.parse(await readFile(metadataPath, 'utf8')) as { visualQaDigest?: string; workflow?: { state?: string } };
    assert.equal(saved.visualQaDigest, undefined);
    assert.equal(saved.workflow?.state, 'qa-pending');
  } finally {
    if (previous === undefined) delete process.env.ARTIFACTS_DIR;
    else process.env.ARTIFACTS_DIR = previous;
    await rm(root, { force: true, recursive: true });
  }
});
