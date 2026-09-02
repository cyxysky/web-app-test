import assert from 'node:assert/strict';
import test from 'node:test';
import { browserToolApprovalRequest } from './browser-tool-approval';

test('requires approval for committing browser code', () => {
  const request = browserToolApprovalRequest({
    toolName: 'browser',
    toolInput: { action: 'code', code: "await page.getByRole('button', { name: '提交' }).click()", reason: '提交表单' },
  });
  assert.ok(request);
  assert.equal(request?.prompt, '提交表单');
});

test('does not require approval for read-only page fetches', () => {
  assert.equal(browserToolApprovalRequest({
    toolName: 'browser',
    toolInput: {
      action: 'code',
      code: "const response = await fetch('data/document.js', { credentials: 'include' }); return response.text()",
      reason: '读取 Axure 原型数据',
    },
  }), undefined);
});

test('requires approval before delivering a downloaded file', () => {
  const request = browserToolApprovalRequest({
    toolName: 'file',
    toolInput: { action: 'download', reason: '下载测试报告', artifactId: 'artifact-1' },
  });
  assert.match(request?.prompt || '', /下载测试报告/);
});
