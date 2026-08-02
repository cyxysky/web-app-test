import { noStoreJson } from '@/server/http/no-store-response';
import { startAutomationScheduler } from '@/server/automation/automation-scheduler';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

export async function POST() {
  startAutomationScheduler();
  return noStoreJson({ ok: true });
}
