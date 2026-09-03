#!/usr/bin/env node
import { serveBrowserMcpStdio } from '../mcp.js';
import { installBrowserSessionShutdownHooks } from '../node/browser-session-lifecycle.js';

installBrowserSessionShutdownHooks();

serveBrowserMcpStdio({
  sessionOptions: {
    headless: process.env.BROWSER_HEADLESS !== 'false',
    isolated: process.env.BROWSER_MCP_ISOLATED !== 'false',
  },
});
