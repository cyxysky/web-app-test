import assert from 'node:assert/strict';
import test from 'node:test';
import type { Page } from 'playwright';
import { BrowserSession } from './browser-session';

type MutableBrowserSession = {
  browserOwnership: 'shared';
  browserSurface: 'external';
  ownedPages: Set<Page>;
  releaseSharedBrowser?: (force?: boolean) => Promise<void>;
};

function sharedSessionWithPage() {
  const session = new BrowserSession({ runId: 'chat_lifecycle_test' });
  const state = session as unknown as MutableBrowserSession;
  let closedPages = 0;
  const page = {
    close: async () => { closedPages += 1; },
    isClosed: () => false,
  } as unknown as Page;
  state.browserOwnership = 'shared';
  state.browserSurface = 'external';
  state.ownedPages.add(page);
  return { closedPages: () => closedPages, session, state };
}

test('closing a conversation closes only that shared browser session pages', async () => {
  const { closedPages, session, state } = sharedSessionWithPage();
  let releasedForce: boolean | undefined;
  state.releaseSharedBrowser = async (force) => { releasedForce = force; };

  await session.close({ closePages: true });

  assert.equal(closedPages(), 1);
  assert.equal(releasedForce, undefined);
  assert.equal(state.ownedPages.size, 0);
});

test('idle user browser shutdown preserves pages until the shared process exits', async () => {
  const { closedPages, session, state } = sharedSessionWithPage();
  let releasedForce: boolean | undefined;
  state.releaseSharedBrowser = async (force) => { releasedForce = force; };

  await session.close({ force: true, preservePages: true });

  assert.equal(closedPages(), 0);
  assert.equal(releasedForce, true);
  assert.equal(state.ownedPages.size, 0);
});
