import assert from 'node:assert/strict';
import test from 'node:test';
import { browserChatArtifactsFromSteps, mergeBrowserChatArtifactSummaries } from './browser-chat-artifacts';

test('extracts compact file and screenshot summaries from persisted steps', () => {
  const artifacts = browserChatArtifactsFromSteps([{
    index: 1,
    action: 'capture and download',
    expected: 'artifacts',
    actual: 'done',
    status: 'passed',
    tools: [{
      name: 'downloadFile',
      rawResult: {
        ok: true,
        actual: JSON.stringify({
          artifactId: 'chat/file/ai_icon.png',
          bytes: 747_110,
          path: 'C:/data/artifacts/chat/file/ai_icon.png',
        }),
      },
      screenshots: [{ title: '结果页', path: 'C:/data/artifacts/chat/shots/result.png' }],
    }],
  }]);

  assert.deepEqual(artifacts.map((artifact) => ({
    bytes: artifact.bytes,
    fileName: artifact.fileName,
    kind: artifact.kind,
    title: artifact.title,
  })), [
    { bytes: 747_110, fileName: 'ai_icon.png', kind: 'image', title: undefined },
    { bytes: undefined, fileName: 'result.png', kind: 'screenshot', title: '结果页' },
  ]);
});

test('deduplicates repeated screenshot paths across progress snapshots', () => {
  const tool = {
    name: 'browserCode',
    screenshots: [{ title: '页面', path: 'C:/data/artifacts/chat/shots/page.png' }],
  };
  const artifacts = browserChatArtifactsFromSteps([
    { index: 1, action: 'one', expected: '', actual: '', status: 'running', tools: [tool] },
    { index: 2, action: 'two', expected: '', actual: '', status: 'passed', tools: [tool] },
  ]);
  assert.equal(artifacts.length, 1);
});

test('does not expose internal document visual-QA pages as message screenshots', () => {
  const artifacts = browserChatArtifactsFromSteps([{
    index: 1,
    action: 'render document',
    expected: '',
    actual: '',
    status: 'passed',
    tools: [{
      name: 'file',
      screenshots: [{
        title: 'file explicit image 1',
        path: 'C:/data/artifacts/chat/attachment-previews/report/page-1.png',
      }],
    }],
  }]);
  assert.deepEqual(artifacts, []);

  assert.deepEqual(mergeBrowserChatArtifactSummaries([{
    fileName: 'page-1.png',
    id: 'screenshot:legacy-preview',
    kind: 'screenshot',
    path: 'C:/data/artifacts/chat/attachment-previews/report/page-1.png',
    title: 'file explicit image 1',
  }]), []);
});

test('keeps only the latest rendered revision with the same authoritative documentId', () => {
  const generated = (artifactId: string, fileName: string) => ({
    name: 'file',
    rawResult: {
      ok: true,
      actual: JSON.stringify({
        artifactId,
        documentId: 'document-1',
        fileName,
        path: `C:/data/artifacts/chat/generated/${fileName}`,
      }),
    },
  });
  const artifacts = browserChatArtifactsFromSteps([
    { index: 1, action: 'preview', expected: '', actual: '', status: 'passed', tools: [generated('chat/generated/report.pdf', 'report.pdf')] },
    { index: 2, action: 'final', expected: '', actual: '', status: 'passed', tools: [generated('chat/generated/report-2.pdf', 'report-2.pdf')] },
  ]);
  assert.deepEqual(artifacts.map(({ documentId, fileName }) => ({ documentId, fileName })), [
    { documentId: 'document-1', fileName: 'report-2.pdf' },
  ]);

  assert.deepEqual(mergeBrowserChatArtifactSummaries(artifacts).map((artifact) => artifact.fileName), ['report-2.pdf']);
});

test('does not guess document identity from similar file names', () => {
  const artifacts = mergeBrowserChatArtifactSummaries([
    { documentId: 'quarter-one', fileName: 'report.pdf', id: 'file:document:quarter-one', kind: 'file' },
    { documentId: 'quarter-two', fileName: 'report-2.pdf', id: 'file:document:quarter-two', kind: 'file' },
  ]);
  assert.deepEqual(artifacts.map((artifact) => artifact.documentId), ['quarter-one', 'quarter-two']);
});
