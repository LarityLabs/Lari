$ErrorActionPreference = "Continue"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$Out = Join-Path $Root "benchmarks\latest-windows-hypervisor-repair-report.txt"
New-Item -ItemType Directory -Force -Path (Split-Path $Out) | Out-Null

function Log($Message) {
  Write-Host $Message
  $Message | Add-Content $Out
}

function Step($Message) {
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
  "" | Add-Content $Out
  "==> $Message" | Add-Content $Out
}

"Timestamp: $(Get-Date -Format o)" | Set-Content $Out
"Admin: $(([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator))" | Add-Content $Out

Step "Enable WSL2, VM Platform, Windows Hypervisor Platform, and Hyper-V subfeatures"
$features = @(
  "Microsoft-Windows-Subsystem-Linux",
  "VirtualMachinePlatform",
  "HypervisorPlatform",
  "Microsoft-Hyper-V",
  "Microsoft-Hyper-V-All",
  "Microsoft-Hyper-V-Hypervisor",
  "Microsoft-Hyper-V-Services",
  "Microsoft-Hyper-V-Management-PowerShell"
)
foreach ($featureName in $features) {
  Log "Enabling $featureName"
  dism.exe /online /enable-feature /featurename:$featureName /all /norestart | Tee-Object -Append -FilePath $Out
}

Step "Set boot options that allow Hyper-V to launch"
bcdedit /set "{current}" hypervisorlaunchtype Auto | Tee-Object -Append -FilePath $Out
bcdedit /set "{current}" vsmlaunchtype Auto | Tee-Object -Append -FilePath $Out

Step "Feature state after repair"
Get-WindowsOptionalFeature -Online |
  Where-Object { $_.FeatureName -like "*Hyper-V*" -or $_.FeatureName -in @("VirtualMachinePlatform", "HypervisorPlatform", "Microsoft-Windows-Subsystem-Linux") } |
  Select-Object FeatureName,State,RestartNeeded |
  Format-Table -AutoSize |
  Out-String |
  Tee-Object -Append -FilePath $Out

Step "Current boot config"
bcdedit /enum "{current}" | Tee-Object -Append -FilePath $Out

Step "Systeminfo hypervisor lines"
systeminfo | findstr /i "hyper-v virtualization hypervisor" | Tee-Object -Append -FilePath $Out

Step "Recent Hyper-V Hypervisor events"
try {
  Get-WinEvent -LogName Microsoft-Windows-Hyper-V-Hypervisor-Admin -MaxEvents 30 |
    Select-Object TimeCreated,Id,LevelDisplayName,Message |
    Format-List |
    Out-String |
    Tee-Object -Append -FilePath $Out
} catch {
  Log "Could not read Hyper-V Hypervisor Admin log: $($_.Exception.Message)"
}

Step "Done"
Log "Reboot Windows after this script. Then verify: systeminfo | findstr /i `"hyper-v virtualization hypervisor`""
