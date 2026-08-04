import assert from 'node:assert/strict';
import test from 'node:test';
import { browserCodeServiceFileDeliveryViolation } from './browser-chat-file-delivery';

test('rejects Blob downloads created inside the backend Playwright page', () => {
  const code = `
    await page.evaluate(() => {
      const blob = new Blob(['report'], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank');
    });
  `;
  assert.match(browserCodeServiceFileDeliveryViolation(code) || '', /do not deliver a file to the user browser/);
});

test('allows ordinary page inspection and real Playwright navigation', () => {
  assert.equal(browserCodeServiceFileDeliveryViolation('nodeRepl.write(await page.title());'), undefined);
  assert.equal(browserCodeServiceFileDeliveryViolation("await page.evaluate(() => document.body.innerText);"), undefined);
  assert.equal(browserCodeServiceFileDeliveryViolation("await page.getByRole('link', { name: 'Download' }).click();"), undefined);
});
