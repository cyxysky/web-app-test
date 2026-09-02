#!/usr/bin/env node
import { serveBrowserMcpStdio } from '../mcp.js';

serveBrowserMcpStdio({
  sessionOptions: {
    headless: process.env.BROWSER_HEADLESS !== 'false',
    isolated: process.env.BROWSER_MCP_ISOLATED !== 'false',
  },
});
