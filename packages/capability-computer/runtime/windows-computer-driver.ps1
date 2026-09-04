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
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;

public static class WebPilotComputerNative {
    [StructLayout(LayoutKind.Sequential)]
    public struct WindowRect {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

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

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr window, out WindowRect rect);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowText(IntPtr window, StringBuilder text, int count);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetClassName(IntPtr window, StringBuilder text, int count);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
}

public sealed class WebPilotVisualRegion {
    public int X;
    public int Y;
    public int Width;
    public int Height;
    public int PixelCount;
    public string Color;
}

public static class WebPilotVisualRegionDetector {
    private const ushort Empty = ushort.MaxValue;

    public static WebPilotVisualRegion[] Find(string imagePath, int cropX, int cropY, int cropWidth, int cropHeight) {
        using (var source = new Bitmap(imagePath)) {
            var imageBounds = new Rectangle(0, 0, source.Width, source.Height);
            var cropBounds = Rectangle.Intersect(imageBounds, new Rectangle(cropX, cropY, cropWidth, cropHeight));
            if (cropBounds.Width <= 0 || cropBounds.Height <= 0) return new WebPilotVisualRegion[0];
            using (var bitmap = source.Clone(cropBounds, PixelFormat.Format32bppArgb)) {
                int width = bitmap.Width;
                int height = bitmap.Height;
                int size = width * height;
                var buckets = new ushort[size];
                for (int index = 0; index < size; index++) buckets[index] = Empty;
                var data = bitmap.LockBits(new Rectangle(0, 0, width, height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
                try {
                    int stride = Math.Abs(data.Stride);
                    var pixels = new byte[stride * height];
                    Marshal.Copy(data.Scan0, pixels, 0, pixels.Length);
                    for (int y = 0; y < height; y++) {
                        int row = data.Stride >= 0 ? y * stride : (height - 1 - y) * stride;
                        for (int x = 0; x < width; x++) {
                            int offset = row + (x * 4);
                            int blue = pixels[offset];
                            int green = pixels[offset + 1];
                            int red = pixels[offset + 2];
                            int maximum = Math.Max(red, Math.Max(green, blue));
                            int minimum = Math.Min(red, Math.Min(green, blue));
                            if (maximum < 110 || maximum - minimum < 60) continue;
                            buckets[(y * width) + x] = (ushort)(((red >> 5) << 6) | ((green >> 5) << 3) | (blue >> 5));
                        }
                    }
                } finally {
                    bitmap.UnlockBits(data);
                }

                var visited = new bool[size];
                var queue = new int[size];
                var regions = new List<WebPilotVisualRegion>();
                for (int seed = 0; seed < size; seed++) {
                    ushort bucket = buckets[seed];
                    if (bucket == Empty || visited[seed]) continue;
                    int head = 0;
                    int tail = 0;
                    queue[tail++] = seed;
                    visited[seed] = true;
                    int minimumX = width;
                    int minimumY = height;
                    int maximumX = -1;
                    int maximumY = -1;
                    long redTotal = 0;
                    long greenTotal = 0;
                    long blueTotal = 0;
                    while (head < tail) {
                        int current = queue[head++];
                        int y = current / width;
                        int x = current - (y * width);
                        minimumX = Math.Min(minimumX, x);
                        minimumY = Math.Min(minimumY, y);
                        maximumX = Math.Max(maximumX, x);
                        maximumY = Math.Max(maximumY, y);
                        redTotal += ((bucket >> 6) & 7) * 32 + 16;
                        greenTotal += ((bucket >> 3) & 7) * 32 + 16;
                        blueTotal += (bucket & 7) * 32 + 16;
                        AddNeighbor(current - 1, x > 0, bucket, buckets, visited, queue, ref tail);
                        AddNeighbor(current + 1, x + 1 < width, bucket, buckets, visited, queue, ref tail);
                        AddNeighbor(current - width, y > 0, bucket, buckets, visited, queue, ref tail);
                        AddNeighbor(current + width, y + 1 < height, bucket, buckets, visited, queue, ref tail);
                    }
                    int regionWidth = maximumX - minimumX + 1;
                    int regionHeight = maximumY - minimumY + 1;
                    int area = regionWidth * regionHeight;
                    if (regionWidth < 24 || regionHeight < 12 || tail < 100 || tail < area * 0.25) continue;
                    if (regionWidth >= width * 0.92 && regionHeight >= height * 0.92) continue;
                    regions.Add(new WebPilotVisualRegion {
                        X = cropBounds.X + minimumX,
                        Y = cropBounds.Y + minimumY,
                        Width = regionWidth,
                        Height = regionHeight,
                        PixelCount = tail,
                        Color = string.Format("#{0:X2}{1:X2}{2:X2}", redTotal / tail, greenTotal / tail, blueTotal / tail)
                    });
                }
                regions.Sort((left, right) => right.PixelCount.CompareTo(left.PixelCount));
                var selected = new List<WebPilotVisualRegion>();
                foreach (var region in regions) {
                    bool duplicate = false;
                    foreach (var existing in selected) {
                        var intersection = Rectangle.Intersect(
                            new Rectangle(region.X, region.Y, region.Width, region.Height),
                            new Rectangle(existing.X, existing.Y, existing.Width, existing.Height)
                        );
                        int smallerArea = Math.Min(region.Width * region.Height, existing.Width * existing.Height);
                        if (smallerArea > 0 && intersection.Width * intersection.Height >= smallerArea * 0.8) {
                            duplicate = true;
                            break;
                        }
                    }
                    if (!duplicate) selected.Add(region);
                    if (selected.Count >= 32) break;
                }
                return selected.ToArray();
            }
        }
    }

    private static void AddNeighbor(int index, bool valid, ushort bucket, ushort[] buckets, bool[] visited, int[] queue, ref int tail) {
        if (!valid || visited[index] || buckets[index] != bucket) return;
        visited[index] = true;
        queue[tail++] = index;
    }
}
'@ -ReferencedAssemblies System.Drawing

Add-Type -AssemblyName Accessibility
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using Accessibility;

public sealed class WebPilotDesktopItem {
    public string Name;
    public int X;
    public int Y;
    public int Width;
    public int Height;
}

public static class WebPilotDesktopAccessibility {
    private delegate bool EnumWindowsCallback(IntPtr window, IntPtr data);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr FindWindow(string className, string windowName);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string className, string windowName);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsCallback callback, IntPtr data);

