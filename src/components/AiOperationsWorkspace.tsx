'use client';

import Link from 'next/link';
import {
  Activity,
  Bot,
  CircleAlert,
  Clock3,
  Cpu,
  Database,
  Gauge,
  LockKeyhole,
  MessageSquare,
  RefreshCw,
  Settings,
  Timer,
  Users,
  Workflow,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { useCallback, useLayoutEffect, useMemo, useState, type ReactNode } from 'react';
import { CustomSelect } from '@/components/CustomSelect';
import { WorkspaceNavItem, WorkspaceSidebar } from '@/components/WorkspaceSidebar';
import { useI18n } from '@/i18n/I18nProvider';
import { readApiJson } from '@/lib/api-client';
import {
  readSidebarCollapsedPreference,
  writeSidebarCollapsedPreference,
} from '@/lib/sidebar-collapse';
import { withWebPilotBasePath } from '@/lib/webpilot-base-path';
import type {
  AiOperationsDashboardData,
  AiOperationsStatus,
  AiOperationsTrendPoint,
} from '@/server/observability/ai-operations-dashboard';
import { useTheme } from '@/theme/ThemeProvider';

const rangeOptions = [7, 30, 90] as const;

function compactNumber(value: number) {
  return new Intl.NumberFormat('zh-CN', {
    maximumFractionDigits: value >= 1000 ? 1 : 0,
    notation: value >= 10_000 ? 'compact' : 'standard',
  }).format(value || 0);
}

function percent(value: number) {
  return `${Number.isFinite(value) ? value.toFixed(value % 1 ? 1 : 0) : '0'}%`;
}

function duration(value: number) {
  if (!value) return '—';
  if (value < 1000) return `${Math.round(value)}ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}s`;
  return `${Math.floor(value / 60_000)}m ${Math.round((value % 60_000) / 1000)}s`;
}

function dateTime(value: string) {
  if (!value) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    month: '2-digit',
  }).format(parsed);
}

function dayLabel(value: string) {
  return value.slice(5).replace('-', '/');
}

function statusLabel(status: AiOperationsStatus) {
  if (status === 'passed') return '成功';
  if (status === 'failed') return '失败';
  if (status === 'blocked') return '阻塞';
  if (status === 'running') return '执行中';
  if (status === 'interrupted') return '已中断';
  return '未知';
}

function MetricCard({
  detail,
  icon: Icon,
  label,
  tone = 'default',
  value,
}: {
  detail: string;
  icon: LucideIcon;
  label: string;
  tone?: 'danger' | 'default' | 'success' | 'warning';
  value: ReactNode;
}) {
  return (
    <article className={`ai-operations-metric-card tone-${tone}`}>
      <div className="ai-operations-metric-icon"><Icon aria-hidden="true" size={17} /></div>
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
        <small>{detail}</small>
      </div>
    </article>
  );
}

function ChartShell({ children, description, title }: { children: ReactNode; description: string; title: string }) {
  return (
    <section className="ai-operations-panel ai-operations-chart-panel">
      <header className="ai-operations-panel-header">
        <div>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
      </header>
      {children}
    </section>
  );
}

function UsageTrendChart({ points }: { points: AiOperationsTrendPoint[] }) {
  const maximum = Math.max(1, ...points.map((point) => point.chatTasks + point.automationRuns));
  const labelEvery = points.length <= 7 ? 1 : points.length <= 30 ? 5 : 15;
  return (
    <div
      aria-label="对话任务与自动化运行使用趋势"
      className="ai-operations-chart"
      role="img"
    >
      <div className="ai-operations-chart-grid" aria-hidden="true"><span /><span /><span /><span /></div>
      <div className="ai-operations-chart-columns">
        {points.map((point, index) => {
          const total = point.chatTasks + point.automationRuns;
          return (
            <div
              className="ai-operations-chart-column"
              key={point.date}
              title={`${point.date}：对话 ${point.chatTasks}，自动化 ${point.automationRuns}`}
            >
              <div className="ai-operations-chart-column-track">
                <div
                  className="ai-operations-stacked-bar usage-bar"
                  style={{ height: `${total ? Math.max(3, total / maximum * 100) : 0}%` }}
                >
                  <span className="is-chat" style={{ flexGrow: point.chatTasks }} />
                  <span className="is-automation" style={{ flexGrow: point.automationRuns }} />
                </div>
              </div>
              <span className="ai-operations-chart-label">
                {index % labelEvery === 0 || index === points.length - 1 ? dayLabel(point.date) : ''}
              </span>
            </div>
          );
        })}
      </div>
      <div className="ai-operations-chart-legend">
        <span><i className="is-chat" />对话任务</span>
        <span><i className="is-automation" />自动化运行</span>
      </div>
    </div>
  );
}

