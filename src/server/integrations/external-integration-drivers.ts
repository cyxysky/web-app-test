import { createHash, randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { DataSource } from 'typeorm';
import { createMcpStreamableHttpConnector } from '@webpilot/capability-connectors/node';
import type { AgentConnector } from '@webpilot/capability-connectors';
import type { AgentDataSource } from '@webpilot/capability-data';
import { createTypeOrmAgentDataSource } from '@webpilot/capability-data/typeorm';
import type { ResearchOperations, ResearchSource } from '@webpilot/capability-research';
import {
  createConnectorCommunicationChannel,
  createJsonWebhookChannel,
  discoverWeComAiBotConversation,
} from '@webpilot/capability-communication/node';
import type { CommunicationChannel, CommunicationDraft } from '@webpilot/capability-communication';
import type {
  ExternalIntegrationCategory,
  ExternalIntegrationConfiguration,
  ResolvedExternalIntegration,
} from './external-integration-vault';

export type ExternalIntegrationFieldDescriptor = {
  key: string;
  label: string;
  description?: string;
  control: 'text' | 'password' | 'url' | 'textarea' | 'select';
  placeholder?: string;
  required?: boolean;
  secret?: boolean;
  hidden?: boolean;
  defaultValue?: string;
  options?: Array<{ label: string; value: string }>;
  visibleWhen?: { field: string; value: string };
  picker?: 'file';
};

export type ExternalIntegrationDriverDescriptor = {
  id: string;
  category: ExternalIntegrationCategory;
  label: string;
  description: string;
  testLabel: string;
  testHint?: string;
  fields: ExternalIntegrationFieldDescriptor[];
};

export type ExternalIntegrationPublicSummary = {
  id: string;
  category: ExternalIntegrationCategory;
  driverId: string;
  name: string;
  detailPreview: string;
  configuredFields: string[];
  publicConfiguration: ExternalIntegrationConfiguration;
  enabled: boolean;
  updatedAt: string;
};

export type ExternalIntegrationTestResult =
  | { kind: 'operations'; operationCount: number; operations: string[] }
  | { kind: 'delivered'; deliveryCount: number }
  | { kind: 'target-discovered'; target: { kind: 'user' | 'group'; id: string }; targetBinding: string }
  | { kind: 'data-source'; tableCount: number; tables: string[] }
  | { kind: 'search-results'; resultCount: number; results: string[] };

export type ExternalIntegrationTestProgress = {
  stage: 'connecting' | 'connected' | 'authenticated' | 'verifying';
};

type ResearchSearch = NonNullable<ResearchOperations['search']>;

type ExternalIntegrationDriver = ExternalIntegrationDriverDescriptor & {
  normalize(configuration: ExternalIntegrationConfiguration): ExternalIntegrationConfiguration;
  summarize(configuration: ExternalIntegrationConfiguration): string;
  createConnector?(integration: ResolvedExternalIntegration, timeoutMs: number): AgentConnector;
  createChannel?(integration: ResolvedExternalIntegration, timeoutMs: number): CommunicationChannel;
  createDataSource?(integration: ResolvedExternalIntegration, timeoutMs: number): Promise<AgentDataSource>;
  createResearchSearch?(integration: ResolvedExternalIntegration, timeoutMs: number): ResearchSearch;
  test(
    integration: ResolvedExternalIntegration,
    timeoutMs: number,
    abortSignal?: AbortSignal,
    onProgress?: (progress: ExternalIntegrationTestProgress) => void,
  ): Promise<ExternalIntegrationTestResult>;
};

function httpEndpoint(value: string, label: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`请输入有效的${label}。`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`${label}仅支持 HTTP 或 HTTPS。`);
  if (url.username || url.password) throw new Error(`${label}不能包含用户名或密码。`);
  return url.href;
}

function websocketEndpoint(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('请输入有效的 WebSocket 长连接地址。');
  }
  if (url.protocol !== 'wss:' && url.protocol !== 'ws:') throw new Error('长连接地址仅支持 WSS 或 WS。');
  if (url.username || url.password) throw new Error('长连接地址不能包含用户名或密码。');
  return url.href;
}

function endpointPreview(endpoint: string) {
  const url = new URL(endpoint);
  const hiddenPath = url.pathname && url.pathname !== '/' ? '/••••' : '';
  return `${url.protocol}//${url.host}${hiddenPath}`;
}

function authenticationConfiguration(configuration: ExternalIntegrationConfiguration): ExternalIntegrationConfiguration {
  const authentication = configuration.authentication || 'none';
  if (authentication !== 'none' && authentication !== 'bearer') throw new Error('不支持所选认证方式。');
  const token = configuration.token?.trim();
  if (authentication === 'bearer' && !token) throw new Error('使用 Bearer Token 时必须填写访问令牌。');
  return authentication === 'bearer' ? { authentication: 'bearer', token: token! } : { authentication: 'none' };
}

function authorizationHeader(configuration: ExternalIntegrationConfiguration) {
  return configuration.authentication === 'bearer' && configuration.token
    ? { authorization: `Bearer ${configuration.token}` }
    : undefined;
}

