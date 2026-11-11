$ErrorActionPreference = 'Stop'
. 'D:/agents/projects/misc/dsh-desktop-caption-visibility/Installer.Common.ps1'
$root = 'D:/Codex/evidence/dsh-goal-wait-20261110'
$ids = @('41d5501d-dc71-423d-91dd-c96ab3c49b0b','38e0204a-2306-4851-8e6a-90bba6be6118','f8d57763-3d57-44d9-a416-dec3109f495a','a21abcf4-253f-40ab-ae0f-aba90156d976')
$results = foreach ($id in $ids) {
  $directory = Join-Path $root ('cross-installer-' + $id)
  $state = Read-Json (Join-Path $directory 'run/installer-state.json')
  $exe = (Get-Item -LiteralPath (Join-Path $directory 'receipt-fixture-node.exe')).FullName
  $workerLive = Test-ProcessIdentity $state.identity
  $relaunchLive = Test-ProcessIdentity $state.extra
  $targetProcesses = @(Get-TargetProcesses $exe).Count
  [pscustomobject]@{ directory=$directory; stage=$state.stage; workerIdentityLive=$workerLive; relaunchIdentityLive=$relaunchLive; fixtureProcessCount=$targetProcesses; processState='exited'; pass=(-not $workerLive -and -not $relaunchLive -and $targetProcesses -eq 0) }
}
$result = @{ status=$(if (@($results | Where-Object { -not $_.pass }).Count -eq 0) { 'passed' } else { 'failed' }); checkedAt=[DateTimeOffset]::UtcNow.ToString('o'); results=@($results) }
Write-JsonAtomic (Join-Path $root 'cross-cleanup.json') $result
$result | ConvertTo-Json -Depth 6 -Compress
if ($result.status -ne 'passed') { exit 1 }