    [DllImport("oleacc.dll")]
    private static extern int AccessibleObjectFromWindow(
        IntPtr window,
        uint objectId,
        ref Guid interfaceId,
        [MarshalAs(UnmanagedType.Interface)] out object accessible
    );

    [DllImport("oleacc.dll")]
    private static extern int AccessibleChildren(
        IAccessible container,
        int childStart,
        int childCount,
        [Out, MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 2)] object[] children,
        out int obtained
    );

    private static IntPtr FindDesktopList() {
        IntPtr definition = FindWindowEx(FindWindow("Progman", null), IntPtr.Zero, "SHELLDLL_DefView", null);
        if (definition == IntPtr.Zero) {
            EnumWindows(delegate(IntPtr window, IntPtr data) {
                IntPtr candidate = FindWindowEx(window, IntPtr.Zero, "SHELLDLL_DefView", null);
                if (candidate == IntPtr.Zero) return true;
                definition = candidate;
                return false;
            }, IntPtr.Zero);
        }
        return definition == IntPtr.Zero
            ? IntPtr.Zero
            : FindWindowEx(definition, IntPtr.Zero, "SysListView32", "FolderView");
    }

    public static WebPilotDesktopItem[] GetItems() {
        IntPtr list = FindDesktopList();
        if (list == IntPtr.Zero) return new WebPilotDesktopItem[0];
        Guid accessibleInterface = new Guid("618736E0-3C3D-11CF-810C-00AA00389B71");
        object value;
        int result = AccessibleObjectFromWindow(list, 0xFFFFFFFC, ref accessibleInterface, out value);
        if (result != 0 || value == null) return new WebPilotDesktopItem[0];
        IAccessible container = (IAccessible)value;
        int childCount = Math.Max(0, container.accChildCount);
        if (childCount == 0) return new WebPilotDesktopItem[0];
        var children = new object[childCount];
        int obtained;
        AccessibleChildren(container, 0, childCount, children, out obtained);
        var items = new List<WebPilotDesktopItem>();
        for (int index = 0; index < obtained; index++) {
            object child = children[index];
            IAccessible item = child as IAccessible;
            IAccessible owner = item ?? container;
            object childId = item == null ? child : (object)0;
            try {
                string name = owner.get_accName(childId);
                int x, y, width, height;
                owner.accLocation(out x, out y, out width, out height, childId);
                if (string.IsNullOrWhiteSpace(name) || width <= 0 || height <= 0) continue;
                items.Add(new WebPilotDesktopItem {
                    Name = name.Trim(),
                    X = x,
                    Y = y,
                    Width = width,
                    Height = height
                });
            } catch { }
        }
        return items.ToArray();
    }
}
'@ -ReferencedAssemblies Accessibility

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