function accessConfiguration(configuration: ExternalIntegrationConfiguration) {
  const access = configuration.access || 'read-only';
  if (access !== 'read-only' && access !== 'read-write') throw new Error('不支持所选数据访问权限。');
  return access;
}

function boundedPort(value: string, fallback: number) {
  const port = Number(value || fallback);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('请输入 1 到 65535 之间的数据库端口。');
  return port;
}

function requiredText(value: string | undefined, label: string, maximum = 500) {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`请输入${label}。`);
  if (normalized.length > maximum) throw new Error(`${label}过长。`);
  return normalized;
}

function researchAuthentication(configuration: ExternalIntegrationConfiguration): ExternalIntegrationConfiguration {
  const authentication = configuration.authentication || 'none';
  if (authentication === 'none') return { authentication };
  if (authentication === 'bearer') {
    return {
      authentication,
      token: requiredText(configuration.token, '访问令牌', 20_000),
    };
  }
  if (authentication === 'api-key') {
    const apiKeyHeader = requiredText(configuration.apiKeyHeader, 'API Key 请求头名称', 100).toLowerCase();
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(apiKeyHeader)) throw new Error('API Key 请求头名称无效。');
    if (apiKeyHeader === 'content-type' || apiKeyHeader === 'accept' || apiKeyHeader === 'content-length' || apiKeyHeader === 'host') {
      throw new Error('该请求头名称不能用于 API Key。');
    }
    return {
      authentication,
      apiKeyHeader,
      apiKey: requiredText(configuration.apiKey, 'API Key', 20_000),
    };
  }
  throw new Error('不支持所选认证方式。');
}

function researchHeaders(configuration: ExternalIntegrationConfiguration): Record<string, string> {
  if (configuration.authentication === 'bearer') return { authorization: `Bearer ${configuration.token}` };
  if (configuration.authentication === 'api-key') return { [configuration.apiKeyHeader]: configuration.apiKey };
  return {};
}

function normalizedResearchSources(payload: unknown, provider: string, limit: number): ResearchSource[] {
  const values = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object' && Array.isArray((payload as Record<string, unknown>).results)
      ? (payload as { results: unknown[] }).results
      : [];
  return values.slice(0, limit).flatMap((item, index): ResearchSource[] => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const url = typeof record.url === 'string' ? record.url.trim() : '';
    if (!url) return [];
    return [{
      sourceId: typeof record.sourceId === 'string' && record.sourceId.trim()
        ? record.sourceId.trim()
        : `source_${createHash('sha256').update(url).digest('hex').slice(0, 16)}`,
      url,
      title: typeof record.title === 'string' && record.title.trim() ? record.title.trim() : `Search result ${index + 1}`,
      snippet: typeof record.snippet === 'string' ? record.snippet : undefined,
      provider,
      retrievedAt: new Date().toISOString(),
    }];
  });
}

