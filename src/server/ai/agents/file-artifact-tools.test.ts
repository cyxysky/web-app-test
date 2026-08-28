import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  applyUnoDraftLineEdits,
  applyUnoDraftPatch,
  downloadFileArtifact,
  editUnoFileArtifact,
  formatFileArtifactResult,
  generateUnoFileArtifact,
  getOfficeJsApi,
  listOfficeDrafts,
  pendingOfficeDocumentWork,
  planFileArtifact,
  readUnoDraft,
  recordOfficeVisualQaProgress,
  repairFileArtifactDownloadLinks,
  renderFileArtifact,
  syncDocumentAssets,
  verifyCurrentUnoRenderedArtifact,
} from './file-artifact-tools';
import { resolveLibreOfficeExecutable } from '@/server/files/libreoffice';

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
    document = job.new_document('word')
    cursor = document.Text.createTextCursor()
    document.Text.insertString(cursor, 'Generated through the UNO worker', False)
    document.storeAsURL(job.output_url, (job.property('FilterName', 'Office Open XML Text'),))
    job.close(document)
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
    currentRevision: 2,
    lastSuccessfulRevision: 2,
    error: 'Syntax error',
  }));
  assert.match(formatted || '', /validation failed/i);
  assert.match(formatted || '', /workingSourceSaved=true/);
  assert.doesNotMatch(formatted || '', /source validated/i);
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

