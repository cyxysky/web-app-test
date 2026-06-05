import { Activity, Bot, CheckCircle2, Globe2, ListChecks } from 'lucide-react';
import { DashboardWorkspace } from '@/components/DashboardWorkspace';
import { startScheduler } from '@/server/ai/agents/test-runner.service';
import { store } from '@/server/db/mock-store';

export const dynamic = 'force-dynamic';

export default function DashboardPage() {
  store.applyRuntimeEnv();
  startScheduler();
  const testCases = store.listTestCases();
  const groups = store.listGroups();
  const schedules = store.listSchedules();
  const readyCount = testCases.filter((item) => item.status === 'ready' || item.status === 'generated').length;
  const runningCount = testCases.filter((item) => item.status === 'running').length;
  const finishedCount = testCases.filter((item) => ['passed', 'failed', 'blocked'].includes(item.status)).length;

  return (
    <main className="dashboard-v2">
      <header className="dashboard-v2-head">
        <div>
          <h1>自动化测试工作台</h1>
          <span>用自然语言定义测试目标，由 AI 在真实浏览器中决定操作并产出证据。</span>
        </div>
      </header>

      <section className="dashboard-v2-metrics" aria-label="测试概览">
        <div>
          <Activity size={17} />
          <span>用例总数</span>
          <strong>{testCases.length}</strong>
        </div>
        <div>
          <Bot size={17} />
          <span>运行中</span>
          <strong>{runningCount}</strong>
        </div>
        <div>
          <ListChecks size={17} />
          <span>待执行</span>
          <strong>{readyCount}</strong>
        </div>
        <div>
          <CheckCircle2 size={17} />
          <span>已完成</span>
          <strong>{finishedCount}</strong>
        </div>
        <div>
          <Globe2 size={17} />
          <span>模型</span>
          <strong>{process.env.AI_MODEL || 'deepseek-v4-flash'}</strong>
        </div>
      </section>

      <DashboardWorkspace testCases={testCases} groups={groups} schedules={schedules} />
    </main>
  );
}