function resultRecord(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function decodedOperationResultValues(value: unknown, depth = 0): unknown[] {
  if (depth > 5 || value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.flatMap((item) => decodedOperationResultValues(item, depth + 1));
  const record = resultRecord(value);
  if (!record) return [value];
  const values: unknown[] = [record];
  if (record.type === 'text' && typeof record.text === 'string') {
    try {
      values.push(...decodedOperationResultValues(JSON.parse(record.text), depth + 1));
    } catch {
      values.push(record.text.trim());
    }
  }
  for (const key of ['content', 'structuredContent', 'data', 'result', 'response', 'receipt', 'output']) {
    if (record[key] !== undefined) values.push(...decodedOperationResultValues(record[key], depth + 1));
  }
  return values;
}

function compactOperationResult(value: unknown) {
  try {
    return JSON.stringify(value).slice(0, 1_000);
  } catch {
    return String(value).slice(0, 1_000);
  }
}

function verifyWeComMessageSendResult(result: unknown) {
  let accepted = false;
  for (const value of decodedOperationResultValues(result)) {
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (['ok', 'success', 'sent', 'message sent successfully', '发送成功', '消息发送成功'].includes(normalized)) {
        accepted = true;
      }
      continue;
    }
    const record = resultRecord(value);
    if (!record) continue;
    if (Object.prototype.hasOwnProperty.call(record, 'errcode')) {
      const errcode = Number(record.errcode);
      if (Number.isFinite(errcode) && errcode !== 0) {
        const detail = String(record.errmsg || record.message || '未知错误');
        if (errcode === 40073 || /chat[_\s-]?id/i.test(detail)) {
          throw new Error(`企业微信拒绝了已识别的会话标识（errcode ${errcode}）：${detail}。请确认“消息 MCP 地址”与 Bot ID、Secret 来自同一个机器人，并在该机器人的“消息”权限页完成授权后重新复制 MCP 地址，再重新连接验证。`);
        }
        throw new Error(`企业微信拒绝发送（errcode ${errcode}）：${detail}`);
      }
      if (errcode === 0) accepted = true;
    }
    if (record.ok === false || record.success === false || record.accepted === false) {
      throw new Error(`企业微信拒绝发送：${String(record.errmsg || record.message || record.error || '未知错误')}`);
    }
    if (record.ok === true || record.success === true || record.accepted === true) accepted = true;
    if (['msgid', 'message_id', 'messageId', 'delivery_id', 'deliveryId'].some((key) => {
      const identifier = record[key];
      return (typeof identifier === 'string' || typeof identifier === 'number') && String(identifier).trim() !== '';
    })) accepted = true;
  }
  if (!accepted) {
    throw new Error(`企业微信 MCP 未返回可验证的发送回执，不能确认消息已送达。原始返回：${compactOperationResult(result)}`);
  }
}

const weComMessageOperationId = 'message_aibot_send';
const weComSessionsOperationId = 'message_aibot_sessions_list';

function assertWeComOperationSucceeded(result: unknown, label: string) {
  const root = resultRecord(result);
  if (root?.isError === true) {
    const text = Array.isArray(root.content)
      ? root.content.flatMap((item) => {
        const entry = resultRecord(item);
        return typeof entry?.text === 'string' ? [entry.text.trim()] : [];
      }).filter(Boolean).join('\n')
      : '';
    throw new Error(`${label}失败：${text || String(root.message || root.error || '未知错误')}`);
  }
  for (const value of decodedOperationResultValues(result)) {
    const record = resultRecord(value);
    if (!record || !Object.prototype.hasOwnProperty.call(record, 'errcode')) continue;
    const errcode = Number(record.errcode);
    if (Number.isFinite(errcode) && errcode !== 0) {
      throw new Error(`${label}失败（errcode ${errcode}）：${String(record.errmsg || record.message || '未知错误')}`);
    }
  }
}

function weComRecentSessions(result: unknown) {
  assertWeComOperationSucceeded(result, '获取企业微信最近会话');
  for (const value of decodedOperationResultValues(result)) {
    const record = resultRecord(value);
    if (!record || !Array.isArray(record.sessions)) continue;
    return record.sessions.flatMap((item) => {
      const session = resultRecord(item);
      const id = typeof session?.chat_id === 'string' ? session.chat_id.trim() : '';
      const kind = session?.chat_type === 'group'
        ? 'group' as const
        : session?.chat_type === 'single'
          ? 'user' as const
          : undefined;
      if (!id || !kind) return [];
      const name = typeof session.chat_name === 'string' ? session.chat_name.trim() : '';
      return [{ kind, id, ...(name ? { name } : {}) }];
    });
  }
  throw new Error('企业微信最近会话接口没有返回 sessions 列表。');
}

async function resolveWeComTargets(
  connector: AgentConnector,
  targets: readonly { kind: string; id: string; name?: string }[],
  context: Parameters<AgentConnector['call']>[2],
) {
  const result = await connector.call(weComSessionsOperationId, {}, context);
  const sessions = weComRecentSessions(result);
  if (!sessions.length) {
    throw new Error('企业微信最近会话列表为空。请先给机器人发送一条消息，群聊中需要先 @机器人。');
  }
  return targets.map((target) => {
    const expectedKind = target.kind === 'group' ? 'group' : 'user';
    const session = sessions.find((item) => item.kind === expectedKind && item.id === target.id);
    if (!session) {
      throw new Error(`当前企业微信最近会话列表中没有这个${expectedKind === 'group' ? '群聊' : '单聊'}。请重新给机器人发送一条消息后再试。`);
    }
    return session;
  });
}

function weComTargetBinding(input: {
  botId: string;
  endpoint: string;
  target: { kind: 'user' | 'group'; id: string };
}) {
  return createHash('sha256')
    .update(`${input.endpoint}\0${input.botId}\0${input.target.kind}\0${input.target.id}`)
    .digest('hex');
}

function verifiedWeComTarget(configuration: ExternalIntegrationConfiguration) {
  const id = configuration.defaultTarget?.trim();
  if (!id) return undefined;
  const kind = configuration.defaultTargetKind === 'group' ? 'group' as const : 'user' as const;
  const expectedBinding = weComTargetBinding({
    botId: configuration.botId,
    endpoint: configuration.endpoint,
    target: { kind, id },
  });
  return configuration.defaultTargetBinding === expectedBinding ? { kind, id } : undefined;
}

function createWeComAiBotChannel(
  integration: ResolvedExternalIntegration,
  timeoutMs: number,
  existingConnector?: AgentConnector,
) {
  const connector = existingConnector || createMcpStreamableHttpConnector({
    id: integration.id,
    name: integration.name,
    url: integration.configuration.endpoint,
    timeoutMs,
  });
  const defaultTarget = verifiedWeComTarget(integration.configuration);
  return createConnectorCommunicationChannel({
    id: integration.id,
    name: integration.name,
    driverId: 'wecom-aibot-mcp',
    connector,
    operationId: weComMessageOperationId,
    requiredOperationIds: [weComSessionsOperationId],
    capabilities: {
      targetKinds: ['user', 'group'],
      contentFormats: ['text', 'markdown'],
    },
    defaultTargets: defaultTarget ? [defaultTarget] : [],
    resolveTargets(targets, _draft, context) {
      return resolveWeComTargets(connector, targets, context);
    },
    mapArguments(draft, target) {
      const title = draft.content.title?.trim();
      const content = title ? `### ${title}\n\n${draft.content.body}` : draft.content.body;
      if (Buffer.byteLength(content, 'utf8') > 20_480) {
        throw new Error('企业微信 Markdown 消息不能超过 20480 字节。');
      }
      return {
        chat_id: target.id,
        msg_type: 'markdown',
        markdown: { content },
      };
    },
    verifyResult(result) {
      verifyWeComMessageSendResult(result);
    },
  });
}

function connectorDriver(): ExternalIntegrationDriver {
  return {
    id: 'mcp-streamable-http',
    category: 'connector',
    label: 'MCP Streamable HTTP',
    description: '连接遵循 MCP Streamable HTTP 标准的业务系统或工具服务。',
    testLabel: '测试并发现操作',
    fields: [
      { key: 'endpoint', label: 'MCP 服务地址', control: 'url', placeholder: 'https://example.com/mcp', required: true, secret: true },
      {
        key: 'authentication',
        label: '认证方式',
        control: 'select',
        defaultValue: 'none',
        options: [{ label: '无需认证', value: 'none' }, { label: 'Bearer Token', value: 'bearer' }],
      },
      { key: 'token', label: '访问令牌', control: 'password', placeholder: '输入访问令牌', required: true, secret: true, visibleWhen: { field: 'authentication', value: 'bearer' } },
    ],
    normalize(configuration) {
      return {
        endpoint: httpEndpoint(configuration.endpoint, 'MCP 服务地址'),
        ...authenticationConfiguration(configuration),
      };
    },
    summarize(configuration) {
      return endpointPreview(configuration.endpoint);
    },
    createConnector(integration, timeoutMs) {
      return createMcpStreamableHttpConnector({
        id: integration.id,
        name: integration.name,
        url: integration.configuration.endpoint,
        headers: authorizationHeader(integration.configuration),
        timeoutMs,
      });
    },
    async test(integration, timeoutMs) {
      const connector = this.createConnector!(integration, timeoutMs);
      try {
        const operations = await connector.listOperations({ invocationId: `settings-test-${randomUUID()}` });
        return {
          kind: 'operations',
          operationCount: operations.length,
          operations: operations.slice(0, 10).map((item) => item.title || item.id),
        };
      } finally {
        await connector.dispose?.();
      }
    },
  };
}

function sqliteDataDriver(): ExternalIntegrationDriver {
  return {
    id: 'sqlite',
    category: 'data',
    label: 'SQLite',
    description: '连接 WebPilot 运行主机上的 SQLite 数据库文件。',
    testLabel: '测试并读取表结构',
    fields: [
      {
        key: 'database',
        label: '数据库文件',
        description: '填写运行 WebPilot 的这台主机上的 .db、.sqlite 或 .sqlite3 文件路径；桌面版可直接选择文件。',
        control: 'text',
        placeholder: 'C:\\data\\analytics.db',
        required: true,
        picker: 'file',
      },
      {
        key: 'access',
        label: '访问权限',
        control: 'select',
        defaultValue: 'read-only',
        options: [{ label: '只读（推荐）', value: 'read-only' }, { label: '允许写入', value: 'read-write' }],
      },
    ],
    normalize(configuration) {
      const database = requiredText(configuration.database, '数据库文件', 4_000);
      return { database: path.resolve(database), access: accessConfiguration(configuration) };
    },
    summarize(configuration) {
      return `${path.basename(configuration.database)} · ${configuration.access === 'read-write' ? '可写' : '只读'}`;
    },
    async createDataSource(integration) {
      const readOnly = integration.configuration.access !== 'read-write';
      const databaseStat = await stat(integration.configuration.database).catch(() => undefined);
      if (!databaseStat?.isFile()) throw new Error('找不到所选 SQLite 数据库文件。');
      const source = new DataSource({
        type: 'better-sqlite3',
        database: integration.configuration.database,
        readonly: readOnly,
        logging: false,
        synchronize: false,
      });
      await source.initialize();
      const adapter = createTypeOrmAgentDataSource({
        id: integration.id,
        name: integration.name,
        source,
        readOnly,
      });
      return {
        ...adapter,
        async dispose() {
          if (source.isInitialized) await source.destroy();
        },
      };
    },
    async test(integration, timeoutMs) {
      const source = await this.createDataSource!(integration, timeoutMs);
      try {
        const tables = await source.schema({ invocationId: `settings-test-${randomUUID()}` });
        return {
          kind: 'data-source',
          tableCount: tables.length,
          tables: tables.slice(0, 10).map((table) => table.name),
        };
      } finally {
        await source.dispose?.();
      }
    },
  };
}

function postgresDataDriver(): ExternalIntegrationDriver {
  return {
    id: 'postgresql',
    category: 'data',
    label: 'PostgreSQL',
    description: '使用主机、端口、数据库和账号信息连接 PostgreSQL，无需拼接连接字符串。',
    testLabel: '测试并读取表结构',
    fields: [
      { key: 'host', label: '主机地址', control: 'text', placeholder: 'db.example.com', required: true },
      { key: 'port', label: '端口', control: 'text', placeholder: '5432', defaultValue: '5432', required: true },
      { key: 'database', label: '数据库名称', control: 'text', placeholder: 'analytics', required: true },
      { key: 'username', label: '用户名', control: 'text', placeholder: 'webpilot', required: true },
      { key: 'password', label: '密码', control: 'password', placeholder: '输入数据库密码', required: true, secret: true },
      {
        key: 'sslMode',
        label: 'SSL 模式',
        control: 'select',
        defaultValue: 'disable',
        options: [
          { label: '不使用 SSL', value: 'disable' },
          { label: '使用 SSL', value: 'require' },
          { label: 'SSL 并验证证书', value: 'verify-full' },
        ],
      },
      {
        key: 'access',
        label: '访问权限',
        control: 'select',
        defaultValue: 'read-only',
        options: [{ label: '只读（推荐）', value: 'read-only' }, { label: '允许写入', value: 'read-write' }],
      },
    ],
    normalize(configuration) {
      const sslMode = configuration.sslMode || 'disable';
      if (sslMode !== 'disable' && sslMode !== 'require' && sslMode !== 'verify-full') throw new Error('不支持所选 SSL 模式。');
      return {
        host: requiredText(configuration.host, '主机地址'),
        port: String(boundedPort(configuration.port, 5432)),
        database: requiredText(configuration.database, '数据库名称'),
        username: requiredText(configuration.username, '用户名'),
        password: requiredText(configuration.password, '密码', 20_000),
        sslMode,
        access: accessConfiguration(configuration),
      };
    },
    summarize(configuration) {
      return `${configuration.host}:${configuration.port}/${configuration.database} · ${configuration.access === 'read-write' ? '可写' : '只读'}`;
    },
    async createDataSource(integration, timeoutMs) {
      const readOnly = integration.configuration.access !== 'read-write';
      const sslMode = integration.configuration.sslMode;
      const source = new DataSource({
        type: 'postgres',
        host: integration.configuration.host,
        port: Number(integration.configuration.port),
        database: integration.configuration.database,
        username: integration.configuration.username,
        password: integration.configuration.password,
        ssl: sslMode === 'disable' ? false : { rejectUnauthorized: sslMode === 'verify-full' },
        connectTimeoutMS: timeoutMs,
        applicationName: 'WebPilot',
        logging: false,
        synchronize: false,
      });
      await source.initialize();
      const adapter = createTypeOrmAgentDataSource({
        id: integration.id,
        name: integration.name,
        source,
        readOnly,
      });
      return {
        ...adapter,
        async dispose() {
          if (source.isInitialized) await source.destroy();
        },
      };
    },
    async test(integration, timeoutMs) {
      const source = await this.createDataSource!(integration, timeoutMs);
      try {
        const tables = await source.schema({ invocationId: `settings-test-${randomUUID()}` });
        return {
          kind: 'data-source',
          tableCount: tables.length,
          tables: tables.slice(0, 10).map((table) => table.name),
        };
      } finally {
        await source.dispose?.();
      }
    },
  };
}

function jsonResearchDriver(): ExternalIntegrationDriver {
  return {
    id: 'json-search-api',
    category: 'research',
    label: 'JSON 搜索 API',
    description: '连接接受标准搜索请求并返回 URL、标题和摘要列表的 HTTP API。',
    testLabel: '发送测试搜索',
    fields: [
      {
        key: 'endpoint',
        label: '搜索服务地址',
        description: '系统会以 POST 发送 query、limit、domains 和 recencyDays，并读取数组或 results 数组。',
        control: 'url',
        placeholder: 'https://search.example.com/api/search',
        required: true,
        secret: true,
      },
      {
        key: 'authentication',
        label: '认证方式',
        control: 'select',
        defaultValue: 'none',
        options: [
          { label: '无需认证', value: 'none' },
          { label: 'Bearer Token', value: 'bearer' },
          { label: 'API Key 请求头', value: 'api-key' },
        ],
      },
      { key: 'token', label: '访问令牌', control: 'password', placeholder: '输入访问令牌', required: true, secret: true, visibleWhen: { field: 'authentication', value: 'bearer' } },
      { key: 'apiKeyHeader', label: 'API Key 请求头名称', control: 'text', placeholder: 'x-api-key', defaultValue: 'x-api-key', required: true, visibleWhen: { field: 'authentication', value: 'api-key' } },
      { key: 'apiKey', label: 'API Key', control: 'password', placeholder: '输入 API Key', required: true, secret: true, visibleWhen: { field: 'authentication', value: 'api-key' } },
    ],
    normalize(configuration) {
      return {
        endpoint: httpEndpoint(configuration.endpoint, '搜索服务地址'),
        ...researchAuthentication(configuration),
      };
    },
    summarize(configuration) {
      return endpointPreview(configuration.endpoint);
    },
    createResearchSearch(integration, timeoutMs) {
      return async (input, execution) => {
        const timeout = AbortSignal.timeout(timeoutMs);
        const signal = execution.abortSignal ? AbortSignal.any([execution.abortSignal, timeout]) : timeout;
        const response = await fetch(integration.configuration.endpoint, {
          method: 'POST',
          signal,
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            ...researchHeaders(integration.configuration),
          },
          body: JSON.stringify(input),
        });
        const text = await response.text();
        if (!response.ok) throw new Error(`搜索服务返回 HTTP ${response.status}：${text.slice(0, 1_000)}`);
        let payload: unknown;
        try {
          payload = JSON.parse(text);
        } catch {
          throw new Error('搜索服务没有返回有效的 JSON。');
        }
        return normalizedResearchSources(payload, integration.name, input.limit);
      };
    },
    async test(integration, timeoutMs, abortSignal) {
      const results = await this.createResearchSearch!(integration, timeoutMs)(
        { query: 'WebPilot', limit: 3 },
        { invocationId: `settings-test-${randomUUID()}`, abortSignal },
      );
      return {
        kind: 'search-results',
        resultCount: results.length,
        results: results.slice(0, 5).map((result) => result.title || result.url),
      };
    },
  };
}

