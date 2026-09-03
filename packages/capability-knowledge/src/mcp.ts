import { createCapabilityMcpHandler, createCapabilityMcpServer, serveCapabilityMcpStdio, type CapabilityMcpServerOptions } from '@webpilot/capability-adapter-mcp';
import type { CapabilityProvider } from '@webpilot/capability-sdk';
export type KnowledgeMcpOptions = Omit<CapabilityMcpServerOptions, 'name' | 'version' | 'providers'> & { provider: CapabilityProvider };
const options = (input: KnowledgeMcpOptions): CapabilityMcpServerOptions => ({ ...input, name: 'webpilot-knowledge', version: '0.1.0', providers: [input.provider] });
export const createKnowledgeMcpServer = (input: KnowledgeMcpOptions) => createCapabilityMcpServer(options(input));
export const createKnowledgeMcpHandler = (input: KnowledgeMcpOptions) => createCapabilityMcpHandler(options(input));
export const serveKnowledgeMcpStdio = (input: KnowledgeMcpOptions) => serveCapabilityMcpStdio(options(input));
