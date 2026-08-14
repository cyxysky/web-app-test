import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  appendMissingFileArtifactDownloadLinks,
  generateFileArtifact,
} from './file-artifact-tools';

test('stores generated files in the session generated-artifact directory', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'webpilot-generated-artifact-'));
  const previous = process.env.ARTIFACTS_DIR;
  process.env.ARTIFACTS_DIR = root;
  try {
    const result = await generateFileArtifact({
      content: 'name,value\nstatus,passed',
      fileName: 'result.csv',
      runId: 'chat_test',
    });
    assert.equal(result.ok, true, result.actual);
    const payload = JSON.parse(result.actual || '{}') as { artifactId?: string; kind?: string; path?: string };
    assert.equal(payload.kind, 'generated');
    assert.equal(payload.artifactId, 'chat_test/generated/result.csv');
    assert.equal(await readFile(payload.path || '', 'utf8'), 'name,value\nstatus,passed\n');
  } finally {
    if (previous === undefined) delete process.env.ARTIFACTS_DIR;
    else process.env.ARTIFACTS_DIR = previous;
    await rm(root, { force: true, recursive: true });
  }
});

test('appends only missing current-turn Artifact download links', () => {
  const firstUrl = '/webpilot/api/artifacts/chat_test/generated/first.md?download=1';
  const secondUrl = '/webpilot/api/artifacts/chat_test/generated/second.docx?download=1';
  const reply = `第一个文件：[first.md](${firstUrl})`;
  const result = appendMissingFileArtifactDownloadLinks(reply, [
    {
      name: 'generateFile',
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
      name: 'generateFile',
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
  assert.match(result, /## 文件下载/);
  assert.match(result, new RegExp(`\\[second\\.docx\\]\\(${secondUrl.replace(/[?]/g, '\\?')}\\)`));
});

test('repairs a model-authored Artifact link from the verified tool result instead of appending a duplicate', () => {
  const fileName = '研发部员工年中工作总结报告-陈劲帆-丰富版.docx';
  const correctUrl = `/webpilot/api/artifacts/chat_test/generated/${encodeURIComponent(fileName)}?download=1`;
  const wrongUrl = `/webpilot/api/artifacts/chat_test/generated/${encodeURIComponent('研发部员工工作总结报告-陈劲帆-丰富版.docx')}?download=1`;
  const result = appendMissingFileArtifactDownloadLinks(
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
  const result = appendMissingFileArtifactDownloadLinks(
    '[first.md](/webpilot/api/artifacts/chat_test/generated/wrong-first.md?download=1)\n[second.docx](/webpilot/api/artifacts/chat_test/generated/wrong-second.docx?download=1)',
    [
      {
        name: 'generateFile',
        result: { ok: true, actual: JSON.stringify({ artifactId: 'chat_test/generated/first.md', downloadUrl: firstUrl, fileName: 'first.md' }) },
      },
      {
        name: 'generateFile',
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
  const result = appendMissingFileArtifactDownloadLinks(reply, [
    {
      name: 'generateFile',
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
      name: 'downloadFile',
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