function Get-ApplicationShortcuts([string]$ApplicationName) {
  $requested = $ApplicationName.Trim()
  if (-not $requested) { throw 'Application name is required.' }
  $roots = @(
    [ordered]@{ path = [Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory); source = 'desktop'; rank = 0; recursive = $false }
    [ordered]@{ path = [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonDesktopDirectory); source = 'common-desktop'; rank = 1; recursive = $false }
    [ordered]@{ path = [Environment]::GetFolderPath([Environment+SpecialFolder]::Programs); source = 'start-menu'; rank = 2; recursive = $true }
    [ordered]@{ path = [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonPrograms); source = 'common-start-menu'; rank = 3; recursive = $true }
  )
  $candidates = @()
  foreach ($root in $roots) {
    if (-not $root.path -or -not (Test-Path -LiteralPath $root.path)) { continue }
    $shortcuts = if ($root.recursive) {
      Get-ChildItem -LiteralPath $root.path -Filter '*.lnk' -File -Recurse -ErrorAction SilentlyContinue
    } else {
      Get-ChildItem -LiteralPath $root.path -Filter '*.lnk' -File -ErrorAction SilentlyContinue
    }
    $rootCandidates = @()
    foreach ($shortcut in $shortcuts) {
      $name = [IO.Path]::GetFileNameWithoutExtension($shortcut.Name)
      $matchRank = if ($name.Equals($requested, [StringComparison]::OrdinalIgnoreCase)) {
        0
      } elseif ($name.StartsWith($requested, [StringComparison]::OrdinalIgnoreCase)) {
        1
      } elseif ($name.IndexOf($requested, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
        2
      } else {
        continue
      }
      $rootCandidates += [pscustomobject]@{
        path = $shortcut.FullName
        name = $name
        source = $root.source
        score = ($matchRank * 10) + $root.rank
      }
    }
    $exactMatches = @($rootCandidates | Where-Object { $_.score -eq $root.rank })
    if ($exactMatches.Count -gt 0) {
      return @($exactMatches | Sort-Object score, name, path)
    }
    $candidates += $rootCandidates
  }
  return @($candidates | Sort-Object score, name, path)
}

function Invoke-ApplicationLaunch([string]$ApplicationName) {
  $candidates = @(Get-ApplicationShortcuts $ApplicationName)
  if ($candidates.Count -eq 0) {
    throw "No desktop or Start-menu shortcut matched application '$ApplicationName'."
  }
  $best = $candidates[0]
  $sameScore = @($candidates | Where-Object { $_.score -eq $best.score })
  $distinctNames = @($sameScore | Select-Object -ExpandProperty name -Unique)
  if ($distinctNames.Count -gt 1) {
    throw "Application '$ApplicationName' is ambiguous. Matching shortcuts: $($distinctNames -join ', ')."
  }
  Start-Process -FilePath $best.path
  Start-Sleep -Milliseconds 1200
  $shell = New-Object -ComObject WScript.Shell
  $activated = $shell.AppActivate($best.name)
  if (-not $activated -and -not $best.name.Equals($ApplicationName.Trim(), [StringComparison]::OrdinalIgnoreCase)) {
    $activated = $shell.AppActivate($ApplicationName.Trim())
  }
  if ($activated) { Start-Sleep -Milliseconds 250 }
  return [ordered]@{
    requestedApplication = $ApplicationName.Trim()
    matchedApplication = $best.name
    source = $best.source
    windowActivated = [bool]$activated
  }
}

function Get-ForegroundWindowContext {
  $window = [WebPilotComputerNative]::GetForegroundWindow()
  $title = New-Object System.Text.StringBuilder 1024
  [WebPilotComputerNative]::GetWindowText($window, $title, $title.Capacity) | Out-Null
  $className = New-Object System.Text.StringBuilder 256
  [WebPilotComputerNative]::GetClassName($window, $className, $className.Capacity) | Out-Null
  [uint32]$processId = 0
  [WebPilotComputerNative]::GetWindowThreadProcessId($window, [ref]$processId) | Out-Null
  $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
  $rect = New-Object WebPilotComputerNative+WindowRect
  $hasBounds = [WebPilotComputerNative]::GetWindowRect($window, [ref]$rect)
  return [pscustomobject]@{
    handle = $window
    className = $className.ToString()
    activeWindow = [ordered]@{
      title = $title.ToString()
      application = if ($process) { $process.ProcessName } else { '' }
      bounds = if ($hasBounds -and $rect.Right -gt $rect.Left -and $rect.Bottom -gt $rect.Top) {
        [ordered]@{
          x = $rect.Left
          y = $rect.Top
          width = $rect.Right - $rect.Left
          height = $rect.Bottom - $rect.Top
        }
      } else { $null }
    }
  }
}

function Convert-ToScreenshotBounds($Rect, [int]$ScreenWidth, [int]$ScreenHeight) {
  if ($null -eq $Rect) { return $null }
  $values = @([double]$Rect.X, [double]$Rect.Y, [double]$Rect.Width, [double]$Rect.Height)
  if (@($values | Where-Object { [double]::IsNaN($_) -or [double]::IsInfinity($_) }).Count -gt 0) { return $null }
  $left = [Math]::Max(0, [Math]::Floor($values[0]))
  $top = [Math]::Max(0, [Math]::Floor($values[1]))
  $right = [Math]::Min($ScreenWidth, [Math]::Ceiling($values[0] + $values[2]))
  $bottom = [Math]::Min($ScreenHeight, [Math]::Ceiling($values[1] + $values[3]))
  if ($right -le $left -or $bottom -le $top) { return $null }
  return [ordered]@{
    x = [int]$left
    y = [int]$top
    width = [int]($right - $left)
    height = [int]($bottom - $top)
  }
}

function New-ComputerElement(
  [string]$Id,
  [string]$Source,
  [string]$Role,
  [string]$Name,
  [string]$Text,
  $Bounds,
  [bool]$Enabled
) {
  return [ordered]@{
    id = $Id
    source = $Source
    role = $Role
    name = if ($Name) { $Name.Substring(0, [Math]::Min(200, $Name.Length)) } else { $null }
    text = if ($Text) { $Text.Substring(0, [Math]::Min(200, $Text.Length)) } else { $null }
    bounds = $Bounds
    center = [ordered]@{
      x = $Bounds.x + [Math]::Floor($Bounds.width / 2)
      y = $Bounds.y + [Math]::Floor($Bounds.height / 2)
    }
    enabled = $Enabled
  }
}

function Get-UiaElements([IntPtr]$Window, [int]$ScreenWidth, [int]$ScreenHeight, [long]$Sequence) {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($Window)
  if ($null -eq $root) { return [ordered]@{ elements = @(); actionableCount = 0 } }
  $actionableRoles = @('Button', 'CheckBox', 'ComboBox', 'Edit', 'Hyperlink', 'ListItem', 'MenuItem', 'RadioButton', 'TabItem', 'TreeItem')
  $contextRoles = @('Document', 'Pane', 'Window')
  $rootElements = New-Object System.Collections.ArrayList
  $actionableElements = New-Object System.Collections.ArrayList
  $contextElements = New-Object System.Collections.ArrayList
  $actionableCount = 0
  $rootBounds = Convert-ToScreenshotBounds $root.Current.BoundingRectangle $ScreenWidth $ScreenHeight
  if ($rootBounds) {
    [void]$rootElements.Add((New-ComputerElement "uia:${Sequence}:window" 'uia' 'window' ([string]$root.Current.Name).Trim() '' $rootBounds ([bool]$root.Current.IsEnabled)))
  }
  $nodes = $root.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.Condition]::TrueCondition
  )
  for ($index = 0; $index -lt $nodes.Count; $index++) {
    try {
      $node = $nodes.Item($index)
      if ($node.Current.IsOffscreen) { continue }
      $role = ([string]$node.Current.ControlType.ProgrammaticName) -replace '^ControlType\.', ''
      $name = ([string]$node.Current.Name).Trim()
      $automationId = ([string]$node.Current.AutomationId).Trim()
      $isActionable = $actionableRoles -contains $role
      $isContext = $contextRoles -contains $role
      if (-not $isActionable -and (-not $isContext -or -not $name)) { continue }
      $bounds = Convert-ToScreenshotBounds $node.Current.BoundingRectangle $ScreenWidth $ScreenHeight
      if (-not $bounds) { continue }
      $label = if ($name) { $name } else { $automationId }
      $element = New-ComputerElement "uia:${Sequence}:$index" 'uia' $role.ToLowerInvariant() $label '' $bounds ([bool]$node.Current.IsEnabled)
      if ($isActionable) {
        $actionableCount += 1
        [void]$actionableElements.Add($element)
      } elseif ($contextElements.Count -lt 12) {
        [void]$contextElements.Add($element)
      }
    } catch { }
  }
  $elements = @($rootElements) + @($actionableElements) + @($contextElements)
  return [ordered]@{ elements = @($elements | Select-Object -First 160); actionableCount = $actionableCount }
}

