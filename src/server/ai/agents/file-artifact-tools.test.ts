import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  editFileArtifact,
  repairFileArtifactDownloadLinks,
  generateFileArtifactBlocks,
  planFileArtifact,
  renderFileArtifact,
} from './file-artifact-tools';

test('stores generated files in the session generated-artifact directory', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'webpilot-generated-artifact-'));
  const previous = process.env.ARTIFACTS_DIR;
  process.env.ARTIFACTS_DIR = root;
  try {
    const planned = await planFileArtifact({
      documentId: 'result-spreadsheet',
      documentType: 'spreadsheet',
      fileName: 'result.csv',
      runId: 'chat_test',
    });
    assert.equal(planned.ok, true, planned.actual);
    const documentId = (JSON.parse(planned.actual || '{}') as { documentId?: string }).documentId;
    const result = await generateFileArtifactBlocks({
      blocks: [{ id: 'data', type: 'table', rows: [['name', 'value'], ['status', 'passed']] }],
      documentId,
      includeVisualVerification: false,
      render: true,
      runId: 'chat_test',
    });
    assert.equal(result.ok, true, result.actual);
    const payload = JSON.parse(result.actual || '{}') as { artifactId?: string; kind?: string; path?: string };
    assert.equal(payload.kind, 'generated');
    assert.equal(payload.artifactId, 'chat_test/generated/result.csv');
    assert.equal(await readFile(payload.path || '', 'utf8'), 'name,value\nstatus,passed\n');
    const replanned = await planFileArtifact({
      documentId: 'result-spreadsheet',
      documentType: 'spreadsheet',
      fileName: 'renamed-result.csv',
      runId: 'chat_test',
    });
    assert.equal(replanned.ok, true, replanned.actual);
    assert.deepEqual(
      (({ documentId, fileName, blockCount, reused }) => ({ documentId, fileName, blockCount, reused }))(
        JSON.parse(replanned.actual || '{}') as { documentId?: string; fileName?: string; blockCount?: number; reused?: boolean },
      ),
      { documentId: 'result-spreadsheet', fileName: 'result.csv', blockCount: 1, reused: true },
    );
    const second = await generateFileArtifactBlocks({
      blocks: [{ id: 'more-data', type: 'table', rows: [['next', 'revision']] }],
      documentId,
      includeVisualVerification: false,
      render: true,
      runId: 'chat_test',
    });
    assert.equal(second.ok, true, second.actual);
    const secondPayload = JSON.parse(second.actual || '{}') as { artifactId?: string };
    assert.equal(secondPayload.artifactId, payload.artifactId);
  } finally {
    if (previous === undefined) delete process.env.ARTIFACTS_DIR;
    else process.env.ARTIFACTS_DIR = previous;
    await rm(root, { force: true, recursive: true });
  }
});

test('requires the model to choose a stable documentId during plan', async () => {
  const planned = await planFileArtifact({
    documentType: 'word',
    fileName: 'report.docx',
    runId: 'chat_test',
  });
  assert.equal(planned.ok, false);
  assert.match(planned.actual || '', /stable model-chosen documentId/);
});

test('rejects empty add edits instead of reporting a successful no-op', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'webpilot-empty-edit-'));
  const previous = process.env.ARTIFACTS_DIR;
  process.env.ARTIFACTS_DIR = root;
  try {
    await planFileArtifact({ documentId: 'empty-edit', documentType: 'word', fileName: 'empty.docx', runId: 'chat_test' });
    const result = await editFileArtifact({
      documentId: 'empty-edit',
      operations: [{ op: 'add' } as never],
      render: false,
      runId: 'chat_test',
    });
    assert.equal(result.ok, false);
    assert.match(result.actual || '', /add requires block or a non-empty blocks array/);
  } finally {
    if (previous === undefined) delete process.env.ARTIFACTS_DIR;
    else process.env.ARTIFACTS_DIR = previous;
    await rm(root, { force: true, recursive: true });
  }
});

test('atomically replaces page children and reports the changed revision', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'webpilot-replace-children-'));
  const previous = process.env.ARTIFACTS_DIR;
  process.env.ARTIFACTS_DIR = root;
  try {
    await planFileArtifact({ documentId: 'replace-page', documentType: 'presentation', fileName: 'replace.pptx', runId: 'chat_test' });
    await generateFileArtifactBlocks({
      blocks: [{ id: 'page-1', type: 'page', children: [{ id: 'old-title', type: 'text', text: 'Old' }] }],
      documentId: 'replace-page',
      render: false,
      runId: 'chat_test',
    });
    const result = await editFileArtifact({
      documentId: 'replace-page',
      operations: [{
        op: 'replaceChildren',
        parentId: 'page-1',
        blocks: [{ id: 'new-title', type: 'text', style: { fontSize: 22, width: 600 }, text: 'New' }],
      }],
      render: false,
      runId: 'chat_test',
    });
    assert.equal(result.ok, true, result.actual);
    const payload = JSON.parse(result.actual || '{}') as { changedBlockIds?: string[]; revision?: number };
    assert.equal(payload.revision, 2);
    assert.deepEqual(new Set(payload.changedBlockIds), new Set(['page-1', 'old-title', 'new-title']));
    const draft = JSON.parse(await readFile(path.join(root, 'chat_test', 'document-drafts', 'replace-page.json'), 'utf8'));
    assert.deepEqual(draft.blocks[0].children[0].style, { fontSize: 22, width: 600 });
  } finally {
    if (previous === undefined) delete process.env.ARTIFACTS_DIR;
    else process.env.ARTIFACTS_DIR = previous;
    await rm(root, { force: true, recursive: true });
  }
});

