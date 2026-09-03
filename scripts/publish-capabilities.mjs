import { spawnSync } from 'node:child_process';

const packages = [
  '@webpilot/capability-sdk',
  '@webpilot/capability-host',
  '@webpilot/capability-adapter-ai-sdk',
  '@webpilot/capability-adapter-mcp',
  '@webpilot/capability-browser',
  '@webpilot/capability-chart',
  '@webpilot/capability-file',
  '@webpilot/capability-code-sandbox',
  '@webpilot/capability-research',
  '@webpilot/capability-connectors',
  '@webpilot/capability-knowledge',
  '@webpilot/capability-data',
  '@webpilot/capability-media',
  '@webpilot/capability-communication',
  '@webpilot/capability-git',
  '@webpilot/capability-computer',
  '@webpilot/capability-workflow',
  '@webpilot/capability-sensitive-data',
];
const dryRun = process.argv.includes('--dry-run');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

for (const packageName of packages) {
  const args = [
    'publish',
    '--workspace', packageName,
    '--access', 'public',
    ...(dryRun ? ['--dry-run'] : []),
  ];
  const result = spawnSync(npm, args, { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
