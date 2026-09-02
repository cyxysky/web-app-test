#!/usr/bin/env node
import path from 'node:path';
import { serveChartMcpStdio } from '../mcp.js';

const artifactsRoot = path.resolve(
  process.env.CAPABILITY_CHART_ARTIFACTS_DIR
    || process.env.ARTIFACTS_DIR
    || path.join(process.cwd(), 'artifacts'),
);

serveChartMcpStdio({
  directory: (context) => path.join(artifactsRoot, context.runId, 'charts'),
});
