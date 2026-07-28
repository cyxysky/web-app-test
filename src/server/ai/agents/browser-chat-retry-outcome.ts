export type RecoveredBrowserChatReplyInput = {
  recoveredAfterRetry: boolean;
  reply: string;
  hasToolTrace: boolean;
  requiresToolEvidence: boolean;
};

export function shouldCompleteRecoveredBrowserChatReply(input: RecoveredBrowserChatReplyInput) {
  if (!input.recoveredAfterRetry || !input.reply.trim()) return false;
  return input.hasToolTrace || !input.requiresToolEvidence;
}
