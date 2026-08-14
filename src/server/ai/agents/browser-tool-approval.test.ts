import assert from 'node:assert/strict';
import test from 'node:test';
import { browserToolApprovalRequest } from './browser-tool-approval';

test('keeps read-only and preparatory browser tools approval-free', () => {
  assert.equal(browserToolApprovalRequest({ toolName: 'takeSnapshot', toolInput: { reason: '读取页面' } }), undefined);
  assert.equal(browserToolApprovalRequest({
    toolName: 'interact',
    toolInput: { action: 'type', reason: '填写名称', value: '示例' },
    targetDescription: 'textbox "名称"',
  }), undefined);
});

test('requires approval for committing DOM interactions using backend target evidence', () => {
  const request = browserToolApprovalRequest({
    toolName: 'interact',
    toolInput: { action: 'click', reason: '继续操作' },
    targetDescription: 'button "删除项目"',
  });
  assert.match(request?.prompt || '', /删除项目/);
});

test('requires approval for committing browser code', () => {
  const request = browserToolApprovalRequest({
    toolName: 'browserCode',
    toolInput: { code: "await page.getByRole('button', { name: '提交' }).click()", reason: '提交表单' },
  });
  assert.ok(request);
  assert.equal(request?.prompt, '提交表单');
});

test('does not require approval for read-only page fetches', () => {
  assert.equal(browserToolApprovalRequest({
    toolName: 'browserCode',
    toolInput: {
      code: "const response = await fetch('data/document.js', { credentials: 'include' }); return response.text()",
      reason: '读取 Axure 原型数据',
    },
  }), undefined);
});

test('requires approval before delivering a downloaded file', () => {
  const request = browserToolApprovalRequest({
    toolName: 'downloadFile',
    toolInput: { reason: '下载测试报告', artifactId: 'artifact-1' },
  });
  assert.match(request?.prompt || '', /下载测试报告/);
});