function canonicalWebhookDriver(): ExternalIntegrationDriver {
  return {
    id: 'canonical-http-webhook',
    category: 'communication',
    label: '标准消息 Webhook',
    description: '向能够接收 WebPilot 标准消息结构的 HTTP 服务发送消息。',
    testLabel: '发送测试消息',
    fields: [
      { key: 'endpoint', label: 'Webhook 地址', control: 'url', placeholder: 'https://example.com/webhook', required: true, secret: true },
      {
        key: 'authentication',
        label: '认证方式',
        control: 'select',
        defaultValue: 'none',
        options: [{ label: '无需认证', value: 'none' }, { label: 'Bearer Token', value: 'bearer' }],
      },
      { key: 'token', label: '访问令牌', control: 'password', placeholder: '输入访问令牌', required: true, secret: true, visibleWhen: { field: 'authentication', value: 'bearer' } },
    ],
    normalize(configuration) {
      return {
        endpoint: httpEndpoint(configuration.endpoint, 'Webhook 地址'),
        ...authenticationConfiguration(configuration),
      };
    },
    summarize(configuration) {
      return endpointPreview(configuration.endpoint);
    },
    createChannel(integration, timeoutMs) {
      return createJsonWebhookChannel({
        id: integration.id,
        name: integration.name,
        url: integration.configuration.endpoint,
        headers: authorizationHeader(integration.configuration),
        timeoutMs,
      });
    },
    async test(integration, timeoutMs) {
      const channel = this.createChannel!(integration, timeoutMs);
      const draft: CommunicationDraft = {
        id: randomUUID(),
        channelId: integration.id,
        targets: [],
        content: { format: 'text', title: 'WebPilot 渠道测试', body: '这是一条由管理员主动发送的 WebPilot 渠道测试消息。' },
        metadata: { type: 'configuration-test' },
        createdAt: new Date().toISOString(),
      };
      const receipt = await channel.send(draft, { invocationId: `settings-test-${randomUUID()}` });
      await channel.dispose?.();
      return { kind: 'delivered', deliveryCount: receipt.deliveryIds.length };
    },
  };
}

