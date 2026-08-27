/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const test = require('node:test');
const {
  assertSupportedNodeVersion,
  createNsisScript,
  createServiceXml,
  windowsVersion,
} = require('./package-server-installer');

test('service configuration uses the packaged Node runtime and public port 3000', () => {
  const xml = createServiceXml();
  assert.match(xml, /<executable>%BASE%\\node\.exe<\/executable>/);
  assert.match(xml, /<workingdirectory>%BASE%\\server<\/workingdirectory>/);
  assert.match(xml, /<env name="HOSTNAME" value="0\.0\.0\.0" \/>/);
  assert.match(xml, /<env name="PORT" value="3000" \/>/);
  assert.match(xml, /<env name="APP_DATA_DIR" value="%ProgramData%\\WebPilot\\runtime" \/>/);
  assert.match(xml, /<env name="AI_SENSITIVE_DATA_FILTER_ENABLED" value="true" \/>/);
  assert.match(xml, /<env name="AI_SENSITIVE_DATA_FILTER_FAILURE_MODE" value="closed" \/>/);
  assert.match(xml, /<env name="GLINER_DEVICE" value="cpu" \/>/);
  assert.match(xml, /<env name="GLINER_RUNTIME_MODE" value="local" \/>/);
  assert.match(xml, /<env name="GLINER_PYTHON_PATH" value="%BASE%\\server\\gliner-runtime\\python\\python\.exe" \/>/);
  assert.match(xml, /<env name="GLINER_MODEL_BUNDLE_DIR" value="%BASE%\\server\\gliner-runtime\\models\\gliner2" \/>/);
  assert.match(xml, /<env name="GLINER_CHINESE_NER_MODEL_BUNDLE_DIR" value="%BASE%\\server\\gliner-runtime\\models\\chinese-roberta" \/>/);
  assert.match(xml, /<env name="GLINER_PII_MODEL_BUNDLE_DIR" value="%BASE%\\server\\gliner-runtime\\models\\liquid-pii" \/>/);
  assert.match(xml, /<onfailure action="restart" delay="10 sec" \/>/);
});

test('installer registers the service and a private/domain firewall rule', () => {
  const script = createNsisScript({
    iconPath: 'C:\\source\\app.ico',
    licensePath: 'C:\\source\\WinSW-LICENSE.txt',
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    outputPath: 'C:\\output\\WebPilot-Server-Setup.exe',
    packageRoot: 'C:\\source\\WebPilot-Server',
    serviceConfigPath: 'C:\\temp\\WebPilotService.xml',
    version: '0.1.0',
    winSwPath: 'C:\\cache\\WinSW.exe',
  });
  assert.match(script, /RequestExecutionLevel admin/);
  assert.match(script, /WebPilotService\.exe" install/);
  assert.match(script, /WebPilotService\.exe" start/);
  assert.match(script, /localport=3000 profile=domain,private/);
  assert.match(script, /Runtime data remains in \$APPDATA\\WebPilot/);
});

test('Node and Windows versions are validated', () => {
  assert.doesNotThrow(() => assertSupportedNodeVersion('22.16.0'));
  assert.doesNotThrow(() => assertSupportedNodeVersion('24.1.0'));
  assert.throws(() => assertSupportedNodeVersion('22.15.9'), /22\.16 or later/);
  assert.equal(windowsVersion('1.2.3'), '1.2.3.0');
});
