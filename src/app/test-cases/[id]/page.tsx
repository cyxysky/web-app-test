import { redirect } from 'next/navigation';
import { withWebPilotBasePath } from '@/lib/webpilot-base-path';

export const dynamic = 'force-dynamic';

type PageProps = {
  params: Promise<{ id: string }>;
};

export default async function TestCaseDetailPage({ params }: PageProps) {
  await params;
  redirect(withWebPilotBasePath('/browser-chat'));
}