function OutcomeTrendChart({ points }: { points: AiOperationsTrendPoint[] }) {
  const maximum = Math.max(1, ...points.map((point) => point.passed + point.failed + point.blocked + point.interrupted));
  const labelEvery = points.length <= 7 ? 1 : points.length <= 30 ? 5 : 15;
  return (
    <div aria-label="任务执行结果趋势" className="ai-operations-chart" role="img">
      <div className="ai-operations-chart-grid" aria-hidden="true"><span /><span /><span /><span /></div>
      <div className="ai-operations-chart-columns">
        {points.map((point, index) => {
          const total = point.passed + point.failed + point.blocked + point.interrupted;
          return (
            <div
              className="ai-operations-chart-column"
              key={point.date}
              title={`${point.date}：成功 ${point.passed}，失败 ${point.failed}，阻塞 ${point.blocked}，中断 ${point.interrupted}`}
            >
              <div className="ai-operations-chart-column-track">
                <div
                  className="ai-operations-stacked-bar outcome-bar"
                  style={{ height: `${total ? Math.max(3, total / maximum * 100) : 0}%` }}
                >
                  <span className="is-passed" style={{ flexGrow: point.passed }} />
                  <span className="is-blocked" style={{ flexGrow: point.blocked }} />
                  <span className="is-failed" style={{ flexGrow: point.failed + point.interrupted }} />
                </div>
              </div>
              <span className="ai-operations-chart-label">
                {index % labelEvery === 0 || index === points.length - 1 ? dayLabel(point.date) : ''}
              </span>
            </div>
          );
        })}
      </div>
      <div className="ai-operations-chart-legend">
        <span><i className="is-passed" />成功</span>
        <span><i className="is-blocked" />阻塞</span>
        <span><i className="is-failed" />失败/中断</span>
      </div>
    </div>
  );
}

function EmptyState({ children }: { children: ReactNode }) {
  return <div className="ai-operations-empty">{children}</div>;
}