function Get-DesktopAccessibilityElements($WindowContext, [int]$ScreenWidth, [int]$ScreenHeight, [long]$Sequence) {
  $desktopActive = @('Progman', 'WorkerW') -contains [string]$WindowContext.className
  $occludingBounds = if ($desktopActive) {
    $null
  } else {
    Convert-ToScreenshotBounds $WindowContext.activeWindow.bounds $ScreenWidth $ScreenHeight
  }
  $items = [WebPilotDesktopAccessibility]::GetItems()
  $elements = New-Object System.Collections.ArrayList
  for ($index = 0; $index -lt $items.Count; $index++) {
    $item = $items[$index]
    $rect = [pscustomobject]@{ X = $item.X; Y = $item.Y; Width = $item.Width; Height = $item.Height }
    $bounds = Convert-ToScreenshotBounds $rect $ScreenWidth $ScreenHeight
    if (-not $bounds) { continue }
    $occluded = $occludingBounds -and
      $bounds.x -lt ($occludingBounds.x + $occludingBounds.width) -and
      ($bounds.x + $bounds.width) -gt $occludingBounds.x -and
      $bounds.y -lt ($occludingBounds.y + $occludingBounds.height) -and
      ($bounds.y + $bounds.height) -gt $occludingBounds.y
    if ($occluded) { continue }
    [void]$elements.Add((New-ComputerElement "msaa:${Sequence}:desktop:$index" 'msaa' 'desktop-icon' $item.Name '' $bounds $true))
  }
  return @($elements | Select-Object -First 240)
}

