#!/usr/bin/env node
import path from 'node:path';
import { serveFileMcpStdio } from '../mcp.js';

const artifactsRoot = path.resolve(
  process.env.CAPABILITY_FILE_ARTIFACTS_DIR
    || process.env.ARTIFACTS_DIR
    || path.join(process.cwd(), 'artifacts'),
);

serveFileMcpStdio({
  workspace: { artifactsRoot },
  visualInputAvailable: false,
});
