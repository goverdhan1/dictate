param(
  [Parameter(Mandatory = $true)][string]$Hwnd,
  [Parameter(Mandatory = $true)][uint32]$Affinity
)

# WDA_NONE = 0, WDA_EXCLUDEFROMCAPTURE = 0x11
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class DictateWin32Affinity {
  [DllImport("user32.dll")]
  public static extern bool SetWindowDisplayAffinity(IntPtr hWnd, uint dwAffinity);
}
"@ -ErrorAction SilentlyContinue

$ptr = [IntPtr]::new([int64]$Hwnd)
[void][DictateWin32Affinity]::SetWindowDisplayAffinity($ptr, $Affinity)
