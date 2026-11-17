param(
    [Parameter(Mandatory)][string]$SkillFile,
    [string]$AdditionalRequired,
    [string]$ReportPath
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ([string]::IsNullOrWhiteSpace($env:DSH_NODE_EXECUTABLE) -or [string]::IsNullOrWhiteSpace($env:DSH_INSTALL_DIR)) { throw 'Run from the DSH Host shell so the installation and Electron anchors are available.' }
$checker = Join-Path $PSScriptRoot 'check-dsh-skill-pointers.cjs'
$start = [System.Diagnostics.ProcessStartInfo]::new($env:DSH_NODE_EXECUTABLE)
foreach ($argument in @($checker, '--skill', $SkillFile)) { $start.ArgumentList.Add($argument) }
if ($AdditionalRequired) { $start.ArgumentList.Add('--extra-required'); $start.ArgumentList.Add($AdditionalRequired) }
$start.Environment['ELECTRON_RUN_AS_NODE'] = '1'
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
$start.StandardOutputEncoding = [System.Text.Encoding]::UTF8
$start.StandardErrorEncoding = [System.Text.Encoding]::UTF8
$process = [System.Diagnostics.Process]::Start($start)
$stderrTask = $process.StandardError.ReadToEndAsync()
$stdoutTask = $process.StandardOutput.ReadToEndAsync()
if (-not $process.WaitForExit(30000)) { $process.Kill($true); throw 'The read-only Electron pointer check exceeded 30 seconds.' }
$stdoutText = $stdoutTask.Result
if ($stderrTask.Result) { [Console]::Error.Write($stderrTask.Result) }
if ($ReportPath) {
    $reportParent = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($ReportPath))
    if (-not (Test-Path -LiteralPath $reportParent -PathType Container)) { throw 'Report parent must already exist.' }
    [IO.File]::WriteAllText($ReportPath, $stdoutText, [System.Text.UTF8Encoding]::new($false))
    $parsed = $stdoutText | ConvertFrom-Json
    [Console]::Out.WriteLine(([pscustomobject]@{ status = $parsed.status; exitCode = $process.ExitCode; summary = $parsed.summary; report = $ReportPath } | ConvertTo-Json -Depth 4 -Compress))
} else { [Console]::Out.Write($stdoutText) }
exit $process.ExitCode
