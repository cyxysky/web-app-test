import assert from 'node:assert/strict';
import test from 'node:test';
import { translateText } from '@/i18n/translations';

test('settings translations cover browser, account, and shared-resource copy', () => {
  assert.equal(translateText('en', '实时预览帧率'), 'Live preview frame rate');
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
});