$script:WebPilotAsTaskMethod = $null

function Await-WindowsRuntime($Operation, [Type]$ResultType) {
  if ($null -eq $script:WebPilotAsTaskMethod) {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $script:WebPilotAsTaskMethod = [System.WindowsRuntimeSystemExtensions].GetMethods() |
      Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 } |
      Select-Object -First 1
  }
  $task = $script:WebPilotAsTaskMethod.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
  $task.Wait()
  return $task.Result
}

function Get-OcrElements([string]$ScreenshotPath, $WindowBounds, [int]$ScreenWidth, [int]$ScreenHeight, [long]$Sequence) {
  if (-not $ScreenshotPath -or -not (Test-Path -LiteralPath $ScreenshotPath)) { return @() }
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType=WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType=WindowsRuntime]
  $null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType=WindowsRuntime]
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Media.Ocr, ContentType=WindowsRuntime]
  $null = [Windows.Media.Ocr.OcrResult, Windows.Media.Ocr, ContentType=WindowsRuntime]

  $sourceBounds = Convert-ToScreenshotBounds $WindowBounds $ScreenWidth $ScreenHeight
  if (-not $sourceBounds) {
    $sourceBounds = [ordered]@{ x = 0; y = 0; width = $ScreenWidth; height = $ScreenHeight }
  }
  $source = [System.Drawing.Image]::FromFile($ScreenshotPath)
  try {
    $crop = New-Object System.Drawing.Bitmap $sourceBounds.width, $sourceBounds.height
    $graphics = [System.Drawing.Graphics]::FromImage($crop)
    try {
      $graphics.DrawImage(
        $source,
        (New-Object System.Drawing.Rectangle 0, 0, $sourceBounds.width, $sourceBounds.height),
        (New-Object System.Drawing.Rectangle $sourceBounds.x, $sourceBounds.y, $sourceBounds.width, $sourceBounds.height),
        [System.Drawing.GraphicsUnit]::Pixel
      )
    } finally {
      $graphics.Dispose()
    }
    try {
      $maxDimension = [Windows.Media.Ocr.OcrEngine]::MaxImageDimension
      $scale = [Math]::Max(1, [Math]::Min(3, [Math]::Floor($maxDimension / [Math]::Max($crop.Width, $crop.Height))))
      $ocrImage = $crop
      if ($scale -gt 1) {
        $ocrImage = New-Object System.Drawing.Bitmap ($crop.Width * $scale), ($crop.Height * $scale)
        $graphics = [System.Drawing.Graphics]::FromImage($ocrImage)
        try {
          $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
          $graphics.DrawImage($crop, 0, 0, $ocrImage.Width, $ocrImage.Height)
        } finally {
          $graphics.Dispose()
        }
      }
      try {
        $memory = New-Object System.IO.MemoryStream
        try {
          $ocrImage.Save($memory, [System.Drawing.Imaging.ImageFormat]::Png)
          $memory.Position = 0
          $stream = [System.IO.WindowsRuntimeStreamExtensions]::AsRandomAccessStream($memory)
          try {
            $decoder = Await-WindowsRuntime ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
            $softwareBitmap = Await-WindowsRuntime ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
            try {
              $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
              if ($null -eq $engine) { return @() }
              $result = Await-WindowsRuntime ($engine.RecognizeAsync($softwareBitmap)) ([Windows.Media.Ocr.OcrResult])
              $elements = New-Object System.Collections.ArrayList
              $elementIndex = 0
              foreach ($line in $result.Lines) {
                $words = @($line.Words | Sort-Object { $_.BoundingRect.X })
                $group = New-Object System.Collections.ArrayList
                foreach ($word in $words) {
                  if ($group.Count -gt 0) {
                    $previous = $group[$group.Count - 1]
                    $gap = $word.BoundingRect.X - ($previous.BoundingRect.X + $previous.BoundingRect.Width)
                    $maximumGap = [Math]::Max($previous.BoundingRect.Height, $word.BoundingRect.Height) * 1.25
                    if ($gap -gt $maximumGap) {
                      $elementIndex = Add-OcrElement $elements $group $sourceBounds $scale $Sequence $elementIndex $ScreenWidth $ScreenHeight
                      $group = New-Object System.Collections.ArrayList
                    }
                  }
                  [void]$group.Add($word)
                }
                if ($group.Count -gt 0) {
                  $elementIndex = Add-OcrElement $elements $group $sourceBounds $scale $Sequence $elementIndex $ScreenWidth $ScreenHeight
                }
                if ($elements.Count -ge 80) { break }
              }
              return @($elements | Select-Object -First 80)
            } finally {
              $softwareBitmap.Dispose()
            }
          } finally {
            $stream.Dispose()
          }
        } finally {
          $memory.Dispose()
        }
      } finally {
        if ($ocrImage -ne $crop) { $ocrImage.Dispose() }
      }
    } finally {
      $crop.Dispose()
    }
  } finally {
    $source.Dispose()
  }
}

