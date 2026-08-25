/* eslint-disable @typescript-eslint/no-require-imports */
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const distributionRoot = path.join(root, 'dist-server', 'WebPilot-Server');
const installerWorkRoot = path.join(root, 'dist-server', '.server-installer');
const installerOutputRoot = path.join(root, 'dist-server');
const winSwVersion = '2.12.0';
const winSwUrl = `https://github.com/winsw/winsw/releases/download/v${winSwVersion}/WinSW-x64.exe`;
const winSwSha256 = '05B82D46AD331CC16BDC00DE5C6332C1EF818DF8CEEFCD49C726553209B3A0DA';

function xmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function nsisEscape(value) {
  return String(value).replaceAll('$', '$$').replaceAll('"', '$\\"');
}

function windowsVersion(version) {
  const parts = String(version).split('.').map((part) => Number.parseInt(part, 10));
  if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 65_535)) {
    throw new Error(`The package version cannot be represented as a Windows version: ${version}`);
  }
  return [...parts.slice(0, 4), 0, 0, 0, 0].slice(0, 4).join('.');
}

function assertSupportedNodeVersion(version = process.versions.node) {
  const [major, minor] = String(version).split('.').map((part) => Number.parseInt(part, 10));
  if (!Number.isInteger(major) || !Number.isInteger(minor) || major < 22 || (major === 22 && minor < 16)) {
    throw new Error(`The bundled Node.js runtime must be 22.16 or later; found ${version}.`);
  }
}

function createServiceXml() {
  const environment = {
    APP_DATA_DIR: '%ProgramData%\\WebPilot\\runtime',
    ARTIFACTS_DIR: '%ProgramData%\\WebPilot\\runtime\\artifacts',
    HEADLESS_BROWSER: 'true',
    HOSTNAME: '0.0.0.0',
    LIBREOFFICE_PATH: '%BASE%\\libreoffice\\program\\soffice.exe',
    LIBREOFFICE_PYTHON_PATH: '%BASE%\\libreoffice\\program\\python.exe',
    NODE_ENV: 'production',
    PLAYWRIGHT_BROWSERS_PATH: '%BASE%\\ms-playwright',
    PORT: '3000',
    WEBPILOT_SERVER_ROOT: '%BASE%',
  };
  const environmentXml = Object.entries(environment)
    .map(([name, value]) => `  <env name="${xmlEscape(name)}" value="${xmlEscape(value)}" />`)
    .join('\r\n');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<service>',
    '  <id>WebPilotServer</id>',
    '  <name>WebPilot Server</name>',
    '  <description>WebPilot HTTP and WebSocket backend service.</description>',
    '  <executable>%BASE%\\node.exe</executable>',
    '  <arguments>webpilot-server.js</arguments>',
    '  <workingdirectory>%BASE%\\server</workingdirectory>',
    environmentXml,
    '  <startmode>Automatic</startmode>',
    '  <delayedAutoStart>true</delayedAutoStart>',
    '  <hidewindow>true</hidewindow>',
    '  <stoptimeout>30 sec</stoptimeout>',
    '  <onfailure action="restart" delay="10 sec" />',
    '  <resetfailure>1 hour</resetfailure>',
    '  <logpath>%ProgramData%\\WebPilot\\logs</logpath>',
    '  <log mode="roll" />',
    '</service>',
    '',
  ].join('\r\n');
}

