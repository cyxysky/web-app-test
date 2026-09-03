import { createCapabilityMcpHandler, createCapabilityMcpServer, serveCapabilityMcpStdio, type CapabilityMcpServerOptions } from '@webpilot/capability-adapter-mcp';
import type { CapabilityProvider } from '@webpilot/capability-sdk';
export type ResearchMcpOptions = Omit<CapabilityMcpServerOptions, 'name' | 'version' | 'providers'> & { provider: CapabilityProvider };
const options = (input: ResearchMcpOptions): CapabilityMcpServerOptions => ({ ...input, name: 'webpilot-research', version: '0.1.0', providers: [input.provider] });
export const createResearchMcpServer = (input: ResearchMcpOptions) => createCapabilityMcpServer(options(input));
export const createResearchMcpHandler = (input: ResearchMcpOptions) => createCapabilityMcpHandler(options(input));
export const serveResearchMcpStdio = (input: ResearchMcpOptions) => serveCapabilityMcpStdio(options(input));