function Add-OcrElement($Elements, $Words, $SourceBounds, [int]$Scale, [long]$Sequence, [int]$ElementIndex, [int]$ScreenWidth, [int]$ScreenHeight) {
  $text = (@($Words | ForEach-Object { ([string]$_.Text).Trim() }) -join '').Trim()
  if (-not $text) { return $ElementIndex }
  $left = ($Words | ForEach-Object { $_.BoundingRect.X } | Measure-Object -Minimum).Minimum
  $top = ($Words | ForEach-Object { $_.BoundingRect.Y } | Measure-Object -Minimum).Minimum
  $right = ($Words | ForEach-Object { $_.BoundingRect.X + $_.BoundingRect.Width } | Measure-Object -Maximum).Maximum
  $bottom = ($Words | ForEach-Object { $_.BoundingRect.Y + $_.BoundingRect.Height } | Measure-Object -Maximum).Maximum
  $rect = [pscustomobject]@{
    X = $SourceBounds.x + ($left / $Scale)
    Y = $SourceBounds.y + ($top / $Scale)
    Width = ($right - $left) / $Scale
    Height = ($bottom - $top) / $Scale
  }
  $bounds = Convert-ToScreenshotBounds $rect $ScreenWidth $ScreenHeight
  if ($bounds) {
    [void]$Elements.Add((New-ComputerElement "ocr:${Sequence}:$ElementIndex" 'ocr' 'text' $text $text $bounds $true))
    return $ElementIndex + 1
  }
  return $ElementIndex
}