function createNsisScript({ iconPath, licensePath, nodePath, outputPath, packageRoot, serviceConfigPath, version, winSwPath }) {
  const escaped = Object.fromEntries(Object.entries({
    iconPath,
    licensePath,
    nodePath,
    outputPath,
    packageRoot,
    serviceConfigPath,
    winSwPath,
  }).map(([key, value]) => [key, nsisEscape(value)]));

  return [
    'Unicode true',
    'RequestExecutionLevel admin',
    'SetCompressor /SOLID lzma',
    `Name "WebPilot Server ${nsisEscape(version)}"`,
    'BrandingText "WebPilot Server"',
    `OutFile "${escaped.outputPath}"`,
    'InstallDir "$PROGRAMFILES64\\WebPilot Server"',
    'InstallDirRegKey HKLM "Software\\WebPilot\\Server" "InstallLocation"',
    `Icon "${escaped.iconPath}"`,
    `UninstallIcon "${escaped.iconPath}"`,
    `VIProductVersion "${windowsVersion(version)}"`,
    'VIAddVersionKey "ProductName" "WebPilot Server"',
    `VIAddVersionKey "ProductVersion" "${nsisEscape(version)}"`,
    `VIAddVersionKey "FileVersion" "${nsisEscape(version)}"`,
    'VIAddVersionKey "CompanyName" "WebPilot"',
    'VIAddVersionKey "FileDescription" "WebPilot Server Installer"',
    'VIAddVersionKey "LegalCopyright" "Copyright WebPilot"',
    '',
    '!include "MUI2.nsh"',
    '!include "x64.nsh"',
    '!define MUI_ABORTWARNING',
    '!define MUI_ICON "' + escaped.iconPath + '"',
    '!define MUI_UNICON "' + escaped.iconPath + '"',
    '!insertmacro MUI_PAGE_WELCOME',
    '!insertmacro MUI_PAGE_DIRECTORY',
    '!insertmacro MUI_PAGE_INSTFILES',
    '!define MUI_FINISHPAGE_RUN "$WINDIR\\explorer.exe"',
    '!define MUI_FINISHPAGE_RUN_PARAMETERS "http://127.0.0.1:3000"',
    '!define MUI_FINISHPAGE_RUN_TEXT "Open WebPilot Server"',
    '!insertmacro MUI_PAGE_FINISH',
    '!insertmacro MUI_UNPAGE_CONFIRM',
    '!insertmacro MUI_UNPAGE_INSTFILES',
    '!insertmacro MUI_LANGUAGE "English"',
    '',
    'Function .onInit',
    '  ${IfNot} ${RunningX64}',
    '    MessageBox MB_ICONSTOP "WebPilot Server requires 64-bit Windows."',
    '    Abort',
    '  ${EndIf}',
    '  SetRegView 64',
    '  SetShellVarContext all',
    'FunctionEnd',
    '',
    'Section "WebPilot Server" SEC_SERVER',
    '  SetOutPath "$INSTDIR"',
    '  IfFileExists "$INSTDIR\\WebPilotService.exe" 0 service_stopped',
    '    ExecWait \'"$INSTDIR\\WebPilotService.exe" stop\' $0',
    '    ExecWait \'"$INSTDIR\\WebPilotService.exe" uninstall\' $0',
    '  service_stopped:',
    '  RMDir /r "$INSTDIR"',
    '  CreateDirectory "$INSTDIR"',
    '  CreateDirectory "$APPDATA\\WebPilot\\runtime\\artifacts"',
    '  CreateDirectory "$APPDATA\\WebPilot\\logs"',
    '  SetOutPath "$INSTDIR"',
    `  File /r "${escaped.packageRoot}\\*.*"`,
    `  File /oname=node.exe "${escaped.nodePath}"`,
    `  File /oname=WebPilotService.exe "${escaped.winSwPath}"`,
    `  File /oname=WebPilotService.xml "${escaped.serviceConfigPath}"`,
    `  File /oname=WinSW-LICENSE.txt "${escaped.licensePath}"`,
    '  WriteUninstaller "$INSTDIR\\Uninstall.exe"',
    '  WriteRegStr HKLM "Software\\WebPilot\\Server" "InstallLocation" "$INSTDIR"',
    '  WriteRegStr HKLM "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\WebPilotServer" "DisplayName" "WebPilot Server"',
    '  WriteRegStr HKLM "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\WebPilotServer" "DisplayVersion" "' + nsisEscape(version) + '"',
    '  WriteRegStr HKLM "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\WebPilotServer" "Publisher" "WebPilot"',
    '  WriteRegStr HKLM "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\WebPilotServer" "InstallLocation" "$INSTDIR"',
    '  WriteRegStr HKLM "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\WebPilotServer" "UninstallString" \'"$INSTDIR\\Uninstall.exe"\'',
    '  WriteRegDWORD HKLM "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\WebPilotServer" "NoModify" 1',
    '  WriteRegDWORD HKLM "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\WebPilotServer" "NoRepair" 1',
    '  CreateDirectory "$SMPROGRAMS\\WebPilot Server"',
    '  CreateShortCut "$SMPROGRAMS\\WebPilot Server\\Open WebPilot Server.lnk" "$WINDIR\\explorer.exe" "http://127.0.0.1:3000"',
    '  CreateShortCut "$SMPROGRAMS\\WebPilot Server\\Windows Services.lnk" "$SYSDIR\\mmc.exe" "services.msc"',
    '  CreateShortCut "$SMPROGRAMS\\WebPilot Server\\Uninstall.lnk" "$INSTDIR\\Uninstall.exe"',
    '  ExecWait \'"$SYSDIR\\netsh.exe" advfirewall firewall delete rule name="WebPilot Server (TCP 3000)"\' $0',
    '  ExecWait \'"$SYSDIR\\netsh.exe" advfirewall firewall add rule name="WebPilot Server (TCP 3000)" dir=in action=allow protocol=TCP localport=3000 profile=domain,private\' $0',
    '  ExecWait \'"$INSTDIR\\WebPilotService.exe" install\' $0',
    '  IntCmp $0 0 service_installed service_install_failed service_install_failed',
    '  service_install_failed:',
    '    MessageBox MB_ICONSTOP "The WebPilot Server Windows service could not be installed (exit code $0)."',
    '    Abort',
    '  service_installed:',
    '  ExecWait \'"$INSTDIR\\WebPilotService.exe" start\' $0',
    '  IntCmp $0 0 service_started service_start_failed service_start_failed',
    '  service_start_failed:',
    '    MessageBox MB_ICONEXCLAMATION "WebPilot Server was installed, but the service could not be started (exit code $0). Check $APPDATA\\WebPilot\\logs."',
    '  service_started:',
    'SectionEnd',
    '',
    'Section "Uninstall"',
    '  SetRegView 64',
    '  SetShellVarContext all',
    '  IfFileExists "$INSTDIR\\WebPilotService.exe" 0 service_removed',
    '    ExecWait \'"$INSTDIR\\WebPilotService.exe" stop\' $0',
    '    ExecWait \'"$INSTDIR\\WebPilotService.exe" uninstall\' $0',
    '  service_removed:',
    '  ExecWait \'"$SYSDIR\\netsh.exe" advfirewall firewall delete rule name="WebPilot Server (TCP 3000)"\' $0',
    '  DeleteRegKey HKLM "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\WebPilotServer"',
    '  DeleteRegKey HKLM "Software\\WebPilot\\Server"',
    '  RMDir /r "$SMPROGRAMS\\WebPilot Server"',
    '  RMDir /r "$INSTDIR"',
    '  MessageBox MB_ICONINFORMATION "WebPilot Server was removed. Runtime data remains in $APPDATA\\WebPilot."',
    'SectionEnd',
    '',
  ].join('\r\n');
}

