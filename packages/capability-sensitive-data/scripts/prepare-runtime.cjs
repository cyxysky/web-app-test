/* eslint-disable @typescript-eslint/no-require-imports */
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const {
  assertSensitiveDataRuntime,
  preparedSensitiveDataRuntimeRoot,
} = require('./runtime-layout.cjs');

const packageRoot = path.resolve(__dirname, '..');
const hostRoot = process.cwd();
const stagingRoot = `${preparedSensitiveDataRuntimeRoot}.staging`;
const serviceRoot = path.join(packageRoot, 'runtime', 'python');
const requirementsPath = path.join(serviceRoot, 'requirements.txt');
const serviceAppPath = path.join(serviceRoot, 'app.py');
const serviceBoundariesPath = path.join(serviceRoot, 'entity_boundaries.py');
const serviceCandidateResolutionPath = path.join(serviceRoot, 'candidate_resolution.py');
const serviceDeterministicSpansPath = path.join(serviceRoot, 'deterministic_spans.py');
const defaultVirtualPython = path.join(hostRoot, '.venv-gliner', 'Scripts', 'python.exe');
const bundleFormatVersion = 3;

const environmentPath = path.join(hostRoot, '.env');
if (fs.existsSync(environmentPath)) process.loadEnvFile(environmentPath);