function Get-VisualElements([string]$ScreenshotPath, $WindowBounds, [int]$ScreenWidth, [int]$ScreenHeight, [long]$Sequence) {
  if (-not $ScreenshotPath -or -not (Test-Path -LiteralPath $ScreenshotPath)) { return @() }
  $sourceBounds = Convert-ToScreenshotBounds $WindowBounds $ScreenWidth $ScreenHeight
  if (-not $sourceBounds) {
    $sourceBounds = [ordered]@{ x = 0; y = 0; width = $ScreenWidth; height = $ScreenHeight }
  }
  $regions = [WebPilotVisualRegionDetector]::Find(
    $ScreenshotPath,
    $sourceBounds.x,
    $sourceBounds.y,
    $sourceBounds.width,
    $sourceBounds.height
  )
  $elements = New-Object System.Collections.ArrayList
  for ($index = 0; $index -lt $regions.Count; $index++) {
    $region = $regions[$index]
    $bounds = [ordered]@{ x = $region.X; y = $region.Y; width = $region.Width; height = $region.Height }
    $isButtonCandidate = $region.Width -ge ($region.Height * 1.6) -and $region.Height -le 180
    $role = if ($isButtonCandidate) { 'button-candidate' } else { 'visual-region' }
    $name = "$role $($region.Color)"
    [void]$elements.Add((New-ComputerElement "visual:${Sequence}:$index" 'visual' $role $name '' $bounds $true))
  }
  return @($elements)
}

