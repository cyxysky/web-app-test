import assert from 'node:assert/strict';
import test from 'node:test';
import type { BrowserContext, Page } from 'playwright';
import { BrowserSession } from './browser-session';

function markedPage(groupId: string, nativeTabId: number) {
  let reads = 0;
  return {
    isClosed: () => false,
    url: () => 'https://example.test/same-url',
    evaluate: async () => (++reads === 1 ? groupId : nativeTabId),
  } as unknown as Page;
}

test('reclaims shared pages only from exact session markers and keeps their native tab id', async () => {
  const session = new BrowserSession('code', {
    headless: true,
    runId: 'chat_current',
  });
  const current = markedPage('chat_current', 71);
  const otherConversationAtSameUrl = markedPage('chat_other', 82);
  const claimed: Page[] = [];
  Reflect.set(session, 'claimPage', (page: Page) => {
    claimed.push(page);
    return true;
  });
  const context = {
    pages: () => [current, otherConversationAtSameUrl],
  } as unknown as BrowserContext;

  const reclaimed = await Reflect.get(session, 'reclaimSessionPagesByMarker').call(session, context) as Page[];

  assert.deepEqual(reclaimed, [current]);
  assert.deepEqual(claimed, [current]);
  const nativeIds = Reflect.get(session, 'nativeTabIdByPage') as WeakMap<Page, number>;
  assert.equal(nativeIds.get(current), 71);
  assert.equal(nativeIds.get(otherConversationAtSameUrl), undefined);
});
