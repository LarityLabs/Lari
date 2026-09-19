# Phase A: the remaining three transfer conditions, run one at a time.
#
# Sequential on purpose. Two measurements sharing this machine make the oracle slower than the
# per-candidate timeout expects, and a candidate cut off for lack of CPU is recorded as a rejection --
# a property of the machine written down as a property of the code. That already showed up once today
# in the execution-claim lane, as a pure call reporting 'unusable' while a measurement had the box busy.
#
# Growth is disabled in every condition: nothing may be learned during the test. Priors travel with the
# vocabulary that describes them, which the measurement script reports as priorsLoaded -- loading one
# without the other has already produced a false 0/5 on a set the vocabulary provably covered.

$ErrorActionPreference = 'Stop'
Set-Location 'C:\Users\goryg\.gemini\antigravity\scratch\html-agent-swarm'
$env:LARI_AUTONOMOUS_LEARNING = '0'

$SEED     = 'models/lari/trained/seed-baseline.json'
$TRAINED  = 'models/lari/trained/blitz-natsort-9families.json'
$DONE     = '"benchmark": "lari-mechanical-testset"'

function Wait-ForRun($logPath, $label) {
  Write-Host "waiting for $label to finish ..."
  while ($true) {
    if (Test-Path $logPath) {
      if (Select-String -Path $logPath -Pattern ([regex]::Escape($DONE)) -Quiet) {
        Write-Host "$label complete."
        return
      }
    }
    Start-Sleep -Seconds 30
  }
}

function Invoke-Measurement($manifest, $model, $log, $label) {
  if ((Test-Path $log) -and (Select-String -Path $log -Pattern ([regex]::Escape($DONE)) -Quiet)) {
    Write-Host "$label already complete; skipping."
    return
  }
  Write-Host "=== $label ==="
  & node scripts/measure_lari_mechanical_holdout.js `
      --manifest $manifest --limit 320 --no-growth --model $model *>&1 |
    Tee-Object $log | Select-Object -Last 3
  Write-Host "$label finished with exit code $LASTEXITCODE"
}

# The blind control was launched earlier and is still going.
Wait-ForRun 'holdouts/results/humanize-blind-CONTROL.txt' 'blind CONTROL'

Invoke-Measurement 'holdouts/transfer-humanize-blind/manifest.json'    $TRAINED `
  'holdouts/results/humanize-blind-TREATMENT.txt'    'blind TREATMENT'
Invoke-Measurement 'holdouts/transfer-humanize-targeted/manifest.json' $SEED `
  'holdouts/results/humanize-targeted-CONTROL.txt'   'targeted CONTROL'
Invoke-Measurement 'holdouts/transfer-humanize-targeted/manifest.json' $TRAINED `
  'holdouts/results/humanize-targeted-TREATMENT.txt' 'targeted TREATMENT'

Write-Host ''
Write-Host '=== all four conditions complete; summaries ==='
foreach ($pair in @(
  @('blind CONTROL',      'holdouts/results/humanize-blind-CONTROL.txt'),
  @('blind TREATMENT',    'holdouts/results/humanize-blind-TREATMENT.txt'),
  @('targeted CONTROL',   'holdouts/results/humanize-targeted-CONTROL.txt'),
  @('targeted TREATMENT', 'holdouts/results/humanize-targeted-TREATMENT.txt'))) {
  Write-Host ''
  Write-Host ('--- ' + $pair[0] + ' ---')
  if (Test-Path $pair[1]) { Get-Content $pair[1] -Tail 24 } else { Write-Host 'MISSING' }
}