function Get-ComputerElements($WindowContext, [string]$ScreenshotPath, [int]$ScreenWidth, [int]$ScreenHeight, [long]$Sequence) {
  $errors = New-Object System.Collections.ArrayList
  $uia = [ordered]@{ elements = @(); actionableCount = 0 }
  try {
    $uia = Get-UiaElements $WindowContext.handle $ScreenWidth $ScreenHeight $Sequence
  } catch {
    [void]$errors.Add("UI Automation: $($_.Exception.Message)")
  }
  $desktopElements = @()
  try {
    $desktopElements = @(Get-DesktopAccessibilityElements $WindowContext $ScreenWidth $ScreenHeight $Sequence)
  } catch {
    [void]$errors.Add("Desktop accessibility: $($_.Exception.Message)")
  }
  $desktopActive = @('Progman', 'WorkerW') -contains [string]$WindowContext.className
  $ocrElements = @()
  $ocrUsed = -not $desktopActive -and $uia.actionableCount -eq 0
  if ($ocrUsed) {
    try {
      $ocrElements = @(Get-OcrElements $ScreenshotPath $WindowContext.activeWindow.bounds $ScreenWidth $ScreenHeight $Sequence)
    } catch {
      [void]$errors.Add("Windows OCR: $($_.Exception.Message)")
    }
  }
  $visualElements = @()
  $visualUsed = -not $desktopActive -and $uia.actionableCount -eq 0
  if ($visualUsed) {
    try {
      $visualElements = @(Get-VisualElements $ScreenshotPath $WindowContext.activeWindow.bounds $ScreenWidth $ScreenHeight $Sequence)
    } catch {
      [void]$errors.Add("Visual regions: $($_.Exception.Message)")
    }
  }
  return [ordered]@{
    elements = @($uia.elements) + @($desktopElements) + @($ocrElements) + @($visualElements)
    discovery = [ordered]@{
      uiaCount = @($uia.elements).Count
      msaaCount = $desktopElements.Count
      ocrCount = @($ocrElements).Count
      visualCount = @($visualElements).Count
      ocrUsed = $ocrUsed
      visualUsed = $visualUsed
      errors = @($errors | ForEach-Object { $_.Substring(0, [Math]::Min(300, $_.Length)) })
    }
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
$launch = $null

switch ($action) {
  'launch' { $launch = Invoke-ApplicationLaunch ([string]$inputAction.application) }
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
  default { throw "Unsupported computer action: $action" }
}

$width = [WebPilotComputerNative]::GetSystemMetrics(0)
$height = [WebPilotComputerNative]::GetSystemMetrics(1)
$windowContext = Get-ForegroundWindowContext
if ($ScreenshotPath) { Save-Screenshot $ScreenshotPath $width $height }
$sequence = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$elementPayload = if ($ScreenshotPath) {
  Get-ComputerElements $windowContext $ScreenshotPath $width $height $sequence
} else { $null }

$result = [ordered]@{
  displayId = 'main'
  width = $width
  height = $height
  activeWindow = $windowContext.activeWindow
  sequence = $sequence
}
if ($launch) { $result.launch = $launch }
if ($elementPayload) {
  $result.elements = $elementPayload.elements
  $result.elementDiscovery = $elementPayload.discovery
}
$result | ConvertTo-Json -Compress -Depth 6
