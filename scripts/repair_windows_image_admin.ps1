$ErrorActionPreference = "Continue"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$Out = Join-Path $Root "benchmarks\latest-windows-image-repair-report.txt"
New-Item -ItemType Directory -Force -Path (Split-Path $Out) | Out-Null

function Step($Message) {
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
  "" | Add-Content $Out
  "==> $Message" | Add-Content $Out
}

"Timestamp: $(Get-Date -Format o)" | Set-Content $Out
"Admin: $(([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))" | Add-Content $Out

Step "DISM RestoreHealth"
DISM.exe /Online /Cleanup-Image /RestoreHealth | Tee-Object -Append -FilePath $Out

Step "SFC scan"
sfc.exe /scannow | Tee-Object -Append -FilePath $Out

Step "Re-assert Hyper-V boot and feature state"
bcdedit /set "{current}" hypervisorlaunchtype Auto | Tee-Object -Append -FilePath $Out
bcdedit /set "{current}" vsmlaunchtype Auto | Tee-Object -Append -FilePath $Out
foreach ($featureName in @(
  "Microsoft-Windows-Subsystem-Linux",
  "VirtualMachinePlatform",
  "HypervisorPlatform",
  "Microsoft-Hyper-V-All",
  "Microsoft-Hyper-V-Hypervisor",
  "Microsoft-Hyper-V-Services"
)) {
  dism.exe /online /enable-feature /featurename:$featureName /all /norestart | Tee-Object -Append -FilePath $Out
}

Step "Current checks before reboot"
"HypervisorPresent=$((Get-CimInstance Win32_ComputerSystem).HypervisorPresent)" | Tee-Object -Append -FilePath $Out
systeminfo | findstr /i "hyper-v virtualization hypervisor" | Tee-Object -Append -FilePath $Out
bcdedit /enum "{current}" | Tee-Object -Append -FilePath $Out

Step "Done"
"Reboot Windows after this. If HypervisorPresent is still False after reboot, this Windows build is blocking WSL2/Hyper-V and Docker cannot run until Windows is repaired, upgraded, or rolled back." | Tee-Object -Append -FilePath $Out