function requiredServerPackageEntries(packageRoot = distributionRoot) {
  return [
    path.join(packageRoot, 'server', '.next', 'BUILD_ID'),
    path.join(packageRoot, 'server', 'node_modules', 'next', 'package.json'),
    path.join(packageRoot, 'server', 'webpilot-server.js'),
    path.join(packageRoot, 'ms-playwright'),
    path.join(packageRoot, 'libreoffice', 'program', 'soffice.exe'),
  ];
}

function assertServerPackage(packageRoot = distributionRoot) {
  const missing = requiredServerPackageEntries(packageRoot).filter((entry) => !fs.existsSync(entry));
  if (missing.length) {
    throw new Error(`The packaged server is incomplete. Run "npm run server:package" first. Missing:\n${missing.join('\n')}`);
  }
}

function sha256(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex').toUpperCase();
}

async function resolveWinSwExecutable() {
  const configuredPath = String(process.env.WINSW_EXECUTABLE_PATH || '').trim();
  const cacheRoot = path.join(root, 'node_modules', '.cache', 'webpilot-server-installer');
  const executablePath = configuredPath ? path.resolve(configuredPath) : path.join(cacheRoot, `WinSW-x64-${winSwVersion}.exe`);
  if (fs.existsSync(executablePath) && sha256(executablePath) === winSwSha256) return executablePath;
  if (configuredPath) {
    throw new Error(`WINSW_EXECUTABLE_PATH does not match the pinned WinSW ${winSwVersion} SHA-256: ${executablePath}`);
  }

  fs.mkdirSync(cacheRoot, { recursive: true });
  const temporaryPath = `${executablePath}.download`;
  console.log(`Downloading WinSW ${winSwVersion} from ${winSwUrl}`);
  const response = await fetch(winSwUrl, { redirect: 'follow' });
  if (!response.ok) throw new Error(`Unable to download WinSW: HTTP ${response.status}`);
  fs.writeFileSync(temporaryPath, Buffer.from(await response.arrayBuffer()));
  if (sha256(temporaryPath) !== winSwSha256) {
    fs.rmSync(temporaryPath, { force: true });
    throw new Error(`The downloaded WinSW ${winSwVersion} executable failed SHA-256 verification.`);
  }
  fs.renameSync(temporaryPath, executablePath);
  return executablePath;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code ?? `signal ${signal}`}.`));
    });
  });
}

async function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error('The WebPilot Server installer can only be built on 64-bit Windows.');
  }
  assertSupportedNodeVersion();
  assertServerPackage();

  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const version = String(packageJson.version || '').trim();
  if (!version) throw new Error('package.json must define a version.');
  const iconPath = path.join(root, 'assets', 'app-icon.ico');
  const licensePath = path.join(root, 'assets', 'licenses', 'WinSW-LICENSE.txt');
  for (const requiredFile of [process.execPath, iconPath, licensePath]) {
    if (!fs.existsSync(requiredFile)) throw new Error(`Required installer input is missing: ${requiredFile}`);
  }

  const winSwPath = await resolveWinSwExecutable();
  fs.rmSync(installerWorkRoot, { recursive: true, force: true });
  fs.mkdirSync(installerWorkRoot, { recursive: true });
  const serviceConfigPath = path.join(installerWorkRoot, 'WebPilotService.xml');
  const scriptPath = path.join(installerWorkRoot, 'WebPilot-Server.nsi');
  const outputPath = path.join(installerOutputRoot, `WebPilot-Server-Setup-${version}-x64.exe`);
  fs.writeFileSync(serviceConfigPath, createServiceXml(), 'utf8');
  fs.writeFileSync(scriptPath, createNsisScript({
    iconPath,
    licensePath,
    nodePath: process.execPath,
    outputPath,
    packageRoot: distributionRoot,
    serviceConfigPath,
    version,
    winSwPath,
  }), 'utf8');

  const { getMakeNsisPath } = require('app-builder-lib/out/toolsets/windows');
  const makeNsis = await getMakeNsisPath(null);
  await run(makeNsis.path, ['/V2', scriptPath], {
    cwd: root,
    env: { ...process.env, ...(makeNsis.env || {}) },
  });
  if (!fs.existsSync(outputPath)) throw new Error(`NSIS did not create the expected installer: ${outputPath}`);
  console.log(`WebPilot Server installer created:\n  ${outputPath}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  assertServerPackage,
  assertSupportedNodeVersion,
  createNsisScript,
  createServiceXml,
  requiredServerPackageEntries,
  windowsVersion,
};
