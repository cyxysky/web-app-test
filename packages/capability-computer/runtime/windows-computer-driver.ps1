param(
  [Parameter(Mandatory = $true)][string]$ActionBase64,
  [string]$ScreenshotPath = ''
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class WebPilotComputerNative {
    [DllImport("user32.dll")]
    public static extern bool SetProcessDPIAware();

    [DllImport("user32.dll")]
    public static extern int GetSystemMetrics(int index);

    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int x, int y);

    [DllImport("user32.dll")]
    public static extern void mouse_event(uint flags, uint dx, uint dy, int data, UIntPtr extraInfo);

    [DllImport("user32.dll")]
    public static extern void keybd_event(byte virtualKey, byte scanCode, uint flags, UIntPtr extraInfo);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowText(IntPtr window, StringBuilder text, int count);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
}
'@

[WebPilotComputerNative]::SetProcessDPIAware() | Out-Null

function Get-VirtualKey([string]$Name) {
  $normalized = $Name.Trim().ToUpperInvariant()
  $known = @{
    'ALT' = 0x12; 'BACKSPACE' = 0x08; 'CTRL' = 0x11; 'CONTROL' = 0x11
    'DELETE' = 0x2E; 'DOWN' = 0x28; 'END' = 0x23; 'ENTER' = 0x0D
    'ESC' = 0x1B; 'ESCAPE' = 0x1B; 'HOME' = 0x24; 'INSERT' = 0x2D
    'LEFT' = 0x25; 'ARROWLEFT' = 0x25; 'META' = 0x5B; 'SUPER' = 0x5B
    'PAGEDOWN' = 0x22; 'PAGEUP' = 0x21; 'RETURN' = 0x0D
    'RIGHT' = 0x27; 'ARROWRIGHT' = 0x27; 'SHIFT' = 0x10; 'SPACE' = 0x20; 'TAB' = 0x09
    'UP' = 0x26; 'ARROWUP' = 0x26; 'ARROWDOWN' = 0x28
    'WIN' = 0x5B; 'WINDOWS' = 0x5B; 'COMMAND' = 0x5B; 'CMD' = 0x5B
  }
  if ($known.ContainsKey($normalized)) { return [byte]$known[$normalized] }
  if ($normalized -match '^F([1-9]|1[0-2])$') { return [byte](0x6F + [int]$Matches[1]) }
  if ($normalized.Length -eq 1 -and $normalized -match '^[A-Z0-9]$') {
    return [byte][char]$normalized
  }
  throw "Unsupported key: $Name"
}

function Invoke-KeyChord($Keys) {
  $virtualKeys = @($Keys | ForEach-Object { Get-VirtualKey ([string]$_) })
  foreach ($virtualKey in $virtualKeys) {
    [WebPilotComputerNative]::keybd_event($virtualKey, 0, 0, [UIntPtr]::Zero)
  }
  [Array]::Reverse($virtualKeys)
  foreach ($virtualKey in $virtualKeys) {
    [WebPilotComputerNative]::keybd_event($virtualKey, 0, 2, [UIntPtr]::Zero)
  }
}

function Invoke-TextInput([string]$Text) {
  if ($Text.Length -eq 0) { return }
  $previousClipboard = [System.Windows.Forms.Clipboard]::GetDataObject()
  try {
    [System.Windows.Forms.Clipboard]::SetText($Text)
    Invoke-KeyChord @('CTRL', 'V')
    Start-Sleep -Milliseconds 120
  } finally {
    if ($null -ne $previousClipboard) {
      [System.Windows.Forms.Clipboard]::SetDataObject($previousClipboard, $true)
    } else {
      [System.Windows.Forms.Clipboard]::Clear()
    }
  }
}

function Get-ActiveWindow {
  $window = [WebPilotComputerNative]::GetForegroundWindow()
  $title = New-Object System.Text.StringBuilder 1024
  [WebPilotComputerNative]::GetWindowText($window, $title, $title.Capacity) | Out-Null
  [uint32]$processId = 0
  [WebPilotComputerNative]::GetWindowThreadProcessId($window, [ref]$processId) | Out-Null
  $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
  return [ordered]@{
    title = $title.ToString()
    application = if ($process) { $process.ProcessName } else { '' }
  }
}

function Save-Screenshot([string]$Path, [int]$Width, [int]$Height) {
  $bitmap = New-Object System.Drawing.Bitmap $Width, $Height, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.CopyFromScreen(0, 0, 0, 0, $bitmap.Size, [System.Drawing.CopyPixelOperation]::SourceCopy)
    $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $graphics.Dispose()
    $bitmap.Dispose()
  }
}

$json = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ActionBase64))
$inputAction = $json | ConvertFrom-Json
$action = [string]$inputAction.action

switch ($action) {
  'click' {
    $x = [int]$inputAction.x
    $y = [int]$inputAction.y
    [WebPilotComputerNative]::SetCursorPos($x, $y) | Out-Null
    $button = if ($inputAction.button) { [string]$inputAction.button } else { 'left' }
    $down = if ($button -eq 'right') { 0x0008 } elseif ($button -eq 'middle') { 0x0020 } else { 0x0002 }
    $up = if ($button -eq 'right') { 0x0010 } elseif ($button -eq 'middle') { 0x0040 } else { 0x0004 }
    $count = if ($inputAction.clickCount) { [Math]::Max(1, [Math]::Min(3, [int]$inputAction.clickCount)) } else { 1 }
    for ($index = 0; $index -lt $count; $index += 1) {
      [WebPilotComputerNative]::mouse_event($down, 0, 0, 0, [UIntPtr]::Zero)
      [WebPilotComputerNative]::mouse_event($up, 0, 0, 0, [UIntPtr]::Zero)
      if ($index + 1 -lt $count) { Start-Sleep -Milliseconds 80 }
    }
  }
  'type' { Invoke-TextInput ([string]$inputAction.text) }
  'key' { Invoke-KeyChord @($inputAction.keys) }
  'scroll' {
    if ($null -ne $inputAction.deltaY) {
      [WebPilotComputerNative]::mouse_event(0x0800, 0, 0, -[int]$inputAction.deltaY, [UIntPtr]::Zero)
    }
    if ($null -ne $inputAction.deltaX) {
      [WebPilotComputerNative]::mouse_event(0x01000, 0, 0, [int]$inputAction.deltaX, [UIntPtr]::Zero)
    }
  }
  'wait' {
    $duration = if ($null -ne $inputAction.durationMs) { [int]$inputAction.durationMs } else { 500 }
    Start-Sleep -Milliseconds ([Math]::Max(0, [Math]::Min(300000, $duration)))
  }
  'observe' { }
  'screenshot' { }
  default { throw "Unsupported computer action: $action" }
}

$width = [WebPilotComputerNative]::GetSystemMetrics(0)
$height = [WebPilotComputerNative]::GetSystemMetrics(1)
if ($ScreenshotPath) { Save-Screenshot $ScreenshotPath $width $height }

$result = [ordered]@{
  displayId = 'main'
  width = $width
  height = $height
  activeWindow = Get-ActiveWindow
  sequence = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
}
$result | ConvertTo-Json -Compress -Depth 6
