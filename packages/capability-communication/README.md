# @webpilot/capability-communication

Draft-first outbound messaging for agents. The core uses provider-neutral targets,
content, channel capabilities, and delivery receipts. Each channel driver owns its
protocol, authentication, message mapping, response validation, and lifecycle;
credentials remain host-managed.

The Node adapter includes:

- a canonical HTTP webhook channel for services that accept Orbit's standard
  `{ targets, content, metadata }` envelope;
- a provider-neutral connector-operation channel for turning an MCP or other
  connector operation into an outbound channel;
- Enterprise WeChat conversation discovery backed by the official
  `@wecom/aibot-node-sdk` WebSocket client. Enterprise WeChat delivery itself
  uses the configured message MCP operation.

Email, DingTalk, Feishu, Slack, and other providers can implement the same
`CommunicationChannel` interface without changing the core communication tool.

## TypeScript Agent framework integration

```ts
import {
  createConnectorCommunicationChannel,
  createJsonWebhookChannel,
  createNodeCommunicationCapability,
} from '@webpilot/capability-communication/node';
import { createMcpStreamableHttpConnector } from '@webpilot/capability-connectors/node';

const wecomConnector = createMcpStreamableHttpConnector({
  id: 'wecom-message-mcp',
  url: process.env.WECOM_MESSAGE_MCP_URL!,
});

const provider = createNodeCommunicationCapability({
  channels: [
    createJsonWebhookChannel({
      id: 'notifications',
      url: process.env.NOTIFICATION_WEBHOOK_URL!,
    }),
    createConnectorCommunicationChannel({
      id: 'wecom',
      driverId: 'wecom-aibot-mcp',
      connector: wecomConnector,
      operationId: 'message_aibot_send',
      capabilities: { targetKinds: ['user', 'group'], contentFormats: ['text', 'markdown'] },
      defaultTargets: [{ kind: 'user', id: process.env.WECOM_DEFAULT_CHAT_ID! }],
      mapArguments: (draft, target) => ({
        chat_id: target.id,
        msg_type: 'markdown',
        markdown: { content: draft.content.body },
      }),
    }),
  ],
  draftDirectory: './agent-data/communication',
});
```

Register this provider with `mountCapabilities()` and expose the resolved
`communication` tool through the consuming TypeScript Agent framework. The host
must keep credentials outside model input and approve `send` separately from
draft creation. See the complete
[TypeScript Agent framework integration guide](../capability-sdk/FRAMEWORK_INTEGRATION.md).

The Node draft store imports version 2 `drafts.json` once into `drafts.db` and uses SQLite transactions to claim delivery across local processes. A sent draft returns its original receipt when called again. Failed or interrupted sends remain `unknown` (or `sending` after a crash); verify the remote receipt before creating a replacement. The draft id is passed as an idempotency key to channel context metadata and JSON webhooks. Custom stores must implement atomic `claimDelivery` and `finishDelivery` to send. Call `dispose()` when directly managing a store.