function weComAiBotDriver(): ExternalIntegrationDriver {
  return {
    id: 'wecom-aibot-mcp',
    category: 'communication',
    label: '企业微信智能机器人',
    description: '通过企业微信消息 MCP 发送消息；Bot ID 和 Secret 仅用于自动识别接收会话。',
    testLabel: '连接并验证会话',
    testHint: '点击后先等待“连接已就绪”，再到企业微信给机器人发送一条消息；系统会通过消息 MCP 回发测试消息，收到后才会保存该会话。群聊中需要 @机器人。',
    fields: [
      {
        key: 'endpoint',
        label: '企业微信消息 MCP 地址',
        description: '复制机器人“消息”权限页面中的 StreamableHttp URL。地址内含 API Key，将加密保存。',
        control: 'url',
        placeholder: 'https://qyapi.weixin.qq.com/mcp/v2/bot/msg?apikey=...',
        required: true,
        secret: true,
      },
      { key: 'botId', label: 'Bot ID', control: 'text', placeholder: '企业微信后台显示的 Bot ID', required: true },
      {
        key: 'secret',
        label: 'Secret',
        description: '仅在识别会话时建立临时长连接；真正发送消息不使用长连接。',
        control: 'password',
        placeholder: '输入机器人 Secret',
        required: true,
        secret: true,
      },
      {
        key: 'defaultTargetKind',
        label: '已识别会话类型',
        control: 'select',
        hidden: true,
        defaultValue: 'user',
        options: [{ label: '单聊', value: 'user' }, { label: '群聊', value: 'group' }],
      },
      {
        key: 'defaultTarget',
        label: '接收会话识别',
        description: '无需自己查 userid。点击“连接并识别会话”，再给机器人发送一条消息即可自动填入。',
        control: 'text',
        placeholder: '等待自动识别',
        secret: true,
        hidden: true,
      },
      {
        key: 'defaultTargetBinding',
        label: '已验证会话绑定',
        control: 'text',
        secret: true,
        hidden: true,
      },
      {
        key: 'wsUrl',
        label: '长连接地址（可选）',
        description: '标准企业无需填写；私有部署企业可填写管理后台提供的地址。',
        control: 'url',
        placeholder: 'wss://openws.work.weixin.qq.com',
        hidden: true,
      },
    ],
    normalize(configuration) {
      const endpoint = configuration.endpoint?.trim();
      const botId = configuration.botId?.trim();
      const secret = configuration.secret?.trim();
      if (!endpoint) throw new Error('请输入企业微信消息 MCP 地址。');
      if (!botId) throw new Error('请输入 Bot ID。');
      if (!secret) throw new Error('请输入机器人 Secret。');
      if (botId.length > 500 || secret.length > 20_000) throw new Error('企业微信机器人凭据过长。');
      const wsUrl = configuration.wsUrl?.trim();
      const defaultTarget = configuration.defaultTarget?.trim();
      const defaultTargetKind = configuration.defaultTargetKind || 'user';
      if (defaultTargetKind !== 'user' && defaultTargetKind !== 'group') throw new Error('已识别会话类型无效。');
      if (defaultTarget && defaultTarget.length > 500) throw new Error('已识别接收会话过长。');
      const normalizedEndpoint = httpEndpoint(endpoint, '企业微信消息 MCP 地址');
      const expectedTargetBinding = defaultTarget
        ? weComTargetBinding({
          botId,
          endpoint: normalizedEndpoint,
          target: { kind: defaultTargetKind, id: defaultTarget },
        })
        : '';
      const targetIsVerified = Boolean(expectedTargetBinding)
        && configuration.defaultTargetBinding === expectedTargetBinding;
      return {
        endpoint: normalizedEndpoint,
        botId,
        secret,
        defaultTargetKind,
        ...(targetIsVerified ? {
          defaultTarget,
          defaultTargetBinding: expectedTargetBinding,
        } : {}),
        ...(wsUrl ? { wsUrl: websocketEndpoint(wsUrl) } : {}),
      };
    },
    summarize(configuration) {
      const target = verifiedWeComTarget(configuration);
      const status = target
        ? `已验证${target.kind === 'group' ? '群聊' : '单聊'}`
        : '待识别接收会话';
      return `${status} · ${endpointPreview(configuration.endpoint)}`;
    },
    createChannel(integration, timeoutMs) {
      return createWeComAiBotChannel(integration, timeoutMs);
    },
    async test(integration, timeoutMs, abortSignal, onProgress) {
      const testController = new AbortController();
      const testSignal = abortSignal
        ? AbortSignal.any([abortSignal, testController.signal])
        : testController.signal;
      const connector = createMcpStreamableHttpConnector({
        id: integration.id,
        name: integration.name,
        url: integration.configuration.endpoint,
        timeoutMs,
      });
      const validateMcp = async () => {
        try {
          const operations = await connector.listOperations({
            invocationId: `settings-test-${randomUUID()}`,
            abortSignal: testSignal,
          });
          if (!operations.some((operation) => operation.id === weComMessageOperationId)) {
            throw new Error(`这个 MCP 地址没有提供 ${weComMessageOperationId} 发送能力。`);
          }
        } finally {
          await connector.dispose?.();
        }
      };
      try {
        const [, target] = await Promise.all([
          validateMcp(),
          discoverWeComAiBotConversation({
            botId: integration.configuration.botId,
            secret: integration.configuration.secret,
            wsUrl: integration.configuration.wsUrl,
            timeoutMs: 45_000,
            abortSignal: testSignal,
            onStatus(status) {
              onProgress?.({ stage: status });
            },
          }),
        ]);
        onProgress?.({ stage: 'verifying' });
        const verifiedIntegration: ResolvedExternalIntegration = {
          ...integration,
          configuration: {
            ...integration.configuration,
            defaultTargetKind: target.kind,
            defaultTarget: target.id,
          },
        };
        const channel = createWeComAiBotChannel(verifiedIntegration, timeoutMs);
        try {
          await channel.send({
            id: randomUUID(),
            channelId: integration.id,
            targets: [target],
            content: {
              format: 'text',
              body: 'WebPilot 企业微信发送渠道已连接成功。',
            },
            metadata: { type: 'configuration-test' },
            createdAt: new Date().toISOString(),
          }, {
            invocationId: `settings-test-send-${randomUUID()}`,
            abortSignal: testSignal,
          });
        } finally {
          await channel.dispose?.();
        }
        return {
          kind: 'target-discovered',
          target,
          targetBinding: weComTargetBinding({
            botId: integration.configuration.botId,
            endpoint: integration.configuration.endpoint,
            target,
          }),
        };
      } finally {
        testController.abort();
      }
    },
  };
}