export function AiOperationsWorkspace({
  initialData,
  initialSidebarCollapsed = false,
}: {
  initialData: AiOperationsDashboardData;
  initialSidebarCollapsed?: boolean;
}) {
  const { t } = useI18n();
  const { mode: themeMode, toggleMode } = useTheme();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(initialSidebarCollapsed);
  const [data, setData] = useState(initialData);
  const [rangeDays, setRangeDays] = useState(initialData.rangeDays);
  const [trendUserId, setTrendUserId] = useState(initialData.trendUserId || '');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useLayoutEffect(() => {
    const stored = readSidebarCollapsedPreference(initialSidebarCollapsed);
    setSidebarCollapsed(stored);
    writeSidebarCollapsedPreference(stored);
  }, [initialSidebarCollapsed]);

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed((current) => {
      const next = !current;
      writeSidebarCollapsedPreference(next);
      return next;
    });
  }, []);

  const loadDashboard = useCallback(async (days: number, userId: string) => {
    setLoading(true);
    setError('');
    try {
      const query = new URLSearchParams({ days: String(days) });
      if (userId) query.set('userId', userId);
      const response = await fetch(withWebPilotBasePath(`/api/admin/ai-operations?${query}`), {
        cache: 'no-store',
      });
      const nextData = await readApiJson<AiOperationsDashboardData>(response, '加载 AI 运营指标失败');
      setData(nextData);
      setRangeDays(days);
      setTrendUserId(nextData.trendUserId || '');
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '加载 AI 运营指标失败');
    } finally {
      setLoading(false);
    }
  }, []);

  const overview = data.overview;
  const maximumSystemTasks = Math.max(1, ...data.systems.map((item) => item.totalTasks));
  const trendUserOptions = useMemo(() => [
    { label: '全部用户', description: '查看公司整体使用趋势', value: '' },
    ...data.trendUsers.map((item) => ({
      description: `${item.totalTasks} 个任务 · ${compactNumber(item.totalTokens)} Token`,
      label: `用户 ${item.userId}`,
      selectedLabel: `用户 ${item.userId}`,
      value: item.userId,
    })),
  ], [data.trendUsers]);
  const trendScopeLabel = trendUserId ? `用户 ${trendUserId}` : '全部用户';

  return (
    <section className={sidebarCollapsed ? 'browser-chat-layout sidebar-collapsed ai-operations-layout' : 'browser-chat-layout ai-operations-layout'}>
      <WorkspaceSidebar
        className="ai-operations-sidebar"
        collapsed={sidebarCollapsed}
        collapseLabel={t(sidebarCollapsed ? '展开侧边栏' : '折叠侧边栏')}
        onToggleCollapse={toggleSidebar}
        onToggleTheme={toggleMode}
        themeMode={themeMode}
        themeToggleLabel={t(themeMode === 'dark' ? '切换到浅色模式' : '切换到深色模式')}
        themeToggleTitle={t(themeMode === 'dark' ? '浅色模式' : '深色模式')}
      >
        <nav className="browser-chat-nav" aria-label={t('工作模式')}>
          <WorkspaceNavItem href="/browser-chat" icon={<MessageSquare size={17} />} label={t('对话模式')} />
          <WorkspaceNavItem href="/automation" icon={<Workflow size={17} />} label={t('自动化')} />
          <WorkspaceNavItem active href="/admin/ai-operations" icon={<Gauge size={17} />} label={t('AI 运营')} />
          <WorkspaceNavItem href="/settings" icon={<Settings size={17} />} label={t('设置')} />
        </nav>
        <section aria-label={t('管理员')} className="browser-chat-sidebar-section ai-operations-sidebar-summary">
          <div aria-current="page" className="ai-operations-sidebar-current">
            <span className="ai-operations-sidebar-current-icon">
              <Gauge aria-hidden="true" size={16} />
            </span>
            <span>{t('运营视图')}</span>
          </div>
          <small className="ai-operations-sidebar-access">
            <LockKeyhole aria-hidden="true" size={12} />
            <span>{t('仅用户 1 可访问')}</span>
          </small>
        </section>
      </WorkspaceSidebar>

      <main className="browser-chat-main ai-operations-main">
        <div className="ai-operations-content" aria-busy={loading}>
          <header className="ai-operations-page-header">
            <div>
              <div className="ai-operations-eyebrow"><Activity size={14} /> {t('管理员专属')}</div>
              <h1>{t('AI 运营中心')}</h1>
              <p>{t('查看 AI 对话、自动化运行、模型使用、异常任务与系统运行状态。')}</p>
            </div>
            <div className="ai-operations-header-controls">
              <div className="ai-operations-range" aria-label={t('统计时间范围')}>
                {rangeOptions.map((days) => (
                  <button
                    aria-pressed={rangeDays === days}
                    className={rangeDays === days ? 'active' : undefined}
                    disabled={loading}
                    key={days}
                    onClick={() => void loadDashboard(days, trendUserId)}
                    type="button"
                  >
                    {days} {t('天')}
                  </button>
                ))}
              </div>
              <button
                className="ai-operations-refresh"
                disabled={loading}
                onClick={() => void loadDashboard(rangeDays, trendUserId)}
                type="button"
              >
                <RefreshCw className={loading ? 'spin' : undefined} size={15} />
                {t('刷新')}
              </button>
            </div>
          </header>

          <div className="ai-operations-meta-row">
            <span>{t('时区')}：{data.timezone}</span>
            <span>{t('更新时间')}：{dateTime(data.generatedAt)}</span>
            {error ? <strong role="alert">{error}</strong> : null}
          </div>

          <section className="ai-operations-panel ai-operations-runtime-panel">
            <header className="ai-operations-panel-header"><div><h2>{t('系统运行状态')}</h2><p>{t('当前进程的任务队列与工作线程')}</p></div></header>
            <div className="ai-operations-runtime-grid">
              <div><Database size={17} /><span>{t('SQLite 写入队列')}</span><strong>{data.runtime.sqliteWrites.pending}</strong><small>{data.runtime.sqliteWrites.workerActive ? t('工作线程运行中') : t('当前空闲')}</small></div>
              <div><Cpu size={17} /><span>{t('CPU 工作线程')}</span><strong>{data.runtime.cpuWorkers.active}/{data.runtime.cpuWorkers.workers}</strong><small>{data.runtime.cpuWorkers.queued} {t('个等待任务')}</small></div>
              <div><Workflow size={17} /><span>{t('启用的执行计划')}</span><strong>{overview.enabledSchedules}</strong><small>{overview.automationRuns} {t('次范围内运行')}</small></div>
              <div><Clock3 size={17} /><span>{t('数据生成时间')}</span><strong>{dateTime(data.generatedAt)}</strong><small>{data.timezone}</small></div>
            </div>
          </section>

          <section className="ai-operations-metric-grid" aria-label={t('运营总览')}>
            <MetricCard detail={`${overview.chatTasks} 对话 · ${overview.automationRuns} 自动化`} icon={Activity} label={t('任务总量')} value={compactNumber(overview.totalTasks)} />
            <MetricCard detail={`${overview.passed} 个成功结果`} icon={Gauge} label={t('任务成功率')} tone="success" value={percent(overview.successRate)} />
            <MetricCard detail={`${overview.failed} 失败 · ${overview.blocked} 阻塞`} icon={CircleAlert} label={t('异常任务')} tone={overview.failed || overview.blocked ? 'danger' : 'default'} value={compactNumber(overview.failed + overview.blocked)} />
            <MetricCard detail={`${overview.enabledSchedules} 个计划已启用`} icon={Workflow} label={t('当前执行中')} tone={overview.runningNow ? 'warning' : 'default'} value={compactNumber(overview.runningNow)} />
            <MetricCard detail={`P95 ${duration(overview.p95DurationMs)}`} icon={Timer} label={t('平均耗时')} value={duration(overview.averageDurationMs)} />
            <MetricCard detail={`${overview.repairs} 次恢复或修复`} icon={Wrench} label={t('AI 自动修复')} value={compactNumber(overview.repairs)} />
            <MetricCard detail={`${overview.modelCalls} 次进程内模型调用`} icon={Bot} label={t('模型 Token')} value={compactNumber(overview.inputTokens + overview.outputTokens)} />
            <MetricCard detail={t('统计范围内有任务的用户')} icon={Users} label={t('活跃用户')} value={compactNumber(overview.activeUsers)} />
          </section>

          <div className="ai-operations-trend-toolbar">
            <div>
              <strong>{t('趋势分析')}</strong>
              <span>{trendScopeLabel} · {rangeDays} {t('天')}</span>
            </div>
            <div className="ai-operations-trend-user-filter">
              <span>{t('趋势用户')}</span>
              <CustomSelect
                className="ai-operations-user-select"
                disabled={loading}
                onChange={(userId) => void loadDashboard(rangeDays, userId)}
                options={trendUserOptions}
                searchable={trendUserOptions.length > 8}
                searchPlaceholder={t('搜索用户')}
                title={t('选择要查看趋势的用户')}
                value={trendUserId}
              />
            </div>
          </div>

          <div className="ai-operations-chart-grid-layout">
            <ChartShell description={`${trendScopeLabel} · ${t('按天统计对话请求与自动化运行次数')}`} title={t('使用趋势')}>
              <UsageTrendChart points={data.trend} />
            </ChartShell>
            <ChartShell description={`${trendScopeLabel} · ${t('按天查看成功、失败、阻塞与中断情况')}`} title={t('执行结果趋势')}>
              <OutcomeTrendChart points={data.trend} />
            </ChartShell>
          </div>

          <div className="ai-operations-lower-grid">
            <section className="ai-operations-panel ai-operations-incidents-panel">
              <header className="ai-operations-panel-header">
                <div>
                  <h2>{t('异常任务')}</h2>
                  <p>{t('最近失败、阻塞或中断的任务')}</p>
                </div>
                <span>{data.incidents.length}</span>
              </header>
              {data.incidents.length ? (
                <div className="ai-operations-table-wrap">
                  <table className="ai-operations-table">
                    <thead><tr><th>{t('任务')}</th><th>{t('用户')}</th><th>{t('状态')}</th><th>{t('目标')}</th><th>{t('时间')}</th></tr></thead>
                    <tbody>
                      {data.incidents.slice(0, 20).map((item) => (
                        <tr key={item.id}>
                          <td>
                            {item.href ? <Link href={item.href}>{item.title}</Link> : <strong>{item.title}</strong>}
                            <small title={item.reason}>{item.reason}</small>
                          </td>
                          <td>{item.userId}</td>
                          <td><span className={`ai-operations-status is-${item.status}`}>{statusLabel(item.status)}</span></td>
                          <td>{item.target}</td>
                          <td>{dateTime(item.time)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : <EmptyState>{t('当前范围内没有异常任务')}</EmptyState>}
            </section>

            <section className="ai-operations-panel ai-operations-systems-panel">
              <header className="ai-operations-panel-header">
                <div><h2>{t('目标系统')}</h2><p>{t('按浏览器目标域名统计任务量和成功率')}</p></div>
              </header>
              {data.systems.length ? (
                <div className="ai-operations-system-list">
                  {data.systems.slice(0, 10).map((item) => (
                    <div className="ai-operations-system-row" key={item.target}>
                      <div><strong>{item.target}</strong><span>{item.totalTasks} · {percent(item.successRate)}</span></div>
                      <div className="ai-operations-horizontal-track"><span style={{ width: `${Math.max(3, item.totalTasks / maximumSystemTasks * 100)}%` }} /></div>
                    </div>
                  ))}
                </div>
              ) : <EmptyState>{t('暂无目标系统使用数据')}</EmptyState>}
            </section>
          </div>

          <div className="ai-operations-table-grid">
            <section className="ai-operations-panel">
              <header className="ai-operations-panel-header"><div><h2>{t('用户使用情况')}</h2><p>{t('按用户统计任务量和执行结果')}</p></div></header>
              {data.users.length ? (
                <div className="ai-operations-table-wrap">
                  <table className="ai-operations-table compact">
                    <thead><tr><th>{t('用户')}</th><th>{t('任务')}</th><th>{t('Token 用量')}</th><th>{t('对话')}</th><th>{t('自动化')}</th><th>{t('成功率')}</th><th>{t('最近使用')}</th></tr></thead>
                    <tbody>{data.users.map((item) => (
                      <tr key={item.userId}>
                        <td><strong>{item.userId}</strong></td>
                        <td>{item.totalTasks}</td>
                        <td className="ai-operations-token-usage"><strong>{compactNumber(item.totalTokens)}</strong><small>输入 {compactNumber(item.inputTokens)} · 输出 {compactNumber(item.outputTokens)}</small></td>
                        <td>{item.chatTasks}</td>
                        <td>{item.automationRuns}</td>
                        <td>{percent(item.successRate)}</td>
                        <td>{dateTime(item.lastActiveAt)}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              ) : <EmptyState>{t('暂无用户使用数据')}</EmptyState>}
            </section>

            <section className="ai-operations-panel">
              <header className="ai-operations-panel-header"><div><h2>{t('模型使用情况')}</h2><p>{t('历史任务与当前服务进程 Token 指标')}</p></div></header>
              {data.models.length ? (
                <div className="ai-operations-table-wrap">
                  <table className="ai-operations-table compact">
                    <thead><tr><th>{t('模型')}</th><th>{t('任务')}</th><th>{t('调用')}</th><th>{t('输入 Token')}</th><th>{t('输出 Token')}</th><th>{t('平均响应')}</th></tr></thead>
                    <tbody>{data.models.map((item) => (
                      <tr key={`${item.provider}:${item.model}`}>
                        <td><strong>{item.model}</strong><small>{item.provider}</small></td>
                        <td>{item.taskCount}</td><td>{compactNumber(item.calls)}</td><td>{compactNumber(item.inputTokens)}</td><td>{compactNumber(item.outputTokens)}</td><td>{duration(item.averageResponseMs)}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              ) : <EmptyState>{t('暂无模型使用数据')}</EmptyState>}
            </section>
          </div>

        </div>
      </main>
    </section>
  );
}
