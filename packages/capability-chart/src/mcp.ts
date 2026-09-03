import {
  createCapabilityMcpHandler,
  createCapabilityMcpServer,
  serveCapabilityMcpStdio,
  type CapabilityMcpServerOptions,
} from '@webpilot/capability-adapter-mcp';
import type { CapabilityRunContext } from '@webpilot/capability-sdk';
import { createNodeChartCapability } from './node.js';

export type ChartMcpOptions = {
  directory: string | ((context: CapabilityRunContext) => string);
  echartsVersion?: string;
  context?: CapabilityMcpServerOptions['context'];
  configurations?: CapabilityMcpServerOptions['configurations'];
  configStore?: CapabilityMcpServerOptions['configStore'];
  configScope?: CapabilityMcpServerOptions['configScope'];
  skillMode?: CapabilityMcpServerOptions['skillMode'];
  skillToolName?: CapabilityMcpServerOptions['skillToolName'];
};

function serverOptions(options: ChartMcpOptions): CapabilityMcpServerOptions {
  return {
    name: 'webpilot-chart',
    version: '0.1.0',
    context: options.context,
    configurations: options.configurations,
    configStore: options.configStore,
    configScope: options.configScope,
    skillMode: options.skillMode,
    skillToolName: options.skillToolName,
    providers: [createNodeChartCapability(options)],
  };
}

export function createChartMcpServer(options: ChartMcpOptions) {
  return createCapabilityMcpServer(serverOptions(options));
}

export function createChartMcpHandler(options: ChartMcpOptions) {
  return createCapabilityMcpHandler(serverOptions(options));
}

export function serveChartMcpStdio(options: ChartMcpOptions) {
  return serveCapabilityMcpStdio(serverOptions(options));
}
