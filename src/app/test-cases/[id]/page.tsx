import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ArrowLeft, Play } from 'lucide-react';
import { store } from '@/server/db/mock-store';
import { runTestCase } from '@/server/ai/agents/test-runner.service';

export const dynamic = 'force-dynamic';

type PageProps = {
  params: Promise<{ id: string }>;
};

export default async function TestCaseDetailPage({ params }: PageProps) {
  const { id } = await params;
  const testCase = store.getTestCase(id);
  if (!testCase) notFound();

  async function runAction() {
    'use server';
    const run = await runTestCase(id);
    redirect(`/runs/${run?.id}`);
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Test Case</p>
          <h1 className="page-title">{testCase.title}</h1>
          <p className="page-subtitle">{testCase.description}</p>
        </div>
        <Link className="button secondary" href="/dashboard">
          <ArrowLeft size={16} />
          返回控制台
        </Link>
      </header>

      <section className="detail-grid">
        <aside className="panel">
          <div className="panel-heading">
            <h2>用例信息</h2>
            <span className={`badge status-${testCase.status}`}>{testCase.status}</span>
          </div>
          <dl className="info-list">
            <div>
              <dt>优先级</dt>
              <dd>{testCase.priority}</dd>
            </div>
            <div>
              <dt>目标地址</dt>
              <dd>{testCase.targetUrl}</dd>
            </div>
            <div>
              <dt>图片上下文</dt>
              <dd>{testCase.imageNames.length ? testCase.imageNames.join(', ') : '无'}</dd>
            </div>
          </dl>
          <form action={runAction}>
            <button className="button full-width" type="submit">
              <Play size={16} />
              开始浏览器测试
            </button>
          </form>
        </aside>

        <div className="panel">
          <div className="panel-heading">
            <h2>测试步骤</h2>
            <span>{testCase.content.steps.length} 步</span>
          </div>
          <ol className="steps">
            {testCase.content.steps.map((step) => (
              <li className="step" key={step.index}>
                <div className="step-index">{step.index}</div>
                <div>
                  <div className="step-title">
                    <strong>{step.action}</strong>
                    <span className="badge">{step.operation || 'auto'}</span>
                    <span className={`badge risk-${step.riskLevel}`}>{step.riskLevel}</span>
                  </div>
                  {step.selectorHint ? <p>定位提示：{step.selectorHint}</p> : null}
                  {step.input ? <p>输入：{step.input}</p> : null}
                  <p className="muted">预期：{step.expected}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>
    </main>
  );
}