test('rejects flattened update style fields without changing the persisted draft', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'webpilot-canonical-update-'));
  const previous = process.env.ARTIFACTS_DIR;
  process.env.ARTIFACTS_DIR = root;
  try {
    await planFileArtifact({ documentId: 'canonical-update', documentType: 'word', fileName: 'canonical.docx', runId: 'chat_test' });
    await generateFileArtifactBlocks({
      blocks: [{ id: 'title', type: 'text', style: { fontSize: 18 }, text: 'Original' }],
      documentId: 'canonical-update',
      render: false,
      runId: 'chat_test',
    });
    const result = await editFileArtifact({
      documentId: 'canonical-update',
      operations: [{ op: 'update', blockId: 'title', patch: { fontSize: 32 } }],
      render: false,
      runId: 'chat_test',
    });
    assert.equal(result.ok, false);
    assert.match(result.actual || '', /patch\.fontSize.*patch\.style\.fontSize/);
    const draft = JSON.parse(await readFile(path.join(root, 'chat_test', 'document-drafts', 'canonical-update.json'), 'utf8'));
    assert.equal(draft.revision, 1);
    assert.deepEqual(draft.blocks[0].style, { fontSize: 18 });
  } finally {
    if (previous === undefined) delete process.env.ARTIFACTS_DIR;
    else process.env.ARTIFACTS_DIR = previous;
    await rm(root, { force: true, recursive: true });
  }
});

test('invalid presentation structure is rejected before any draft commit', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'webpilot-render-transaction-'));
  const previous = process.env.ARTIFACTS_DIR;
  process.env.ARTIFACTS_DIR = root;
  try {
    await planFileArtifact({ documentId: 'atomic-presentation', documentType: 'presentation', fileName: 'atomic.pptx', runId: 'chat_test' });
    const result = await generateFileArtifactBlocks({
      blocks: [{ id: 'orphan', type: 'text', text: 'Not inside a page' }],
      documentId: 'atomic-presentation',
      includeVisualVerification: false,
      render: false,
      runId: 'chat_test',
    });
    assert.equal(result.ok, false);
    assert.match(result.actual || '', /top-level page blocks/);
    const draft = JSON.parse(await readFile(path.join(root, 'chat_test', 'document-drafts', 'atomic-presentation.json'), 'utf8'));
    assert.equal(draft.revision, 0);
    assert.deepEqual(draft.blocks, []);
  } finally {
    if (previous === undefined) delete process.env.ARTIFACTS_DIR;
    else process.env.ARTIFACTS_DIR = previous;
    await rm(root, { force: true, recursive: true });
  }
});

test('renderer failure does not commit the candidate blocks or revision', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'webpilot-render-failure-'));
  const previous = process.env.ARTIFACTS_DIR;
  process.env.ARTIFACTS_DIR = root;
  try {
    await planFileArtifact({ documentId: 'failed-render', documentType: 'presentation', fileName: 'failed-render.pptx', runId: 'chat_test' });
    const result = await generateFileArtifactBlocks({
      blocks: [{
        id: 'page-1',
        type: 'page',
        children: [{ id: 'missing-image', type: 'image', source: 'missing-image.png' }],
      }],
      documentId: 'failed-render',
      includeVisualVerification: false,
      render: true,
      runId: 'chat_test',
    });
    assert.equal(result.ok, false);
    assert.match(result.actual || '', /file rendering failed/);
    const draft = JSON.parse(await readFile(path.join(root, 'chat_test', 'document-drafts', 'failed-render.json'), 'utf8'));
    assert.equal(draft.revision, 0);
    assert.deepEqual(draft.blocks, []);
  } finally {
    if (previous === undefined) delete process.env.ARTIFACTS_DIR;
    else process.env.ARTIFACTS_DIR = previous;
    await rm(root, { force: true, recursive: true });
  }
});