test('serializes different downloads from the same domain', async () => {
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
    const [first, second] = await Promise.all([
      downloadFileArtifact({ runId: 'chat_test', url: 'https://queue.example.test/a.txt', fileType: 'txt' }),
      downloadFileArtifact({ runId: 'chat_test', url: 'https://queue.example.test/b.txt', fileType: 'txt' }),
    ]);
    assert.equal(first.ok, true, first.actual);
    assert.equal(second.ok, true, second.actual);
    assert.equal(maximumActive, 1);
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
    assert.equal(payload.generator, 'javascript');
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
    assert.equal(overwrite.ok, false);
    assert.match(overwrite.actual || '', /already has source/);

    const draft = await readUnoDraft({ documentId: 'uno-report', runId: 'chat_test' });
    assert.equal(draft.ok, true, draft.actual);
    const draftPayload = JSON.parse(draft.actual || '{}') as { sourceDigest: string };
    assert.match(draft.actual || '', /Generated through the UNO worker/);
    assert.match(await readFile(path.join(root, 'chat_test', 'document-drafts', 'uno-report.py'), 'utf8'), /create_document/);
    assert.match(await readFile(path.join(root, 'chat_test', 'document-drafts', 'uno-report.json'), 'utf8'), /sourceDigest/);

    const rerendered = await renderFileArtifact({ documentId: 'uno-report', includeVisualVerification: false, runId: 'chat_test' });
    assert.equal(rerendered.ok, true, rerendered.actual);
    const replacement = await editUnoFileArtifact({
      documentId: 'uno-report',
      baseDigest: draftPayload.sourceDigest,
      edits: [{
        startLine: 4,
        endLine: 4,
        newText: "    document.Text.insertString(cursor, 'Generated through a replacement program', False)",
      }],
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

test('applies line edits against one stable line-numbered source', () => {
  const source = 'one\ntwo\nthree\nfour\n';
  assert.equal(applyUnoDraftLineEdits(source, [
    { startLine: 2, endLine: 2, newText: 'TWO\nTWO-DETAIL' },
    { startLine: 4, endLine: 4, newText: 'FOUR' },
  ]), 'one\nTWO\nTWO-DETAIL\nthree\nFOUR\n');
  assert.throws(() => applyUnoDraftLineEdits(source, [
    { startLine: 2, endLine: 3, newText: 'middle' },
    { startLine: 3, endLine: 4, newText: 'overlap' },
  ]), /overlap/);
});

test('supports structured editor operations and unified patches', () => {
  const source = 'one\ntwo\nthree\nfour\n';
  assert.equal(applyUnoDraftLineEdits(source, [
    { kind: 'insertAfter', line: 1, newText: 'one-detail' },
    { kind: 'deleteRange', startLine: 3, endLine: 3, newText: '' },
  ]), 'one\none-detail\ntwo\nfour\n');
  assert.equal(applyUnoDraftLineEdits(source, [
    { kind: 'replaceText', oldText: 'two\nthree', newText: 'TWO\nTHREE' },
  ]), 'one\nTWO\nTHREE\nfour\n');
  assert.equal(applyUnoDraftPatch(source, [
    '--- a/draft.py',
    '+++ b/draft.py',
    '@@ -1,4 +1,4 @@',
    ' one',
    '-two',
    '+TWO',
    ' three',
    ' four',
  ].join('\n')), 'one\nTWO\nthree\nfour\n');
});

test('records source revisions and restores an older revision as a new save', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'webpilot-office-revisions-'));
  const previous = process.env.ARTIFACTS_DIR;
  process.env.ARTIFACTS_DIR = root;
  try {
    await planFileArtifact({ documentId: 'revision-workflow', documentType: 'word', fileName: 'revision.docx', runId: 'chat_test' });
    const generated = await generateUnoFileArtifact({ documentId: 'revision-workflow', program: wordProgram, render: false, runId: 'chat_test' });
    assert.equal(generated.ok, true, generated.actual);
    const edited = await editUnoFileArtifact({
      documentId: 'revision-workflow',
      edits: [{ kind: 'replaceText', oldText: 'Generated through the UNO worker', newText: 'Revision two' }],
      render: false,
      runId: 'chat_test',
    });
    assert.equal(edited.ok, true, edited.actual);
    const restored = await editUnoFileArtifact({ documentId: 'revision-workflow', restoreRevision: 1, render: false, runId: 'chat_test' });
    assert.equal(restored.ok, true, restored.actual);
    const current = await readUnoDraft({ documentId: 'revision-workflow', runId: 'chat_test' });
    const payload = JSON.parse(current.actual || '{}') as { currentRevision?: number; revisions?: unknown[]; program?: string };
    assert.equal(payload.currentRevision, 3);
    assert.equal(payload.revisions?.length, 3);
    assert.match(payload.program || '', /Generated through the UNO worker/);
  } finally {
    if (previous === undefined) delete process.env.ARTIFACTS_DIR;
    else process.env.ARTIFACTS_DIR = previous;
    await rm(root, { force: true, recursive: true });
  }
});

test('keeps a failed edit in the single working source and blocks rendering until it is repaired', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'webpilot-office-edit-repair-'));
  const previous = process.env.ARTIFACTS_DIR;
  process.env.ARTIFACTS_DIR = root;
  try {
    await planFileArtifact({ documentId: 'transactional-edit', documentType: 'word', fileName: 'transaction.docx', runId: 'chat_test' });
    const generated = await generateUnoFileArtifact({ documentId: 'transactional-edit', program: wordProgram, render: false, runId: 'chat_test' });
    assert.equal(generated.ok, true, generated.actual);
    const before = JSON.parse((await readUnoDraft({ documentId: 'transactional-edit', runId: 'chat_test' })).actual || '{}') as {
      currentRevision?: number;
      program?: string;
      sourceDigest?: string;
    };

    const failed = await editUnoFileArtifact({
      documentId: 'transactional-edit',
      edits: [{ kind: 'replaceText', oldText: "    cursor = document.Text.createTextCursor()", newText: '    if (' }],
      includeVisualVerification: false,
      runId: 'chat_test',
    });
    assert.equal(failed.ok, false, failed.actual);
    const failure = JSON.parse(failed.actual || '{}') as {
      saved?: boolean;
      currentRevision?: number;
      lastSuccessfulRevision?: number;
      requiredNextAction?: string;
    };
    assert.equal(failure.saved, true);
    assert.equal(failure.currentRevision, before.currentRevision);
    assert.equal(failure.lastSuccessfulRevision, before.currentRevision);
    assert.equal(failure.requiredNextAction, 'edit');

    const after = JSON.parse((await readUnoDraft({ documentId: 'transactional-edit', runId: 'chat_test' })).actual || '{}') as {
      currentRevision?: number;
      program?: string;
      sourceDigest?: string;
      revisions?: unknown[];
      validationStatus?: string;
    };
    assert.equal(after.currentRevision, before.currentRevision);
    assert.notEqual(after.sourceDigest, before.sourceDigest);
    assert.match(after.program || '', /if \(/);
    assert.equal(after.validationStatus, 'failed');
    assert.equal(after.revisions?.length, 1);
    const pendingRepair = await pendingOfficeDocumentWork('chat_test', new Set(['transactional-edit']));
    assert.equal(pendingRepair[0]?.requiredNextAction, 'edit');

    const blockedRender = await renderFileArtifact({ documentId: 'transactional-edit', runId: 'chat_test' });
    assert.equal(blockedRender.ok, false, blockedRender.actual);
    assert.equal(JSON.parse(blockedRender.actual || '{}').requiredNextAction, 'edit');

    const repaired = await editUnoFileArtifact({
      documentId: 'transactional-edit',
      edits: [{ kind: 'replaceText', oldText: '    if (', newText: '    cursor = document.Text.createTextCursor()' }],
      includeVisualVerification: false,
      runId: 'chat_test',
    });
    assert.equal(repaired.ok, true, repaired.actual);
    const repairedDraft = JSON.parse((await readUnoDraft({ documentId: 'transactional-edit', runId: 'chat_test' })).actual || '{}') as {
      currentRevision?: number;
      program?: string;
      validationStatus?: string;
    };
    assert.equal(repairedDraft.currentRevision, 1);
    assert.equal(repairedDraft.program, before.program);
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
    document = job.new_document('word')
    cursor = document.Text.createTextCursor()
    # @webpilot-unit pages/page-001
    document.Text.insertString(cursor, 'page one', False)
    # @webpilot-endunit
    # @webpilot-unit pages/page-002
    document.Text.insertString(cursor, 'page two', False)
    # @webpilot-endunit
    document.storeAsURL(job.output_url, (job.property('FilterName', 'Office Open XML Text'),))
    job.close(document)
`;
  try {
    await planFileArtifact({ documentId: 'unit-workflow', documentType: 'word', fileName: 'units.docx', runId: 'chat_test' });
    const generated = await generateUnoFileArtifact({ documentId: 'unit-workflow', program: unitProgram, render: false, runId: 'chat_test' });
    assert.equal(generated.ok, true, generated.actual);
    const unitRead = await readUnoDraft({ documentId: 'unit-workflow', path: 'pages/page-002', runId: 'chat_test' });
    assert.equal(unitRead.ok, true, unitRead.actual);
    const unitPayload = JSON.parse(unitRead.actual || '{}') as { lineCount?: number; program?: string; sourceUnitPath?: string };
    assert.equal(unitPayload.sourceUnitPath, 'pages/page-002');
    assert.equal(unitPayload.lineCount, 1);
    assert.match(unitPayload.program || '', /page two/);
    assert.doesNotMatch(unitPayload.program || '', /page one/);

    const edited = await editUnoFileArtifact({
      documentId: 'unit-workflow',
      path: 'pages/page-002',
      edits: [{ startLine: 1, endLine: 1, newText: "    document.Text.insertString(cursor, 'updated page two', False)" }],
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

test('applies current line edits after the initial draft without a version handshake', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'webpilot-uno-editor-'));
  const previous = process.env.ARTIFACTS_DIR;
  process.env.ARTIFACTS_DIR = root;
  try {
    await planFileArtifact({ documentId: 'editor-workflow', documentType: 'word', fileName: 'editor.docx', runId: 'chat_test' });
    const generated = await generateUnoFileArtifact({
      documentId: 'editor-workflow', program: wordProgram, render: false, runId: 'chat_test',
    });
    assert.equal(generated.ok, true, generated.actual);

    const retriedProgram = wordProgram.replace('Generated through the UNO worker', 'generate retry');
    const retried = await generateUnoFileArtifact({
      documentId: 'editor-workflow',
      program: retriedProgram,
      render: false,
      runId: 'chat_test',
    });
    assert.equal(retried.ok, false, retried.actual);
    assert.match(retried.actual || '', /Do not send another complete program/);

    const current = await readUnoDraft({ documentId: 'editor-workflow', runId: 'chat_test' });
    assert.equal(current.ok, true, current.actual);
    const currentPayload = JSON.parse(current.actual || '{}') as { sourceDigest: string };
    const stale = await editUnoFileArtifact({
      documentId: 'editor-workflow',
      baseDigest: '0'.repeat(64),
      edits: [{ startLine: 4, endLine: 4, newText: "    document.Text.insertString(cursor, 'stale edit', False)" }],
      render: false,
      runId: 'chat_test',
    });
    assert.equal(stale.ok, true, stale.actual);
    assert.equal(JSON.parse(stale.actual || '{}').documentChanged, true);

    const edited = await editUnoFileArtifact({
      documentId: 'editor-workflow',
      baseDigest: currentPayload.sourceDigest,
      edits: [{ startLine: 4, endLine: 4, newText: "    document.Text.insertString(cursor, 'targeted edit', False)" }],
      render: false,
      runId: 'chat_test',
    });
    assert.equal(edited.ok, true, edited.actual);
    const editedPayload = JSON.parse(edited.actual || '{}') as { sourceDigest: string };
    const unchanged = await editUnoFileArtifact({
      documentId: 'editor-workflow',
      baseDigest: editedPayload.sourceDigest,
      edits: [{ startLine: 4, endLine: 4, newText: "    document.Text.insertString(cursor, 'targeted edit', False)" }],
      render: false,
      runId: 'chat_test',
    });
    assert.equal(unchanged.ok, true, unchanged.actual);
    assert.equal(JSON.parse(unchanged.actual || '{}').changed, false);

    const replacementProgram = wordProgram.replace('Generated through the UNO worker', 'whole-file replacement');
    const replaced = await editUnoFileArtifact({
      documentId: 'editor-workflow',
      program: replacementProgram,
      render: false,
      runId: 'chat_test',
    });
    assert.equal(replaced.ok, false, replaced.actual);
    assert.match(replaced.actual || '', /does not accept a complete source replacement/);
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
    assert.match(result.actual || '', /must define create_document\(job\)/);
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
    assert.equal(pending[0]?.requiredNextAction, 'edit');
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
      workflow: { state: 'qa-pending', checkpointAt: new Date().toISOString() },
    }), 'utf8');

    const visualModelPending = await pendingOfficeDocumentWork(
      'chat_test',
      new Set(['structural-only-model']),
    );
    assert.equal(visualModelPending[0]?.requiredNextAction, 'fileVisual');

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
            { pageNumber: 1, status: 'passed', issues: [] },
            { pageNumber: 2, status: 'failed', issues: [{ type: 'overlap', description: 'Text overlaps the footer.' }] },
          ],
        }),
      },
    });
    assert.equal(reportResult.ok, true, reportResult.actual);
    const resultPayload = JSON.parse(reportResult.actual || '{}') as { visualQa?: { complete?: boolean; visualQaDigest?: string | null } };
    assert.equal(resultPayload.visualQa?.complete, false);
    assert.equal(resultPayload.visualQa?.visualQaDigest, null);
    const saved = JSON.parse(await readFile(metadataPath, 'utf8')) as { visualQaDigest?: string; workflow?: { state?: string } };
    assert.equal(saved.visualQaDigest, undefined);
    assert.equal(saved.workflow?.state, 'qa-pending');
  } finally {
    if (previous === undefined) delete process.env.ARTIFACTS_DIR;
    else process.env.ARTIFACTS_DIR = previous;
    await rm(root, { force: true, recursive: true });
  }
});
