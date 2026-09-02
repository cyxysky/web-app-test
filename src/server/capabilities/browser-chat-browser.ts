import { createBrowserCapability } from '@webpilot/capability-browser';
import {
  createNodeBrowserOperations,
  type BrowserCodeAttachmentBinding,
  type BrowserCodeCredentialBinding,
  type BrowserSession,
} from '@webpilot/capability-browser/node';
import { browserCodeServiceFileDeliveryViolation } from '@/server/ai/agents/browser-chat-file-delivery';

export type BrowserChatBrowserCapabilityOptions = {
  session: BrowserSession;
  runId: string;
  stepIndex?: number;
  attachmentBindings?: BrowserCodeAttachmentBinding[];
  credentialBindings?: BrowserCodeCredentialBinding[];
  getCredentialBindings?: () => BrowserCodeCredentialBinding[] | undefined;
  imageInputAvailable: boolean;
};

export function createBrowserChatBrowserCapability(
  options: BrowserChatBrowserCapabilityOptions,
) {
  return createBrowserCapability({
    instruction: false,
    createOperations: () => createNodeBrowserOperations({
      session: options.session,
      runId: options.runId,
      stepIndex: options.stepIndex,
      attachments: options.attachmentBindings,
      credentials: options.getCredentialBindings || options.credentialBindings,
      imageInputAvailable: options.imageInputAvailable,
      validateCode: browserCodeServiceFileDeliveryViolation,
    }),
  });
}
