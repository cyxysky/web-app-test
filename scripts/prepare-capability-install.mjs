import { readFile, writeFile } from 'node:fs/promises';

const source = String(process.argv[2] || 'workspace').trim().toLowerCase();
if (source !== 'workspace' && source !== 'npm') {
  throw new Error('Capability source must be "workspace" or "npm".');
}

if (source === 'npm') {
  const packagePath = new URL('../package.json', import.meta.url);
  const packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
  const capabilityDependencies = Object.entries(packageJson.dependencies || {})
    .filter(([name]) => name.startsWith('@webpilot/capability-'));
  const invalid = capabilityDependencies
    .filter(([, version]) => typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version))
    .map(([name]) => name);
  if (invalid.length) {
    throw new Error(`npm capability dependencies must use exact versions: ${invalid.join(', ')}`);
  }
  delete packageJson.workspaces;
  await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');

  const lockPath = new URL('../package-lock.json', import.meta.url);
  const packageLock = JSON.parse(await readFile(lockPath, 'utf8'));
  if (packageLock.packages?.['']) delete packageLock.packages[''].workspaces;
  for (const [name] of capabilityDependencies) {
    const moduleKey = `node_modules/${name}`;
    if (packageLock.packages?.[moduleKey]?.link) delete packageLock.packages[moduleKey];
    for (const [key, value] of Object.entries(packageLock.packages || {})) {
      if (key.startsWith('packages/') && value?.name === name) delete packageLock.packages[key];
    }
  }
  await writeFile(lockPath, `${JSON.stringify(packageLock, null, 2)}\n`, 'utf8');
}
