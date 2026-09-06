import assert from 'node:assert/strict';
import test from 'node:test';
import { modelProviderDefinitions, runtimeEnvDefinitions } from '@/config/settings';
import { hasChinese, translateText } from '@/i18n/translations';

test('settings translations cover browser, account, and shared-resource copy', () => {
  assert.equal(translateText('en', '实时预览帧率'), 'Live preview frame rate');
  assert.equal(
    translateText('en', '实时预览轮询截图并发送的目标帧率；可设置 1–60 FPS。静态页面也会按该频率持续发送画面。'),
    'Target frame rate for capturing and sending live-preview screenshots, from 1 to 60 FPS. Static pages are also sent continuously at this rate.',
  );
  assert.equal(translateText('en', '截图输出像素倍率'), 'Screenshot output pixel ratio');
  assert.equal(translateText('en', '实时预览 JPEG 质量'), 'Live preview JPEG quality');
  assert.equal(translateText('en', '实时预览传输模式'), 'Live preview transport mode');
  assert.equal(translateText('en', 'H.264 视频流（推荐）'), 'H.264 video stream (recommended)');
  assert.equal(translateText('en', '登录账号'), 'Login accounts');
  assert.equal(
    translateText('en', '{count} 个按域名保存的账号；密码只在后台解密并通过短期安全引用使用', { count: 6 }),
    '6 domain-based accounts. Passwords are decrypted only on the backend and used through short-lived secure references.',
  );
  assert.equal(
    translateText('en', '其他 ID 可以使用此 Skill，但只有创建 ID {id} 可以编辑或删除', { id: 1 }),
    'Other IDs can use this Skill, but only its creator ID 1 can edit or delete it.',
  );
  assert.equal(translateText('zh', 'Login accounts'), '登录账号');
  assert.equal(translateText('zh', 'Live preview image format'), '实时预览图片格式');
  assert.equal(translateText('zh', 'JPEG (recommended for high frame rates)'), 'JPEG（高帧率推荐）');
});

test('all settings copy has an English translation', () => {
  const copy = [
    ...modelProviderDefinitions.flatMap((definition) => [definition.keyLabel, definition.baseUrlLabel]),
    ...runtimeEnvDefinitions.flatMap((definition) => [
      definition.label,
      definition.description,
      definition.group,
      ...(definition.options || []).map((option) => option.label),
    ]),
  ].filter((value): value is string => typeof value === 'string' && hasChinese(value));

  // A translated prefix such as "Select CPU 或 CUDA 推理。" is still incomplete.
  const missing = [...new Set(copy.filter((value) => hasChinese(translateText('en', value))))];
  assert.deepEqual(missing, []);
});

test('dynamic settings units and UI templates respect language without translating user content', () => {
  for (const [source, english] of [['10 分钟', '10 min'], ['1 秒', '1 s'], ['250 毫秒', '250 ms']]) {
    assert.equal(translateText('en', source), english);
    assert.equal(translateText('zh', source), source);
  }
  for (const [source, english] of [['{count} 分钟', '30 min'], ['{count} 秒', '30 s'], ['{count} 毫秒', '30 ms']]) {
    assert.equal(translateText('en', source, { count: 30 }), english);
  }
  for (const source of ['研究高级设置', '连接器高级设置', '数据高级设置', '通信高级设置']) {
    assert.equal(hasChinese(translateText('en', source)), false);
    assert.equal(translateText('zh', source), source);
  }
  assert.equal(translateText('en', '{count} 项设置，修改后自动保存。', { count: 1 }), 'Settings: 1. Changes save automatically.');
  assert.equal(translateText('en', '打开文件 {name}', { name: '订单汇总.xlsx' }), 'Open file 订单汇总.xlsx');
  assert.equal(translateText('en', '第 {index} 轮：{prompt}', { index: 2, prompt: '查询订单' }), 'Turn 2: 查询订单');
  assert.equal(translateText('zh', 'Edit chart data'), '编辑图表数据');
});