const drivers = [
  connectorDriver(),
  canonicalWebhookDriver(),
  weComAiBotDriver(),
  sqliteDataDriver(),
  postgresDataDriver(),
  jsonResearchDriver(),
] as const;
const driversById = new Map(drivers.map((driver) => [driver.id, driver]));

export function listExternalIntegrationDrivers(category?: ExternalIntegrationCategory): ExternalIntegrationDriverDescriptor[] {
  return drivers
    .filter((driver) => !category || driver.category === category)
    .map((driver) => ({
      id: driver.id,
      category: driver.category,
      label: driver.label,
      description: driver.description,
      testLabel: driver.testLabel,
      testHint: driver.testHint,
      fields: driver.fields,
    }));
}

export function externalIntegrationDriver(driverId: string, category?: ExternalIntegrationCategory) {
  const driver = driversById.get(driverId);
  if (!driver || (category && driver.category !== category)) throw new Error('不支持所选外部集成驱动。');
  return driver;
}

export function resolveExternalIntegrationConfiguration(input: {
  driverId: string;
  category: ExternalIntegrationCategory;
  configuration: ExternalIntegrationConfiguration;
  clearFields?: string[];
  existing?: ResolvedExternalIntegration;
}) {
  const driver = externalIntegrationDriver(input.driverId, input.category);
  const allowedFields = new Set(driver.fields.map((field) => field.key));
  for (const key of Object.keys(input.configuration)) {
    if (!allowedFields.has(key)) throw new Error(`配置字段 ${key} 不属于所选驱动。`);
  }
  for (const key of input.clearFields || []) {
    if (!allowedFields.has(key)) throw new Error(`不能清除未知配置字段 ${key}。`);
  }
  const merged: ExternalIntegrationConfiguration = { ...(input.existing?.configuration || {}) };
  for (const key of input.clearFields || []) delete merged[key];
  for (const [key, value] of Object.entries(input.configuration)) {
    const normalized = value.trim();
    if (normalized) merged[key] = normalized;
  }
  for (const field of driver.fields) {
    if (!merged[field.key] && field.defaultValue) merged[field.key] = field.defaultValue;
  }
  return driver.normalize(merged);
}

