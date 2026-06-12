import { EnvironmentSettings } from '@/components/EnvironmentSettings';
import { store } from '@/server/db/mock-store';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  await store.applyRuntimeEnv();
  return <EnvironmentSettings />;
}
