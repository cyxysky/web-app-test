import {
  createCapabilityMcpHandler,
  createCapabilityMcpServer,
  serveCapabilityMcpStdio,
  type CapabilityMcpServerOptions,
} from '@webpilot/capability-adapter-mcp';
import type { CapabilityProvider } from '@webpilot/capability-sdk';
import { createNodeFileCapability, type NodeFileCapabilityOptions } from './node/capability.js';
import { disposeUnoRuntime } from './node/office/uno.js';

export type FileMcpOptions = NodeFileCapabilityOptions & {
  context?: CapabilityMcpServerOptions['context'];
  configurations?: CapabilityMcpServerOptions['configurations'];
  configStore?: CapabilityMcpServerOptions['configStore'];
  configScope?: CapabilityMcpServerOptions['configScope'];
  skillMode?: CapabilityMcpServerOptions['skillMode'];
  skillToolName?: CapabilityMcpServerOptions['skillToolName'];
};

function createFileMcpCapability(options: FileMcpOptions): CapabilityProvider {
  const provider = createNodeFileCapability(options);
  let activeRuntimes = 0;
  return {
    manifest: provider.manifest,
    async createRuntime(context) {
      const runtime = await provider.createRuntime(context);
      activeRuntimes += 1;
      let disposed = false;
      return {
        ...runtime,
        async dispose() {
          if (disposed) return;
          disposed = true;
          try {
            await runtime.dispose();
          } finally {
            activeRuntimes -= 1;
            if (activeRuntimes === 0) await disposeUnoRuntime();
          }
        },
      };
    },
  };
}

function serverOptions(options: FileMcpOptions): CapabilityMcpServerOptions {
  return {
    name: 'webpilot-file',
    version: '0.1.0',
    context: options.context,
    configurations: options.configurations,
    configStore: options.configStore,
    configScope: options.configScope,
    skillMode: options.skillMode,
    skillToolName: options.skillToolName,
    providers: [createFileMcpCapability(options)],
  };
}

export function createFileMcpServer(options: FileMcpOptions) {
  return createCapabilityMcpServer(serverOptions(options));
}

export function createFileMcpHandler(options: FileMcpOptions) {
  return createCapabilityMcpHandler(serverOptions(options));
}

export function serveFileMcpStdio(options: FileMcpOptions) {
  return serveCapabilityMcpStdio(serverOptions(options));
}
