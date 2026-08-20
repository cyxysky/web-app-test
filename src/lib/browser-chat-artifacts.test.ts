import assert from 'node:assert/strict';
import test from 'node:test';
import { browserChatArtifactsFromSteps } from './browser-chat-artifacts';

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
