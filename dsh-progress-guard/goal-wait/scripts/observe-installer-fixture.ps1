[CmdletBinding()]
param([Parameter(Mandatory)][string]$FixtureDirectory, [Parameter(Mandatory)][string]$InstallerRoot)
$ErrorActionPreference = 'Stop'
. (Join-Path $InstallerRoot 'Installer.Common.ps1')
$directory = [IO.Path]::GetFullPath($FixtureDirectory)
if (-not $directory.StartsWith('D:\Codex\evidence\dsh-goal-wait-20261110\cross-installer-', [StringComparison]::OrdinalIgnoreCase)) { throw 'Fixture directory is outside the owned integration evidence scope.' }
$run = Join-Path $directory 'run'
$state = Read-Json (Join-Path $run 'installer-state.json')
$original = Read-Json (Join-Path $directory 'original-ready.json')
$exe = (Get-Item -LiteralPath (Join-Path $directory 'receipt-fixture-node.exe')).FullName
if ($state.stage -ne 'waiting-for-app-exit') { throw 'Installer must be waiting for the fixture app before observing.' }
if (-not (Test-ProcessIdentity $state.identity)) { throw 'Installer worker identity is not live.' }
$originalIdentity = Get-ProcessIdentity ([int]$original.pid)
if ($originalIdentity.executable -ine $exe -or $original.executable -ine $exe) { throw 'Original app executable is not the owned Node copy.' }
$originalProcess = Get-Process -Id $originalIdentity.pid
$originalHandle = $originalProcess.Handle
$worker = Get-Process -Id $state.identity.pid
$workerHandle = $worker.Handle
Write-JsonAtomic (Join-Path $directory 'monitor-ready.json') @{ original=$originalIdentity; worker=$state.identity; ownerTokenSha256=$state.ownerTokenSha256; monitor=(Get-ProcessIdentity $PID) }
try {
  if (-not $worker.WaitForExit(45000)) { throw 'Fixture installer did not exit within the declared bound.' }
  if ($worker.ExitCode -ne 0) { throw ('Fixture installer exited ' + $worker.ExitCode) }
  $state = Read-Json (Join-Path $run 'installer-state.json')
  if ($state.stage -ne 'relaunched') { throw ('Installer terminal stage was ' + $state.stage) }
  if (-not $originalProcess.WaitForExit(5000) -or $originalProcess.ExitCode -ne 0) { throw 'Original fixture did not self-exit successfully.' }
  if (-not (Test-ProcessIdentity $state.extra)) { throw 'Relaunched fixture exited before it could be bound for exit evidence.' }
  $relaunch = Get-Process -Id $state.extra.pid
  $relaunchHandle = $relaunch.Handle
  if ($state.extra.executable -ine $exe) { throw 'Relaunch executable is outside the owned fixture.' }
  if (-not $relaunch.WaitForExit(15000)) { throw 'Relaunched fixture did not self-exit within its declared bound.' }
  if ($relaunch.ExitCode -ne 0) { throw ('Relaunched fixture exited ' + $relaunch.ExitCode) }
  $remaining = @(Get-TargetProcesses $exe).Count
  if ($remaining -ne 0 -or (Test-ProcessIdentity $state.identity)) { throw 'Owned fixture processes remain live.' }
  $result = @{ status='passed'; processState='exited'; worker=$state.identity; workerExitCode=$worker.ExitCode; original=$originalIdentity; originalExitCode=$originalProcess.ExitCode; relaunched=$state.extra; relaunchExitCode=$relaunch.ExitCode; remainingFixtureProcesses=$remaining; workerOwnerTokenSha256=$state.ownerTokenSha256; stage=$state.stage; installLockPresent=(Test-Path -LiteralPath (Join-Path $directory 'app.asar.caption-install.lock')); applyLockPresent=(Test-Path -LiteralPath (Join-Path $directory 'app.asar.caption-apply.lock')); checkedAt=[DateTimeOffset]::UtcNow.ToString('o') }
  if ($result.installLockPresent -or $result.applyLockPresent) { throw 'Fixture installer locks remain.' }
  Write-JsonAtomic (Join-Path $directory 'process-exits.json') $result
  $result | ConvertTo-Json -Depth 8 -Compress
} catch {
  Write-JsonAtomic (Join-Path $directory 'process-exits.json') @{ status='failed'; detail=$_.Exception.Message; checkedAt=[DateTimeOffset]::UtcNow.ToString('o') }
  throw
}
