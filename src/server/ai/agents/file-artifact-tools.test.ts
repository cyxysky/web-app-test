import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  applyUnoDraftLineEdits,
  editUnoFileArtifact,
  generateUnoFileArtifact,
  planFileArtifact,
  readUnoDraft,
  renderFileArtifact,
  syncDocumentAssets,
  verifyCurrentUnoRenderedArtifact,
} from './file-artifact-tools';
import { resolveLibreOfficeExecutable } from '@/server/files/libreoffice';

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

test('does not infer existing-file modification from natural-language intent', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'webpilot-uno-plan-create-'));
  const previous = process.env.ARTIFACTS_DIR;
  process.env.ARTIFACTS_DIR = root;
  try {
    const planned = await planFileArtifact({
      documentId: 'new-repair-guide',
      documentType: 'word',
      fileName: 'repair-guide.docx',
      intent: 'Create a new guide and repair its layout if needed.',
      runId: 'chat_test',
    });
    assert.equal(planned.ok, true, planned.actual);
    assert.equal(JSON.parse(planned.actual || '{}').operation, 'create');
  } finally {
    if (previous === undefined) delete process.env.ARTIFACTS_DIR;
    else process.env.ARTIFACTS_DIR = previous;
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
    assert.equal(JSON.parse(stale.actual || '{}').changed, true);

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
    assert.match(replaced.actual || '', /does not accept a complete program replacement/);
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

test('rejects a draft that does not implement the UNO entrypoint', async () => {
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
    assert.match(result.actual || '', /must define def create_document/);
  } finally {
    if (previous === undefined) delete process.env.ARTIFACTS_DIR;
    else process.env.ARTIFACTS_DIR = previous;
    await rm(root, { force: true, recursive: true });
  }
});
