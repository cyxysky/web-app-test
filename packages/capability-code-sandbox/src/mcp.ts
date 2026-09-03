import { createCapabilityMcpHandler, createCapabilityMcpServer, serveCapabilityMcpStdio, type CapabilityMcpServerOptions } from '@webpilot/capability-adapter-mcp';
import type { CapabilityProvider } from '@webpilot/capability-sdk';

export type CodeSandboxMcpOptions = Omit<CapabilityMcpServerOptions, 'name' | 'version' | 'providers'> & { provider: CapabilityProvider };
const options = (input: CodeSandboxMcpOptions): CapabilityMcpServerOptions => ({ ...input, name: 'webpilot-code-sandbox', version: '0.1.0', providers: [input.provider] });
export const createCodeSandboxMcpServer = (input: CodeSandboxMcpOptions) => createCapabilityMcpServer(options(input));
export const createCodeSandboxMcpHandler = (input: CodeSandboxMcpOptions) => createCapabilityMcpHandler(options(input));
export const serveCodeSandboxMcpStdio = (input: CodeSandboxMcpOptions) => serveCapabilityMcpStdio(options(input));
