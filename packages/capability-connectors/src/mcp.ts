import { createCapabilityMcpHandler, createCapabilityMcpServer, serveCapabilityMcpStdio, type CapabilityMcpServerOptions } from '@webpilot/capability-adapter-mcp';
import type { CapabilityProvider } from '@webpilot/capability-sdk';
export type ConnectorsMcpOptions = Omit<CapabilityMcpServerOptions, 'name' | 'version' | 'providers'> & { provider: CapabilityProvider };
const options = (input: ConnectorsMcpOptions): CapabilityMcpServerOptions => ({ ...input, name: 'webpilot-connectors', version: '0.1.0', providers: [input.provider] });
export const createConnectorsMcpServer = (input: ConnectorsMcpOptions) => createCapabilityMcpServer(options(input));
export const createConnectorsMcpHandler = (input: ConnectorsMcpOptions) => createCapabilityMcpHandler(options(input));
export const serveConnectorsMcpStdio = (input: ConnectorsMcpOptions) => serveCapabilityMcpStdio(options(input));
