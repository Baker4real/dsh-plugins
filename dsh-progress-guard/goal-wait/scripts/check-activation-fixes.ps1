$ErrorActionPreference = 'Stop'
$env:ELECTRON_RUN_AS_NODE = '1'
& 'D:/Users/WINDOWS/AppData/Local/Programs/DeepSeek Harness/DeepSeek Harness.exe' --import 'file:///D:/agents/projects/dsh-plugins/dsh-progress-guard/goal-wait/scripts/runtime-loader.mjs' --test --test-reporter=spec 'D:/agents/projects/dsh-plugins/dsh-progress-guard/goal-wait/tests/early-human-loop.test.js' 'D:/agents/projects/dsh-plugins/dsh-progress-guard/goal-wait/tests/lifecycle.test.js' 'D:/agents/projects/dsh-plugins/dsh-progress-guard/goal-wait/tests/races.test.js' 'D:/agents/projects/dsh-plugins/dsh-progress-guard/goal-wait/tests/agent-loop.test.js'
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
