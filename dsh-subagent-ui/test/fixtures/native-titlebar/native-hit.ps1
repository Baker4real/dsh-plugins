#requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string] $Handle,
    [Parameter(Mandatory)] [int] $X,
    [Parameter(Mandatory)] [int] $Y
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$source = @'
using System;
using System.Runtime.InteropServices;
public static class DshNativeTitlebarHit {
    [StructLayout(LayoutKind.Sequential)] public struct Point { public int X; public int Y; }
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr window, uint flags);
    [DllImport("user32.dll")] public static extern IntPtr SendMessageTimeout(IntPtr window, uint message, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);
}
'@
Add-Type -TypeDefinition $source -Language CSharp
$window = [IntPtr]::new([long]::Parse($Handle))
$point = [DshNativeTitlebarHit+Point]::new()
$point.X = $X
$point.Y = $Y
$target = [DshNativeTitlebarHit]::WindowFromPoint($point)
if ($target -eq [IntPtr]::Zero) { throw "WindowFromPoint failed at $X,$Y" }
$packed = [IntPtr]::new((($Y -band 0xffff) -shl 16) -bor ($X -band 0xffff))
$hit = [IntPtr]::Zero
$sendOk = [DshNativeTitlebarHit]::SendMessageTimeout($target, 0x0084, [IntPtr]::Zero, $packed, 0x0002, 1000, [ref] $hit)
if ($sendOk -eq [IntPtr]::Zero) { throw "SendMessageTimeout failed at $X,$Y" }
$root = [DshNativeTitlebarHit]::GetAncestor($target, 2)
[pscustomobject]@{ x = $X; y = $Y; hitWindow = $target.ToInt64(); rootWindow = $root.ToInt64(); hitTest = $hit.ToInt64() } | ConvertTo-Json -Compress
