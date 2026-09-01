import { describe, expect, it } from 'vitest';
import { normalizeBrowserChatAttachmentPreviewPages } from './browser-chat-attachment-visuals';

describe('browser chat attachment visual page normalization', () => {
  it('keeps all eight explicitly requested preview pages in order', () => {
    expect(normalizeBrowserChatAttachmentPreviewPages([1, 2, 3, 4, 5, 6, 7, 8], 8))
      .toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(normalizeBrowserChatAttachmentPreviewPages([8, 7, 8, 6, 5, 4, 3, 2, 1], 8))
      .toEqual([8, 7, 6, 5, 4, 3, 2, 1]);
  });
});
