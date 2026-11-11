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
public static class DshManagedScreenClick {
    [StructLayout(LayoutKind.Sequential)] public struct Point { public int X; public int Y; }
    [StructLayout(LayoutKind.Sequential)] public struct Input { public uint Type; public MouseInput Mouse; }
    [StructLayout(LayoutKind.Sequential)] public struct MouseInput { public int Dx; public int Dy; public uint Data; public uint Flags; public uint Time; public UIntPtr ExtraInfo; }
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point point);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll")] public static extern uint SendInput(uint count, Input[] inputs, int size);
}
'@
Add-Type -TypeDefinition $source -Language CSharp
$window = [IntPtr]::new([long]::Parse($Handle))
$processId = [uint32] 0
[void][DshManagedScreenClick]::GetWindowThreadProcessId($window, [ref] $processId)
$process = Get-Process -Id $processId -ErrorAction Stop
if ($process.ProcessName -ne 'DeepSeek Harness') { throw "unexpected target process: $($process.ProcessName)" }
if ([DshManagedScreenClick]::GetForegroundWindow() -ne $window) { throw 'target window is not in the foreground; no input sent' }
[void][DshManagedScreenClick]::SetProcessDPIAware()
if (-not [DshManagedScreenClick]::SetCursorPos($X, $Y)) { throw 'SetCursorPos failed; no input sent' }
$point = [DshManagedScreenClick+Point]::new()
[void][DshManagedScreenClick]::GetCursorPos([ref] $point)
if ($point.X -ne $X -or $point.Y -ne $Y) { throw "cursor verification failed; no input sent: $($point.X),$($point.Y)" }
$size = [Runtime.InteropServices.Marshal]::SizeOf([type][DshManagedScreenClick+Input])
$down = [DshManagedScreenClick+Input]::new()
$down.Type = 0
$down.Mouse = [DshManagedScreenClick+MouseInput]::new()
$down.Mouse.Flags = 0x0002
$up = [DshManagedScreenClick+Input]::new()
$up.Type = 0
$up.Mouse = [DshManagedScreenClick+MouseInput]::new()
$up.Mouse.Flags = 0x0004
$sent = [DshManagedScreenClick]::SendInput(2, [DshManagedScreenClick+Input[]]@($down, $up), $size)
if ($sent -ne 2) { throw "SendInput failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
Write-Output "SCREEN_CLICK_SENT screen=$X,$Y"
