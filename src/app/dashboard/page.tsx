import { redirect } from 'next/navigation';
import { withWebPilotBasePath } from '@/lib/webpilot-base-path';

export default function LegacyDashboardPage() {
  redirect(withWebPilotBasePath('/browser-chat'));
}