test('renders an existing draft without adding a trigger block', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'webpilot-explicit-render-'));
  const previous = process.env.ARTIFACTS_DIR;
  process.env.ARTIFACTS_DIR = root;
  try {
    await planFileArtifact({ documentId: 'explicit-render', documentType: 'word', fileName: 'explicit.docx', runId: 'chat_test' });
    await generateFileArtifactBlocks({
      blocks: [{ id: 'body', type: 'text', text: 'Rendered without mutation' }],
      documentId: 'explicit-render',
      render: false,
      runId: 'chat_test',
    });
    const result = await renderFileArtifact({
      documentId: 'explicit-render',
      expectedRevision: 1,
      includeVisualVerification: false,
      runId: 'chat_test',
    });
    assert.equal(result.ok, true, result.actual);
    const payload = JSON.parse(result.actual || '{}') as { revision?: number; blockCount?: number };
    assert.equal(payload.revision, 1);
    assert.equal(payload.blockCount, 1);
  } finally {
    if (previous === undefined) delete process.env.ARTIFACTS_DIR;
    else process.env.ARTIFACTS_DIR = previous;
    await rm(root, { force: true, recursive: true });
  }
});

test('does not append a download section for files already exposed as message artifacts', () => {
  const firstUrl = '/webpilot/api/artifacts/chat_test/generated/first.md?download=1';
  const secondUrl = '/webpilot/api/artifacts/chat_test/generated/second.docx?download=1';
  const reply = `第一个文件：[first.md](${firstUrl})`;
  const result = repairFileArtifactDownloadLinks(reply, [
    {
      name: 'file',
      result: {
        ok: true,
        actual: JSON.stringify({
          artifactId: 'chat_test/generated/first.md',
          downloadUrl: firstUrl,
          fileName: 'first.md',
        }),
      },
    },
    {
      name: 'file',
      result: {
        ok: true,
        actual: JSON.stringify({
          artifactId: 'chat_test/generated/second.docx',
          downloadUrl: secondUrl,
          fileName: 'second.docx',
        }),
      },
    },
  ]);

  assert.equal(result.match(new RegExp(firstUrl.replace(/[?]/g, '\\?'), 'g'))?.length, 1);
  assert.doesNotMatch(result, /## 文件下载/);
  assert.doesNotMatch(result, new RegExp(secondUrl.replace(/[?]/g, '\\?')));
});

test('repairs a model-authored Artifact link from the verified tool result instead of appending a duplicate', () => {
  const fileName = '研发部员工年中工作总结报告-陈劲帆-丰富版.docx';
  const correctUrl = `/webpilot/api/artifacts/chat_test/generated/${encodeURIComponent(fileName)}?download=1`;
  const wrongUrl = `/webpilot/api/artifacts/chat_test/generated/${encodeURIComponent('研发部员工工作总结报告-陈劲帆-丰富版.docx')}?download=1`;
  const result = repairFileArtifactDownloadLinks(
    `下载：[${fileName}](${wrongUrl})`,
    [{
      name: 'fillDocumentTemplate',
      result: {
        ok: true,
        actual: JSON.stringify({
          artifactId: `chat_test/generated/${fileName}`,
          downloadUrl: correctUrl,
          fileName,
        }),
      },
    }],
  );

  assert.equal(result, `下载：[${fileName}](${correctUrl})`);
  assert.doesNotMatch(result, /## 文件下载/);
  assert.doesNotMatch(result, new RegExp(wrongUrl));
});

test('repairs multiple model-authored Artifact links by their verified file labels', () => {
  const firstUrl = '/webpilot/api/artifacts/chat_test/generated/first.md?download=1';
  const secondUrl = '/webpilot/api/artifacts/chat_test/generated/second.docx?download=1';
  const result = repairFileArtifactDownloadLinks(
    '[first.md](/webpilot/api/artifacts/chat_test/generated/wrong-first.md?download=1)\n[second.docx](/webpilot/api/artifacts/chat_test/generated/wrong-second.docx?download=1)',
    [
      {
        name: 'file',
        result: { ok: true, actual: JSON.stringify({ artifactId: 'chat_test/generated/first.md', downloadUrl: firstUrl, fileName: 'first.md' }) },
      },
      {
        name: 'file',
        result: { ok: true, actual: JSON.stringify({ artifactId: 'chat_test/generated/second.docx', downloadUrl: secondUrl, fileName: 'second.docx' }) },
      },
    ],
  );

  assert.match(result, new RegExp(firstUrl.replace(/[?]/g, '\\?')));
  assert.match(result, new RegExp(secondUrl.replace(/[?]/g, '\\?')));
  assert.doesNotMatch(result, /wrong-first|wrong-second|## 文件下载/);
});

test('does not expose failed or non-Artifact file tool URLs', () => {
  const reply = '生成失败。';
  const result = repairFileArtifactDownloadLinks(reply, [
    {
      name: 'file',
      result: {
        ok: false,
        actual: JSON.stringify({
          artifactId: 'chat_test/generated/failed.pdf',
          downloadUrl: '/webpilot/api/artifacts/chat_test/generated/failed.pdf?download=1',
          fileName: 'failed.pdf',
        }),
      },
    },
    {
      name: 'file',
      result: {
        ok: true,
        actual: JSON.stringify({
          artifactId: 'chat_test/generated/not-an-artifact.txt',
          downloadUrl: 'https://example.com/not-an-artifact.txt',
          fileName: 'not-an-artifact.txt',
        }),
      },
    },
  ]);

  assert.equal(result, reply);
});