function safelyRemove(target) {
  const resolved = path.resolve(target);
  if (resolved !== preparedSensitiveDataRuntimeRoot && resolved !== stagingRoot) {
    throw new Error(`Refusing to remove an unexpected GLiNER bundle path: ${resolved}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: hostRoot,
    env: { ...process.env, ...(options.env || {}) },
    encoding: options.capture ? 'utf8' : undefined,
    stdio: options.capture ? 'pipe' : 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = options.capture ? String(result.stderr || result.stdout || '').trim() : '';
    throw new Error(`${command} exited with code ${result.status}.${detail ? ` ${detail}` : ''}`);
  }
  return options.capture ? String(result.stdout || '').trim() : '';
}

function pythonInformation(pythonPath) {
  const output = run(pythonPath, ['-c', [
    'import json, platform, sys',
    'print(json.dumps({',
    '  "basePrefix": sys.base_prefix,',
    '  "executable": sys.executable,',
    '  "machine": platform.machine(),',
    '  "platform": sys.platform,',
    '  "version": platform.python_version(),',
    '}))',
  ].join('\n')], { capture: true });
  const info = JSON.parse(output);
  const [major, minor] = String(info.version || '').split('.').map(Number);
  if (info.platform !== 'win32' || !/^(?:AMD64|x86_64)$/i.test(String(info.machine || ''))) {
    throw new Error(`The bundled GLiNER runtime requires 64-bit Windows Python; found ${info.platform}/${info.machine}.`);
  }
  if (major !== 3 || minor < 10) {
    throw new Error(`The bundled GLiNER runtime requires Python 3.10 or newer; found ${info.version}.`);
  }
  return info;
}

function bundleFingerprint(input) {
  return createHash('sha256')
    .update(String(bundleFormatVersion))
    .update(fs.readFileSync(requirementsPath))
    .update(fs.readFileSync(serviceAppPath))
    .update(fs.readFileSync(serviceBoundariesPath))
    .update(fs.readFileSync(serviceCandidateResolutionPath))
    .update(fs.readFileSync(serviceDeterministicSpansPath))
    .update(input.modelName)
    .update(input.piiModelName)
    .update(input.chineseNerModelName)
    .update(input.pythonVersion)
    .digest('hex');
}

function currentBundleMatches(fingerprint) {
  try {
    assertSensitiveDataRuntime(preparedSensitiveDataRuntimeRoot);
    const manifest = JSON.parse(fs.readFileSync(path.join(preparedSensitiveDataRuntimeRoot, 'runtime-manifest.json'), 'utf8'));
    return manifest.fingerprint === fingerprint;
  } catch {
    return false;
  }
}

function copyPythonRuntime(basePrefix, targetRoot) {
  const sourceRoot = path.resolve(basePrefix);
  const sourceSitePackages = path.join(sourceRoot, 'Lib', 'site-packages');
  fs.cpSync(sourceRoot, targetRoot, {
    recursive: true,
    filter: (source) => {
      const resolved = path.resolve(source);
      if (resolved === sourceSitePackages || resolved.startsWith(`${sourceSitePackages}${path.sep}`)) return false;
      return !source.split(path.sep).includes('__pycache__');
    },
  });
  if (!fs.existsSync(path.join(targetRoot, 'python.exe'))) {
    throw new Error(`The selected Python installation is not portable because python.exe is missing under ${basePrefix}.`);
  }
}

function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error('The self-contained GLiNER bundle can currently only be built on 64-bit Windows. Docker builds create their Linux runtime separately.');
  }
  const sourcePython = path.resolve(String(process.env.GLINER_BUNDLE_PYTHON_PATH || defaultVirtualPython).trim());
  if (!fs.existsSync(sourcePython)) {
    throw new Error(`GLiNER build Python was not found: ${sourcePython}. Run "npm run sensitive-data:install" first or set GLINER_BUNDLE_PYTHON_PATH.`);
  }
  const python = pythonInformation(sourcePython);
  const configuredModelName = String(process.env.GLINER_MODEL || '').trim();
  const modelName = !configuredModelName || configuredModelName === 'urchade/gliner_multi-v2.1'
    ? 'fastino/gliner2.5-multi-v1'
    : configuredModelName;
  const chineseNerModelName = String(
    process.env.GLINER_CHINESE_NER_MODEL || 'uer/roberta-base-finetuned-cluener2020-chinese',
  ).trim();
  const piiModelName = String(
    process.env.GLINER_PII_MODEL || 'LiquidAI/LFM2.5-Encoder-350M-PII-Detector',
  ).trim();
  const fingerprint = bundleFingerprint({ modelName, piiModelName, chineseNerModelName, pythonVersion: python.version });
  if (currentBundleMatches(fingerprint)) {
    console.log(`Reusing bundled sensitive-data runtime: ${preparedSensitiveDataRuntimeRoot}`);
    return;
  }

  fs.mkdirSync(path.dirname(preparedSensitiveDataRuntimeRoot), { recursive: true });
  safelyRemove(stagingRoot);
  fs.mkdirSync(stagingRoot, { recursive: true });
  const bundledPythonRoot = path.join(stagingRoot, 'python');
  const bundledPython = path.join(bundledPythonRoot, 'python.exe');
  const sitePackages = path.join(bundledPythonRoot, 'Lib', 'site-packages');
  const serviceRoot = path.join(stagingRoot, 'service');
  const modelRoot = path.join(stagingRoot, 'models', 'gliner2');
  const chineseNerModelRoot = path.join(stagingRoot, 'models', 'chinese-roberta');
  const piiModelRoot = path.join(stagingRoot, 'models', 'liquid-pii');

  console.log(`Copying Python ${python.version} runtime from ${python.basePrefix}`);
  copyPythonRuntime(python.basePrefix, bundledPythonRoot);
  fs.mkdirSync(sitePackages, { recursive: true });
  run(sourcePython, [
    '-m', 'pip', 'install',
    '--disable-pip-version-check',
    '--no-compile',
    '--target', sitePackages,
    '-r', requirementsPath,
  ]);
  fs.mkdirSync(serviceRoot, { recursive: true });
  fs.cpSync(serviceAppPath, path.join(serviceRoot, 'app.py'));
  fs.cpSync(serviceBoundariesPath, path.join(serviceRoot, 'entity_boundaries.py'));
  fs.cpSync(serviceCandidateResolutionPath, path.join(serviceRoot, 'candidate_resolution.py'));
  fs.cpSync(serviceDeterministicSpansPath, path.join(serviceRoot, 'deterministic_spans.py'));
  fs.cpSync(requirementsPath, path.join(serviceRoot, 'requirements.txt'));

  console.log(`Downloading GLiNER model ${modelName} into the application runtime.`);
  run(sourcePython, ['-c', [
    'import sys',
    'sys.path.insert(0, sys.argv[1])',
    'from huggingface_hub import snapshot_download',
    'snapshot_download(repo_id=sys.argv[2], local_dir=sys.argv[3])',
  ].join('\n'), sitePackages, modelName, modelRoot], {
    env: { HF_HUB_DISABLE_SYMLINKS_WARNING: '1' },
  });

  console.log(`Downloading Chinese RoBERTa boundary model ${chineseNerModelName} into the application runtime.`);
  run(sourcePython, ['-c', [
    'import sys',
    'sys.path.insert(0, sys.argv[1])',
    'from huggingface_hub import snapshot_download',
    'snapshot_download(repo_id=sys.argv[2], local_dir=sys.argv[3])',
  ].join('\n'), sitePackages, chineseNerModelName, chineseNerModelRoot], {
    env: { HF_HUB_DISABLE_SYMLINKS_WARNING: '1' },
  });

  console.log(`Downloading LiquidAI PII model ${piiModelName} into the application runtime.`);
  run(sourcePython, ['-c', [
    'import sys',
    'sys.path.insert(0, sys.argv[1])',
    'from huggingface_hub import snapshot_download',
    'snapshot_download(repo_id=sys.argv[2], local_dir=sys.argv[3])',
  ].join('\n'), sitePackages, piiModelName, piiModelRoot], {
    env: { HF_HUB_DISABLE_SYMLINKS_WARNING: '1' },
  });

  console.log('Validating the self-contained Python, GLiNER2.5, LiquidAI PII, and Chinese RoBERTa models.');
  run(bundledPython, ['-c', [
    'import sys',
    'from gliner2 import AutoExtractor',
    'from tokenizers import Tokenizer',
    'from transformers import AutoModelForTokenClassification, AutoTokenizer, PreTrainedTokenizerFast',
    'model = AutoExtractor.from_pretrained(sys.argv[1], map_location="cpu")',
    'AutoTokenizer.from_pretrained(sys.argv[2], local_files_only=True)',
    'AutoModelForTokenClassification.from_pretrained(sys.argv[2], local_files_only=True)',
    'PreTrainedTokenizerFast(tokenizer_object=Tokenizer.from_file(sys.argv[3] + "/tokenizer.json"), bos_token="<|startoftext|>", eos_token="<|im_end|>", pad_token="<|pad|>", mask_token="<|mask|>", model_input_names=["input_ids", "attention_mask"])',
    'AutoModelForTokenClassification.from_pretrained(sys.argv[3], local_files_only=True, trust_remote_code=True)',
    'print(type(model).__name__)',
  ].join('\n'), modelRoot, chineseNerModelRoot, piiModelRoot], {
    env: {
      HF_HUB_OFFLINE: '1',
      TRANSFORMERS_OFFLINE: '1',
    },
  });

  fs.writeFileSync(path.join(stagingRoot, 'runtime-manifest.json'), JSON.stringify({
    bundleFormatVersion,
    createdAt: new Date().toISOString(),
    fingerprint,
    chineseNerModelName,
    modelName,
    piiModelName,
    platform: 'win32-x64',
    pythonVersion: python.version,
  }, null, 2), 'utf8');
  safelyRemove(preparedSensitiveDataRuntimeRoot);
  fs.renameSync(stagingRoot, preparedSensitiveDataRuntimeRoot);
  assertSensitiveDataRuntime(preparedSensitiveDataRuntimeRoot);
  console.log(`Self-contained sensitive-data runtime created: ${preparedSensitiveDataRuntimeRoot}`);
}

try {
  main();
} catch (error) {
  safelyRemove(stagingRoot);
  throw error;
}
