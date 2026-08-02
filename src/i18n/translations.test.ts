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
  assert.equal(translateText('en', '浏览器启动时最大化'), 'Maximize browser on launch');
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
      ...(definition.options || []).map((option) => option.label),
    ]),
  ].filter((value): value is string => typeof value === 'string' && hasChinese(value));

  const missing = [...new Set(copy.filter((value) => translateText('en', value) === value))];
  assert.deepEqual(missing, []);
});
