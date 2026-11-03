# Saves an image of only the Extension Development Host window, even when others overlap it, so
# nothing else on the desktop can end up in a screenshot.
param([string]$OutFile)
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Win {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
"@
$script:found = [IntPtr]::Zero
$callback = [Win+EnumProc]{
  param($h, $l)
  if ([Win]::IsWindowVisible($h)) {
    $sb = New-Object System.Text.StringBuilder 512
    [void][Win]::GetWindowText($h, $sb, 512)
    if ($sb.ToString() -like '*Extension Development Host*') { $script:found = $h; return $false }
  }
  return $true
}
[void][Win]::EnumWindows($callback, [IntPtr]::Zero)
if ($script:found -eq [IntPtr]::Zero) { Write-Error 'Extension Development Host window not found'; exit 1 }
[void][Win]::ShowWindow($script:found, 9)  # Restore if minimised; PrintWindow cannot draw a minimised window.
$r = New-Object Win+RECT
[void][Win]::GetWindowRect($script:found, [ref]$r)
$bmp = New-Object System.Drawing.Bitmap ($r.R - $r.L), ($r.B - $r.T)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$dc = $g.GetHdc()
[void][Win]::PrintWindow($script:found, $dc, 2)  # 2 = PW_RENDERFULLCONTENT, needed for Chromium windows.
$g.ReleaseHdc($dc)
$bmp.Save($OutFile, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
