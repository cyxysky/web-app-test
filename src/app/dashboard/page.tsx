import Link from 'next/link';
import { Activity, Bot, Globe2, Plus, ShieldCheck } from 'lucide-react';
import { NewTestCaseForm } from '@/components/NewTestCaseForm';
import { store } from '@/server/db/mock-store';

export const dynamic = 'force-dynamic';

export default function DashboardPage() {
  const testCases = store.listTestCases();
  const readyCount = testCases.filter((item) => item.status === 'ready' || item.status === 'generated').length;
  const finishedCount = testCases.filter((item) => ['passed', 'failed', 'blocked'].includes(item.status)).length;

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">AI Browser Testing</p>
          <h1 className="page-title">Web 自动化测试控制台</h1>
          <p className="page-subtitle">输入目标地址和测试目标，生成可执行步骤，并由 Playwright 浏览器完成点击、输入、断言与截图。</p>
        </div>
        <a className="button secondary" href="#new-case">
          <Plus size={16} />
          新建用例
        </a>
      </header>

      <section className="metric-grid">
        <div className="metric">
          <Activity size={18} />
          <span>用例总数</span>
          <strong>{testCases.length}</strong>
        </div>
        <div className="metric">
          <Bot size={18} />
          <span>待执行</span>
          <strong>{readyCount}</strong>
        </div>
        <div className="metric">
          <ShieldCheck size={18} />
          <span>已完成</span>
          <strong>{finishedCount}</strong>
        </div>
        <div className="metric">
          <Globe2 size={18} />
          <span>模型</span>
          <strong>{process.env.AI_MODEL || 'gpt-5.4'}</strong>
        </div>
      </section>

      <section className="workspace">
        <div className="panel">
          <div className="panel-heading">
            <h2>历史测试用例</h2>
            <span>{testCases.length} 条</span>
          </div>
          <div className="case-list">
            {testCases.map((item) => (
              <Link className="case-row" href={`/test-cases/${item.id}`} key={item.id}>
                <div className="case-row-main">
                  <strong>{item.title}</strong>
                  <span>{item.description}</span>
                </div>
                <div className="meta">
                  <span className={`badge status-${item.status}`}>{item.status}</span>
                  <span>{item.priority}</span>
                  <span>{item.targetUrl}</span>
                  <span>{new Date(item.updatedAt).toLocaleString()}</span>
                </div>
              </Link>
            ))}
          </div>
        </div>

        <aside className="panel new-case-panel" id="new-case">
          <div className="panel-heading">
            <h2>AI 新建测试用例</h2>
            <span>结构化生成</span>
          </div>
          <NewTestCaseForm />
        </aside>
      </section>
    </main>
  );
}
