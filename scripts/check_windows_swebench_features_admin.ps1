$ErrorActionPreference = "Continue"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$Out = Join-Path $Root "benchmarks\latest-windows-swebench-feature-state.txt"
New-Item -ItemType Directory -Force -Path (Split-Path $Out) | Out-Null

"Timestamp: $(Get-Date -Format o)" | Set-Content $Out
"Admin: $(([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))" | Add-Content $Out
"" | Add-Content $Out

foreach ($f in @("VirtualMachinePlatform", "Microsoft-Windows-Subsystem-Linux", "Microsoft-Hyper-V-All", "HypervisorPlatform")) {
  try {
    $feature = Get-WindowsOptionalFeature -Online -FeatureName $f
    "$($feature.FeatureName): State=$($feature.State) RestartNeeded=$($feature.RestartNeeded)" | Add-Content $Out
  } catch {
    "${f}: ERROR $($_.Exception.Message)" | Add-Content $Out
  }
}

"" | Add-Content $Out
"BCDEdit hypervisor launch:" | Add-Content $Out
try { bcdedit /enum "{current}" | Select-String -Pattern "hypervisorlaunchtype" | ForEach-Object { $_.Line } | Add-Content $Out } catch { $_.Exception.Message | Add-Content $Out }
try { bcdedit /enum "{current}" | Add-Content $Out } catch { $_.Exception.Message | Add-Content $Out }

"" | Add-Content $Out
"Systeminfo hypervisor lines:" | Add-Content $Out
try { systeminfo | findstr /i "hyper-v virtualization hypervisor" | Add-Content $Out } catch { $_.Exception.Message | Add-Content $Out }

"" | Add-Content $Out
"Hyper-V Compute recent events:" | Add-Content $Out
try {
  Get-WinEvent -LogName Microsoft-Windows-Hyper-V-Compute-Admin -MaxEvents 20 |
    Select-Object TimeCreated,Id,LevelDisplayName,Message |
    Format-List |
    Out-String |
    Add-Content $Out
} catch { $_.Exception.Message | Add-Content $Out }

"" | Add-Content $Out
"Lxss recent events:" | Add-Content $Out
try {
  Get-WinEvent -LogName Microsoft-Windows-Lxss/Operational -MaxEvents 30 |
    Select-Object TimeCreated,Id,LevelDisplayName,Message |
    Format-List |
    Out-String |
    Add-Content $Out
} catch { $_.Exception.Message | Add-Content $Out }

"" | Add-Content $Out
"WSL status:" | Add-Content $Out
try { wsl --status 2>&1 | Add-Content $Out } catch { $_.Exception.Message | Add-Content $Out }
try { wsl -l -v 2>&1 | Add-Content $Out } catch { $_.Exception.Message | Add-Content $Out }

"" | Add-Content $Out
"Docker service:" | Add-Content $Out
try { Get-Service com.docker.service | Format-List | Out-String | Add-Content $Out } catch { $_.Exception.Message | Add-Content $Out }

Write-Host "Wrote $Out"
