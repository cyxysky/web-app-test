import { WEBPILOT_EMBED_SDK } from '@/embed/webpilot-sdk';
import { embedJavaScript, embedOptionsResponse } from '@/server/embed/browser-chat-embed';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export function OPTIONS() {
  return embedOptionsResponse();
}

export async function GET() {
  return embedJavaScript(WEBPILOT_EMBED_SDK);
}