export function publicExternalIntegrationSummary(integration: ResolvedExternalIntegration): ExternalIntegrationPublicSummary {
  const driver = externalIntegrationDriver(integration.driverId, integration.category);
  return {
    id: integration.id,
    category: integration.category,
    driverId: integration.driverId,
    name: integration.name,
    detailPreview: driver.summarize(integration.configuration),
    configuredFields: driver.fields.filter((field) => Boolean(integration.configuration[field.key])).map((field) => field.key),
    publicConfiguration: Object.fromEntries(driver.fields
      .filter((field) => !field.secret && integration.configuration[field.key])
      .map((field) => [field.key, integration.configuration[field.key]])),
    enabled: integration.enabled,
    updatedAt: integration.updatedAt,
  };
}

export function createExternalIntegrationConnector(integration: ResolvedExternalIntegration, timeoutMs: number) {
  const driver = externalIntegrationDriver(integration.driverId, 'connector');
  if (!driver.createConnector) throw new Error(`驱动 ${driver.id} 不能创建连接器。`);
  return driver.createConnector(integration, timeoutMs);
}

export function createExternalCommunicationChannel(integration: ResolvedExternalIntegration, timeoutMs: number) {
  const driver = externalIntegrationDriver(integration.driverId, 'communication');
  if (!driver.createChannel) throw new Error(`驱动 ${driver.id} 不能创建通信渠道。`);
  return driver.createChannel(integration, timeoutMs);
}

export function createExternalDataSource(integration: ResolvedExternalIntegration, timeoutMs: number) {
  const driver = externalIntegrationDriver(integration.driverId, 'data');
  if (!driver.createDataSource) throw new Error(`驱动 ${driver.id} 不能创建数据源。`);
  return driver.createDataSource(integration, timeoutMs);
}

export function createExternalResearchSearch(integration: ResolvedExternalIntegration, timeoutMs: number) {
  const driver = externalIntegrationDriver(integration.driverId, 'research');
  if (!driver.createResearchSearch) throw new Error(`驱动 ${driver.id} 不能创建研究搜索服务。`);
  return driver.createResearchSearch(integration, timeoutMs);
}

export async function testExternalIntegration(
  integration: ResolvedExternalIntegration,
  timeoutMs: number,
  abortSignal?: AbortSignal,
  onProgress?: (progress: ExternalIntegrationTestProgress) => void,
) {
  return externalIntegrationDriver(integration.driverId, integration.category).test(integration, timeoutMs, abortSignal, onProgress);
}
